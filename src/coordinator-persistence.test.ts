import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Effect, Layer } from 'effect'

import { Coordinator, CoordinatorLive } from './coordinator'
import { Db } from './db/live'
import { workflow_runs, workflow_assignments } from './db/schema'
import { Store } from './store'
import { TestStoreLive } from './test/db'
import { fixture } from './test/fixtures'

// Verifies coordinator replay and publication recovery against persisted run and journal rows, with external services faked.

function coordinatorLayer(f: ReturnType<typeof fixture>) {
  return CoordinatorLive.pipe(Layer.provideMerge(f.dependencies), Layer.provideMerge(TestStoreLive))
}

const execute = (f: ReturnType<typeof fixture>) =>
  Effect.flatMap(Coordinator, (coordinator) => coordinator.step({ id: f.state.run.id, sequence: 0 })).pipe(
    Effect.provide(coordinatorLayer(f)),
  )

test('replay after rebuilding the coordinator reads its committed journal without repeating external work', async () => {
  const f = fixture()
  await Effect.runPromise(
    Effect.flatMap(Store, (store) => store.create(f.state.run)).pipe(Effect.provide(TestStoreLive)),
  )
  expect(await Effect.runPromise(execute(f))).toBe('continue')
  expect(await Effect.runPromise(execute(f))).toBe('continue')
  expect(f.state.calls).toBe(1)
  expect(f.state.posts).toBe(1)
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Db
      const [run] = yield* db.select().from(workflow_runs).where(eq(workflow_runs.id, f.state.run.id))
      const journals = yield* db
        .select()
        .from(workflow_assignments)
        .where(eq(workflow_assignments.run_id, f.state.run.id))
      expect(run?.data).toMatchObject({
        sequence: 1,
        phase: 'implementation',
        refinement_comment_id: f.comments[0]?.id,
      })
      expect(journals).toHaveLength(1)
      expect(journals[0]?.data).toMatchObject({ state: 'done', comment_id: f.comments[0]?.id, step_result: 'continue' })
      const store = yield* Store
      yield* store.save({ ...(yield* store.get(f.state.run.id)), status: 'approved' })
    }).pipe(Effect.provide(TestStoreLive)),
  )
})

test('ambiguous publication leaves a prepared outbox that a rebuilt coordinator reconciles', async () => {
  const f = fixture()
  f.state.ambiguous = true
  await Effect.runPromise(
    Effect.flatMap(Store, (store) => store.create(f.state.run)).pipe(Effect.provide(TestStoreLive)),
  )
  const failure = await Effect.runPromise(execute(f).pipe(Effect.exit))
  expect(failure._tag).toBe('Failure')
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Db
      const [journal] = yield* db
        .select()
        .from(workflow_assignments)
        .where(eq(workflow_assignments.run_id, f.state.run.id))
      const [run] = yield* db.select().from(workflow_runs).where(eq(workflow_runs.id, f.state.run.id))
      expect(journal?.data).toMatchObject({ state: 'prepared', body: f.comments[0]?.body, comment_id: null })
      expect(run?.data.sequence).toBe(0)
    }).pipe(Effect.provide(TestStoreLive)),
  )
  expect(await Effect.runPromise(execute(f))).toBe('continue')
  expect(f.state.calls).toBe(1)
  expect(f.state.posts).toBe(1)
  await Effect.runPromise(
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
    }).pipe(Effect.provide(TestStoreLive)),
  )
})
