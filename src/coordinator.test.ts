import { expect, test } from 'bun:test'
import { Effect, Logger, Layer } from 'effect'

import { Agent } from './agent'
import { Coordinator } from './coordinator'
import { CommentId } from './domain'
import { blocked, humanAnswer, validateResult } from './handoff'
import { Store } from './store'
import { fixture, makeRun, ready, settings, sha, userId } from './test/fixtures'

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
  expect(f.acknowledgements[0]?.commentId).toBeUndefined()
  expect(f.acknowledgements[0]?.issueId).toBe(f.state.run.issueId)
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
  expect(f.comments.at(-1)?.body).toContain('tokens 10000/10000 (resume --extra-tokens)')
})

test('time exhaustion identifies the limit without calling the agent', async () => {
  const f = fixture({ ...makeRun(), activeMillis: 600000 })
  expect(await execute(f)).toBe('wait')
  expect(f.state.calls).toBe(0)
  expect(f.comments.at(-1)?.body).toContain('active minutes 10/10 (resume --extra-minutes)')
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
  expect(publication.body).toContain('Reply in this thread')
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
  expect(f.comments.at(-1)?.body).toContain('implementation attempts 3/3 (resume --extra-attempts)')
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

test('human reply acknowledgement reacts directly to the comment and precedes resumed agent execution', async () => {
  const responseCommentId = CommentId.make(crypto.randomUUID())
  const f = fixture({ ...makeRun(), sequence: 1, answer: 'Try now', responseCommentId })
  f.state.agentResult = (run) => {
    expect(f.acknowledgements).toHaveLength(1)
    expect(f.acknowledgements[0]?.commentId).toBe(responseCommentId)
    return ready(run)
  }
  expect(await execute(f)).toBe('continue')
  expect(f.state.run.responseCommentId).toBeUndefined()
  expect(f.comments).toHaveLength(1)
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
  const f = fixture({ ...makeRun(), tokens: 12000, cachedTokens: 11000 })
  expect(await execute(f)).toBe('continue')
  expect(f.state.calls).toBe(1)
  expect(f.state.run.tokens).toBe(12100)
  expect(f.state.run.cachedTokens).toBe(11000)
  const exhausted = fixture({ ...makeRun(), tokens: 12000, cachedTokens: 2000 })
  expect(await execute(exhausted)).toBe('wait')
  expect(exhausted.state.calls).toBe(0)
})

test('an existing run uses changed configuration while retaining its usage counters', async () => {
  const prepared = fixture()
  await execute(prepared)
  const run = { ...prepared.state.run, tokens: 10000, activeMillis: 600000, attempts: 3 }
  const blockedRun = fixture(run)
  expect(await execute(blockedRun)).toBe('wait')
  const reconfigured = fixture(run, { ...settings, maxTokens: 20000, maxMinutes: 20, maxAttempts: 6 })
  reconfigured.comments.push(...prepared.comments)
  expect(await execute(reconfigured)).toBe('continue')
  expect(reconfigured.state.calls).toBe(1)
  expect(reconfigured.state.run.tokens).toBe(10100)
  expect(reconfigured.state.run.attempts).toBe(4)
  expect(run.attempts).toBe(3)
})

test('an explicit token override is enforced while time follows configuration', async () => {
  const f = fixture(
    { ...makeRun(), tokens: 10000, activeMillis: 600000, budgetOverrides: { maxTokens: 10000 } },
    { ...settings, maxTokens: 20000, maxMinutes: 20 },
  )
  expect(await execute(f)).toBe('wait')
  expect(f.state.calls).toBe(0)
  expect(f.comments.at(-1)?.body).toContain('tokens 10000/10000')
  expect(f.comments.at(-1)?.body).not.toContain('active minutes')
})

test('Developer progress is published during execution without invalidating the refinement or creating a handoff', async () => {
  const f = fixture()
  await execute(f)
  const refinement = f.state.run.refinementCommentId
  f.state.progressMessages = [{ key: 'item_1', message: 'Implemented the upload flow; checking retries.' }]
  f.state.agentResult = (run) => {
    expect(f.progressComments).toHaveLength(2)
    expect(f.progressComments[0]?.body).toContain(run.workspace)
    expect(f.progressComments[0]?.body).toContain(`'open' '${run.id}'`)
    expect(f.progressComments[1]?.body).toContain('Implemented the upload flow')
    expect(f.state.run.predecessorId).toBe(refinement)
    return ready(run)
  }
  expect(await execute(f)).toBe('continue')
  expect(f.state.run.phase).toBe('verification')
  expect(f.state.run.refinementCommentId).toBe(refinement)
  expect(f.state.posts).toBe(2)
  expect(f.state.journals.get(1)?.progressComments?.every((item) => item.commentId !== null)).toBe(true)
})

test('ambiguous progress is reconciled from its saved intent before the final handoff', async () => {
  const f = fixture()
  await execute(f)
  f.state.ambiguousProgress = true
  expect(await execute(f)).toBe('continue')
  expect(f.progressComments).toHaveLength(1)
  expect(f.state.calls).toBe(2)
  expect(f.state.run.phase).toBe('verification')
})

test('unrecorded progress-looking comments still return work to PM', async () => {
  const f = fixture()
  await execute(f)
  f.state.agentResult = (run) => {
    f.comments.push({
      id: CommentId.make(crypto.randomUUID()),
      body: `<!-- linear-ai-workflow:${run.id}/${run.sequence}/progress/99 -->\nNew requirement`,
      createdAt: new Date().toISOString(),
      user: { id: userId },
    })
    return ready(run)
  }
  expect(await execute(f)).toBe('continue')
  expect(f.state.run.phase).toBe('refinement')
})

test('a canceled Linear ticket cannot begin an assignment or publish an acknowledgement', async () => {
  const f = fixture()
  f.state.canceled = true
  expect(await execute(f)).toBe('complete')
  expect(f.state.run.status).toBe('canceling')
  expect(f.state.calls).toBe(0)
  expect(f.acknowledgements).toHaveLength(0)
  expect(f.state.posts).toBe(0)
  expect(f.state.journals.size).toBe(0)
})

test('persisted cancellation interrupts active work and suppresses its handoff', async () => {
  const f = fixture()
  let stopped = false
  const agent = Agent.of({
    execute: () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            stopped = true
          }),
        )
        yield* f.store.cancel(f.state.run.id)
        return yield* Effect.never
      }).pipe(Effect.scoped),
  })
  const result = await Effect.runPromise(
    Effect.flatMap(Coordinator, (coordinator) => coordinator.step({ id: f.state.run.id, sequence: 0 })).pipe(
      Effect.provide(
        Coordinator.layer.pipe(
          Layer.provide(Layer.succeed(Agent, agent)),
          Layer.provide(f.dependencies),
          Layer.provide(Layer.succeed(Store, f.store)),
        ),
      ),
      Effect.timeout('4 seconds'),
    ),
  )
  expect(result).toBe('complete')
  expect(stopped).toBe(true)
  expect(f.state.run.status).toBe('canceling')
  expect(f.state.posts).toBe(0)
})

test('handoffs create new threads while reports and Developer progress stay under their role root', async () => {
  const f = fixture()
  for (let sequence = 0; sequence < 4; sequence++) await execute(f)
  expect(f.roots).toHaveLength(4)
  expect(new Set(f.roots.map((root) => root.id)).size).toBe(4)
  for (const [sequence, journal] of f.state.journals) {
    const root = f.roots[sequence]
    expect(journal.assignment.run.threadCommentId).toBe(root?.id)
    expect(f.publications.find((item) => item.id === journal.commentId)?.parentId).toBe(root?.id)
    for (const progress of journal.progressComments ?? [])
      expect(f.publications.find((item) => item.id === progress.commentId)?.parentId).toBe(root?.id)
    expect(root?.body).toContain('+++ Workflow details')
    expect(root?.body).toContain('<!-- linear-ai-workflow:')
  }
  expect(f.comments.every((comment) => !comment.body.includes('linear-ai-workflow:'))).toBe(true)
  expect(f.progressComments.every((comment) => !comment.body.includes('linear-ai-workflow:'))).toBe(true)
})

test('ambiguous handoffs reuse their recorded thread, publication ID, and session without rerunning', async () => {
  const f = fixture()
  await execute(f)
  f.state.ambiguous = true
  const failure = await execute(f).then(
    () => '',
    (cause: unknown) => String(cause),
  )
  expect(failure).toContain('Timed out after publication')
  const root = f.state.run.threadCommentId
  const session = f.state.run.codexSessionId
  const journal = f.state.journals.get(1)
  expect(root).toBe(f.roots[1]?.id)
  expect(session).toBeDefined()
  const calls = f.state.calls
  expect(await execute(f)).toBe('continue')
  expect(f.state.calls).toBe(calls)
  expect(f.roots).toHaveLength(2)
  expect(f.state.run.codexSessionId).toBeUndefined()
  expect(f.comments.at(-1)?.id).toBe(journal?.publicationId)
})

test('a human continuation preserves its role thread and Codex session, then clears them on handoff', async () => {
  const f = fixture()
  f.state.agentResult = (run) => blocked(run, 'Connect the device')
  expect(await execute(f)).toBe('wait')
  const threadCommentId = f.state.run.threadCommentId
  const codexSessionId = f.state.run.codexSessionId
  expect(codexSessionId).toBeDefined()
  f.state.run = {
    ...f.state.run,
    status: 'queued',
    answer: 'Connected',
    responseCommentId: CommentId.make(crypto.randomUUID()),
  }
  f.state.agentResult = (run) => {
    expect(run.threadCommentId).toBe(threadCommentId)
    expect(run.codexSessionId).toBe(codexSessionId)
    return ready(run)
  }
  expect(await execute(f)).toBe('continue')
  expect(f.roots).toHaveLength(1)
  expect(f.state.run.threadCommentId).toBeUndefined()
  expect(f.state.run.codexSessionId).toBeUndefined()
})

test('untagged coordinator publications cannot be interpreted as human answers', () => {
  const publication = {
    id: CommentId.make(crypto.randomUUID()),
    body: 'Question',
    createdAt: '2026-01-01T00:00:00Z',
    user: { id: userId },
  }
  const progress = { ...publication, id: CommentId.make(crypto.randomUUID()), body: 'Developer: Checking the build' }
  expect(humanAnswer({ publication, replies: [progress], publicationIds: [progress.id] })).toBeUndefined()
})

test('an unresolved session blocks continuation instead of silently replacing the session', async () => {
  const f = fixture({
    ...makeRun(),
    threadCommentId: CommentId.make(crypto.randomUUID()),
    codexSessionUnresolved: true,
  })
  expect(await execute(f)).toBe('wait')
  expect(f.state.calls).toBe(0)
  expect(f.state.run.question).toContain('cannot silently start')
})

test('ambiguous thread creation is reconciled before the session starts', async () => {
  const f = fixture()
  f.state.ambiguousRoot = true
  const failure = await execute(f).then(
    () => '',
    (cause: unknown) => String(cause),
  )
  expect(failure).toContain('Timed out after thread publication')
  expect(f.state.calls).toBe(0)
  expect(f.state.journals.get(0)?.threadPublished).toBe(false)
  expect(await execute(f)).toBe('continue')
  expect(f.roots).toHaveLength(1)
  expect(f.state.calls).toBe(1)
})

test('questions remain outside collapsed workflow metadata', async () => {
  const f = fixture()
  f.state.agentResult = (run) => blocked(run, 'Connect the device')
  await execute(f)
  const body = f.comments[0]?.body ?? ''
  expect(body.indexOf('Connect the device')).toBeLessThan(body.indexOf('+++ Workflow details'))
  expect(body).toContain('Session: ')
  expect(body).not.toContain('linear-ai-workflow:')
})

test('a confirmed thread resumes startup after a crash before the agent was dispatched', async () => {
  const f = fixture()
  f.state.ambiguousRoot = true
  await execute(f).catch(() => undefined)
  const journal = f.state.journals.get(0)
  if (!journal) throw new Error('Expected thread intent')
  f.state.journals.set(0, {
    ...journal,
    threadPublished: true,
    state: 'started',
    assignment: { ...journal.assignment, snapshot: { ...f.state.snapshot, comments: f.roots } },
  })
  expect(await execute(f)).toBe('continue')
  expect(f.state.calls).toBe(1)
  expect(f.roots).toHaveLength(1)
})
