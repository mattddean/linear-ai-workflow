import { expect, test } from 'bun:test'
import { Effect, Fiber, Layer, Schema } from 'effect'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Agent, stopCanceledAgent } from './agent'
import { childEnvironment } from './child-environment'
import { Settings } from './config'
import { Path, RunId, CodexSessionId } from './domain'
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
  ).toEqual({ tokens: 23, cachedTokens: 0, sessionUsage: { tokens: 23, cachedTokens: 0 } })
})

async function mockCodex(options: { hang: boolean; progress?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), 'linear-agent-test-'))
  const f = fixture()
  if (options.progress) f.state.run = { ...f.state.run, phase: 'implementation' }
  const output = ready(f.state.run)
  const progressScript = options.progress
    ? `console.log(JSON.stringify({type:'item.completed',item:{id:'item_1',type:'agent_message',text:'Implementation complete; running checks.'}}));\nwhile (!(await Bun.file(${JSON.stringify(join(dir, 'progress-received'))}).exists())) await Bun.sleep(10);\n`
    : ''
  const script = `#!${process.execPath}\nconst args = process.argv.slice(2);\nconsole.log(JSON.stringify({type:"thread.started", thread_id: args.includes("resume") ? args[args.indexOf("resume") + 3] : "00000000-0000-4000-8000-000000000099"}));\nawait Bun.write(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(args));\nawait Bun.write(${JSON.stringify(join(dir, 'input.md'))}, await Bun.stdin.text());\n${progressScript}${options.hang ? 'await new Promise(() => { setInterval(() => {}, 1000) });' : `await Bun.write(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(output))});\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:3}}));`}\n`
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
  expect(input).toContain('To reopen a closed isolate')
  expect(input).toContain('run start before open')
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

test('budget uses the latest cumulative turn totals, without adding reasoning twice', () => {
  const log = [
    {
      type: 'turn.completed',
      usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 30, reasoning_output_tokens: 10 },
    },
    { type: 'turn.completed', usage: { input_tokens: 1500, cached_input_tokens: 1400, output_tokens: 50 } },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')
  const usage = countTokenUsage(log)
  expect(usage).toEqual({ tokens: 1550, cachedTokens: 1400, sessionUsage: { tokens: 1550, cachedTokens: 1400 } })
  expect(budgetTokens(usage)).toBe(150)
})

for (const override of [undefined, 20]) {
  test(`runner timeout uses ${override === undefined ? 'configured minutes' : 'an explicit minute override'}`, async () => {
    const mock = await mockCodex({ hang: true })
    const prior = process.env.PATH
    process.env.PATH = `${mock.dir}:${prior ?? ''}`
    const allowedMinutes = override ?? settings.maxMinutes
    try {
      const result = await Effect.runPromise(
        Effect.flatMap(Agent, (agent) =>
          agent.execute({
            ...mock.assignment,
            run: {
              ...mock.assignment.run,
              activeMillis: allowedMinutes * 60000 - 100,
              ...(override === undefined ? {} : { budgetOverrides: { maxMinutes: override } }),
            },
          }),
        ).pipe(Effect.provide(mock.layer), Effect.result),
      )
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') {
        expect(result.failure.kind).toBe('blocked')
        expect(result.failure.message).toContain(`${allowedMinutes} active minutes allowed`)
      }
      expect(await Bun.file(join(mock.dir, 'agent.lock', 'pid')).exists()).toBe(false)
    } finally {
      process.env.PATH = prior
      await rm(mock.dir, { recursive: true, force: true })
    }
  })
}

test('Developer public commentary is delivered while its Codex process is still running', async () => {
  const mock = await mockCodex({ hang: false, progress: true })
  const prior = process.env.PATH
  process.env.PATH = `${mock.dir}:${prior ?? ''}`
  const messages: string[] = []
  try {
    const output = await Effect.runPromise(
      Effect.flatMap(Agent, (agent) =>
        agent.execute(mock.assignment, (progress) =>
          Effect.promise(async () => {
            messages.push(progress.message)
            await writeFile(join(mock.dir, 'progress-received'), 'yes')
          }),
        ),
      ).pipe(Effect.provide(mock.layer), Effect.timeout('8 seconds')),
    )
    expect(messages).toEqual(['Implementation complete; running checks.'])
    expect(output.result.outcome).toBe('ready')
  } finally {
    process.env.PATH = prior
    await rm(mock.dir, { recursive: true, force: true })
  }
}, 10000)

test('ticket cancellation stops only its owned Codex process and preserves artifacts', async () => {
  const mock = await mockCodex({ hang: true })
  const prior = process.env.PATH
  process.env.PATH = `${mock.dir}:${prior ?? ''}`
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const agent = yield* Agent
        const fiber = yield* agent.execute(mock.assignment).pipe(Effect.result, Effect.forkScoped)
        while (!(yield* Effect.promise(() => Bun.file(join(mock.dir, 'args.json')).exists())))
          yield* Effect.sleep('10 millis')
        yield* stopCanceledAgent(RunId.make(crypto.randomUUID()))
        expect(yield* Effect.promise(() => Bun.file(join(mock.dir, 'agent.lock', 'pid')).exists())).toBe(true)
        yield* stopCanceledAgent(mock.assignment.run.id)
        expect((yield* Fiber.join(fiber))._tag).toBe('Failure')
        expect(
          yield* Effect.promise(() => Bun.file(join(mock.assignment.artifactDir, 'assignment.json')).exists()),
        ).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(join(mock.dir, 'agent.lock', 'pid')).exists())).toBe(false)
      }).pipe(
        Effect.scoped,
        Effect.provide(mock.layer),
        Effect.provideService(Settings, { ...settings, artifactRoot: Path.make(mock.dir) }),
        Effect.timeout('8 seconds'),
      ),
    )
  } finally {
    process.env.PATH = prior
    await rm(mock.dir, { recursive: true, force: true })
  }
}, 10000)

test('same-thread continuation resumes the exact recorded session with structured output and permission settings', async () => {
  const mock = await mockCodex({ hang: false })
  const prior = process.env.PATH
  process.env.PATH = `${mock.dir}:${prior ?? ''}`
  const sessionId = CodexSessionId.make('00000000-0000-4000-8000-000000000099')
  const recorded: CodexSessionId[] = []
  try {
    await Effect.runPromise(
      Effect.flatMap(Agent, (agent) =>
        agent.execute(
          {
            ...mock.assignment,
            run: {
              ...mock.assignment.run,
              codexSessionId: sessionId,
              answer: 'Device connected',
              codexSessionUsage: { tokens: 10, cachedTokens: 0 },
            },
          },
          undefined,
          (id) =>
            Effect.sync(() => {
              recorded.push(id)
            }),
        ),
      ).pipe(Effect.provide(mock.layer)),
    )
    const args = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
      await readFile(join(mock.dir, 'args.json'), 'utf8'),
    )
    expect(args.slice(-5)).toEqual(['resume', '--model', 'gpt-6-astra', sessionId, '-'])
    expect(args).toContain('--output-schema')
    expect(args).toContain('workspace-write')
    expect(recorded).toEqual([sessionId])
    const input = await readFile(join(mock.dir, 'input.md'), 'utf8')
    expect(input).toContain('Device connected')
    expect(input).not.toContain('# Shared runtime instructions')
  } finally {
    process.env.PATH = prior
    await rm(mock.dir, { recursive: true, force: true })
  }
})

test('resumed session usage charges only the increase in lifetime totals', () => {
  const log = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1500, cached_input_tokens: 1200, output_tokens: 100 },
  })
  const usage = countTokenUsage(log, { tokens: 1050, cachedTokens: 900 })
  expect(usage).toEqual({ tokens: 550, cachedTokens: 300, sessionUsage: { tokens: 1600, cachedTokens: 1200 } })
  expect(budgetTokens(usage)).toBe(250)
  expect(countTokenUsage('bad', { tokens: 1050, cachedTokens: 900 })).toEqual({ tokens: 0, cachedTokens: 0 })
})
