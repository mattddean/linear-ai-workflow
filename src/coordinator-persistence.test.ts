import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Effect, Layer } from 'effect'

import { Coordinator } from './coordinator'
import { Db } from './db/live'
import { workflow_runs, workflow_assignments } from './db/schema'
import { CommentId, error } from './domain'
import { Linear } from './linear.client'
import { Store } from './store'
import { coordinatorLayer, fixture, userId } from './test/fixtures'
import { testRuntime } from './test/runtime/root'

// Verifies coordinator replay and publication recovery against persisted run and journal rows, with external services faked.

const execute = (f: ReturnType<typeof fixture>) =>
  Effect.flatMap(Coordinator, (coordinator) => coordinator.step({ id: f.state.run.id, sequence: 0 })).pipe(
    Effect.provide(coordinatorLayer(f)),
  )

test('concurrent coordinators share persistence without sharing fake failures or comments', async () => {
  const ambiguous = fixture()
  const normal = fixture()
  ambiguous.state.ambiguous = true
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      yield* store.create(ambiguous.state.run)
      yield* store.create(normal.state.run)
    }),
  )

  const [failed, succeeded] = await Promise.all([
    testRuntime.runPromise(execute(ambiguous).pipe(Effect.exit)),
    testRuntime.runPromise(execute(normal)),
  ])
  expect(failed._tag).toBe('Failure')
  expect(succeeded).toBe('continue')
  expect(ambiguous.state.calls).toBe(1)
  expect(normal.state.calls).toBe(1)
  expect(ambiguous.comments).toHaveLength(1)
  expect(normal.comments).toHaveLength(1)
  expect(ambiguous.comments[0]?.id).not.toBe(normal.comments[0]?.id)

  await testRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      expect((yield* store.get(ambiguous.state.run.id)).sequence).toBe(0)
      expect((yield* store.get(normal.state.run.id)).sequence).toBe(1)
    }),
  )
  expect(await testRuntime.runPromise(execute(ambiguous))).toBe('continue')
  expect(ambiguous.state.calls).toBe(1)
  expect(normal.state.calls).toBe(1)
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      for (const f of [ambiguous, normal]) {
        yield* store.save({ ...(yield* store.get(f.state.run.id)), status: 'approved' })
      }
    }),
  )
})

test('replay after rebuilding the coordinator reads its committed journal without repeating external work', async () => {
  const f = fixture()
  f.state.cachedTokensPerAssignment = 60
  await testRuntime.runPromise(Effect.flatMap(Store, (store) => store.create(f.state.run)))
  expect(await testRuntime.runPromise(execute(f))).toBe('continue')
  expect(await testRuntime.runPromise(execute(f))).toBe('continue')
  expect(f.state.calls).toBe(1)
  expect(f.state.posts).toBe(1)
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db
      const [run] = yield* db.select().from(workflow_runs).where(eq(workflow_runs.id, f.state.run.id))
      const journals = yield* db
        .select()
        .from(workflow_assignments)
        .where(eq(workflow_assignments.run_id, f.state.run.id))
      expect(run?.data).toMatchObject({
        sequence: 1,
        tokens: 100,
        cached_tokens: 60,
        phase: 'implementation',
        refinement_comment_id: f.comments[0]?.id,
      })
      expect(journals).toHaveLength(1)
      expect(journals[0]?.data).toMatchObject({
        state: 'done',
        tokens: 100,
        cached_tokens: 60,
        comment_id: f.comments[0]?.id,
        step_result: 'continue',
      })
      const store = yield* Store
      yield* store.save({ ...(yield* store.get(f.state.run.id)), status: 'approved' })
    }),
  )
})

test('ambiguous publication leaves a prepared outbox that a rebuilt coordinator reconciles', async () => {
  const f = fixture()
  f.state.ambiguous = true
  await testRuntime.runPromise(Effect.flatMap(Store, (store) => store.create(f.state.run)))
  const failure = await testRuntime.runPromise(execute(f).pipe(Effect.exit))
  expect(failure._tag).toBe('Failure')
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db
      const [journal] = yield* db
        .select()
        .from(workflow_assignments)
        .where(eq(workflow_assignments.run_id, f.state.run.id))
      const [run] = yield* db.select().from(workflow_runs).where(eq(workflow_runs.id, f.state.run.id))
      expect(journal?.data).toMatchObject({ state: 'prepared', body: f.comments[0]?.body, comment_id: null })
      expect(run?.data.sequence).toBe(0)
    }),
  )
  expect(await testRuntime.runPromise(execute(f))).toBe('continue')
  expect(f.state.calls).toBe(1)
  expect(f.state.posts).toBe(1)
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db
      const [journal] = yield* db
        .select()
        .from(workflow_assignments)
        .where(eq(workflow_assignments.run_id, f.state.run.id))
      expect(journal?.data).toMatchObject({ state: 'done', body: f.comments[0]?.body, comment_id: f.comments[0]?.id })
      const store = yield* Store
      const run = yield* store.get(f.state.run.id)
      expect(run.sequence).toBe(1)
      yield* store.save({ ...run, status: 'approved' })
    }),
  )
})

test('persisted acknowledgement intent survives a restart after an ambiguous Linear write', async () => {
  const f = fixture()
  f.state.ambiguousAcknowledgement = true
  await testRuntime.runPromise(Effect.flatMap(Store, (store) => store.create(f.state.run)))
  expect((await testRuntime.runPromise(execute(f).pipe(Effect.exit)))._tag).toBe('Failure')
  expect(f.state.calls).toBe(0)
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      const journal = yield* store.journal(f.state.run)
      expect(journal?.state).toBe('acknowledging')
      expect(journal?.assignment.run.issueId).toBe(f.acknowledgements[0]?.issueId)
    }),
  )
  expect(await testRuntime.runPromise(execute(f))).toBe('continue')
  expect(f.acknowledgements).toHaveLength(1)
  expect(f.state.calls).toBe(1)
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      yield* store.save({ ...(yield* store.get(f.state.run.id)), status: 'approved' })
    }),
  )
})

test('prepared Developer result and pending progress survive rebuilding the coordinator', async () => {
  const f = fixture()
  const refinement = CommentId.make(crypto.randomUUID())
  f.state.run = { ...f.state.run, phase: 'implementation', refinementCommentId: refinement, predecessorId: refinement }
  f.comments.push({ id: refinement, body: 'PM refinement', createdAt: new Date().toISOString(), user: { id: userId } })
  let ambiguous = true
  const linear = Linear.of({
    ...f.linear,
    post: (input) =>
      f.linear
        .post(input)
        .pipe(
          Effect.flatMap((comment) =>
            ambiguous && input.eventMarker.includes('/progress/')
              ? Effect.fail(error('transport', 'Progress acknowledgement was lost'))
              : Effect.succeed(comment),
          ),
        ),
  })
  const layer = Coordinator.layer.pipe(Layer.provide(Layer.merge(f.dependencies, Layer.succeed(Linear, linear))))
  const step = () =>
    Effect.flatMap(Coordinator, (coordinator) => coordinator.step({ id: f.state.run.id, sequence: 0 })).pipe(
      Effect.provide(layer),
    )
  await testRuntime.runPromise(Effect.flatMap(Store, (store) => store.create(f.state.run)))
  expect((await testRuntime.runPromise(step().pipe(Effect.exit)))._tag).toBe('Failure')
  expect(f.state.calls).toBe(1)
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db
      const [row] = yield* db.select().from(workflow_assignments).where(eq(workflow_assignments.run_id, f.state.run.id))
      expect(row?.data.state).toBe('prepared')
      expect(row?.data.result?.outcome).toBe('ready')
      expect(row?.data.progress_comments?.[0]?.comment_id).toBeNull()
      expect(row?.data.progress_comments?.[0]?.body).toContain(f.state.run.workspace)
    }),
  )
  ambiguous = false
  expect(await testRuntime.runPromise(step())).toBe('continue')
  expect(f.state.calls).toBe(1)
  expect(f.progressComments).toHaveLength(1)
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      const journal = yield* store.journal(f.state.run)
      expect(journal?.state).toBe('done')
      expect(journal?.progressComments?.[0]?.commentId).toBe(f.progressComments[0]?.id)
      const run = yield* store.get(f.state.run.id)
      expect(run.phase).toBe('verification')
      yield* store.save({ ...run, status: 'approved' })
    }),
  )
})
