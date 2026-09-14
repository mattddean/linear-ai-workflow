import { BunContext } from '@effect/platform-bun'
import { PgClient } from '@effect/sql-pg'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Effect, Exit, Layer, Redacted, Scope } from 'effect'

import { CoordinatorLive } from '../src/coordinator'
import { blocked } from '../src/domain'
import { Store, StoreLive, initializeStore } from '../src/store'
import { TicketWorkflow, TicketWorkflowLive } from '../src/ticket-workflow'
import { pollRuns } from '../src/worker'
import { clientEngineLayer, ensureWorker, workerEngineLayer, workerGroups } from '../src/workflow-engine'
import { fixture, makeRun, ready } from '../test/fixtures'

let container: StartedPostgreSqlContainer | undefined
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start()
}, 120000)
afterAll(async () => {
  await container?.stop()
}, 30000)

function database() {
  if (!container) throw new Error('Disposable test database was not started')
  return PgClient.layer({ url: Redacted.make(container.getConnectionUri()) })
}

test('Postgres journal survives a store restart and enforces one active enrollment per issue', async () => {
  const db = database()
  const run = makeRun()
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* initializeStore()
      const store = yield* Store
      yield* store.create(run)
      const duplicate = yield* store.create({ ...run, id: makeRun().id }).pipe(Effect.exit)
      expect(duplicate._tag).toBe('Failure')
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(db)))),
  )
  const loaded = await Effect.runPromise(
    Effect.flatMap(Store, (store) => store.get(run.id)).pipe(Effect.provide(StoreLive.pipe(Layer.provide(db)))),
  )
  expect(loaded).toEqual(run)
  await Effect.runPromise(
    Effect.flatMap(Store, (store) => store.save({ ...run, status: 'approved' })).pipe(
      Effect.provide(StoreLive.pipe(Layer.provide(db))),
    ),
  )
}, 15000)

test.each([...workerGroups])(
  'cluster client routes %s workflow; durable wait survives worker restart',
  async (group) => {
    const db = database()
    const f = fixture({ ...makeRun(), workerGroup: group })
    let shouldBlock = true
    f.state.agentResult = (run) => (shouldBlock ? blocked(run, 'Confirm test environment') : ready(run))
    const dependencies = f.dependencies.pipe(
      Layer.provideMerge(StoreLive),
      Layer.provideMerge(db),
      Layer.provideMerge(BunContext.layer),
    )
    const port = 35671
    const worker = TicketWorkflowLive.pipe(
      Layer.provide(CoordinatorLive),
      Layer.provideMerge(workerEngineLayer({ group, host: '127.0.0.1', port })),
      Layer.provideMerge(dependencies),
    )
    const client = clientEngineLayer(group).pipe(Layer.provide(db), Layer.provide(BunContext.layer))
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* initializeStore().pipe(Effect.provide(db))
        yield* Effect.flatMap(Store, (store) => store.create(f.state.run)).pipe(Effect.provide(dependencies))
        const scope1 = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        yield* Layer.buildWithScope(worker, scope1)
        const clientContext = yield* Layer.build(client)
        yield* ensureWorker(group).pipe(Effect.provide(clientContext), Effect.retry({ times: 20 }))
        const executionId = yield* TicketWorkflow.execute({ id: f.state.run.id }, { discard: true }).pipe(
          Effect.provide(clientContext),
        )
        const storeContext = yield* Layer.build(dependencies)
        const get = Effect.flatMap(Store, (store) => store.get(f.state.run.id)).pipe(Effect.provide(storeContext))
        for (;;) {
          const run = yield* get
          if (run.status === 'blocked') break
          yield* Effect.sleep('100 millis')
        }
        expect(f.state.calls).toBe(1)
        yield* Scope.close(scope1, Exit.void)
        shouldBlock = false
        const waiting = yield* get
        yield* Effect.flatMap(Store, (store) =>
          store.control({ id: waiting.id, command: 'resume', answer: 'Ready' }),
        ).pipe(Effect.provide(storeContext))
        const scope2 = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        yield* Layer.buildWithScope(worker, scope2)
        yield* pollRuns(group).pipe(Effect.provide(clientContext), Effect.provide(storeContext))
        for (;;) {
          const run = yield* get
          if (run.status === 'approved') break
          yield* Effect.sleep('100 millis')
        }
        expect(f.state.calls).toBe(5)
        expect(f.state.posts).toBe(5)
        for (;;) {
          const result = yield* TicketWorkflow.poll(executionId).pipe(Effect.provide(clientContext))
          if (result?._tag === 'Complete') break
          yield* Effect.sleep('100 millis')
        }
        yield* Scope.close(scope2, Exit.void)
      }).pipe(Effect.scoped, Effect.timeout('45 seconds')),
    )
  },
  60000,
)

test('serve CLI starts the cluster and shuts down cleanly against disposable Postgres', async () => {
  if (!container) throw new Error('Expected test container')
  const databaseUrl = container.getConnectionUri()
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  await Effect.runPromise(
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), 'linear-cli-test-'))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      )
      const log = join(dir, 'worker.log')
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn([process.execPath, 'src/commands.ts', 'serve', '--worker', 'local'], {
            cwd: import.meta.dir + '/..',
            stdout: Bun.file(log),
            stderr: Bun.file(join(dir, 'stderr.log')),
            env: {
              ...process.env,
              DATABASE_URL: databaseUrl,
              LINEAR_API_KEY: 'test-only',
              LINEAR_TEAM_ID: '00000000-0000-4000-8000-000000000001',
              WORKER_ID: 'test-machine',
              WORKFLOW_RUNNER_HOST: '127.0.0.1',
              WORKFLOW_RUNNER_PORT: '35672',
              ARTIFACT_ROOT: dir,
              WORKTREE_ROOT: join(dir, 'worktrees'),
            },
          }),
        ),
        (child) =>
          Effect.promise(async () => {
            child.kill('SIGINT')
            await child.exited
          }),
      )
      for (;;) {
        const output = yield* Effect.promise(() => Bun.file(log).text())
        if (output.includes('Listening on:')) break
        if (child.exitCode !== null) throw new Error(`Worker exited before becoming ready: ${child.exitCode}`)
        yield* Effect.sleep('50 millis')
      }
      child.kill('SIGINT')
      yield* Effect.promise(() => child.exited)
      expect(yield* Effect.promise(() => Bun.file(log).text())).toContain('Serving local')
    }).pipe(Effect.scoped, Effect.timeout('15 seconds')),
  )
}, 20000)
