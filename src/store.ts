import { SqlClient } from '@effect/sql'
import { Context, Effect, Layer, Schema } from 'effect'

import type { AppError, RunId } from './domain'

import { Journal, Run, error } from './domain'

export class Store extends Context.Tag('Store')<
  Store,
  {
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

export const initializeStore = Effect.fn('Store.initialize')(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, data JSONB NOT NULL,
    pause_requested BOOLEAN NOT NULL DEFAULT FALSE, resume_requested BOOLEAN NOT NULL DEFAULT FALSE,
    resume_answer TEXT
  )`
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_active_issue
    ON workflow_runs(issue_id) WHERE data->>'status' <> 'approved'`
  yield* sql`CREATE TABLE IF NOT EXISTS workflow_worker_owners (worker_group TEXT PRIMARY KEY, worker_id TEXT NOT NULL)`
  yield* sql`CREATE TABLE IF NOT EXISTS workflow_assignments (
    run_id TEXT NOT NULL REFERENCES workflow_runs(id), sequence INTEGER NOT NULL,
    data JSONB NOT NULL, PRIMARY KEY(run_id, sequence)
  )`
})

export const StoreLive = Layer.effect(
  Store,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const storageError = () => error('storage', 'Database operation failed; run remains recoverable')
    const get = Effect.fn('Store.get')(function* (id: RunId) {
      const rows = yield* sql<{ data: Run }>`SELECT data FROM workflow_runs WHERE id=${id}`
      const row = rows[0]
      if (!row) return yield* error('storage', 'Run not found')
      return yield* Schema.decodeUnknown(Run)(row.data)
    }, Effect.mapError(storageError))
    const save = Effect.fn('Store.save')((run: Run) =>
      sql`
    UPDATE workflow_runs SET data=${JSON.stringify(run)}::jsonb WHERE id=${run.id}
  `.pipe(Effect.asVoid, Effect.mapError(storageError)),
    )
    const saveJournal = Effect.fn('Store.saveJournal')((journal: Journal) =>
      sql`
    INSERT INTO workflow_assignments(run_id, sequence, data)
    VALUES (${journal.assignment.run.id}, ${journal.assignment.run.sequence}, ${JSON.stringify(journal)}::jsonb)
    ON CONFLICT (run_id, sequence) DO UPDATE SET data=EXCLUDED.data
  `.pipe(Effect.asVoid, Effect.mapError(storageError)),
    )
    return Store.of({
      create: Effect.fn('Store.create')((run) =>
        sql`
      INSERT INTO workflow_runs(id,issue_id,data) VALUES(${run.id},${run.issueId},${JSON.stringify(run)}::jsonb)
    `.pipe(
          Effect.asVoid,
          Effect.mapError(() => error('storage', 'Could not enroll issue; check for an existing active run')),
        ),
      ),
      get,
      save,
      saveJournal,
      list: sql<{ data: Run }>`SELECT data FROM workflow_runs ORDER BY data->>'updatedAt', id`.pipe(
        Effect.flatMap((rows) => Schema.decodeUnknown(Schema.Array(Run))(rows.map((row) => row.data))),
        Effect.mapError(storageError),
      ),
      journal: Effect.fn('Store.journal')(function* (run) {
        const rows = yield* sql<{
          data: Journal
        }>`SELECT data FROM workflow_assignments WHERE run_id=${run.id} AND sequence=${run.sequence}`
        return rows[0] ? yield* Schema.decodeUnknown(Journal)(rows[0].data) : null
      }, Effect.mapError(storageError)),
      finish: Effect.fn('Store.finish')((input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* saveJournal(input.journal)
              yield* save(input.run)
            }),
          )
          .pipe(Effect.mapError(storageError)),
      ),
      control: Effect.fn('Store.control')((input) =>
        sql`
      UPDATE workflow_runs SET pause_requested=${input.command === 'pause'}, resume_requested=${input.command === 'resume'},
        resume_answer=${input.answer} WHERE id=${input.id}
    `.pipe(Effect.asVoid, Effect.mapError(storageError)),
      ),
      paused: Effect.fn('Store.paused')((id) =>
        sql<{ pause_requested: boolean }>`SELECT pause_requested FROM workflow_runs WHERE id=${id}`.pipe(
          Effect.map((rows) => rows[0]?.pause_requested ?? true),
          Effect.mapError(storageError),
        ),
      ),
      acknowledge: Effect.fn('Store.acknowledge')((id) =>
        sql`UPDATE workflow_runs SET resume_requested=FALSE, resume_answer=NULL WHERE id=${id}`.pipe(
          Effect.asVoid,
          Effect.mapError(storageError),
        ),
      ),
    })
  }),
)

export const controls = Effect.fn('Store.controls')(function* (id: RunId) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ resume_requested: boolean; resume_answer: string | null }>`
    SELECT resume_requested,resume_answer FROM workflow_runs WHERE id=${id}`
  return rows[0] ?? { resume_requested: false, resume_answer: null }
})
