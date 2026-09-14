import { BunContext } from '@effect/platform-bun'
import { expect, test } from 'bun:test'
import { Effect, Exit, Layer, Scope } from 'effect'

import { CoordinatorLive } from '../coordinator'
import { blocked } from '../handoff'
import { Store, StoreLive } from '../store'
import { TestDatabaseLive } from '../test/db'
import { fixture, makeRun, ready } from '../test/fixtures'
import { TicketWorkflow, TicketWorkflowLive } from '../ticket.workflow'
import { pollRuns } from '../worker'
import { clientEngineLayer, ensureWorker, workerEngineLayer, workerGroups } from './workflow-engine'

// Verifies worker-group routing and durable workflow recovery against a disposable Postgres database.

test.each([...workerGroups])(
  'cluster client routes %s workflow; durable wait survives worker restart',
  async (group) => {
    const db = TestDatabaseLive
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
