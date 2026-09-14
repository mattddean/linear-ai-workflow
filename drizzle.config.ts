import { defineConfig } from 'drizzle-kit'

// Points Drizzle tooling at the application schema and configured database, limiting schema pushes to coordinator tables.

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  tablesFilter: ['workflow_runs', 'workflow_assignments', 'workflow_worker_owners'],
})
