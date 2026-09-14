import { and, asc, eq, sql } from 'drizzle-orm'
import { Context, Effect, Layer, Schema } from 'effect'

import type { RunId, Journal, Run } from './domain'

import { RunData, JournalData } from './boundary-schemas'
import { Db } from './db/live'
import { workflow_runs, workflow_assignments, workflow_worker_owners } from './db/schema'
import { AppError, error } from './domain'

// Persists runs, assignment journals, and operator controls through Drizzle, committing completed handoffs atomically.

export class Store extends Context.Tag('Store')<
  Store,
  {
    readonly enroll: (run: Run) => Effect.Effect<boolean, AppError>
    readonly create: (run: Run) => Effect.Effect<void, AppError>
    readonly get: (id: RunId) => Effect.Effect<Run, AppError>
    readonly list: Effect.Effect<readonly Run[], AppError>
    readonly save: (run: Run) => Effect.Effect<void, AppError>
    readonly journal: (run: Run) => Effect.Effect<Journal | null, AppError>
    readonly saveJournal: (journal: Journal) => Effect.Effect<void, AppError>
    readonly finish: (input: { run: Run; journal: Journal }) => Effect.Effect<void, AppError>
    readonly control: (input: {
      id: RunId
      command: 'pause' | 'resume'
      answer: string | null
    }) => Effect.Effect<void, AppError>
    readonly paused: (id: RunId) => Effect.Effect<boolean, AppError>
    readonly acknowledge: (id: RunId) => Effect.Effect<void, AppError>
  }
>() {}

export const StoreLive = Layer.effect(
  Store,
  Effect.gen(function* () {
    const db = yield* Db
    const storageError = () => error('storage', 'Database operation failed; run remains recoverable')
    const get = Effect.fn('Store.get')(function* (id: RunId) {
      const rows = yield* db.select({ data: workflow_runs.data }).from(workflow_runs).where(eq(workflow_runs.id, id))
      const row = rows[0]
      if (!row) return yield* error('storage', 'Run not found')
      return yield* Schema.decodeUnknown(RunData)(row.data)
    }, Effect.mapError(storageError))
    const save = Effect.fn('Store.save')((run: Run) =>
      db
        .update(workflow_runs)
        .set({ data: Schema.encodeSync(RunData)(run) })
        .where(eq(workflow_runs.id, run.id))
        .pipe(Effect.asVoid, Effect.mapError(storageError)),
    )
    const saveJournal = Effect.fn('Store.saveJournal')((journal: Journal) =>
      db
        .insert(workflow_assignments)
        .values({
          run_id: journal.assignment.run.id,
          sequence: journal.assignment.run.sequence,
          data: Schema.encodeSync(JournalData)(journal),
        })
        .onConflictDoUpdate({
          target: [workflow_assignments.run_id, workflow_assignments.sequence],
          set: { data: Schema.encodeSync(JournalData)(journal) },
        })
        .pipe(Effect.asVoid, Effect.mapError(storageError)),
    )
    return Store.of({
      enroll: Effect.fn('Store.enroll')((run) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              // All discovery processes serialize on the issue, including when its prior run is already approved.
              yield* tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${run.issueId}))`)
              const existing = yield* tx
                .select({ id: workflow_runs.id })
                .from(workflow_runs)
                .where(eq(workflow_runs.issue_id, run.issueId))
                .limit(1)
              if (existing.length > 0) return false
              // Reserve ownership before a worker exists, and serialize enrollment with worker ownership changes.
              yield* tx
                .insert(workflow_worker_owners)
                .values({ worker_group: run.workerGroup, worker_id: run.workerId })
                .onConflictDoNothing()
              const owners = yield* tx
                .select()
                .from(workflow_worker_owners)
                .where(eq(workflow_worker_owners.worker_group, run.workerGroup))
                .for('update')
              if (owners[0] && owners[0].worker_id !== run.workerId)
                return yield* error('blocked', 'Discovery must run on the machine owning its worker group')
              yield* tx
                .insert(workflow_runs)
                .values({ id: run.id, issue_id: run.issueId, data: Schema.encodeSync(RunData)(run) })
              return true
            }),
          )
          .pipe(Effect.mapError((failure) => (failure instanceof AppError ? failure : storageError()))),
      ),
      create: Effect.fn('Store.create')((run) =>
        db
          .insert(workflow_runs)
          .values({ id: run.id, issue_id: run.issueId, data: Schema.encodeSync(RunData)(run) })
          .pipe(
            Effect.asVoid,
            Effect.mapError(() => error('storage', 'Could not enroll issue; check for an existing active run')),
          ),
      ),
      get,
      save,
      saveJournal,
      list: db
        .select({ data: workflow_runs.data })
        .from(workflow_runs)
        .orderBy(sql`${workflow_runs.data}->>'updated_at'`, asc(workflow_runs.id))
        .pipe(
          Effect.flatMap((rows) => Schema.decodeUnknown(Schema.Array(RunData))(rows.map((row) => row.data))),
          Effect.mapError(storageError),
        ),
      journal: Effect.fn('Store.journal')(function* (run) {
        const rows = yield* db
          .select({ data: workflow_assignments.data })
          .from(workflow_assignments)
          .where(and(eq(workflow_assignments.run_id, run.id), eq(workflow_assignments.sequence, run.sequence)))
        return rows[0] ? yield* Schema.decodeUnknown(JournalData)(rows[0].data) : null
      }, Effect.mapError(storageError)),
      finish: Effect.fn('Store.finish')((input) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(workflow_assignments)
                .values({
                  run_id: input.journal.assignment.run.id,
                  sequence: input.journal.assignment.run.sequence,
                  data: Schema.encodeSync(JournalData)(input.journal),
                })
                .onConflictDoUpdate({
                  target: [workflow_assignments.run_id, workflow_assignments.sequence],
                  set: { data: Schema.encodeSync(JournalData)(input.journal) },
                })
              yield* tx
                .update(workflow_runs)
                .set({ data: Schema.encodeSync(RunData)(input.run) })
                .where(eq(workflow_runs.id, input.run.id))
            }),
          )
          .pipe(Effect.mapError(storageError)),
      ),
      control: Effect.fn('Store.control')((input) =>
        db
          .update(workflow_runs)
          .set({
            pause_requested: input.command === 'pause',
            resume_requested: input.command === 'resume',
            resume_answer: input.answer,
          })
          .where(eq(workflow_runs.id, input.id))
          .pipe(Effect.asVoid, Effect.mapError(storageError)),
      ),
      paused: Effect.fn('Store.paused')((id) =>
        db
          .select({ pause_requested: workflow_runs.pause_requested })
          .from(workflow_runs)
          .where(eq(workflow_runs.id, id))
          .pipe(
            Effect.map((rows) => rows[0]?.pause_requested ?? true),
            Effect.mapError(storageError),
          ),
      ),
      acknowledge: Effect.fn('Store.acknowledge')((id) =>
        db
          .update(workflow_runs)
          .set({ resume_requested: false, resume_answer: null })
          .where(eq(workflow_runs.id, id))
          .pipe(Effect.asVoid, Effect.mapError(storageError)),
      ),
    })
  }),
)

export const controls = Effect.fn('Store.controls')(function* (id: RunId) {
  const db = yield* Db
  const rows = yield* db
    .select({ resume_requested: workflow_runs.resume_requested, resume_answer: workflow_runs.resume_answer })
    .from(workflow_runs)
    .where(eq(workflow_runs.id, id))
  return rows[0] ?? { resume_requested: false, resume_answer: null }
})
