import { Context, Effect, Layer } from 'effect'
import { readFile } from 'node:fs/promises'

import type { AppError, Assignment, Run, RunId, StepResult } from './domain'

import { Agent } from './agent'
import { Settings } from './config'
import { error, Path } from './domain'
import {
  blocked,
  commentBody,
  fingerprint,
  discussionChanged,
  marker,
  acknowledgementMarker,
  roleFor,
  validateResult,
} from './handoff'
import { Linear } from './linear'
import { Store } from './store'
import { budgetTokens, countTokenUsage } from './token-usage'
import { Workspace } from './workspace'

// Executes one journaled assignment: checks prerequisites, runs its agent, confirms the Linear handoff, and advances the run.

export class Coordinator extends Context.Tag('Coordinator')<
  Coordinator,
  {
    readonly step: (input: { id: RunId; sequence: number }) => Effect.Effect<StepResult, AppError>
  }
>() {}

export const CoordinatorLive = Layer.effect(
  Coordinator,
  Effect.gen(function* () {
    const store = yield* Store
    const linear = yield* Linear
    const agent = yield* Agent
    const workspace = yield* Workspace
    const settings = yield* Settings
    const gate = yield* Effect.makeSemaphore(1)
    const pauseWatcher = (id: RunId) =>
      Effect.gen(function* () {
        for (;;) {
          if (yield* store.paused(id))
            return yield* error('blocked', 'Run paused by the user. Review interrupted work and resume when ready.')
          yield* Effect.sleep('1 second')
        }
      })
    return Coordinator.of({
      step: Effect.fn('Coordinator.step')((input) =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            let current = yield* store.get(input.id)
            // Read the original sequence on replay; a committed handoff may precede the activity checkpoint.
            let journal = yield* store.journal({ ...current, sequence: input.sequence })
            if (journal?.state === 'done' && journal.stepResult !== null) return journal.stepResult
            if (current.workerId !== settings.workerId)
              return yield* error(
                'blocked',
                `Run belongs to worker ${current.workerId}; its workspace must not move implicitly`,
              )
            if (current.sequence !== input.sequence)
              return yield* error('storage', 'Run sequence and activity journal disagree')
            yield* Effect.annotateLogsScoped({
              ticket: current.issueKey,
              run: current.id,
              role: roleFor(current.phase),
              phase: current.phase,
              sequence: input.sequence,
            })
            const startedAt = Date.now()
            let fresh = journal === null
            if (journal === null) {
              const snapshot = yield* linear.read(current.issueId)
              current = { ...current, status: 'running', updatedAt: new Date().toISOString() }
              const assignment: Assignment = {
                run: current,
                snapshot,
                artifactDir: Path.make(`${settings.artifactRoot}/${current.id}/${input.sequence}`),
              }
              journal = {
                assignment,
                state: current.sequence === 0 || current.responseCommentId !== undefined ? 'acknowledging' : 'started',
                agentStarted: false,
                result: null,
                commentId: null,
                body:
                  current.sequence === 0 || current.responseCommentId !== undefined
                    ? `${acknowledgementMarker(current)}\n👀`
                    : null,
                tokens: 0,
                cachedTokens: 0,
                elapsedMillis: 0,
                stepResult: null,
              }
              yield* store.saveJournal(journal)
              yield* store.save(current)
            }
            if (journal.state === 'acknowledging') {
              if (journal.body === null) return yield* error('storage', 'Acknowledgement is missing its persisted body')
              yield* Effect.logInfo('Publishing 👀 acknowledgement')
              yield* linear.post({
                issueId: current.issueId,
                parentId: journal.assignment.run.responseCommentId,
                body: journal.body,
                eventMarker: acknowledgementMarker(journal.assignment.run),
              })
              // Include our confirmed acknowledgement before capturing the agent's discussion baseline.
              journal = {
                ...journal,
                state: 'started',
                body: null,
                assignment: { ...journal.assignment, snapshot: yield* linear.read(current.issueId) },
              }
              yield* store.saveJournal(journal)
              fresh = true
            }
            if (fresh) {
              const assignment = journal.assignment
              const snapshot = assignment.snapshot
              const run = current
              yield* Effect.logInfo('Assignment started').pipe(
                Effect.annotateLogs({ artifacts: assignment.artifactDir }),
              )
              const initialJournal = journal
              let didExecute = false
              const output = yield* Effect.gen(function* () {
                if (yield* store.paused(run.id))
                  return { result: blocked(run, 'Paused by the user; resume when ready.'), tokens: 0, cachedTokens: 0 }
                if (
                  budgetTokens(run) >= run.maxTokens ||
                  run.activeMillis >= run.maxMinutes * 60000 ||
                  (run.phase === 'implementation' && run.attempts >= run.maxAttempts)
                ) {
                  return {
                    result: blocked(
                      run,
                      'Run budget exhausted. Review the reports and extend the relevant limit with resume before continuing.',
                    ),
                    tokens: 0,
                    cachedTokens: 0,
                  }
                }
                yield* Effect.logInfo('Preparing Whey isolate').pipe(Effect.annotateLogs({ workspace: run.workspace }))
                yield* workspace.prepare(run)
                yield* Effect.logInfo('Whey isolate ready; checking source revision')
                const before = yield* workspace.inspect(run)
                if (run.commitSha !== null && before !== run.commitSha)
                  return yield* error(
                    'blocked',
                    'Workspace HEAD changed outside this assignment; reconcile the expected revision before resuming',
                  )
                for (const id of [run.refinementCommentId, run.predecessorId]) {
                  if (id !== null && !snapshot.comments.some((comment) => comment.id === id))
                    return yield* error('blocked', 'A referenced handoff comment is missing from Linear')
                }
                if (
                  run.phase !== 'refinement' &&
                  (run.refinementCommentId === null || run.issueFingerprint !== fingerprint(snapshot))
                ) {
                  return {
                    result: {
                      outcome: 'changes-required',
                      nextRole: 'pm',
                      nextPhase: 'refinement',
                      refinementCommentId: run.refinementCommentId,
                      commitSha: run.commitSha,
                      report: '## Requirements changed\n\nPM must refine the current issue before work continues.',
                      question: null,
                    } as const,
                    tokens: 0,
                    cachedTokens: 0,
                  }
                }
                didExecute = true
                yield* store.saveJournal({ ...initialJournal, agentStarted: true })
                yield* Effect.logInfo('Starting Codex')
                const output = yield* agent.execute(assignment).pipe(Effect.raceFirst(pauseWatcher(run.id)))
                yield* Effect.logInfo('Codex finished').pipe(
                  Effect.annotateLogs({
                    outcome: output.result.outcome,
                    tokens: output.tokens,
                    cachedTokens: output.cachedTokens,
                    budgetTokens: budgetTokens(output),
                  }),
                )
                yield* validateResult({ run, result: output.result })
                if (output.result.outcome !== 'blocked') {
                  const after = yield* workspace.inspect(run)
                  if (run.phase !== 'implementation' && before !== after)
                    return yield* error('invalid', 'A review agent changed the source revision')
                  if (
                    run.phase === 'implementation' &&
                    output.result.outcome === 'ready' &&
                    output.result.commitSha !== after
                  ) {
                    return yield* error('invalid', 'Developer handoff does not match the actual committed source')
                  }
                }
                return output
              }).pipe(
                Effect.catchAll((failure) =>
                  Effect.gen(function* () {
                    yield* Effect.logError(failure.message)
                    const log = yield* Effect.tryPromise(() =>
                      readFile(`${assignment.artifactDir}/events.jsonl`, 'utf8'),
                    ).pipe(Effect.orElseSucceed(() => ''))
                    return { result: blocked(run, failure.message), ...countTokenUsage(log) }
                  }),
                ),
              )
              journal = {
                ...journal,
                state: 'prepared',
                agentStarted: didExecute,
                result: output.result,
                tokens: output.tokens,
                cachedTokens: output.cachedTokens,
                elapsedMillis: Date.now() - startedAt,
                body: commentBody(run, output.result),
              }
              yield* store.saveJournal(journal)
            } else if (journal.state === 'started') {
              yield* Effect.logWarning('Recovering interrupted assignment; human reconciliation required')
              const result = blocked(
                current,
                `An assignment was interrupted before its result was saved. Inspect ${journal.assignment.artifactDir} and ${current.workspace}, stop any surviving Codex process, and reconcile source before resuming.`,
              )
              journal = { ...journal, state: 'prepared', result, body: commentBody(current, result) }
              yield* store.saveJournal(journal)
            }
            if (journal.result === null || journal.body === null)
              return yield* error('storage', 'Prepared assignment is missing its report')
            const beforePublication = yield* linear.read(current.issueId)
            const existing = beforePublication.comments.find((comment) =>
              comment.body.startsWith(`${marker(current)}\n`),
            )
            if (
              !existing &&
              journal.result.outcome !== 'blocked' &&
              discussionChanged({
                before: journal.assignment.snapshot,
                after: beforePublication,
                ignoreCommentId: null,
              })
            ) {
              const replacement = {
                ...journal.result,
                outcome: 'changes-required' as const,
                nextRole: 'pm' as const,
                nextPhase: 'refinement' as const,
                question: null,
                report: `## Requirements changed during review\n\nPM must reconcile the latest issue discussion.\n\n## Prior agent report\n\n${journal.result.report}`,
              }
              journal = { ...journal, result: replacement, body: commentBody(current, replacement) }
              yield* store.saveJournal(journal)
            }
            if (journal.result === null || journal.body === null)
              return yield* error('storage', 'Missing prepared report')
            if (journal.result.outcome === 'ready' || journal.result.outcome === 'approved') {
              const head = yield* workspace.inspect(current)
              const reviewed = journal.result.commitSha ?? current.commitSha ?? current.baseSha
              if (head !== reviewed)
                return yield* error(
                  'blocked',
                  'Prepared handoff no longer matches the workspace. Restore the reviewed revision before publication can continue.',
                )
            }
            // This is an outbox: retry publication, never regenerate an agent report after an ambiguous write.
            yield* Effect.logInfo('Publishing Linear handoff').pipe(
              Effect.annotateLogs({ outcome: journal.result.outcome }),
            )
            const posted = yield* linear.post({
              issueId: current.issueId,
              body: journal.body,
              eventMarker: marker(current),
            })
            const latest = yield* linear.read(current.issueId)
            const result = journal.result
            const sourceChanged = discussionChanged({
              before: journal.assignment.snapshot,
              after: latest,
              ignoreCommentId: posted.id,
            })
            const paused = yield* store.paused(current.id)
            const waiting = result.outcome === 'blocked' || paused
            const approved = result.outcome === 'approved' && !sourceChanged && !paused
            const newRefinement = current.phase === 'refinement' && result.outcome === 'ready'
            const nextPhase = sourceChanged ? 'refinement' : (result.nextPhase ?? current.phase)
            const stepResult: StepResult = approved ? 'complete' : waiting ? 'wait' : 'continue'
            const next: Run = {
              ...current,
              phase: waiting ? current.phase : nextPhase,
              status: approved ? 'approved' : paused ? 'paused' : waiting ? 'blocked' : 'queued',
              sequence: current.sequence + 1,
              predecessorId: posted.id,
              refinementCommentId: sourceChanged ? null : newRefinement ? posted.id : current.refinementCommentId,
              commitSha:
                result.outcome === 'ready' && current.phase === 'implementation' ? result.commitSha : current.commitSha,
              issueFingerprint: newRefinement ? fingerprint(journal.assignment.snapshot) : current.issueFingerprint,
              attempts: newRefinement
                ? 0
                : current.attempts + (current.phase === 'implementation' && journal.agentStarted ? 1 : 0),
              tokens: current.tokens + journal.tokens,
              cachedTokens: (current.cachedTokens ?? 0) + (journal.cachedTokens ?? 0),
              activeMillis: current.activeMillis + journal.elapsedMillis,
              question: waiting ? (result.question ?? 'Run paused; resume when ready.') : null,
              waitSequence: waiting ? current.sequence : null,
              answer: null,
              responseCommentId: undefined,
              note: sourceChanged
                ? 'Issue discussion changed during the assignment. Reconcile the latest requirements.'
                : result.report,
              updatedAt: new Date().toISOString(),
            }
            yield* store.finish({ run: next, journal: { ...journal, state: 'done', commentId: posted.id, stepResult } })
            yield* (
              waiting
                ? Effect.logWarning('Work waiting for human response or resume')
                : Effect.logInfo(approved ? 'Ticket accepted' : 'Handoff confirmed; next assignment queued')
            ).pipe(
              Effect.annotateLogs({
                status: next.status,
                nextPhase: next.phase,
                comment: posted.id,
                tokens: next.tokens,
                cachedTokens: next.cachedTokens,
                budgetTokens: budgetTokens(next),
                elapsedSeconds: Math.round(journal.elapsedMillis / 1000),
              }),
            )
            return stepResult
          }).pipe(Effect.scoped),
        ),
      ),
    })
  }),
)
