import { Schema } from 'effect'

// Defines the shared schemas, branded identifiers, and errors used by workflow services and persisted state.

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
  workspace: Path,
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
