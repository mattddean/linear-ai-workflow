import { expect, test } from 'bun:test'
import { Effect, Fiber, Layer } from 'effect'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Agent, AgentLive, countTokens } from '../src/agent'
import { Settings } from '../src/config'
import { Path } from '../src/domain'
import { childEnvironment } from '../src/workspace'
import { fixture, ready, settings } from './fixtures'

test('child environment excludes coordinator and inherited API credentials', () => {
  const previous = process.env.LINEAR_API_KEY
  process.env.LINEAR_API_KEY = 'must-not-leak'
  expect(childEnvironment().LINEAR_API_KEY).toBeUndefined()
  expect(childEnvironment().DATABASE_URL).toBeUndefined()
  expect(childEnvironment().OPENAI_API_KEY).toBeUndefined()
  if (previous === undefined) delete process.env.LINEAR_API_KEY
  else process.env.LINEAR_API_KEY = previous
})

test('usage ignores non-usage events and malformed log lines', () => {
  expect(
    countTokens('bad\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 3 } })),
  ).toBe(23)
})

async function mockCodex(options: { hang: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), 'linear-agent-test-'))
  const f = fixture()
  const output = ready(f.state.run)
  const script = `#!${process.execPath}\nconst args = process.argv.slice(2);\nawait Bun.write(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(args));\n${options.hang ? 'await new Promise(() => { setInterval(() => {}, 1000) });' : `await Bun.write(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(output))});\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:3}}));`}\n`
  await writeFile(join(dir, 'codex'), script)
  await chmod(join(dir, 'codex'), 0o755)
  const layer = AgentLive.pipe(Layer.provide(Layer.succeed(Settings, { ...settings, artifactRoot: Path.make(dir) })))
  const assignment = {
    run: { ...f.state.run, worktree: Path.make(dir) },
    snapshot: f.state.snapshot,
    artifactDir: Path.make(join(dir, 'assignment')),
  }
  return { dir, layer, assignment }
}

test('local runner pins Astra, uses structured output, isolates reviewer writes, and releases its lease', async () => {
  const mock = await mockCodex({ hang: false })
  const prior = process.env.PATH
  process.env.PATH = `${mock.dir}:${prior ?? ''}`
  const output = await Effect.runPromise(
    Effect.flatMap(Agent, (agent) => agent.execute(mock.assignment)).pipe(
      Effect.provide(mock.layer),
      Effect.ensuring(
        Effect.sync(() => {
          process.env.PATH = prior
        }),
      ),
    ),
  )
  expect(output.tokens).toBe(23)
  expect(output.result).toEqual(ready(mock.assignment.run))
  const args = await readFile(join(mock.dir, 'args.json'), 'utf8')
  expect(args).toContain('gpt-6-astra')
  expect(args).toContain(mock.assignment.artifactDir)
  expect(args).not.toContain('dangerously')
  expect(
    await stat(join(mock.dir, 'agent.lock')).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  await rm(mock.dir, { recursive: true, force: true })
})

test('interrupting an assignment terminates the local process and releases the lease', async () => {
  const mock = await mockCodex({ hang: true })
  const prior = process.env.PATH
  process.env.PATH = `${mock.dir}:${prior ?? ''}`
  await Effect.runPromise(
    Effect.gen(function* () {
      const agent = yield* Agent
      const fiber = yield* agent.execute(mock.assignment).pipe(Effect.forkScoped)
      while (!(yield* Effect.promise(() => Bun.file(join(mock.dir, 'args.json')).exists())))
        yield* Effect.sleep('10 millis')
      yield* Fiber.interrupt(fiber)
    }).pipe(
      Effect.scoped,
      Effect.provide(mock.layer),
      Effect.timeout('8 seconds'),
      Effect.ensuring(
        Effect.sync(() => {
          process.env.PATH = prior
        }),
      ),
    ),
  )
  expect(
    await stat(join(mock.dir, 'agent.lock')).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  await rm(mock.dir, { recursive: true, force: true })
}, 10000)
