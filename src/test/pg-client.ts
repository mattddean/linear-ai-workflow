import { PgClient } from '@effect/sql-pg'
import { Config } from 'effect'

// Replaces the production SQL layer with real Postgres from the test preload, with no fallback to DATABASE_URL.

export const TestPgClientLive = PgClient.layerConfig({ url: Config.redacted('TEST_DATABASE_URL') })
