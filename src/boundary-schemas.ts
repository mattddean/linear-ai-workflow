import { Schema } from 'effect'

import {
  Comment,
  Issue,
  Result,
  Run,
  Assignment,
  Journal,
  BudgetOverrides,
  ProgressComment,
  CodexSessionUsage,
} from './domain'

// Converts snake_case persisted JSON payloads to the typed camelCase domain model and back.

export const CommentData = Comment.pipe(
  Schema.encodeKeys({
    createdAt: 'created_at',
  }),
)

export const IssueData = Issue.pipe(
  Schema.encodeKeys({
    updatedAt: 'updated_at',
  }),
)

export const SnapshotData = Schema.Struct({
  issue: IssueData,
  comments: Schema.Array(CommentData),
})

export const ResultData = Result.pipe(
  Schema.encodeKeys({
    nextRole: 'next_role',
    nextPhase: 'next_phase',
    refinementCommentId: 'refinement_comment_id',
    commitSha: 'commit_sha',
  }),
)

const CodexSessionUsageData = CodexSessionUsage.pipe(Schema.encodeKeys({ cachedTokens: 'cached_tokens' }))

const BudgetOverridesData = BudgetOverrides.pipe(
  Schema.encodeKeys({ maxAttempts: 'max_attempts', maxTokens: 'max_tokens', maxMinutes: 'max_minutes' }),
)

export const RunData = Schema.Struct({
  ...Run.fields,
  budgetOverrides: Schema.optional(BudgetOverridesData),
  codexSessionUsage: Schema.optional(CodexSessionUsageData),
}).pipe(
  Schema.encodeKeys({
    cachedTokens: 'cached_tokens',
    workerGroup: 'worker_group',
    workerId: 'worker_id',
    issueId: 'issue_id',
    issueKey: 'issue_key',
    baseSha: 'base_sha',
    commitSha: 'commit_sha',
    refinementCommentId: 'refinement_comment_id',
    predecessorId: 'predecessor_id',
    threadCommentId: 'thread_comment_id',
    codexSessionId: 'codex_session_id',
    codexSessionUnresolved: 'codex_session_unresolved',
    codexSessionUsage: 'codex_session_usage',
    budgetOverrides: 'budget_overrides',
    activeMillis: 'active_millis',
    waitSequence: 'wait_sequence',
    responseCommentId: 'response_comment_id',
    issueFingerprint: 'issue_fingerprint',
    updatedAt: 'updated_at',
  }),
)

export const AssignmentData = Schema.Struct({
  run: RunData,
  snapshot: SnapshotData,
  artifactDir: Assignment.fields.artifactDir,
}).pipe(
  Schema.encodeKeys({
    artifactDir: 'artifact_dir',
  }),
)

const ProgressCommentData = ProgressComment.pipe(
  Schema.encodeKeys({ commentId: 'comment_id', publicationId: 'publication_id' }),
)

export const JournalData = Schema.Struct({
  sessionUsage: Schema.optional(CodexSessionUsageData),
  publicationId: Journal.fields.publicationId,
  threadBody: Journal.fields.threadBody,
  threadPublished: Journal.fields.threadPublished,
  progressComments: Schema.optional(Schema.Array(ProgressCommentData)),
  assignment: AssignmentData,
  state: Journal.fields.state,
  agentStarted: Journal.fields.agentStarted,
  result: Schema.NullOr(ResultData),
  commentId: Journal.fields.commentId,
  body: Journal.fields.body,
  tokens: Journal.fields.tokens,
  cachedTokens: Journal.fields.cachedTokens,
  elapsedMillis: Journal.fields.elapsedMillis,
  stepResult: Journal.fields.stepResult,
}).pipe(
  Schema.encodeKeys({
    cachedTokens: 'cached_tokens',
    agentStarted: 'agent_started',
    commentId: 'comment_id',
    elapsedMillis: 'elapsed_millis',
    stepResult: 'step_result',
    progressComments: 'progress_comments',
    publicationId: 'publication_id',
    sessionUsage: 'session_usage',
    threadBody: 'thread_body',
    threadPublished: 'thread_published',
  }),
)
