import { Context, Layer, Redacted } from 'effect'

import type { WorkerGroup } from './domain'

import { Path, TeamId, WorkerId, Branch } from './domain'
import { env } from './env'

// Adapts the validated environment into replaceable Effect settings services and redacts the Linear credential.

export class Settings extends Context.Service<
  Settings,
  {
    readonly linearKey: Redacted.Redacted<string>
    readonly teamId: typeof TeamId.Type
    readonly isolateRoot: Path
    readonly artifactRoot: Path
    readonly workerGroup: WorkerGroup
    readonly workerId: typeof WorkerId.Type
    readonly runnerHost: string
    readonly runnerPort: number
    readonly pollSeconds: number
    readonly maxAttempts: number
    readonly maxTokens: number
    readonly maxMinutes: number
  }
>()('linear-ai-workflow/config/Settings') {
  static readonly layer = Layer.succeed(Settings, {
    workerGroup: env.WORKFLOW_SHARD_GROUP,
    workerId: WorkerId.make(env.WORKER_ID),
    runnerHost: env.WORKFLOW_RUNNER_HOST,
    runnerPort: env.WORKFLOW_RUNNER_PORT,
    linearKey: Redacted.make(env.LINEAR_API_KEY),
    teamId: TeamId.make(env.LINEAR_TEAM_ID),
    isolateRoot: Path.make(env.ISOLATE_ROOT),
    artifactRoot: Path.make(env.ARTIFACT_ROOT),
    pollSeconds: env.POLL_SECONDS,
    maxAttempts: env.RUN_MAX_ATTEMPTS,
    maxTokens: env.RUN_MAX_TOKENS,
    maxMinutes: env.RUN_MAX_MINUTES,
  })
}

export class DiscoverySettings extends Context.Service<
  DiscoverySettings,
  {
    readonly repo: Path
    readonly base: typeof Branch.Type
  }
>()('linear-ai-workflow/config/DiscoverySettings') {
  static readonly layer = Layer.succeed(DiscoverySettings, {
    repo: Path.make(env.REPOSITORY_PATH),
    base: Branch.make(env.BASE_BRANCH),
  })
}
