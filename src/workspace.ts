import { Context, Effect, Layer, Schema } from 'effect'
import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AppError, Run } from './domain'

import { childEnvironment } from './child-environment'
import { Branch, CommitSha, Path, RunId, error } from './domain'

// Provisions Whey isolates and verifies their ownership, branch, base commit, and clean review revision.

export const git = Effect.fn('Git.command')(function* (input: { cwd: Path; args: readonly string[] }) {
  return yield* Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(['git', ...input.args], {
        cwd: input.cwd,
        env: childEnvironment(),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (code !== 0) throw new Error(stderr)
      return stdout.trim()
    },
    catch: () =>
      error('workspace', `Git ${input.args[0]} failed in ${input.cwd}; inspect the repository configuration`),
  })
})
const Isolate = Schema.Struct({
  slug: RunId,
  projectPath: Path,
  repo: Path,
  branch: Branch,
  baseSha: CommitSha,
})

const whey = Effect.fn('Workspace.whey')(function* (run: Run, command: 'create' | 'inspect') {
  const args = [
    process.execPath,
    fileURLToPath(new URL('../whey/whey.mjs', import.meta.url)),
    '--config',
    `${run.repo}/.whey.jsonc`,
    command,
    run.id,
    ...(command === 'create'
      ? ['--base', run.baseSha, '--branch', run.branch, '--root', dirname(run.workspace), '--json']
      : []),
  ]
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            Bun.spawn(args, {
              cwd: run.repo,
              detached: true,
              env: childEnvironment(),
              stdin: 'ignore',
              stdout: 'pipe',
              stderr: 'pipe',
            }),
          catch: () => error('workspace', 'Unable to start Whey'),
        }),
        (child) =>
          Effect.promise(async () => {
            if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL')
            await child.exited
          }),
      )
      const [stdout, stderr, code] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
      )
      if (code !== 0) return yield* error('blocked', `Whey ${command} failed: ${stderr.trim()}`)
      const isolate = yield* Schema.decodeUnknown(Schema.parseJson(Isolate))(stdout).pipe(
        Effect.mapError(() => error('workspace', 'Whey returned invalid isolate metadata')),
      )
      if (
        isolate.slug !== run.id ||
        isolate.projectPath !== run.workspace ||
        isolate.repo !== run.repo ||
        isolate.branch !== run.branch ||
        isolate.baseSha !== run.baseSha
      ) {
        return yield* error('blocked', 'Whey isolate identity does not match the enrolled run')
      }
    }),
  )
})

export class Workspace extends Context.Tag('Workspace')<
  Workspace,
  {
    readonly inspectBase: (input: {
      repo: Path
      base: typeof Branch.Type
    }) => Effect.Effect<{ repo: Path; baseSha: CommitSha }, AppError>
    readonly prepare: (run: Run) => Effect.Effect<void, AppError>
    readonly inspect: (run: Run) => Effect.Effect<CommitSha, AppError>
  }
>() {}
export const WorkspaceLive = Layer.succeed(
  Workspace,
  Workspace.of({
    inspectBase: Effect.fn('Workspace.inspectBase')(function* (input) {
      const repo = yield* Effect.tryPromise({
        try: () => realpath(input.repo),
        catch: () => error('workspace', 'Repository path does not exist'),
      })
      const root = yield* git({ cwd: Path.make(repo), args: ['rev-parse', '--show-toplevel'] })
      const base = yield* git({
        cwd: Path.make(root),
        args: ['rev-parse', '--verify', '--end-of-options', `${input.base}^{commit}`],
      })
      return {
        repo: Path.make(root),
        baseSha: yield* Schema.decodeUnknown(CommitSha)(base).pipe(
          Effect.mapError(() => error('workspace', 'Expected a SHA-1 Git repository')),
        ),
      }
    }),
    prepare: Effect.fn('Workspace.prepare')(function* (run) {
      yield* whey(run, 'create')
    }),
    inspect: Effect.fn('Workspace.inspect')(function* (run) {
      yield* whey(run, 'inspect')
      const branch = yield* git({ cwd: run.workspace, args: ['branch', '--show-current'] })
      if (branch !== run.branch) return yield* error('workspace', 'Workspace branch changed')
      const dirty = yield* git({ cwd: run.workspace, args: ['status', '--porcelain', '--untracked-files=all'] })
      if (dirty)
        return yield* error(
          'blocked',
          `Workspace has uncommitted files. Reconcile ${run.workspace} without discarding work, then resume.`,
        )
      const head = yield* git({ cwd: run.workspace, args: ['rev-parse', 'HEAD'] })
      yield* git({ cwd: run.workspace, args: ['merge-base', '--is-ancestor', run.baseSha, 'HEAD'] })
      return yield* Schema.decodeUnknown(CommitSha)(head).pipe(
        Effect.mapError(() => error('workspace', 'Invalid workspace HEAD')),
      )
    }),
  }),
)
