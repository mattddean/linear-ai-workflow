import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Effect } from 'effect'

import { DiscoverySettings } from './config'
import { Db } from './db/live'
import { workflow_runs, workflow_worker_owners } from './db/schema'
import { discoverTickets, watchTickets } from './discovery'
import { Branch, CommitSha, WorkerId, error } from './domain'
import { Linear } from './linear.client'
import { Store } from './store'
import { TestStoreLive } from './test/db'
import { fixture, makeRun, settings, sha } from './test/fixtures'
import { testRuntime } from './test/runtime/root'
import { Workspace } from './workspace'

// Verifies automatic discovery, cross-session enrollment, and restart behavior using real persisted database rows.

test('concurrent enrollment is unique across groups, restarts, and PM acceptance', async () => {
  const run = makeRun()
  const candidates = [run, { ...run, id: makeRun().id, workerGroup: 'default' as const }]
  const enroll = (candidate: typeof run) =>
    Effect.flatMap(Store, (store) => store.enroll(candidate)).pipe(Effect.provide(TestStoreLive))
  const results = await Promise.all(candidates.map((candidate) => Effect.runPromise(enroll(candidate))))
  expect(results.filter(Boolean)).toHaveLength(1)
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Db
      const store = yield* Store
      const rows = yield* db.select().from(workflow_runs).where(eq(workflow_runs.issue_id, run.issueId))
      expect(rows).toHaveLength(1)
      const row = rows[0]
      if (!row) throw new Error('Expected enrolled row')
      const enrolled = yield* store.get(row.id)
      expect(enrolled.status).toBe('queued')
      yield* store.save({ ...enrolled, status: 'approved' })
      // A new layer/session must see accepted history, not only the partial active-issue index.
      expect(yield* enroll({ ...run, id: makeRun().id })).toBe(false)
      expect(yield* db.select().from(workflow_runs).where(eq(workflow_runs.issue_id, run.issueId))).toHaveLength(1)
      expect((yield* store.get(row.id)).status).toBe('approved')
    }).pipe(Effect.provide(TestStoreLive)),
  )
})

test('discovery persists configured work offline and picks up labels added on a later scan', async () => {
  const f = fixture()
  const second = fixture()
  const issues = [f.state.snapshot.issue]
  let baseSha = sha
  const workspace = Workspace.of({
    ...f.workspace,
    inspectBase: (target) => Effect.sync(() => ({ repo: target.repo, baseSha })),
  })
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db
      const store = yield* Store
      yield* discoverTickets()
      baseSha = CommitSha.make('b'.repeat(40))
      issues.push(second.state.snapshot.issue)
      yield* discoverTickets()
      yield* discoverTickets()
      const rows = yield* db
        .select()
        .from(workflow_runs)
        .where(
          inArray(
            workflow_runs.issue_id,
            issues.map((issue) => issue.id),
          ),
        )
      expect(rows).toHaveLength(2)
      expect(rows.find((row) => row.issue_id === f.state.run.issueId)?.data).toMatchObject({
        repo: f.state.run.repo,
        base_sha: sha,
        worker_group: 'local',
        worker_id: settings.workerId,
        status: 'queued',
        phase: 'refinement',
        max_attempts: 3,
        max_minutes: 120,
        max_tokens: 1000000,
      })
      expect(rows.find((row) => row.issue_id === second.state.run.issueId)?.data.base_sha).toBe(baseSha)
      expect(f.state.calls).toBe(0)
      const [owner] = yield* db
        .select()
        .from(workflow_worker_owners)
        .where(eq(workflow_worker_owners.worker_group, 'local'))
      expect(owner?.worker_id).toBe(settings.workerId)
      const foreignRun = { ...makeRun(), workerId: WorkerId.make('another-machine') }
      const refused = yield* store.enroll(foreignRun).pipe(Effect.result)
      expect(refused._tag).toBe('Failure')
      if (refused._tag === 'Failure') expect(refused.failure.kind).toBe('blocked')
      expect(yield* db.select().from(workflow_runs).where(eq(workflow_runs.id, foreignRun.id))).toHaveLength(0)
      for (const row of rows) yield* store.save({ ...(yield* store.get(row.id)), status: 'approved' })
    }).pipe(
      Effect.provideService(Linear, { ...f.linear, discover: Effect.sync(() => [...issues]) }),
      Effect.provideService(Workspace, workspace),
      Effect.provideService(DiscoverySettings, { repo: f.state.run.repo, base: Branch.make('main') }),
      Effect.provide(f.dependencies),
    ),
  )
})

test('watcher retries failed discovery and finds tickets that arrive after startup', async () => {
  const f = fixture()
  let scans = 0
  const discover = Effect.suspend(() => {
    scans += 1
    if (scans === 1) return Effect.fail(error('transport', 'Temporary Linear outage'))
    return Effect.succeed(scans === 2 ? [] : [f.state.snapshot.issue])
  })
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* Db
      const store = yield* Store
      yield* watchTickets().pipe(Effect.forkScoped)
      for (;;) {
        const [row] = yield* db.select().from(workflow_runs).where(eq(workflow_runs.issue_id, f.state.run.issueId))
        if (row) {
          expect(scans).toBeGreaterThanOrEqual(3)
          expect(row.data.status).toBe('queued')
          yield* store.save({ ...(yield* store.get(row.id)), status: 'approved' })
          break
        }
        yield* Effect.sleep('20 millis')
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(Linear, { ...f.linear, discover }),
      Effect.provideService(DiscoverySettings, { repo: f.state.run.repo, base: Branch.make('main') }),
      Effect.provide(f.dependencies),
      Effect.timeout('5 seconds'),
    ),
  )
}, 10000)
