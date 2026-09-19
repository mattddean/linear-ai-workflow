import { expect, test } from 'bun:test'
import { Effect, Fiber, Layer, Schema } from 'effect'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Agent } from './agent'
import { childEnvironment } from './child-environment'
import { Settings } from './config'
import { Path } from './domain'
import { fixture, ready, settings } from './test/fixtures'
import { budgetTokens, countTokenUsage } from './token-usage'

// Verifies Codex invocation, credential isolation, usage accounting, and process cleanup with a local fake executable.

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
    countTokenUsage(
      'bad\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 3 } }),
    ),
  ).toEqual({ tokens: 23, cachedTokens: 0 })
})

async function mockCodex(options: { hang: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), 'linear-agent-test-'))
  const f = fixture()
  const output = ready(f.state.run)
  const script = `#!${process.execPath}\nconst args = process.argv.slice(2);\nawait Bun.write(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(args));\nawait Bun.write(${JSON.stringify(join(dir, 'input.md'))}, await Bun.stdin.text());\n${options.hang ? 'await new Promise(() => { setInterval(() => {}, 1000) });' : `await Bun.write(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(output))});\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:3}}));`}\n`
  await writeFile(join(dir, 'codex'), script)
  await chmod(join(dir, 'codex'), 0o755)
  const layer = Agent.layer.pipe(Layer.provide(Layer.succeed(Settings, { ...settings, artifactRoot: Path.make(dir) })))
  const assignment = {
    run: { ...f.state.run, workspace: Path.make(dir) },
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
  const resultSchema = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        type: Schema.Literal('object'),
        additionalProperties: Schema.Literal(false),
        required: Schema.Array(Schema.String),
        properties: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  )(await readFile(join(mock.assignment.artifactDir, 'result-schema.json'), 'utf8'))
  expect(resultSchema.required).toContain('outcome')
  expect(resultSchema.required).toContain('report')
  expect(Object.keys(resultSchema.properties).sort()).toEqual([...resultSchema.required].sort())
  const args = await readFile(join(mock.dir, 'args.json'), 'utf8')
  expect(args).toContain('gpt-6-astra')
  expect(args).toContain(JSON.stringify('model_reasoning_effort="medium"'))
  expect(args).toContain(mock.assignment.artifactDir)
  expect(args).not.toContain('dangerously')
  const input = await readFile(join(mock.dir, 'input.md'), 'utf8')
  expect(input).toContain('whey/whey.mjs')
  expect(input).toContain(`${mock.assignment.run.repo}/.whey.jsonc`)
  expect(input).toContain(mock.assignment.run.id)
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

test('budget counts uncached input plus output across completed turns, without adding reasoning twice', () => {
  const log = [
    {
      type: 'turn.completed',
      usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 30, reasoning_output_tokens: 10 },
    },
    { type: 'turn.completed', usage: { input_tokens: 1500, cached_input_tokens: 1400, output_tokens: 20 } },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')
  const usage = countTokenUsage(log)
  expect(usage).toEqual({ tokens: 2550, cachedTokens: 2300 })
  expect(budgetTokens(usage)).toBe(250)
})
