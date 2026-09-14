import type { Effect } from 'effect'

import { PgClient } from '@effect/sql-pg'
import * as PgDrizzle from 'drizzle-orm/effect-postgres'
import { Context, Layer, Redacted } from 'effect'

import { env } from '../env'
import * as schema from './schema'

// Provides the typed Drizzle Effect database and its shared Postgres client as composable layers.

export const PgClientLive = PgClient.layer({ url: Redacted.make(env.DATABASE_URL) })
const makeDb = PgDrizzle.makeWithDefaults({ schema })
export type Database = Omit<Effect.Effect.Success<typeof makeDb>, '$client'>
export class Db extends Context.Tag('Db')<Db, Database>() {}
export const DbLive = Layer.effect(Db, makeDb)
export const DatabaseLive = DbLive.pipe(Layer.provideMerge(PgClientLive))
