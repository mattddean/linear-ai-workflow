import type { Schema } from 'effect'

import { sql } from 'drizzle-orm'
import { boolean, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'

import type { RunData, JournalData } from '../boundary-schemas'
import type { IssueId, RunId, WorkerGroup, WorkerId } from '../domain'

export const workflow_runs = pgTable(
  'workflow_runs',
  {
    id: text('id').$type<RunId>().primaryKey(),
    issue_id: text('issue_id').$type<IssueId>().notNull(),
    data: jsonb('data').$type<Schema.Schema.Encoded<typeof RunData>>().notNull(),
    pause_requested: boolean('pause_requested').notNull().default(false),
    resume_requested: boolean('resume_requested').notNull().default(false),
    resume_answer: text('resume_answer'),
  },
  (table) => [
    uniqueIndex('workflow_runs_active_issue')
      .on(table.issue_id)
      .where(sql`${table.data}->>'status' <> 'approved'`),
  ],
)

export const workflow_assignments = pgTable(
  'workflow_assignments',
  {
    run_id: text('run_id')
      .$type<RunId>()
      .notNull()
      .references(() => workflow_runs.id),
    sequence: integer('sequence').notNull(),
    data: jsonb('data').$type<Schema.Schema.Encoded<typeof JournalData>>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.run_id, table.sequence] })],
)

export const workflow_worker_owners = pgTable('workflow_worker_owners', {
  worker_group: text('worker_group').$type<WorkerGroup>().primaryKey(),
  worker_id: text('worker_id').$type<typeof WorkerId.Type>().notNull(),
})
