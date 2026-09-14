import { Schema } from 'effect'

import { Comment, Issue, Result, Run, Assignment, Journal } from './domain'

// Converts snake_case persisted JSON payloads to the typed camelCase domain model and back.

export const CommentData = Schema.Struct({
  id: Comment.fields.id,
  body: Comment.fields.body,
  created_at: Comment.fields.createdAt,
  user: Comment.fields.user,
}).pipe(
  Schema.rename({
    created_at: 'createdAt',
  }),
)

export const IssueData = Schema.Struct({
  id: Issue.fields.id,
  identifier: Issue.fields.identifier,
  title: Issue.fields.title,
  description: Issue.fields.description,
  updated_at: Issue.fields.updatedAt,
  team: Issue.fields.team,
}).pipe(
  Schema.rename({
    updated_at: 'updatedAt',
  }),
)

export const SnapshotData = Schema.Struct({
  issue: IssueData,
  comments: Schema.Array(CommentData),
})

export const ResultData = Schema.Struct({
  outcome: Result.fields.outcome,
  next_role: Result.fields.nextRole,
  next_phase: Result.fields.nextPhase,
  refinement_comment_id: Result.fields.refinementCommentId,
  commit_sha: Result.fields.commitSha,
  report: Result.fields.report,
  question: Result.fields.question,
}).pipe(
  Schema.rename({
    next_role: 'nextRole',
    next_phase: 'nextPhase',
    refinement_comment_id: 'refinementCommentId',
    commit_sha: 'commitSha',
  }),
)

export const RunData = Schema.Struct({
  id: Run.fields.id,
  worker_group: Run.fields.workerGroup,
  worker_id: Run.fields.workerId,
  issue_id: Run.fields.issueId,
  issue_key: Run.fields.issueKey,
  repo: Run.fields.repo,
  worktree: Run.fields.worktree,
  branch: Run.fields.branch,
  base_sha: Run.fields.baseSha,
  commit_sha: Run.fields.commitSha,
  refinement_comment_id: Run.fields.refinementCommentId,
  predecessor_id: Run.fields.predecessorId,
  phase: Run.fields.phase,
  status: Run.fields.status,
  sequence: Run.fields.sequence,
  attempts: Run.fields.attempts,
  tokens: Run.fields.tokens,
  max_attempts: Run.fields.maxAttempts,
  max_tokens: Run.fields.maxTokens,
  max_minutes: Run.fields.maxMinutes,
  active_millis: Run.fields.activeMillis,
  note: Run.fields.note,
  question: Run.fields.question,
  wait_sequence: Run.fields.waitSequence,
  answer: Run.fields.answer,
  issue_fingerprint: Run.fields.issueFingerprint,
  updated_at: Run.fields.updatedAt,
}).pipe(
  Schema.rename({
    worker_group: 'workerGroup',
    worker_id: 'workerId',
    issue_id: 'issueId',
    issue_key: 'issueKey',
    base_sha: 'baseSha',
    commit_sha: 'commitSha',
    refinement_comment_id: 'refinementCommentId',
    predecessor_id: 'predecessorId',
    max_attempts: 'maxAttempts',
    max_tokens: 'maxTokens',
    max_minutes: 'maxMinutes',
    active_millis: 'activeMillis',
    wait_sequence: 'waitSequence',
    issue_fingerprint: 'issueFingerprint',
    updated_at: 'updatedAt',
  }),
)

export const AssignmentData = Schema.Struct({
  run: RunData,
  snapshot: SnapshotData,
  artifact_dir: Assignment.fields.artifactDir,
}).pipe(
  Schema.rename({
    artifact_dir: 'artifactDir',
  }),
)

export const JournalData = Schema.Struct({
  assignment: AssignmentData,
  state: Journal.fields.state,
  agent_started: Journal.fields.agentStarted,
  result: Schema.NullOr(ResultData),
  comment_id: Journal.fields.commentId,
  body: Journal.fields.body,
  tokens: Journal.fields.tokens,
  elapsed_millis: Journal.fields.elapsedMillis,
  step_result: Journal.fields.stepResult,
}).pipe(
  Schema.rename({
    agent_started: 'agentStarted',
    comment_id: 'commentId',
    elapsed_millis: 'elapsedMillis',
    step_result: 'stepResult',
  }),
)
