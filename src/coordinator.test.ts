import { expect, test } from 'bun:test'
import { Effect, Logger } from 'effect'

import { Coordinator } from './coordinator'
import { CommentId } from './domain'
import { blocked, humanAnswer, validateResult } from './handoff'
import { fixture, makeRun, ready, sha, userId } from './test/fixtures'

// Verifies role sequencing and recovery gates using fake agents, Linear comments, workspaces, and persistence.

const execute = (f: ReturnType<typeof fixture>, sequence = f.state.run.sequence) =>
  Effect.runPromise(
    Effect.flatMap(Coordinator, (coordinator) => coordinator.step({ id: f.state.run.id, sequence })).pipe(
      Effect.provide(f.layer),
    ),
  )

test('PM → Developer → QA → PM accepts the same refinement and commit', async () => {
  const f = fixture()
  for (let i = 0; i < 4; i++) expect(await execute(f)).toBe(i === 3 ? 'complete' : 'continue')
  expect(f.acknowledgements).toHaveLength(1)
  expect(f.acknowledgements[0]?.parentId).toBeUndefined()
  expect(f.acknowledgements[0]?.comment.body).toEndWith('\n👀')
  expect(f.state.run.status).toBe('approved')
  expect(f.state.run.commitSha).toBe(sha)
  expect(f.state.run.refinementCommentId).toBe(f.comments[0]?.id ?? null)
  expect(f.state.calls).toBe(4)
  expect(f.state.posts).toBe(4)
})

test('QA rework goes back through Developer and QA', async () => {
  const f = fixture()
  await execute(f)
  await execute(f)
  f.state.agentResult = (run) => ({
    ...ready(run),
    outcome: 'changes-required',
    nextRole: 'developer',
    nextPhase: 'implementation',
    report: 'QA-1: fails AC-1',
  })
  await execute(f)
  expect(f.state.run.phase).toBe('implementation')
  f.state.agentResult = ready
  await execute(f)
  expect(f.state.run.phase).toBe('verification')
})

test('invalid approval from Developer blocks instead of advancing', async () => {
  const f = fixture()
  await execute(f)
  f.state.agentResult = (run) => ({ ...ready(run), outcome: 'approved', nextRole: null, nextPhase: null })
  expect(await execute(f)).toBe('wait')
  expect(f.state.run.status).toBe('blocked')
})

test('budget exhaustion blocks without calling the agent', async () => {
  const f = fixture({ ...makeRun(), tokens: 10000 })
  expect(await execute(f)).toBe('wait')
  expect(f.state.calls).toBe(0)
})

test('interrupted assignment requires human reconciliation and never repeats code automatically', async () => {
  const f = fixture()
  f.state.journals.set(0, {
    assignment: { run: f.state.run, snapshot: f.state.snapshot, artifactDir: f.state.run.workspace },
    state: 'started',
    agentStarted: true,
    result: null,
    body: null,
    commentId: null,
    tokens: 0,
    elapsedMillis: 0,
    stepResult: null,
  })
  expect(await execute(f)).toBe('wait')
  expect(f.state.calls).toBe(0)
  expect(f.state.run.question).toContain('interrupted')
})

test('changed requirements route to PM without executing a stale implementation', async () => {
  const f = fixture()
  await execute(f)
  f.state.snapshot.issue.title = 'Changed'
  await execute(f)
  expect(f.state.run.phase).toBe('refinement')
  expect(f.state.calls).toBe(1)
})

test('blocked agent asks for a direct reply and accepts its full text without an ID', async () => {
  const f = fixture()
  f.state.agentResult = (run) => blocked(run, 'Please connect the device')
  expect(await execute(f)).toBe('wait')
  expect(f.state.run.phase).toBe('refinement')
  const publication = f.comments[0]
  if (!publication) throw new Error('Expected publication')
  expect(publication.body).toContain('Reply directly to this comment')
  expect(publication.body).not.toContain('Q-')
  const answer = {
    id: CommentId.make(crypto.randomUUID()),
    body: 'Ready\nThe device is connected.',
    createdAt: new Date().toISOString(),
    user: { id: userId },
  }
  expect(humanAnswer({ publication, replies: [answer] })?.body).toBe(answer.body)
  expect(humanAnswer({ publication, replies: [] })).toBeUndefined()
  expect(humanAnswer({ publication, replies: [{ ...answer, body: '  ' }, answer] })?.id).toBe(answer.id)
  expect(humanAnswer({ publication, replies: [{ ...answer, user: null }] })).toBeUndefined()
  expect(humanAnswer({ publication, replies: [{ ...answer, createdAt: '2000-01-01T00:00:00Z' }] })).toBeUndefined()
})

test('stale refinement and review commits are rejected', async () => {
  const run = {
    ...makeRun(),
    phase: 'verification' as const,
    commitSha: sha,
    refinementCommentId: CommentId.make(crypto.randomUUID()),
  }
  await expect(
    Effect.runPromise(validateResult({ run, result: { ...ready(run), refinementCommentId: null } })),
  ).rejects.toThrow('stale refinement')
  await expect(Effect.runPromise(validateResult({ run, result: { ...ready(run), commitSha: null } }))).rejects.toThrow(
    'different commit',
  )
})

test('a scope change during final review prevents publishing an approval', async () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) await execute(f)
  f.state.agentResult = (run) => {
    f.state.snapshot.issue.title = 'New acceptance requirement'
    return ready(run)
  }
  expect(await execute(f)).toBe('continue')
  expect(f.state.run.phase).toBe('refinement')
  expect(f.comments.at(-1)?.body).toContain('Outcome: changes-required')
  expect(f.state.run.status).not.toBe('approved')
})

test('budget-blocked implementation does not consume another attempt', async () => {
  const f = fixture()
  await execute(f)
  f.state.run = { ...f.state.run, attempts: 3 }
  expect(await execute(f)).toBe('wait')
  expect(f.state.run.attempts).toBe(3)
  expect(f.state.calls).toBe(1)
})

test('acknowledgements reconcile after an ambiguous write before executing the agent', async () => {
  const f = fixture()
  f.state.ambiguousAcknowledgement = true
  const result = await Effect.runPromise(
    Effect.flatMap(Coordinator, (coordinator) => coordinator.step({ id: f.state.run.id, sequence: 0 })).pipe(
      Effect.provide(f.layer),
      Effect.exit,
    ),
  )
  expect(result._tag).toBe('Failure')
  expect(f.state.journals.get(0)?.state).toBe('acknowledging')
  expect(f.state.calls).toBe(0)
  expect(f.acknowledgements).toHaveLength(1)
  expect(await execute(f)).toBe('continue')
  expect(f.acknowledgements).toHaveLength(1)
  expect(f.state.calls).toBe(1)
  expect(f.state.run.phase).toBe('implementation')
})

test('human reply acknowledgement is threaded and precedes resumed agent execution', async () => {
  const responseCommentId = CommentId.make(crypto.randomUUID())
  const f = fixture({ ...makeRun(), sequence: 1, answer: 'Try now', responseCommentId })
  f.state.agentResult = (run) => {
    expect(f.acknowledgements).toHaveLength(1)
    expect(f.acknowledgements[0]?.parentId).toBe(responseCommentId)
    return ready(run)
  }
  expect(await execute(f)).toBe('continue')
  expect(f.state.run.responseCommentId).toBeUndefined()
  const acknowledgement = f.acknowledgements[0]?.comment
  const publication = f.comments[0]
  if (!acknowledgement || !publication) throw new Error('Expected comments')
  expect(
    humanAnswer({ publication: { ...publication, createdAt: acknowledgement.createdAt }, replies: [acknowledgement] }),
  ).toBeUndefined()
})

test('local progress logs identify the ticket and role through assignment and handoff', async () => {
  const f = fixture()
  const logs: string[] = []
  const logger = Logger.layer([
    Logger.map(Logger.formatSimple, (line) => {
      logs.push(line)
    }),
  ])
  await Effect.runPromise(
    Effect.flatMap(Coordinator, (coordinator) => coordinator.step({ id: f.state.run.id, sequence: 0 })).pipe(
      Effect.provide(f.layer),
      Effect.provide(logger),
    ),
  )
  for (const message of [
    'Publishing 👀 acknowledgement',
    'Preparing Whey isolate',
    'Starting Codex',
    'Codex finished',
    'Handoff confirmed',
  ]) {
    const line = logs.find((entry) => entry.includes(message))
    expect(line).toContain('ticket=ENG-1')
    expect(line).toContain(`run=${f.state.run.id}`)
    expect(line).toContain('role=pm')
    expect(line).toContain('sequence=0')
  }
})

test('cached input does not exhaust the execution budget and remains tracked separately', async () => {
  const f = fixture({ ...makeRun(), tokens: 12000, cachedTokens: 11000, maxTokens: 10000 })
  expect(await execute(f)).toBe('continue')
  expect(f.state.calls).toBe(1)
  expect(f.state.run.tokens).toBe(12100)
  expect(f.state.run.cachedTokens).toBe(11000)
  const exhausted = fixture({ ...makeRun(), tokens: 12000, cachedTokens: 2000, maxTokens: 10000 })
  expect(await execute(exhausted)).toBe('wait')
  expect(exhausted.state.calls).toBe(0)
})
