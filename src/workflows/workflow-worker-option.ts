import { Options } from '@effect/cli'

import { workerGroups } from './workflow-engine'

// Shares the worker selection option across feature commands, preserving local execution as the default.

export const workflowWorkerOption = Options.choice('worker', workerGroups).pipe(
  Options.withDefault('local'),
  Options.withDescription('Workflow shard group; local targets the local worker'),
)
