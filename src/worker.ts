import { SqlClient } from '@effect/sql'
import { DurableDeferred } from '@effect/workflow'
import { Effect, Layer, Schedule, Schema } from 'effect'

import type { Run, RunId, WorkerGroup } from './domain'

import { recoverAgentLease } from './agent'
import { Settings } from './config'
import { error, humanAnswer } from './domain'
import { Linear } from './linear'
import { Store, controls } from './store'
import { TicketWorkflow, resumeSignal } from './ticket-workflow'

export const pollRuns = Effect.fn('Worker.pollRuns')(function* (group: WorkerGroup) {
  const store = yield* Store
  const linear = yield* Linear
  const settings = yield* Settings
  const runs = yield* store.list
  for (const run of runs.filter(
    (run) => run.workerGroup === group && run.workerId === settings.workerId && run.status !== 'approved',
  )) {
    const executionId = yield* TicketWorkflow.executionId({ id: run.id })
    if ((run.status === 'blocked' || run.status === 'paused') && run.waitSequence !== null) {
      const command = yield* controls(run.id)
      let answer = command.resume_answer
      if (!command.resume_requested && run.status === 'blocked' && run.predecessorId !== null) {
        const snapshot = yield* linear.read(run.issueId)
        const publication = snapshot.comments.find((comment) => comment.id === run.predecessorId)
        if (publication) {
          const response = humanAnswer({ run, comments: snapshot.comments, publication })
          if (response) answer = response.body.split('\n').slice(1).join('\n').trim()
        }
      }
      if (command.resume_requested || (answer !== null && answer.length > 0)) {
        yield* recoverAgentLease()
        const scopeChanged = answer?.startsWith('SCOPE:') ?? false
        const resumed: Run = {
          ...run,
          status: 'queued',
          answer,
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
  }
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
  const foreign = yield* sql<{ id: RunId }>`SELECT id FROM workflow_runs
    WHERE data->>'workerGroup'=${group} AND data->>'workerId'<>${settings.workerId}
      AND data->>'status'<>'approved' LIMIT 1`
  if (foreign.length > 0)
    return yield* error('blocked', `Group ${group} has unfinished runs on another machine; start its owning worker`)
  yield* sql`INSERT INTO workflow_worker_owners(worker_group,worker_id) VALUES(${group},${settings.workerId})
    ON CONFLICT(worker_group) DO UPDATE SET worker_id=EXCLUDED.worker_id`
  yield* Effect.logInfo(`Worker ${settings.workerId} holds group ${group}`)
  // Loss of the lock connection terminates the worker scope and its child processes.
  return connection.executeValues('SELECT 1', []).pipe(Effect.repeat(Schedule.spaced('2 seconds')))
})

export const ensureOwner = Effect.fn('Worker.ensureOwner')(function* (group: WorkerGroup) {
  const sql = yield* SqlClient.SqlClient
  const settings = yield* Settings
  const rows = yield* sql<{
    worker_id: typeof settings.workerId
  }>`SELECT worker_id FROM workflow_worker_owners WHERE worker_group=${group}`
  if (rows[0]?.worker_id !== settings.workerId)
    return yield* error(
      'blocked',
      `Enroll from the machine owning ${group}; local repository paths cannot be transferred implicitly`,
    )
})
