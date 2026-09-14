import { Effect, Layer, Redacted } from 'effect'

import type { Assignment, Comment, Journal, Run, Result, Snapshot } from '../domain'

import { Agent } from '../agent'
import { Settings } from '../config'
import { CoordinatorLive } from '../coordinator'
import {
  CommentId,
  IssueId,
  IssueKey,
  Path,
  RunId,
  CommitSha,
  Branch,
  TeamId,
  UserId,
  WorkerId,
  error,
} from '../domain'
import { Linear } from '../linear'
import { Store } from '../store'
import { Workspace } from '../workspace'

// Builds reusable workflow data and replaceable in-memory services for coordinator and integration tests.

export const sha = CommitSha.make('a'.repeat(40))
export const teamId = TeamId.make('00000000-0000-4000-8000-000000000001')
export const userId = UserId.make('00000000-0000-4000-8000-000000000002')
export function makeRun(): Run {
  return {
    id: RunId.make(crypto.randomUUID()),
    issueId: IssueId.make(crypto.randomUUID()),
    issueKey: IssueKey.make('ENG-1'),
    workerGroup: 'local',
    workerId: WorkerId.make('test-machine'),
    repo: Path.make('/tmp/repo'),
    worktree: Path.make('/tmp/worktree'),
    branch: Branch.make('codex/test'),
    baseSha: sha,
    commitSha: null,
    refinementCommentId: null,
    predecessorId: null,
    phase: 'refinement',
    status: 'queued',
    sequence: 0,
    attempts: 0,
    tokens: 0,
    maxAttempts: 3,
    maxTokens: 10000,
    maxMinutes: 10,
    activeMillis: 0,
    note: '',
    question: null,
    waitSequence: null,
    answer: null,
    issueFingerprint: '["Test",null]',
    updatedAt: new Date().toISOString(),
  }
}
export const settings = {
  linearKey: Redacted.make('test-key'),
  teamId,
  worktreeRoot: Path.make('/tmp/worktrees'),
  artifactRoot: Path.make('/tmp/artifacts'),
  pollSeconds: 1,
  workerId: WorkerId.make('test-machine'),
  runnerHost: '127.0.0.1',
  runnerPort: 34542,
}
export function ready(run: Run): Result {
  return {
    outcome: run.phase === 'acceptance' ? 'approved' : 'ready',
    nextRole:
      run.phase === 'refinement'
        ? 'developer'
        : run.phase === 'implementation'
          ? 'qa'
          : run.phase === 'verification'
            ? 'pm'
            : null,
    nextPhase:
      run.phase === 'refinement'
        ? 'implementation'
        : run.phase === 'implementation'
          ? 'verification'
          : run.phase === 'verification'
            ? 'acceptance'
            : null,
    refinementCommentId: run.phase === 'refinement' ? null : run.refinementCommentId,
    commitSha: run.phase === 'refinement' ? null : sha,
    question: null,
    report: 'Verified AC-1 with evidence.',
  }
}
export function fixture(initial = makeRun()) {
  const state = {
    run: initial,
    journals: new Map<number, Journal>(),
    calls: 0,
    posts: 0,
    pause: false,
    ambiguous: false,
    agentResult: (run: Run): Result => ready(run),
    snapshot: {
      issue: {
        id: initial.issueId,
        identifier: initial.issueKey,
        title: 'Test',
        description: null,
        updatedAt: new Date().toISOString(),
        team: { id: teamId },
      },
      comments: [],
    } satisfies Snapshot,
  }
  const comments: Comment[] = []
  const read = Effect.fn('Test.Linear.read')(() =>
    Effect.sync((): Snapshot => structuredClone({ ...state.snapshot, comments })),
  )
  const linear = Linear.of({
    read,
    post: Effect.fn('Test.Linear.post')((input) =>
      Effect.suspend(() => {
        const existing = comments.find((comment) => comment.body.startsWith(input.eventMarker))
        if (existing) return Effect.succeed(existing)
        state.posts += 1
        const comment: Comment = {
          id: CommentId.make(crypto.randomUUID()),
          body: input.body,
          createdAt: new Date().toISOString(),
          user: { id: userId },
        }
        comments.push(comment)
        if (state.ambiguous) {
          state.ambiguous = false
          return Effect.fail(error('transport', 'Timed out after publication'))
        }
        return Effect.succeed(comment)
      }),
    ),
  })
  const store = Store.of({
    create: (run) =>
      Effect.sync(() => {
        state.run = run
      }),
    get: () => Effect.sync(() => state.run),
    list: Effect.sync(() => [state.run]),
    save: (run) =>
      Effect.sync(() => {
        state.run = run
      }),
    journal: (run) => Effect.sync(() => state.journals.get(run.sequence) ?? null),
    saveJournal: (journal) =>
      Effect.sync(() => {
        state.journals.set(journal.assignment.run.sequence, journal)
      }),
    finish: (input) =>
      Effect.sync(() => {
        state.run = input.run
        state.journals.set(input.journal.assignment.run.sequence, input.journal)
      }),
    control: (input) =>
      Effect.sync(() => {
        state.pause = input.command === 'pause'
      }),
    paused: () => Effect.sync(() => state.pause),
    acknowledge: () => Effect.void,
  })
  const agent = Agent.of({
    execute: Effect.fn('Test.Agent.execute')((assignment: Assignment) =>
      Effect.sync(() => {
        state.calls += 1
        return { result: state.agentResult(assignment.run), tokens: 100 }
      }),
    ),
  })
  const workspace = Workspace.of({
    inspectBase: () => Effect.succeed({ repo: initial.repo, baseSha: sha }),
    prepare: () => Effect.void,
    inspect: () => Effect.succeed(sha),
  })
  const dependencies = Layer.mergeAll(
    Layer.succeed(Agent, agent),
    Layer.succeed(Workspace, workspace),
    Layer.succeed(Settings, settings),
    Layer.succeed(Linear, linear),
  )
  const layer = CoordinatorLive.pipe(Layer.provide(dependencies), Layer.provide(Layer.succeed(Store, store)))
  return { state, comments, store, linear, agent, workspace, dependencies, layer }
}
