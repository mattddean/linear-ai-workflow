import { Effect } from 'effect'
import { Activity, DurableClock, DurableDeferred, Workflow } from 'effect/unstable/workflow'

import { Coordinator } from './coordinator'
import { AppError, RunId, StepResult } from './domain'

// Persists the assignment loop as an Effect Workflow with retryable activities and durable human-response waits.

export const TicketWorkflow = Workflow.make('linear-ticket-v1', {
  payload: { id: RunId },
  idempotencyKey: (input) => input.id,
  error: AppError,
})
export const resumeSignal = (sequence: number) => DurableDeferred.make(`resume-${sequence}`)
export const TicketWorkflowLive = TicketWorkflow.toLayer(
  Effect.fn('TicketWorkflow.run')(function* (input) {
    const coordinator = yield* Coordinator
    for (let sequence = 0; ; sequence += 1) {
      const result = yield* Activity.make({
        name: `assignment-${sequence}`,
        success: StepResult,
        error: AppError,
        execute: Effect.gen(function* () {
          const attempt = yield* Activity.CurrentAttempt
          if (attempt > 1) {
            yield* Effect.logWarning('Assignment retry scheduled in 30 seconds').pipe(
              Effect.annotateLogs({ run: input.id, sequence, attempt }),
            )
            yield* DurableClock.sleep({ name: `retry-${sequence}-${attempt}`, duration: '30 seconds' })
          }
          return yield* coordinator
            .step({ id: input.id, sequence })
            .pipe(
              Effect.tapError((failure) =>
                Effect.logError(failure.message).pipe(Effect.annotateLogs({ run: input.id, sequence, attempt })),
              ),
            )
        }),
      }).pipe(Activity.retry({}))
      if (result === 'complete') return
      if (result === 'wait') yield* DurableDeferred.await(resumeSignal(sequence))
    }
  }),
)
