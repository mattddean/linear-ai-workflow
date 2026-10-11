import { BunServices } from '@effect/platform-bun'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Effect, Exit, Layer, Option, Scope } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Comment } from '../domain'

import { Agent } from '../agent'
import { DiscoverySettings } from '../config'
import { Coordinator } from '../coordinator'
import { Db } from '../db/live'
import { workflow_runs, workflow_assignments } from '../db/schema'
import { discoverTickets } from '../discovery'
import { Branch, CommentId, Path, error } from '../domain'
import { blocked } from '../handoff'
import { Linear } from '../linear.client'
import { Store } from '../store'
import { TestDatabaseLive } from '../test/db'
import { fixture, makeRun, ready, userId, settings } from '../test/fixtures'
import { TicketWorkflow, TicketWorkflowLive } from '../ticket.workflow'
import { pollRuns } from '../worker'
import { clientEngineLayer, ensureWorker, workerEngineLayer } from './workflow-engine'

// Verifies worker-group routing and durable workflow recovery against a disposable Postgres database.

test.each([
  { group: 'default', newThread: false },
  { group: 'local', newThread: false },
  { group: 'local', newThread: true },
] as const)(
  'cluster workflow %j preserves conversation identity across worker restart',
  async ({ group, newThread }) => {
    const db = TestDatabaseLive
    const f = fixture({ ...makeRun(), workerGroup: group })
    let shouldBlock = true
    const answer = 'Ready\nThe device is connected.'
    const replyThreads = new Map<CommentId, readonly Comment[]>()
    f.state.agentResult = (run) => {
      if (!shouldBlock && run.sequence === 2) expect(run.answer).toBe(group === 'local' ? answer : 'Ready')
      return shouldBlock && run.sequence === 1 ? blocked(run, 'Confirm test environment') : ready(run)
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
        expect(f.state.calls).toBe(2)
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
          if (waiting.threadCommentId === undefined) throw new Error('Expected persisted thread root')
          const earlierReply = { ...reply, id: CommentId.make(crypto.randomUUID()), createdAt: '2000-01-01T00:00:00Z' }
          replyThreads.set(waiting.threadCommentId, [earlierReply])
          yield* pollRuns(group).pipe(Effect.provide(clientContext), Effect.provide(storeContext))
          expect((yield* get).status).toBe('blocked')
          expect(waiting.threadCommentId).toBe(f.roots[1]?.id)
          expect(waiting.threadCommentId).not.toBe(waiting.predecessorId)
          if (waiting.threadCommentId === undefined) throw new Error('Expected persisted thread root')
          f.comments.push(reply)
          if (!newThread) replyThreads.set(waiting.threadCommentId, [earlierReply, reply])
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
          expect(f.acknowledgements[1]?.commentId).toBe(f.comments.find((comment) => comment.body === answer)?.id)
        expect(f.state.calls).toBe(5)
        expect(f.state.assignments[2]?.run.codexSessionId).toBe(newThread ? undefined : waiting.codexSessionId)
        expect(f.state.assignments[2]?.run.threadCommentId).toBe(
          newThread ? f.comments.find((comment) => comment.body === answer)?.id : waiting.threadCommentId,
        )
        expect(f.state.assignments[3]?.run.codexSessionId).toBeUndefined()
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
      Effect.provideService(DiscoverySettings, {
        repo: f.state.run.repo,
        base: Branch.make('main'),
      }),
      Effect.provideService(Linear, linear),
      Effect.provide(dependencies),
      Effect.timeout('30 seconds'),
    ),
  )
}, 45000)

for (const active of [true, false]) {
  test(`Linear cancellation stops a ${active ? 'running' : 'blocked'} cluster workflow and prevents resume`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linear-cancel-workflow-'))
    const f = fixture(makeRun(), { ...settings, artifactRoot: Path.make(dir) })
    let started = false
    let stopped = false
    const agent = Agent.of({
      execute: active
        ? () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  stopped = true
                }),
              )
              started = true
              return yield* Effect.never
            }).pipe(Effect.scoped)
        : f.agent.execute,
    })
    f.state.agentResult = (run) => blocked(run, 'Need an answer')
    const dependencies = Layer.merge(f.dependencies, Layer.succeed(Agent, agent)).pipe(
      Layer.provideMerge(Store.layer),
      Layer.provideMerge(TestDatabaseLive),
      Layer.provideMerge(BunServices.layer),
    )
    const worker = TicketWorkflowLive.pipe(
      Layer.provide(Coordinator.layer),
      Layer.provideMerge(workerEngineLayer({ group: 'local', host: '127.0.0.1', port: 35675 })),
      Layer.provideMerge(dependencies),
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.create(f.state.run)
          const context = yield* Layer.build(worker)
          yield* TicketWorkflow.execute({ id: f.state.run.id }, { discard: true }).pipe(Effect.provide(context))
          const get = store.get(f.state.run.id)
          for (;;) {
            if (active ? started : (yield* get).status === 'blocked') break
            yield* Effect.sleep('50 millis')
          }
          const posts = f.state.posts
          const poll = pollRuns('local').pipe(
            Effect.provide(context),
            Effect.provideService(Store, { ...store, list: get.pipe(Effect.map((run) => [run])) }),
          )
          f.state.canceled = true
          yield* poll
          for (;;) {
            if ((yield* get).status === 'canceled' && (!active || stopped)) break
            yield* Effect.sleep('50 millis')
            yield* poll
          }
          const calls = f.state.calls
          yield* store.control({ id: f.state.run.id, command: 'resume', answer: 'continue' })
          f.state.canceled = false
          yield* poll
          expect((yield* get).status).toBe('canceled')
          expect(f.state.posts).toBe(posts)
          expect(f.state.calls).toBe(calls)
          expect(active ? stopped : calls === 1).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(dependencies), Effect.timeout('20 seconds')),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30000)
}
