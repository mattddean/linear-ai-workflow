import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Effect, Layer } from 'effect'

import type { Journal } from './domain'

import { Db } from './db/live'
import { workflow_runs, workflow_assignments } from './db/schema'
import { Store, controls } from './store'
import { TestDatabaseLive, TestStoreLive } from './test/db'
import { fixture, makeRun, ready } from './test/fixtures'

// Verifies the production store’s constraints, transactions, and control flags by reading real persisted rows.

test('Postgres run survives a store restart and enforces one active enrollment per issue', async () => {
  const db = TestDatabaseLive
  const run = makeRun()
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      yield* store.create(run)
      const duplicate = yield* store.create({ ...run, id: makeRun().id }).pipe(Effect.exit)
      expect(duplicate._tag).toBe('Failure')
    }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(db)))),
  )
  const loaded = await Effect.runPromise(
    Effect.flatMap(Store, (store) => store.get(run.id)).pipe(Effect.provide(Store.layer.pipe(Layer.provide(db)))),
  )
  expect(loaded).toEqual(run)
  await Effect.runPromise(
    Effect.flatMap(Store, (store) => store.save({ ...run, status: 'approved' })).pipe(
      Effect.provide(Store.layer.pipe(Layer.provide(db))),
    ),
  )
}, 15000)

test('handoff transaction rolls back its journal when the run update conflicts', async () => {
  const run = makeRun()
  const replacement = { ...makeRun(), issueId: run.issueId }
  const journal: Journal = {
    assignment: { run, snapshot: fixture(run).state.snapshot, artifactDir: run.workspace },
    state: 'done',
    agentStarted: false,
    result: ready(run),
    commentId: null,
    body: null,
    tokens: 0,
    elapsedMillis: 0,
    stepResult: 'continue',
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      yield* store.create({ ...run, status: 'approved' })
      yield* store.create(replacement)
      // The journal insert succeeds first; reactivating the old run then violates issue uniqueness.
      const failed = yield* store.finish({ run, journal }).pipe(Effect.exit)
      expect(failed._tag).toBe('Failure')
      expect(yield* store.journal(run)).toBeNull()
      expect((yield* store.get(run.id)).status).toBe('approved')
      yield* store.save({ ...replacement, status: 'approved' })
      yield* store.finish({ run, journal })
      expect(yield* store.journal(run)).toEqual(journal)
      const db = yield* Db
      const [persistedRun] = yield* db.select().from(workflow_runs).where(eq(workflow_runs.id, run.id))
      const [persistedJournal] = yield* db
        .select()
        .from(workflow_assignments)
        .where(eq(workflow_assignments.run_id, run.id))
      expect(persistedRun?.issue_id).toBe(run.issueId)
      expect(persistedRun?.data.worker_id).toBe(run.workerId)
      expect(persistedRun?.data).not.toHaveProperty('workerId')
      expect(persistedJournal?.data.assignment.artifact_dir).toBe(run.workspace)
      expect(persistedJournal?.data.assignment.snapshot.issue.updated_at).toBe(
        journal.assignment.snapshot.issue.updatedAt,
      )
      expect(persistedJournal?.data.result?.next_role).toBe('developer')
      expect(persistedJournal?.data).not.toHaveProperty('agentStarted')

      expect(yield* store.get(run.id)).toEqual(run)
      yield* store.save({ ...run, status: 'approved' })
    }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(TestDatabaseLive)))),
  )
}, 15000)

test('pause, resume, and acknowledgement persist their control flags', async () => {
  const run = makeRun()
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      const db = yield* Db
      const row = () => db.select().from(workflow_runs).where(eq(workflow_runs.id, run.id))
      yield* store.create(run)
      yield* store.control({ id: run.id, command: 'pause', answer: null })
      expect((yield* row())[0]).toMatchObject({ pause_requested: true, resume_requested: false, resume_answer: null })
      expect(yield* store.paused(run.id)).toBe(true)
      yield* store.control({ id: run.id, command: 'resume', answer: 'Environment ready' })
      expect((yield* row())[0]).toMatchObject({
        pause_requested: false,
        resume_requested: true,
        resume_answer: 'Environment ready',
      })
      expect(yield* controls(run.id)).toEqual({ resume_requested: true, resume_answer: 'Environment ready' })
      yield* store.acknowledge(run.id)
      expect((yield* row())[0]).toMatchObject({ pause_requested: false, resume_requested: false, resume_answer: null })
      yield* store.save({ ...run, status: 'approved' })
    }).pipe(Effect.provide(TestStoreLive)),
  )
})
