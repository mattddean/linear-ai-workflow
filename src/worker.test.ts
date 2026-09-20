import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Effect, Exit, Layer, Scope } from 'effect'
import { WorkflowEngine } from 'effect/unstable/workflow'

import { Settings } from './config'
import { Db } from './db/live'
import { workflow_worker_owners } from './db/schema'
import { WorkerId } from './domain'
import { Store } from './store'
import { TestDatabaseLive } from './test/db'
import { fixture, makeRun, settings } from './test/fixtures'
import { TicketWorkflow } from './ticket.workflow'
import { acquireWorkerLock, ensureOwner, pollingLayer } from './worker'

// Verifies worker ownership and advisory-lock exclusion through competing real Postgres sessions.

test('worker ownership is persisted and a competing session cannot hold the same group lock', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ownerScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      yield* acquireWorkerLock('local').pipe(Scope.provide(ownerScope))
      const db = yield* Db
      const owners = yield* db
        .select()
        .from(workflow_worker_owners)
        .where(eq(workflow_worker_owners.worker_group, 'local'))
      expect(owners).toEqual([{ worker_group: 'local', worker_id: settings.workerId }])
      yield* ensureOwner('local')
      const wrongOwner = yield* ensureOwner('local').pipe(
        Effect.provideService(Settings, { ...settings, workerId: WorkerId.make('another-machine') }),
        Effect.exit,
      )
      expect(wrongOwner._tag).toBe('Failure')
      // Each reserve uses a different session, so PostgreSQL itself arbitrates the competing claim.
      const competing = yield* acquireWorkerLock('local').pipe(Effect.scoped, Effect.exit)
      expect(competing._tag).toBe('Failure')
      yield* Scope.close(ownerScope, Exit.void)
      yield* acquireWorkerLock('local').pipe(Effect.scoped)
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(TestDatabaseLive, Layer.succeed(Settings, settings))),
      Effect.timeout('5 seconds'),
    ),
  )
})

test('polling survives storage and per-ticket defects and keeps visiting later tickets', async () => {
  const f = fixture()
  const older = makeRun()
  let reads = 0
  const attempts: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine
      const laterId = yield* TicketWorkflow.executionId({ id: f.state.run.id })
      yield* Layer.build(pollingLayer('local')).pipe(
        Effect.provideService(Store, {
          ...f.store,
          list: Effect.suspend(() => {
            reads += 1
            return reads === 1 ? Effect.die('Storage defect') : Effect.succeed([older, f.state.run])
          }),
        }),
        Effect.provideService(WorkflowEngine.WorkflowEngine, {
          ...engine,
          execute: (_workflow, options) =>
            Effect.sync(() => attempts.push(options.executionId)).pipe(
              Effect.andThen(Effect.die('Expected array at ["value"]["exit"]["cause"]')),
            ),
        }),
      )
      for (;;) {
        if (attempts.filter((id) => id === laterId).length >= 2) break
        yield* Effect.sleep('50 millis')
      }
      expect(attempts).toEqual([
        yield* TicketWorkflow.executionId({ id: older.id }),
        laterId,
        yield* TicketWorkflow.executionId({ id: older.id }),
        laterId,
      ])
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkflowEngine.layerMemory),
      Effect.provide(f.dependencies),
      Effect.provide(TestDatabaseLive),
      Effect.timeout('5 seconds'),
    ),
  )
}, 10000)
