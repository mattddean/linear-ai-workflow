import { Effect, Schema } from 'effect'

export const RunId = Schema.UUID.pipe(Schema.brand('RunId'))
export type RunId = typeof RunId.Type
export const IssueId = Schema.UUID.pipe(Schema.brand('IssueId'))
export type IssueId = typeof IssueId.Type
export const CommentId = Schema.UUID.pipe(Schema.brand('CommentId'))
export type CommentId = typeof CommentId.Type
export const TeamId = Schema.UUID.pipe(Schema.brand('TeamId'))
export const UserId = Schema.UUID.pipe(Schema.brand('UserId'))
export const IssueKey = Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9]*-\d+$/), Schema.brand('IssueKey'))
export const Path = Schema.String.pipe(Schema.pattern(/^\//), Schema.brand('Path'))
export type Path = typeof Path.Type
export const CommitSha = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/), Schema.brand('CommitSha'))
export type CommitSha = typeof CommitSha.Type
export const Branch = Schema.NonEmptyString.pipe(Schema.brand('Branch'))
export const WorkerGroup = Schema.Literal('default', 'local')
export type WorkerGroup = typeof WorkerGroup.Type
export const WorkerId = Schema.NonEmptyString.pipe(Schema.brand('WorkerId'))
export const Role = Schema.Literal('pm', 'developer', 'qa')
export const Phase = Schema.Literal('refinement', 'implementation', 'verification', 'acceptance')
export type Phase = typeof Phase.Type
export const Outcome = Schema.Literal('ready', 'changes-required', 'blocked', 'approved')
export class AppError extends Schema.TaggedError<AppError>()('AppError', {
  kind: Schema.Literal('configuration', 'transport', 'linear', 'storage', 'workspace', 'agent', 'blocked', 'invalid'),
  message: Schema.String,
}) {}
export const error = (kind: AppError['kind'], message: string): AppError => new AppError({ kind, message })
export const Result = Schema.Struct({
  outcome: Outcome,
  nextRole: Schema.NullOr(Schema.Literal('pm', 'developer', 'qa', 'human')),
  nextPhase: Schema.NullOr(Phase),
  refinementCommentId: Schema.NullOr(CommentId),
  commitSha: Schema.NullOr(CommitSha),
  report: Schema.NonEmptyString,
  question: Schema.NullOr(Schema.NonEmptyString),
})
export type Result = typeof Result.Type
export const Comment = Schema.Struct({
  id: CommentId,
  body: Schema.String,
  createdAt: Schema.String,
  user: Schema.NullOr(Schema.Struct({ id: UserId })),
})
export type Comment = typeof Comment.Type
export const Issue = Schema.Struct({
  id: IssueId,
  identifier: IssueKey,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  team: Schema.Struct({ id: TeamId }),
})
export type Issue = typeof Issue.Type
export const Snapshot = Schema.Struct({ issue: Issue, comments: Schema.Array(Comment) })
export type Snapshot = typeof Snapshot.Type
export const Run = Schema.Struct({
  id: RunId,
  workerGroup: WorkerGroup,
  workerId: WorkerId,
  issueId: IssueId,
  issueKey: IssueKey,
  repo: Path,
  worktree: Path,
  branch: Branch,
  baseSha: CommitSha,
  commitSha: Schema.NullOr(CommitSha),
  refinementCommentId: Schema.NullOr(CommentId),
  predecessorId: Schema.NullOr(CommentId),
  phase: Phase,
  status: Schema.Literal('queued', 'running', 'blocked', 'paused', 'approved'),
  sequence: Schema.Int,
  attempts: Schema.Int,
  tokens: Schema.Int,
  maxAttempts: Schema.Int,
  maxTokens: Schema.Int,
  maxMinutes: Schema.Int,
  activeMillis: Schema.Number,
  note: Schema.String,
  question: Schema.NullOr(Schema.String),
  waitSequence: Schema.NullOr(Schema.Int),
  answer: Schema.NullOr(Schema.String),
  issueFingerprint: Schema.String,
  updatedAt: Schema.String,
})
export type Run = typeof Run.Type
export const Assignment = Schema.Struct({ run: Run, snapshot: Snapshot, artifactDir: Path })
export type Assignment = typeof Assignment.Type
export const AgentOutput = Schema.Struct({ result: Result, tokens: Schema.Int })
export type AgentOutput = typeof AgentOutput.Type
export const StepResult = Schema.Literal('continue', 'wait', 'complete')
export type StepResult = typeof StepResult.Type
export const Journal = Schema.Struct({
  assignment: Assignment,
  state: Schema.Literal('started', 'prepared', 'done'),
  agentStarted: Schema.Boolean,
  result: Schema.NullOr(Result),
  commentId: Schema.NullOr(CommentId),
  body: Schema.NullOr(Schema.String),
  tokens: Schema.Int,
  elapsedMillis: Schema.Number,
  stepResult: Schema.NullOr(StepResult),
})
export type Journal = typeof Journal.Type

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
