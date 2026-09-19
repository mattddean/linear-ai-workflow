import { Console, Effect, Schema } from 'effect'
import { Argument, Command, Flag } from 'effect/unstable/cli'

import { recoverAgentLease } from './agent'
import { Settings } from './config'
import { RunId, error } from './domain'
import { Store } from './store'
import { budgetTokens } from './token-usage'
import { Workspace } from './workspace'

// Defines ticket inspection and operator-control commands against the shared process services.

const idArgument = Argument.String('run-id')
export const statusCommand = Command.make('status', { id: idArgument }, ({ id }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* store.get(yield* Schema.decodeUnknownEffect(RunId)(id))
    yield* Console.log(JSON.stringify({ ...run, budgetTokens: budgetTokens(run) }, null, 2))
  }),
)
export const listCommand = Command.make('list', {}, () =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* Console.log(JSON.stringify(yield* store.list, null, 2))
  }),
)
export const pauseCommand = Command.make('pause', { id: idArgument }, ({ id }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* store.get(yield* Schema.decodeUnknownEffect(RunId)(id))
    if (run.status === 'approved') return yield* error('invalid', 'Approved runs are complete')
    yield* store.control({ id: run.id, command: 'pause', answer: null })
    yield* Console.log('Pause requested. The worker will stop the active assignment and preserve its work.')
  }),
)
export const resumeCommand = Command.make(
  'resume',
  {
    id: idArgument,
    answer: Flag.String('answer').pipe(Flag.withDefault('')),
    extraTokens: Flag.Int('extra-tokens').pipe(Flag.withDefault(0)),
    extraMinutes: Flag.Int('extra-minutes').pipe(Flag.withDefault(0)),
    extraAttempts: Flag.Int('extra-attempts').pipe(Flag.withDefault(0)),
    acceptHead: Flag.Boolean('accept-head').pipe(Flag.withDefault(false)),
  },
  (input) =>
    Effect.gen(function* () {
      const store = yield* Store
      const workspace = yield* Workspace
      const settings = yield* Settings
      const run = yield* store.get(yield* Schema.decodeUnknownEffect(RunId)(input.id))
      if (run.workerId !== settings.workerId)
        return yield* error('blocked', `Resume on the owning machine (${run.workerId})`)
      if (run.status !== 'blocked' && run.status !== 'paused')
        return yield* error('invalid', 'Only blocked or paused runs can resume')
      if (![input.extraTokens, input.extraMinutes, input.extraAttempts].every((n) => Number.isSafeInteger(n) && n >= 0))
        return yield* error('invalid', 'Budget extensions must be non-negative integers')
      yield* recoverAgentLease()
      yield* workspace.prepare(run)
      const head = yield* workspace.inspect(run)
      if (run.commitSha !== null && head !== run.commitSha && !input.acceptHead)
        return yield* error(
          'blocked',
          'HEAD changed. Inspect it, then use --accept-head to restart implementation from this revision.',
        )
      yield* store.save({
        ...run,
        commitSha: input.acceptHead ? head : run.commitSha,
        phase: input.acceptHead && run.refinementCommentId !== null ? 'implementation' : run.phase,
        maxTokens: run.maxTokens + input.extraTokens,
        maxMinutes: run.maxMinutes + input.extraMinutes,
        maxAttempts: run.maxAttempts + input.extraAttempts,
      })
      yield* store.control({ id: run.id, command: 'resume', answer: input.answer || null })
      yield* Console.log('Resume requested; the worker will reconcile the pending handoff before continuing.')
    }),
)
