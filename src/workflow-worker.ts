import { BunRuntime } from '@effect/platform-bun'
import { Effect } from 'effect'
import { mkdir } from 'node:fs/promises'

import { Settings } from './config'
import { rootRuntime } from './runtime/layers/root'
import { acquireWorkerLock } from './worker'
import { registerWorkflows } from './workflows'

// Starts the persistent cluster worker and holds its machine lease until process shutdown.

const runWorker = Effect.fn('Worker.run')(function* () {
  const settings = yield* Settings
  yield* Effect.tryPromise(() => mkdir(settings.artifactRoot, { recursive: true }))
  const heartbeat = yield* acquireWorkerLock(settings.workerGroup)
  yield* Effect.logInfo(
    `Serving ${settings.workerGroup} on ${settings.runnerHost}:${settings.runnerPort}; model gpt-6-astra`,
  )
  yield* registerWorkflows(settings.workerGroup).pipe(Effect.zipRight(Effect.never), Effect.raceFirst(heartbeat))
})

runWorker().pipe(
  Effect.scoped,
  Effect.provide(rootRuntime),
  Effect.tapErrorCause(Effect.logError),
  Effect.ensuring(rootRuntime.disposeEffect),
  BunRuntime.runMain,
)
