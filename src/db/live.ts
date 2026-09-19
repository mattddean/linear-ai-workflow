import type { Effect } from 'effect'

import { PgClient } from '@effect/sql-pg'
import * as PgDrizzle from 'drizzle-orm/effect-postgres'
import { Context, Layer, Redacted } from 'effect'

import { env } from '../env'

// Provides the typed Drizzle Effect database and its shared Postgres client as composable layers.

export const PgClientLive = PgClient.layer({ url: Redacted.make(env.DATABASE_URL) })
const makeDb = PgDrizzle.makeWithDefaults()
export type Database = Omit<Effect.Success<typeof makeDb>, '$client'>
export class Db extends Context.Service<Db, Database>()('linear-ai-workflow/db/Db') {
  static readonly layer = Layer.effect(Db, makeDb)
}
export const DatabaseLive = Db.layer.pipe(Layer.provideMerge(PgClientLive))
