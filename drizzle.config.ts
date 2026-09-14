import { defineConfig } from 'drizzle-kit'

import { env } from './src/env'

// Points Drizzle tooling at the application schema and configured database, limiting schema pushes to coordinator tables.

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: env.DATABASE_URL },
  tablesFilter: ['workflow_runs', 'workflow_assignments', 'workflow_worker_owners'],
})
