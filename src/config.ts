import { Context, Layer, Redacted } from 'effect'

import type { WorkerGroup } from './domain'

import { Path, TeamId, WorkerId, Branch } from './domain'
import { env } from './env'

// Adapts the validated environment into replaceable Effect settings services and redacts the Linear credential.

export class Settings extends Context.Tag('Settings')<
  Settings,
  {
    readonly linearKey: Redacted.Redacted<string>
    readonly teamId: typeof TeamId.Type
    readonly worktreeRoot: Path
    readonly artifactRoot: Path
    readonly workerGroup: WorkerGroup
    readonly workerId: typeof WorkerId.Type
    readonly runnerHost: string
    readonly runnerPort: number
    readonly pollSeconds: number
  }
>() {}
export const SettingsLive = Layer.succeed(Settings, {
  workerGroup: env.WORKFLOW_SHARD_GROUP,
  workerId: WorkerId.make(env.WORKER_ID),
  runnerHost: env.WORKFLOW_RUNNER_HOST,
  runnerPort: env.WORKFLOW_RUNNER_PORT,
  linearKey: Redacted.make(env.LINEAR_API_KEY),
  teamId: TeamId.make(env.LINEAR_TEAM_ID),
  worktreeRoot: Path.make(env.WORKTREE_ROOT),
  artifactRoot: Path.make(env.ARTIFACT_ROOT),
  pollSeconds: env.POLL_SECONDS,
})

export class DiscoverySettings extends Context.Tag('DiscoverySettings')<
  DiscoverySettings,
  {
    readonly repo: Path
    readonly base: typeof Branch.Type
  }
>() {}

export const DiscoverySettingsLive = Layer.succeed(DiscoverySettings, {
  repo: Path.make(env.REPOSITORY_PATH),
  base: Branch.make(env.BASE_BRANCH),
})
