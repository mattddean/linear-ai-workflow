import { Effect, Layer, Redacted } from 'effect'

import type { AgentProgress } from '../agent-progress'
import type { Assignment, Comment, Journal, Run, Result, Snapshot } from '../domain'

import { Agent } from '../agent'
import { Settings } from '../config'
import { Coordinator } from '../coordinator'
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
import { Linear } from '../linear.client'
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
    workspace: Path.make('/tmp/workspace'),
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
    cachedTokens: 0,
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
  isolateRoot: Path.make('/tmp/isolates'),
  artifactRoot: Path.make('/tmp/artifacts'),
  pollSeconds: 1,
  maxAttempts: 3,
  maxTokens: 10000,
  maxMinutes: 10,
  workerId: WorkerId.make('test-machine'),
  workerGroup: 'local' as const,
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
export function fixture(initial = makeRun(), configured: Settings['Service'] = settings) {
  const state = {
    run: initial,
    journals: new Map<number, Journal>(),
    calls: 0,
    cachedTokensPerAssignment: 0,
    posts: 0,
    pause: false,
    canceled: false,
    ambiguous: false,
    ambiguousAcknowledgement: false,
    ambiguousProgress: false,
    progressMessages: new Array<AgentProgress>(),
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
  const progressComments: Comment[] = []
  const acknowledgements: { issueId: IssueId; commentId?: CommentId | undefined }[] = []
  const read = Effect.fn('Test.Linear.read')(() =>
    Effect.sync(
      (): Snapshot =>
        structuredClone({
          ...state.snapshot,
          comments: [...comments, ...progressComments],
        }),
    ),
  )
  const linear = Linear.of({
    isCanceled: () => Effect.sync(() => state.canceled),
    discover: Effect.succeed([state.snapshot.issue]),
    replies: () => Effect.succeed([]),
    read,
    acknowledge: Effect.fn('Test.Linear.acknowledge')((input) =>
      Effect.suspend(() => {
        if (acknowledgements.some((item) => item.issueId === input.issueId && item.commentId === input.commentId))
          return Effect.void
        acknowledgements.push(input)
        if (state.ambiguousAcknowledgement) {
          state.ambiguousAcknowledgement = false
          return Effect.fail(error('transport', 'Timed out after acknowledgement'))
        }
        return Effect.void
      }),
    ),
    post: Effect.fn('Test.Linear.post')((input) =>
      Effect.suspend(() => {
        const existing = [...comments, ...progressComments].find((comment) =>
          comment.body.startsWith(`${input.eventMarker}\n`),
        )
        if (existing) return Effect.succeed(existing)
        const progress = input.eventMarker.includes('/progress/')
        if (!progress) state.posts += 1
        const comment: Comment = {
          id: CommentId.make(crypto.randomUUID()),
          body: input.body,
          createdAt: new Date().toISOString(),
          user: { id: userId },
        }
        if (progress) {
          if (
            state.journals.size > 0 &&
            ![...state.journals.values()].some((journal) =>
              journal.progressComments?.some((item) => item.body === input.body),
            )
          )
            throw new Error('Progress intent must be saved before publication')
          progressComments.push(comment)
          if (state.ambiguousProgress) {
            state.ambiguousProgress = false
            return Effect.fail(error('transport', 'Timed out after progress publication'))
          }
        } else comments.push(comment)
        if (!progress && state.ambiguous) {
          state.ambiguous = false
          return Effect.fail(error('transport', 'Timed out after publication'))
        }
        return Effect.succeed(comment)
      }),
    ),
  })
  const store = Store.of({
    cancel: () =>
      Effect.sync(() => {
        if (state.run.status !== 'canceled') state.run = { ...state.run, status: 'canceling' }
      }),
    enroll: () => Effect.succeed(false),
    create: (run) =>
      Effect.sync(() => {
        state.run = run
      }),
    get: () => Effect.sync(() => state.run),
    list: Effect.sync(() => [state.run]),
    save: (run) =>
      Effect.sync(() => {
        if ((state.run.status !== 'canceling' && state.run.status !== 'canceled') || run.status === 'canceled')
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
    execute: Effect.fn('Test.Agent.execute')(function* (assignment: Assignment, onProgress) {
      state.calls += 1
      for (const progress of state.progressMessages) {
        if (onProgress) yield* onProgress(progress)
      }
      return { result: state.agentResult(assignment.run), tokens: 100, cachedTokens: state.cachedTokensPerAssignment }
    }),
  })
  const workspace = Workspace.of({
    inspectBase: () => Effect.succeed({ repo: initial.repo, baseSha: sha }),
    prepare: () => Effect.void,
    inspect: () => Effect.succeed(sha),
  })
  const dependencies = Layer.mergeAll(
    Layer.succeed(Agent, agent),
    Layer.succeed(Workspace, workspace),
    Layer.succeed(Settings, configured),
    Layer.succeed(Linear, linear),
  )
  const layer = Coordinator.layer.pipe(Layer.provide(dependencies), Layer.provide(Layer.succeed(Store, store)))
  return { state, comments, progressComments, acknowledgements, store, linear, agent, workspace, dependencies, layer }
}

// Capture this test's fakes while leaving the real Store supplied by the calling runtime or scope.
export function coordinatorLayer(f: ReturnType<typeof fixture>): Layer.Layer<Coordinator, never, Store> {
  return Coordinator.layer.pipe(Layer.provide(f.dependencies))
}
