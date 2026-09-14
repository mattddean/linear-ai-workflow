import { Command } from '@effect/cli'
import { Console, Effect } from 'effect'
import { mkdir } from 'node:fs/promises'

import { Settings } from './config'
import { rootRuntime } from './runtime/layers/root'
import { acquireWorkerLock } from './worker'
import { registerWorkflows } from './workflows'
import { workflowWorkerOption } from './workflows/workflow-worker-option'

// Starts the selected worker, holds its execution lease, and registers its durable workflows and polling loop.

export const serveCommand = Command.make('serve', { worker: workflowWorkerOption }, ({ worker }) =>
  Effect.gen(function* () {
    const settings = yield* Settings
    yield* Effect.tryPromise(() => mkdir(settings.artifactRoot, { recursive: true }))
    const heartbeat = yield* acquireWorkerLock(worker)
    yield* Console.log(`Serving ${worker} on ${settings.runnerHost}:${settings.runnerPort}; model gpt-6-astra`)
    yield* Effect.gen(function* () {
      yield* registerWorkflows(worker)
      return yield* Effect.never
    }).pipe(Effect.raceFirst(heartbeat))
  }).pipe(Effect.scoped, Effect.provide(rootRuntime)),
)
