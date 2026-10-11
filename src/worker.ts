import { and, eq, sql as expression } from 'drizzle-orm'
import { Effect, Layer, Schedule, Schema } from 'effect'
import { SqlClient } from 'effect/unstable/sql'
import { DurableDeferred } from 'effect/unstable/workflow'

import type { CommentId, Run, WorkerGroup } from './domain'

import { recoverAgentLease, stopCanceledAgent } from './agent'
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
  if (run.status === 'canceling' || (yield* linear.isCanceled(run.issueId))) {
    yield* store.cancel(run.id)
    // Stop the owned process even if an old malformed workflow reply prevents interrupt delivery.
    yield* stopCanceledAgent(run.id)
    yield* TicketWorkflow.interrupt(executionId)
    // A durable interrupt is a request; verify process cleanup before marking cancellation complete.
    yield* stopCanceledAgent(run.id)
    const canceled = yield* store.get(run.id)
    yield* store.save({
      ...canceled,
      status: 'canceled',
      answer: null,
      question: null,
      waitSequence: null,
      responseCommentId: undefined,
      updatedAt: new Date().toISOString(),
    })
    yield* Effect.logInfo('Ticket canceled; local work stopped and isolate preserved')
    return
  }
  if ((run.status === 'blocked' || run.status === 'paused') && run.waitSequence !== null) {
    const command = yield* controls(run.id)
    let answer = command.resume_answer
    let responseCommentId: CommentId | undefined
    let newThreadId: CommentId | undefined
    if (!command.resume_requested && run.status === 'blocked' && run.predecessorId !== null) {
      const snapshot = yield* linear.read(run.issueId, [
        run.predecessorId,
        ...(run.threadCommentId ? [run.threadCommentId] : []),
      ])
      const publication = snapshot.comments.find((comment) => comment.id === run.predecessorId)
      if (publication) {
        const root =
          run.threadCommentId ?? (yield* linear.threadParent({ issueId: run.issueId, commentId: publication.id }))
        const replies = yield* linear.replies({ issueId: run.issueId, commentId: root })
        const publicationIds = yield* store.publicationIds(run.id)
        const response = humanAnswer({ replies, publication, publicationIds })
        if (response) {
          answer = response.body.trim()
          responseCommentId = response.id
        } else {
          // A new human root starts a fresh conversation, never a continuation of another role's session.
          for (const candidate of snapshot.comments) {
            if (!humanAnswer({ replies: [candidate], publication, publicationIds })) continue
            const parent = yield* linear.threadParent({ issueId: run.issueId, commentId: candidate.id })
            if (parent !== candidate.id || parent === root) continue
            answer = candidate.body.trim()
            responseCommentId = candidate.id
            newThreadId = candidate.id
            break
          }
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
        threadCommentId: newThreadId ?? (scopeChanged ? undefined : run.threadCommentId),
        codexSessionId: scopeChanged || newThreadId !== undefined ? undefined : run.codexSessionId,
        codexSessionUsage: scopeChanged || newThreadId !== undefined ? undefined : run.codexSessionUsage,
        codexSessionUnresolved: scopeChanged || newThreadId !== undefined ? undefined : run.codexSessionUnresolved,
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
    runs.filter(
      (run) =>
        run.workerGroup === group &&
        run.workerId === settings.workerId &&
        run.status !== 'approved' &&
        run.status !== 'canceled',
    ),
    (run) =>
      pollRun(run).pipe(
        // catchCause rather than catch to catch not only errors but also defects.
        Effect.catchCause((cause) => Effect.logError(cause)),
        Effect.annotateLogs({ ticket: run.issueKey, run: run.id, phase: run.phase }),
      ),
    { discard: true },
  )
})

export const pollingLayer = (group: WorkerGroup) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const settings = yield* Settings
      yield* Effect.logInfo(`Polling ${group} runs every ${settings.pollSeconds} seconds`)
      yield* pollRuns(group).pipe(
        // catchCause rather than catch to catch not only errors but also defects.
        Effect.catchCause((cause) => Effect.logError(cause)),
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
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Tuple([Schema.Boolean])))(rows)
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
            expression`${workflow_runs.data}->>'status' NOT IN ('approved', 'canceled')`,
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
