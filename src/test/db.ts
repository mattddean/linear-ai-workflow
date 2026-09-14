import { Layer } from 'effect'

import { DbLive } from '../db/live'
import { StoreLive } from '../store'
import { TestPgClientLive } from './pg-client'

// Shares the disposable Postgres client between production Drizzle queries, workflow storage, and direct test assertions.

export const TestDatabaseLive = DbLive.pipe(Layer.provideMerge(TestPgClientLive))
export const TestStoreLive = StoreLive.pipe(Layer.provideMerge(TestDatabaseLive))
