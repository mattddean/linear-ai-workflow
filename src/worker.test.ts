import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Effect, Exit, Layer, Scope } from 'effect'

import { Settings } from './config'
import { Db } from './db/live'
import { workflow_worker_owners } from './db/schema'
import { WorkerId } from './domain'
import { TestDatabaseLive } from './test/db'
import { settings } from './test/fixtures'
import { acquireWorkerLock, ensureOwner } from './worker'

// Verifies worker ownership and advisory-lock exclusion through competing real Postgres sessions.

test('worker ownership is persisted and a competing session cannot hold the same group lock', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ownerScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      yield* acquireWorkerLock('local').pipe(Scope.extend(ownerScope))
      const db = yield* Db
      const owners = yield* db
        .select()
        .from(workflow_worker_owners)
        .where(eq(workflow_worker_owners.worker_group, 'local'))
      expect(owners).toEqual([{ worker_group: 'local', worker_id: settings.workerId }])
      yield* ensureOwner('local')
      const wrongOwner = yield* ensureOwner('local').pipe(
        Effect.provideService(Settings, { ...settings, workerId: WorkerId.make('another-machine') }),
        Effect.exit,
      )
      expect(wrongOwner._tag).toBe('Failure')
      // Each reserve uses a different session, so PostgreSQL itself arbitrates the competing claim.
      const competing = yield* acquireWorkerLock('local').pipe(Effect.scoped, Effect.exit)
      expect(competing._tag).toBe('Failure')
      yield* Scope.close(ownerScope, Exit.void)
      yield* acquireWorkerLock('local').pipe(Effect.scoped)
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(TestDatabaseLive, Layer.succeed(Settings, settings))),
      Effect.timeout('5 seconds'),
    ),
  )
})
