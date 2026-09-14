import { Context, Effect, Layer, JSONSchema, Schema, Option } from 'effect'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, writeFile, rm, open } from 'node:fs/promises'

import type { AppError, AgentOutput, Assignment } from './domain'

import { childEnvironment } from './child-environment'
import { Settings } from './config'
import { Result, error } from './domain'
import { roleFor } from './handoff'

// Runs a role-specific Codex assignment with structured output, usage accounting, and a recoverable process lease.

export class Agent extends Context.Tag('Agent')<
  Agent,
  {
    readonly execute: (assignment: Assignment) => Effect.Effect<AgentOutput, AppError>
  }
>() {}
const Usage = Schema.Struct({
  type: Schema.Literal('turn.completed'),
  usage: Schema.Struct({ input_tokens: Schema.Int, output_tokens: Schema.Int }),
})
export function countTokens(log: string): number {
  return log.split('\n').reduce((sum, line) => {
    const event = Schema.decodeUnknownOption(Schema.parseJson(Usage))(line)
    return Option.isSome(event) ? sum + event.value.usage.input_tokens + event.value.usage.output_tokens : sum
  }, 0)
}
const waitForExit = (child: ChildProcess): Promise<number> =>
  new Promise((resolveExit, reject) => {
    if (child.exitCode !== null) return resolveExit(child.exitCode)
    if (child.signalCode !== null) return resolveExit(128)
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 128))
  })
const groupAlive = Effect.fn('Agent.groupAlive')(function* (pid: number) {
  return yield* Effect.try({
    try: () => {
      process.kill(-pid, 0)
      return true
    },
    catch: (cause) =>
      Schema.is(Schema.Struct({ code: Schema.Literal('ESRCH') }))(cause)
        ? error('agent', 'gone')
        : error('blocked', 'Cannot establish whether the previous process group is still alive'),
  }).pipe(
    Effect.catchIf(
      (failure) => failure.message === 'gone',
      () => Effect.succeed(false),
    ),
  )
})
const stopProcess = Effect.fn('Agent.stopProcess')(function* (child: ChildProcess) {
  if (child.pid === undefined) return
  const pid = child.pid
  if (yield* groupAlive(pid)) {
    yield* Effect.try(() => process.kill(-pid, 'SIGTERM')).pipe(Effect.ignore)
    yield* Effect.tryPromise(() => waitForExit(child)).pipe(Effect.timeout('3 seconds'), Effect.ignore)
    if (yield* groupAlive(pid)) yield* Effect.try(() => process.kill(-pid, 'SIGKILL')).pipe(Effect.ignore)
    yield* Effect.tryPromise(() => waitForExit(child)).pipe(Effect.timeout('3 seconds'), Effect.ignore)
  }
})

export const recoverAgentLease = Effect.fn('Agent.recoverLease')(function* () {
  const settings = yield* Settings
  const lock = `${settings.artifactRoot}/agent.lock`
  const exists = yield* Effect.tryPromise(() => Bun.file(`${lock}/pid`).exists()).pipe(Effect.orDie)
  if (!exists) {
    const dirExists = yield* Effect.tryPromise(() => import('node:fs/promises').then((fs) => fs.stat(lock))).pipe(
      Effect.option,
    )
    if (Option.isSome(dirExists))
      return yield* error(
        'blocked',
        `Incomplete process lease at ${lock}. Inspect local Codex processes before manually removing this lock directory.`,
      )
    return
  }
  const text = yield* Effect.tryPromise(() => readFile(`${lock}/pid`, 'utf8')).pipe(
    Effect.mapError(() => error('agent', 'Unable to read process lease')),
  )
  const pid = Number(text)
  if (!Number.isSafeInteger(pid) || pid <= 1)
    return yield* error('blocked', `Invalid process lease at ${lock}; inspect it manually`)
  const alive = yield* groupAlive(pid)
  if (alive)
    return yield* error(
      'blocked',
      `A previous Codex process (${pid}) may still be running. Stop it and its process group before resuming. Lease: ${lock}`,
    )
  yield* Effect.tryPromise(() => rm(lock, { recursive: true })).pipe(
    Effect.mapError(() => error('agent', 'Unable to release stale process lease')),
  )
})

export const AgentLive = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const settings = yield* Settings
    return Agent.of({
      execute: Effect.fn('Agent.execute')(function* (assignment) {
        const role = roleFor(assignment.run.phase)
        const dir = assignment.artifactDir
        const lock = `${settings.artifactRoot}/agent.lock`
        const io = <A>(operation: () => Promise<A>) =>
          Effect.tryPromise({ try: operation, catch: () => error('agent', `Agent file operation failed in ${dir}`) })
        yield* io(() => mkdir(dir, { recursive: true }))
        // A surviving lease blocks new processes even after the workflow engine has recovered.
        yield* io(() => mkdir(lock))
        let spawned = false
        return yield* Effect.gen(function* () {
          const shared = yield* io(() => readFile(new URL('../prompts/shared.md', import.meta.url), 'utf8'))
          const prompt = yield* io(() => readFile(new URL(`../prompts/${role}.md`, import.meta.url), 'utf8'))
          const schemaPath = `${dir}/result-schema.json`
          const resultPath = `${dir}/result.json`
          const logPath = `${dir}/events.jsonl`
          yield* io(() => writeFile(schemaPath, JSON.stringify(JSONSchema.make(Result))))
          const input = `${shared}\n\n${prompt}\n\n## Coordinator assignment\n\n${JSON.stringify(assignment)}\n`
          yield* io(() => writeFile(`${dir}/assignment.json`, JSON.stringify(assignment, null, 2)))
          const output = yield* Effect.acquireRelease(
            io(() => open(logPath, 'w')),
            (file) => io(() => file.close()).pipe(Effect.orDie),
          )
          const stderr = yield* Effect.acquireRelease(
            io(() => open(`${dir}/stderr.log`, 'w')),
            (file) => io(() => file.close()).pipe(Effect.orDie),
          )
          const args = [
            'exec',
            '--model',
            'gpt-6-astra',
            '--sandbox',
            'workspace-write',
            '--cd',
            role === 'developer' ? assignment.run.worktree : dir,
            '--add-dir',
            dir,
            '--skip-git-repo-check',
            '--json',
            '--output-schema',
            schemaPath,
            '--output-last-message',
            resultPath,
            '-',
          ]
          const child = yield* Effect.acquireRelease(
            Effect.try({
              // The launcher records its own PID before exec; no task text is interpolated into shell code.
              try: () =>
                spawn(
                  '/bin/sh',
                  ['-c', 'printf "%s" "$$" > "$1"; shift; exec "$@"', '--', `${lock}/pid`, 'codex', ...args],
                  {
                    cwd: assignment.run.worktree,
                    env: childEnvironment(),
                    detached: true,
                    stdio: ['pipe', output.fd, stderr.fd],
                  },
                ),
              catch: () => error('agent', 'Could not start Codex'),
            }),
            (child) => stopProcess(child).pipe(Effect.orDie),
          )
          spawned = true
          let inputFailed = false
          child.stdin?.on('error', () => {
            inputFailed = true
          })
          child.stdin?.end(input)
          const remaining = Math.max(1, assignment.run.maxMinutes * 60000 - assignment.run.activeMillis)
          const code = yield* Effect.tryPromise({
            try: () => waitForExit(child),
            catch: () => error('agent', 'Codex process failed to start'),
          }).pipe(
            Effect.timeoutFail({
              duration: remaining,
              onTimeout: () =>
                error('blocked', 'Run time budget exhausted; review progress and resume with a larger budget'),
            }),
          )
          if (inputFailed) return yield* error('agent', 'Could not deliver the complete assignment to Codex')
          if (code !== 0)
            return yield* error(
              'agent',
              `Codex exited ${code}. Inspect ${dir}/stderr.log and reconcile the worktree before resuming.`,
            )
          const raw = yield* io(() => readFile(resultPath, 'utf8'))
          const result = yield* Schema.decodeUnknown(Schema.parseJson(Result))(raw).pipe(
            Effect.mapError(() => error('invalid', `Invalid Codex structured result at ${resultPath}`)),
          )
          const log = yield* io(() => readFile(logPath, 'utf8'))
          return { result, tokens: countTokens(log) }
        }).pipe(
          Effect.scoped,
          Effect.ensuring(
            Effect.suspend(() =>
              spawned
                ? recoverAgentLease().pipe(
                    Effect.provideService(Settings, settings),
                    Effect.catchAll((failure) => Effect.logWarning(failure.message)),
                  )
                : io(() => rm(lock, { recursive: true, force: true })).pipe(Effect.orDie),
            ),
          ),
        )
      }),
    })
  }),
)
