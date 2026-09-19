import { Layer } from 'effect'

import { Db } from '../db/live'
import { Store } from '../store'
import { TestPgClientLive } from './pg-client'

// Shares the disposable Postgres client between production Drizzle queries, workflow storage, and direct test assertions.

export const TestDatabaseLive = Db.layer.pipe(Layer.provideMerge(TestPgClientLive))
export const TestStoreLive = Store.layer.pipe(Layer.provideMerge(TestDatabaseLive))
