import { SqlClient } from '@effect/sql'
import { DurableDeferred } from '@effect/workflow'
import { and, eq, sql as expression } from 'drizzle-orm'
import { Effect, Layer, Schedule, Schema } from 'effect'

import type { CommentId, Run, WorkerGroup } from './domain'

import { recoverAgentLease } from './agent'
import { Settings } from './config'
import { Db } from './db/live'
import { workflow_runs, workflow_worker_owners } from './db/schema'
import { error } from './domain'
import { humanAnswer } from './handoff'
import { Linear } from './linear.client'
import { Store, controls } from './store'
import { TicketWorkflow, resumeSignal } from './ticket.workflow'

// Keeps a worker group owned by one machine and polls its runs for work and correlated resume requests.

const pollRun = Effect.fn('Worker.pollRun')(function* (run: Run) {
  const store = yield* Store
  const linear = yield* Linear
  const executionId = yield* TicketWorkflow.executionId({ id: run.id })
  if ((run.status === 'blocked' || run.status === 'paused') && run.waitSequence !== null) {
    const command = yield* controls(run.id)
    let answer = command.resume_answer
    let responseCommentId: CommentId | undefined
    if (!command.resume_requested && run.status === 'blocked' && run.predecessorId !== null) {
      const snapshot = yield* linear.read(run.issueId)
      const publication = snapshot.comments.find((comment) => comment.id === run.predecessorId)
      if (publication) {
        const replies = yield* linear.replies({ issueId: run.issueId, commentId: publication.id })
        const response = humanAnswer({ replies, publication })
        if (response) {
          answer = response.body.trim()
          responseCommentId = response.id
        }
      }
    }
    if (command.resume_requested || (answer !== null && answer.length > 0)) {
      yield* recoverAgentLease()
      yield* Effect.logInfo(
        responseCommentId ? 'Human reply detected; queuing work' : 'Operator resume requested',
      ).pipe(Effect.annotateLogs({ responseCommentId: responseCommentId ?? 'CLI' }))
      const scopeChanged = answer?.startsWith('SCOPE:') ?? false
      const resumed: Run = {
        ...run,
        status: 'queued',
        answer,
        responseCommentId,
        question: null,
        phase: scopeChanged ? 'refinement' : run.phase,
        refinementCommentId: scopeChanged ? null : run.refinementCommentId,
        note: `${run.note}\n\nHuman response: ${answer ?? 'Explicit CLI resume; reconcile prior work before continuing.'}`,
      }
      // Keep waitSequence until the signal has been confirmed, so a restart can repeat delivery.
      yield* store.save(resumed)
      yield* store.acknowledge(run.id)
      yield* DurableDeferred.succeed(resumeSignal(run.waitSequence), {
        value: undefined,
        token: DurableDeferred.tokenFromExecutionId(resumeSignal(run.waitSequence), {
          workflow: TicketWorkflow,
          executionId,
        }),
      })
    }
  } else {
    if (run.waitSequence !== null) yield* store.acknowledge(run.id)
    yield* TicketWorkflow.execute({ id: run.id }, { discard: true })
    if (run.waitSequence !== null)
      yield* DurableDeferred.succeed(resumeSignal(run.waitSequence), {
        value: undefined,
        token: DurableDeferred.tokenFromExecutionId(resumeSignal(run.waitSequence), {
          workflow: TicketWorkflow,
          executionId,
        }),
      })
  }
})

export const pollRuns = Effect.fn('Worker.pollRuns')(function* (group: WorkerGroup) {
  const store = yield* Store
  const settings = yield* Settings
  const runs = yield* store.list
  yield* Effect.forEach(
    runs.filter((run) => run.workerGroup === group && run.workerId === settings.workerId && run.status !== 'approved'),
    (run) =>
      pollRun(run).pipe(
        Effect.catchAll((failure) => Effect.logError(failure)),
        Effect.annotateLogs({ ticket: run.issueKey, run: run.id, phase: run.phase }),
      ),
    { discard: true },
  )
})

export const pollingLayer = (group: WorkerGroup) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const settings = yield* Settings
      yield* pollRuns(group).pipe(
        Effect.catchAll((failure) => Effect.logError(failure)),
        Effect.repeat(Schedule.spaced(`${settings.pollSeconds} seconds`)),
        Effect.forkScoped,
      )
    }),
  )

export const acquireWorkerLock = Effect.fn('Worker.acquireLock')(function* (group: WorkerGroup) {
  const sql = yield* SqlClient.SqlClient
  const settings = yield* Settings
  const connection = yield* sql.reserve
  // One owner per group keeps local files on their machine; use another group for another machine.
  const key = `linear-ai-workflow/${group}`
  const rows = yield* connection.executeValues('SELECT pg_try_advisory_lock(hashtext($1))', [key])
  const decoded = yield* Schema.decodeUnknown(Schema.Array(Schema.Tuple(Schema.Boolean)))(rows)
  if (decoded[0]?.[0] !== true) return yield* error('blocked', `Another ${group} coordinator holds the execution lease`)
  yield* Effect.addFinalizer(() =>
    connection.executeValues('SELECT pg_advisory_unlock(hashtext($1))', [key]).pipe(Effect.ignore),
  )
  const db = yield* Db
  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx
        .insert(workflow_worker_owners)
        .values({ worker_group: group, worker_id: settings.workerId })
        .onConflictDoNothing()
      // Lock the same ownership row as discovery before checking or changing its machine.
      yield* tx
        .select()
        .from(workflow_worker_owners)
        .where(eq(workflow_worker_owners.worker_group, group))
        .for('update')
      const foreign = yield* tx
        .select({ id: workflow_runs.id })
        .from(workflow_runs)
        .where(
          and(
            expression`${workflow_runs.data}->>'worker_group' = ${group}`,
            expression`${workflow_runs.data}->>'worker_id' <> ${settings.workerId}`,
            expression`${workflow_runs.data}->>'status' <> 'approved'`,
          ),
        )
        .limit(1)
      if (foreign.length > 0)
        return yield* error('blocked', `Group ${group} has unfinished runs on another machine; start its owning worker`)
      yield* tx
        .update(workflow_worker_owners)
        .set({ worker_id: settings.workerId })
        .where(eq(workflow_worker_owners.worker_group, group))
    }),
  )
  yield* Effect.logInfo(`Worker ${settings.workerId} holds group ${group}`)
  // Loss of the lock connection terminates the worker scope and its child processes.
  return connection.executeValues('SELECT 1', []).pipe(Effect.repeat(Schedule.spaced('2 seconds')))
})

export const ensureOwner = Effect.fn('Worker.ensureOwner')(function* (group: WorkerGroup) {
  const db = yield* Db
  const settings = yield* Settings
  const rows = yield* db
    .select({ worker_id: workflow_worker_owners.worker_id })
    .from(workflow_worker_owners)
    .where(eq(workflow_worker_owners.worker_group, group))
  if (rows[0]?.worker_id !== settings.workerId)
    return yield* error(
      'blocked',
      `Enroll from the machine owning ${group}; local repository paths cannot be transferred implicitly`,
    )
})
