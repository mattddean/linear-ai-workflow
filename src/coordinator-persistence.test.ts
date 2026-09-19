import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'

import { Coordinator } from './coordinator'
import { Db } from './db/live'
import { workflow_runs, workflow_assignments } from './db/schema'
import { Store } from './store'
import { coordinatorLayer, fixture } from './test/fixtures'
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
      expect(journal?.body).toBe(f.acknowledgements[0]?.comment.body)
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
