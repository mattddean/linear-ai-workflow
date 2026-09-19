import { BunServices } from '@effect/platform-bun'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Effect, Exit, Layer, Option, Scope } from 'effect'

import type { Comment } from '../domain'

import { DiscoverySettings } from '../config'
import { Coordinator } from '../coordinator'
import { Db } from '../db/live'
import { workflow_runs, workflow_assignments } from '../db/schema'
import { discoverTickets } from '../discovery'
import { Branch, CommentId, error } from '../domain'
import { blocked } from '../handoff'
import { Linear } from '../linear.client'
import { Store } from '../store'
import { TestDatabaseLive } from '../test/db'
import { fixture, makeRun, ready, userId } from '../test/fixtures'
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
    const answer = 'Ready\nThe device is connected.'
    const replyThreads = new Map<CommentId, readonly Comment[]>()
    f.state.agentResult = (run) => {
      if (!shouldBlock && run.sequence === 1) expect(run.answer).toBe(group === 'local' ? answer : 'Ready')
      return shouldBlock ? blocked(run, 'Confirm test environment') : ready(run)
    }
    const linear = Linear.of({
      ...f.linear,
      replies: (input) =>
        Effect.sync(() => {
          expect(input.issueId).toBe(f.state.run.issueId)
          return replyThreads.get(input.commentId) ?? []
        }),
    })
    const dependencies = Layer.merge(f.dependencies, Layer.succeed(Linear, linear)).pipe(
      Layer.provideMerge(Store.layer),
      Layer.provideMerge(db),
      Layer.provideMerge(BunServices.layer),
    )
    const port = 35671
    const worker = TicketWorkflowLive.pipe(
      Layer.provide(Coordinator.layer),
      Layer.provideMerge(workerEngineLayer({ group, host: '127.0.0.1', port })),
      Layer.provideMerge(dependencies),
    )
    const client = clientEngineLayer(group).pipe(Layer.provide(db), Layer.provide(BunServices.layer))
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
        if (group === 'local') {
          if (waiting.predecessorId === null) throw new Error('Expected a blocker comment')
          const reply = {
            id: CommentId.make(crypto.randomUUID()),
            body: answer,
            createdAt: new Date().toISOString(),
            user: { id: userId },
          }
          // A standalone ticket comment cannot wake the blocked workflow.
          f.comments.push(reply)
          yield* pollRuns(group).pipe(Effect.provide(clientContext), Effect.provide(storeContext))
          expect((yield* get).status).toBe('blocked')
          replyThreads.set(waiting.predecessorId, [reply])
        } else {
          yield* Effect.flatMap(Store, (store) =>
            store.control({ id: waiting.id, command: 'resume', answer: 'Ready' }),
          ).pipe(Effect.provide(storeContext))
        }
        const scope2 = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        yield* Layer.buildWithScope(worker, scope2)
        yield* pollRuns(group).pipe(Effect.provide(clientContext), Effect.provide(storeContext))
        for (;;) {
          const run = yield* get
          if (run.status === 'approved') break
          yield* Effect.sleep('100 millis')
        }
        expect(f.acknowledgements).toHaveLength(group === 'local' ? 2 : 1)
        if (group === 'local')
          expect(f.acknowledgements[1]?.parentId).toBe(f.comments.find((comment) => comment.body === answer)?.id)
        expect(f.state.calls).toBe(5)
        expect(f.state.posts).toBe(5)
        for (;;) {
          const result = yield* TicketWorkflow.poll(executionId).pipe(Effect.provide(clientContext))
          if (Option.isSome(result) && result.value._tag === 'Complete') break
          yield* Effect.sleep('100 millis')
        }
        yield* Scope.close(scope2, Exit.void)
      }).pipe(Effect.scoped, Effect.timeout('45 seconds')),
    )
  },
  60000,
)

test('discovered ticket runs PM to developer to QA to PM despite another ticket poll failing', async () => {
  const f = fixture()
  const inaccessible = {
    ...makeRun(),
    status: 'blocked' as const,
    waitSequence: 0,
    predecessorId: f.state.run.predecessorId,
  }
  // A published blocker makes the worker read Linear while checking for a human answer.
  const stranded = {
    ...inaccessible,
    predecessorId: CommentId.make(crypto.randomUUID()),
    updatedAt: '2000-01-01T00:00:00Z',
  }
  const dependencies = f.dependencies.pipe(
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(TestDatabaseLive),
    Layer.provideMerge(BunServices.layer),
  )
  const linear = Linear.of({
    ...f.linear,
    read: (id) => (id === stranded.issueId ? Effect.fail(error('linear', 'Issue inaccessible')) : f.linear.read(id)),
  })
  const worker = TicketWorkflowLive.pipe(
    Layer.provide(Coordinator.layer),
    Layer.provideMerge(workerEngineLayer({ group: 'local', host: '127.0.0.1', port: 35673 })),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      const db = yield* Db
      yield* store.create(stranded)
      yield* discoverTickets()
      const queued = (yield* store.list).find((run) => run.issueId === f.state.run.issueId)
      if (!queued) throw new Error('Expected discovery to enqueue a run')
      expect(queued.status).toBe('queued')
      const context = yield* Layer.build(worker)
      yield* pollRuns('local').pipe(Effect.provide(context))
      for (;;) {
        const run = yield* store.get(queued.id)
        if (run.status === 'approved') break
        yield* Effect.sleep('100 millis')
      }
      const [row] = yield* db.select().from(workflow_runs).where(eq(workflow_runs.id, queued.id))
      const assignments = yield* db
        .select()
        .from(workflow_assignments)
        .where(eq(workflow_assignments.run_id, queued.id))
        .orderBy(workflow_assignments.sequence)
      expect(row?.data.status).toBe('approved')
      expect(row?.data.commit_sha).toBe(f.state.run.baseSha)
      expect(assignments.map((assignment) => assignment.data.assignment.run.phase)).toEqual([
        'refinement',
        'implementation',
        'verification',
        'acceptance',
      ])
      expect(
        assignments.every((assignment) => assignment.data.state === 'done' && assignment.data.comment_id !== null),
      ).toBe(true)
      expect(f.state.calls).toBe(4)
      expect(f.state.posts).toBe(4)
      yield* discoverTickets()
      expect((yield* store.list).filter((run) => run.issueId === f.state.run.issueId)).toHaveLength(1)
      yield* store.save({ ...stranded, status: 'approved' })
    }).pipe(
      Effect.scoped,
      Effect.provideService(DiscoverySettings, { repo: f.state.run.repo, base: Branch.make('main') }),
      Effect.provideService(Linear, linear),
      Effect.provide(dependencies),
      Effect.timeout('30 seconds'),
    ),
  )
}, 45000)
