import type { Redacted } from 'effect'

import { Config, Context, Layer } from 'effect'
import { hostname } from 'node:os'
import { resolve } from 'node:path'

import { Path, TeamId, WorkerId } from './domain'

export class Settings extends Context.Tag('Settings')<
  Settings,
  {
    readonly linearKey: Redacted.Redacted<string>
    readonly teamId: typeof TeamId.Type
    readonly worktreeRoot: Path
    readonly artifactRoot: Path
    readonly workerId: typeof WorkerId.Type
    readonly runnerHost: string
    readonly runnerPort: number
    readonly pollSeconds: number
  }
>() {}
export const SettingsLive = Layer.effect(
  Settings,
  Config.all({
    workerId: Config.string('WORKER_ID').pipe(Config.withDefault(hostname()), Config.mapAttempt(WorkerId.make)),
    runnerHost: Config.string('WORKFLOW_RUNNER_HOST').pipe(Config.withDefault('127.0.0.1')),
    runnerPort: Config.integer('WORKFLOW_RUNNER_PORT').pipe(Config.withDefault(34541)),
    linearKey: Config.redacted('LINEAR_API_KEY'),
    teamId: Config.string('LINEAR_TEAM_ID').pipe(Config.mapAttempt(TeamId.make)),
    worktreeRoot: Config.string('WORKTREE_ROOT').pipe(
      Config.withDefault(resolve('.worktrees')),
      Config.mapAttempt(Path.make),
    ),
    artifactRoot: Config.string('ARTIFACT_ROOT').pipe(
      Config.withDefault(resolve('.artifacts')),
      Config.mapAttempt(Path.make),
    ),
    pollSeconds: Config.integer('POLL_SECONDS').pipe(
      Config.withDefault(30),
      Config.validate({ message: 'Must be positive', validation: (n) => n > 0 }),
    ),
  }),
)
