import { Effect, Schedule } from 'effect'
import { resolve } from 'node:path'

import type { Issue, Run } from './domain'

import { Settings, DiscoverySettings } from './config'
import { Branch, Path, RunId } from './domain'
import { fingerprint } from './handoff'
import { Linear } from './linear.client'
import { Store } from './store'
import { Workspace } from './workspace'

// Discovers labeled Linear tickets and durably enrolls each issue once, without depending on worker availability.

export const enrollIssue = Effect.fn('Discovery.enrollIssue')(function* (issue: Issue) {
  const settings = yield* Settings
  const target = yield* DiscoverySettings
  const store = yield* Store
  const workspace = yield* Workspace
  const base = yield* workspace.inspectBase(target)
  const id = RunId.make(crypto.randomUUID())
  const run: Run = {
    id,
    workerGroup: settings.workerGroup,
    workerId: settings.workerId,
    issueId: issue.id,
    issueKey: issue.identifier,
    repo: base.repo,
    baseSha: base.baseSha,
    branch: Branch.make(`codex/${issue.identifier.toLowerCase()}-${id}`),
    workspace: Path.make(resolve(settings.isolateRoot, id)),
    commitSha: null,
    refinementCommentId: null,
    predecessorId: null,
    phase: 'refinement',
    status: 'queued',
    sequence: 0,
    attempts: 0,
    tokens: 0,
    cachedTokens: 0,
    maxAttempts: 3,
    maxTokens: 1000000,
    maxMinutes: 120,
    activeMillis: 0,
    note: '',
    question: null,
    waitSequence: null,
    answer: null,
    issueFingerprint: fingerprint({ issue, comments: [] }),
    updatedAt: new Date().toISOString(),
  }
  if (yield* store.enroll(run)) yield* Effect.logInfo(`Queued ${issue.identifier}: ${id} on ${settings.workerGroup}`)
})

export const discoverTickets = Effect.fn('Discovery.poll')(function* () {
  const linear = yield* Linear
  const store = yield* Store
  const known = new Set((yield* store.list).map((run) => run.issueId))
  const issues = yield* linear.discover
  yield* Effect.forEach(
    issues.filter((issue) => !known.has(issue.id)),
    (issue) =>
      enrollIssue(issue).pipe(Effect.catchAll((failure) => Effect.logError(`${issue.identifier}: ${failure.message}`))),
    { discard: true },
  )
})

export const watchTickets = Effect.fn('Discovery.watch')(function* () {
  const settings = yield* Settings
  const target = yield* DiscoverySettings
  const workspace = yield* Workspace
  yield* workspace.inspectBase(target)
  yield* Effect.logInfo(`Watching team ${settings.teamId} for ai-workflow tickets; repository ${target.repo}`)
  return yield* discoverTickets().pipe(
    Effect.catchAll((failure) => Effect.logError(failure.message)),
    Effect.repeat(Schedule.spaced(`${settings.pollSeconds} seconds`)),
  )
})
