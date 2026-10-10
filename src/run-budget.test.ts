import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'

import { Db } from './db/live'
import { workflow_runs } from './db/schema'
import { extendBudget, resolveBudget } from './run-budget'
import { Store } from './store'
import { makeRun } from './test/fixtures'
import { testRuntime } from './test/runtime/root'

// Verifies budget policy changes and explicit extensions across persisted run reloads.

const configured = { maxAttempts: 6, maxTokens: 5000000, maxMinutes: 480 }

test('a persisted run follows configuration and retains only explicit extensions', async () => {
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const store = yield* Store
      const db = yield* Db
      const run = { ...makeRun(), attempts: 3, tokens: 20000, activeMillis: 600000 }
      yield* store.create(run)
      const loaded = yield* store.get(run.id)
      expect(resolveBudget(loaded, configured)).toEqual(configured)
      const increased = { ...configured, maxAttempts: 10 }
      expect(resolveBudget(loaded, increased).maxAttempts).toBe(10)
      const overrides = extendBudget(loaded, configured, { maxAttempts: 2, maxTokens: 0, maxMinutes: 0 })
      yield* store.save({ ...loaded, budgetOverrides: overrides })
      const resumed = yield* store.get(run.id)
      expect(resumed.attempts).toBe(3)
      expect(resumed.tokens).toBe(20000)
      expect(resumed.activeMillis).toBe(600000)
      expect(resolveBudget(resumed, { ...configured, maxTokens: 9000000 })).toEqual({
        maxAttempts: 8,
        maxTokens: 9000000,
        maxMinutes: 480,
      })
      expect(extendBudget(resumed, configured, { maxAttempts: 1, maxTokens: 0, maxMinutes: 0 })).toEqual({
        maxAttempts: 9,
      })
      expect(extendBudget(loaded, configured, { maxAttempts: 0, maxTokens: 0, maxMinutes: 0 })).toEqual({})
      const [row] = yield* db.select().from(workflow_runs).where(eq(workflow_runs.id, run.id))
      expect(row?.data.budget_overrides).toEqual({ max_attempts: 8 })
      expect(row?.data).not.toHaveProperty('max_attempts')
      expect(row?.data).not.toHaveProperty('max_tokens')
      expect(row?.data).not.toHaveProperty('max_minutes')
    }),
  )
})
