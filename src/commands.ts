import { Args, Command, Options } from '@effect/cli'
import { BunContext, BunRuntime } from '@effect/platform-bun'
import { PgClient } from '@effect/sql-pg'
import { Config, Console, Effect, Layer, Schema } from 'effect'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { Run } from './domain'

import { AgentLive, recoverAgentLease } from './agent'
import { Settings, SettingsLive } from './config'
import { CoordinatorLive } from './coordinator'
import { Branch, IssueKey, Path, RunId, error, fingerprint } from './domain'
import { Linear, LinearLive } from './linear'
import { Store, StoreLive, initializeStore } from './store'
import { TicketWorkflow, TicketWorkflowLive } from './ticket-workflow'
import { acquireWorkerLock, ensureOwner, pollingLayer } from './worker'
import { clientEngineLayer, ensureWorker, workerEngineLayer, workerGroups } from './workflow-engine'
import { Workspace, WorkspaceLive } from './workspace'

const DatabaseLive = PgClient.layerConfig({ url: Config.redacted('DATABASE_URL') })
const StoreDatabaseLive = StoreLive.pipe(Layer.provideMerge(DatabaseLive))
const ServicesLive = Layer.mergeAll(StoreLive, WorkspaceLive, LinearLive, AgentLive).pipe(
  Layer.provideMerge(SettingsLive),
  Layer.provideMerge(DatabaseLive),
)
const workerOption = Options.choice('worker', workerGroups).pipe(
  Options.withDefault('local'),
  Options.withDescription('Workflow shard group; local targets the local worker'),
)
const idArgument = Args.text({ name: 'run-id' })
const positive = (value: number) => Number.isSafeInteger(value) && value > 0

const serve = Command.make('serve', { worker: workerOption }, ({ worker }) =>
  Effect.gen(function* () {
    yield* initializeStore()
    const settings = yield* Settings
    yield* Effect.tryPromise(() => mkdir(settings.artifactRoot, { recursive: true }))
    const heartbeat = yield* acquireWorkerLock(worker)
    const services = Layer.merge(TicketWorkflowLive, pollingLayer(worker)).pipe(
      Layer.provide(CoordinatorLive),
      Layer.provide(workerEngineLayer({ group: worker, host: settings.runnerHost, port: settings.runnerPort })),
    )
    yield* Console.log(`Serving ${worker} on ${settings.runnerHost}:${settings.runnerPort}; model gpt-6-astra`)
    yield* Layer.launch(services).pipe(Effect.raceFirst(heartbeat))
  }).pipe(Effect.scoped, Effect.provide(ServicesLive)),
)

const start = Command.make(
  'start',
  {
    issue: Args.text({ name: 'issue' }),
    repo: Options.directory('repo'),
    base: Options.text('base'),
    worker: workerOption,
    maxAttempts: Options.integer('max-attempts').pipe(Options.withDefault(3)),
    maxTokens: Options.integer('max-tokens').pipe(Options.withDefault(1000000)),
    maxMinutes: Options.integer('max-minutes').pipe(Options.withDefault(120)),
  },
  (input) =>
    Effect.gen(function* () {
      if (![input.maxAttempts, input.maxTokens, input.maxMinutes].every(positive))
        return yield* error('configuration', 'Run limits must be positive integers')
      yield* initializeStore()
      const issueKey = yield* Schema.decodeUnknown(IssueKey)(input.issue)
      const workspace = yield* Workspace
      const linear = yield* Linear
      const store = yield* Store
      const settings = yield* Settings
      const base = yield* workspace.inspectBase({ repo: Path.make(resolve(input.repo)), base: Branch.make(input.base) })
      const snapshot = yield* linear.read(issueKey)
      yield* ensureWorker(input.worker).pipe(Effect.provide(clientEngineLayer(input.worker)))
      yield* ensureOwner(input.worker)
      const id = RunId.make(crypto.randomUUID())
      const run: Run = {
        id,
        workerGroup: input.worker,
        workerId: settings.workerId,
        issueId: snapshot.issue.id,
        issueKey: snapshot.issue.identifier,
        repo: base.repo,
        baseSha: base.baseSha,
        branch: Branch.make(`codex/${issueKey.toLowerCase()}-${id}`),
        worktree: Path.make(resolve(settings.worktreeRoot, id)),
        commitSha: null,
        refinementCommentId: null,
        predecessorId: null,
        phase: 'refinement',
        status: 'queued',
        sequence: 0,
        attempts: 0,
        tokens: 0,
        maxAttempts: input.maxAttempts,
        maxTokens: input.maxTokens,
        maxMinutes: input.maxMinutes,
        activeMillis: 0,
        note: '',
        question: null,
        waitSequence: null,
        answer: null,
        issueFingerprint: fingerprint(snapshot),
        updatedAt: new Date().toISOString(),
      }
      yield* store.create(run)
      yield* TicketWorkflow.execute({ id }, { discard: true }).pipe(Effect.provide(clientEngineLayer(input.worker)))
      yield* Console.log(
        `Enrolled ${issueKey}: ${id}\nWorker: ${input.worker} (${settings.workerId})\nWorktree: ${run.worktree}`,
      )
    }).pipe(Effect.scoped, Effect.provide(ServicesLive)),
)

const status = Command.make('status', { id: idArgument }, ({ id }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* store.get(yield* Schema.decodeUnknown(RunId)(id))
    yield* Console.log(JSON.stringify(run, null, 2))
  }).pipe(Effect.provide(StoreDatabaseLive)),
)
const list = Command.make('list', {}, () =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* Console.log(JSON.stringify(yield* store.list, null, 2))
  }).pipe(Effect.provide(StoreDatabaseLive)),
)
const pause = Command.make('pause', { id: idArgument }, ({ id }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* store.get(yield* Schema.decodeUnknown(RunId)(id))
    if (run.status === 'approved') return yield* error('invalid', 'Approved runs are complete')
    yield* store.control({ id: run.id, command: 'pause', answer: null })
    yield* Console.log('Pause requested. The worker will stop the active assignment and preserve its work.')
  }).pipe(Effect.provide(StoreDatabaseLive)),
)
const resume = Command.make(
  'resume',
  {
    id: idArgument,
    answer: Options.text('answer').pipe(Options.withDefault('')),
    extraTokens: Options.integer('extra-tokens').pipe(Options.withDefault(0)),
    extraMinutes: Options.integer('extra-minutes').pipe(Options.withDefault(0)),
    extraAttempts: Options.integer('extra-attempts').pipe(Options.withDefault(0)),
    acceptHead: Options.boolean('accept-head'),
  },
  (input) =>
    Effect.gen(function* () {
      const store = yield* Store
      const workspace = yield* Workspace
      const settings = yield* Settings
      const run = yield* store.get(yield* Schema.decodeUnknown(RunId)(input.id))
      if (run.workerId !== settings.workerId)
        return yield* error('blocked', `Resume on the owning machine (${run.workerId})`)
      if (run.status !== 'blocked' && run.status !== 'paused')
        return yield* error('invalid', 'Only blocked or paused runs can resume')
      if (![input.extraTokens, input.extraMinutes, input.extraAttempts].every((n) => Number.isSafeInteger(n) && n >= 0))
        return yield* error('invalid', 'Budget extensions must be non-negative integers')
      yield* recoverAgentLease()
      yield* workspace.prepare(run)
      const head = yield* workspace.inspect(run)
      if (run.commitSha !== null && head !== run.commitSha && !input.acceptHead)
        return yield* error(
          'blocked',
          'HEAD changed. Inspect it, then use --accept-head to restart implementation from this revision.',
        )
      yield* store.save({
        ...run,
        commitSha: input.acceptHead ? head : run.commitSha,
        phase: input.acceptHead && run.refinementCommentId !== null ? 'implementation' : run.phase,
        maxTokens: run.maxTokens + input.extraTokens,
        maxMinutes: run.maxMinutes + input.extraMinutes,
        maxAttempts: run.maxAttempts + input.extraAttempts,
      })
      yield* store.control({ id: run.id, command: 'resume', answer: input.answer || null })
      yield* Console.log('Resume requested; the worker will reconcile the pending handoff before continuing.')
    }).pipe(Effect.provide(ServicesLive)),
)

const command = Command.make('linear-ai-workflow').pipe(
  Command.withSubcommands([serve, start, status, list, pause, resume]),
)
Command.run(command, { name: 'Linear AI Workflow', version: '0.1.0' })(process.argv).pipe(
  Effect.provide(BunContext.layer),
  Effect.tapErrorCause(Effect.logError),
  BunRuntime.runMain,
)
