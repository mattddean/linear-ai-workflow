import { createEnv } from '@t3-oss/env-core'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { z } from 'zod/v4'

// Validates the application environment once, following Junior’s shared env-core schema and defaults.

const zStr = z.string().min(1)
const zPath = zStr.startsWith('/')

export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    LINEAR_API_KEY: zStr,
    LINEAR_TEAM_ID: z.uuid(),
    REPOSITORY_PATH: zPath,
    BASE_BRANCH: zStr,
    WORKFLOW_SHARD_GROUP: z.enum(['default', 'local']).default('local'),
    WORKER_ID: zStr.default(hostname()),
    WORKTREE_ROOT: zPath.default(resolve('.worktrees')),
    ARTIFACT_ROOT: zPath.default(resolve('.artifacts')),
    WORKFLOW_RUNNER_HOST: zStr.default('127.0.0.1'),
    WORKFLOW_RUNNER_PORT: z.coerce.number().int().min(1).max(65535).default(34541),
    POLL_SECONDS: z.coerce.number().int().positive().default(30),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})
