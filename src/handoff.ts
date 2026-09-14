import { Effect } from 'effect'

import type { Phase, Role, Run, Result, Snapshot, Comment, CommentId } from './domain'

import { error } from './domain'

// Defines valid agent handoffs, formats their Linear comments, and correlates human replies and discussion changes.

export const roleFor = (phase: Phase): typeof Role.Type =>
  phase === 'implementation' ? 'developer' : phase === 'verification' ? 'qa' : 'pm'
export const fingerprint = (snapshot: Snapshot): string =>
  JSON.stringify([snapshot.issue.title, snapshot.issue.description])
export const eventId = (run: Run): string => `${run.id}/${run.sequence}`
export const questionId = (run: Run): string => `Q-${run.id}-${run.sequence}`
export const marker = (run: Run): string => `<!-- linear-ai-workflow:${eventId(run)} -->`

export const validateResult = Effect.fn('Result.validate')(function* (input: { run: Run; result: Result }) {
  const { run, result } = input
  let valid = false
  if (result.outcome === 'blocked') {
    valid = result.nextRole === 'human' && result.nextPhase === null && result.question !== null
  } else if (result.question === null) {
    const route = `${result.nextRole}/${result.nextPhase}`
    if (result.outcome === 'approved') {
      valid = run.phase === 'acceptance' && result.nextRole === null && result.nextPhase === null
    } else if (result.outcome === 'ready') {
      valid =
        (run.phase === 'refinement' && route === 'developer/implementation') ||
        (run.phase === 'implementation' && route === 'qa/verification') ||
        (run.phase === 'verification' && route === 'pm/acceptance')
    } else {
      valid =
        (run.phase === 'implementation' && route === 'pm/refinement') ||
        (run.phase === 'verification' && ['developer/implementation', 'pm/refinement'].includes(route)) ||
        (run.phase === 'acceptance' && ['developer/implementation', 'qa/verification', 'pm/refinement'].includes(route))
    }
  }
  if (!valid) return yield* error('invalid', 'Agent proposed an invalid role/phase transition')
  const newSpec = run.phase === 'refinement' && result.outcome === 'ready'
  if (result.refinementCommentId !== (newSpec ? null : run.refinementCommentId)) {
    return yield* error('invalid', 'Agent result references a stale refinement')
  }
  if (['verification', 'acceptance'].includes(run.phase) && result.commitSha !== run.commitSha) {
    return yield* error('invalid', 'Review result references a different commit')
  }
  if (result.outcome === 'ready' && run.phase !== 'refinement' && result.commitSha === null) {
    return yield* error('invalid', 'Implementation and QA handoffs require a commit')
  }
  return result
})

export function blocked(run: Run, message: string): Result {
  return {
    outcome: 'blocked',
    nextRole: 'human',
    nextPhase: null,
    refinementCommentId: run.refinementCommentId,
    commitSha: run.commitSha,
    report: `## Blocked\n\n${message}`,
    question: message,
  }
}

export function commentBody(run: Run, result: Result): string {
  return `${marker(run)}\nRun: ${run.id}\nRole: ${roleFor(run.phase)}\nPhase: ${run.phase}\nOutcome: ${result.outcome}\nResponds-To: ${run.predecessorId ?? 'none'}\nSpec: ${result.refinementCommentId ?? 'self/none'}\nCommit: ${result.commitSha ?? 'none'}\nNext: ${result.nextRole ?? 'none'}/${result.nextPhase ?? 'none'}\n\n${result.report}${result.question === null ? '' : `\n\n## Human response required\n\nReply with \`${questionId(run)}\` on the first line, followed by your answer. Start your answer with \`SCOPE:\` if it changes the requirements.\n\n${result.question}`}`
}

export function humanAnswer(input: {
  run: Run
  comments: readonly Comment[]
  publication: Comment
}): Comment | undefined {
  const { run, comments, publication } = input
  return comments.find(
    (comment) =>
      comment.id !== publication.id &&
      comment.user !== null &&
      Date.parse(comment.createdAt) >= Date.parse(publication.createdAt) &&
      comment.body.split('\n')[0]?.trim() === questionId({ ...run, sequence: run.waitSequence ?? run.sequence }),
  )
}

export function discussionChanged(input: {
  before: Snapshot
  after: Snapshot
  ignoreCommentId: CommentId | null
}): boolean {
  const comments = input.after.comments.filter((comment) => comment.id !== input.ignoreCommentId)
  return (
    fingerprint(input.before) !== fingerprint(input.after) ||
    input.before.comments.length !== comments.length ||
    comments.some((comment) => !input.before.comments.some((old) => old.id === comment.id && old.body === comment.body))
  )
}
