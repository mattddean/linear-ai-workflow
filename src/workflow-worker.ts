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
  yield* registerWorkflows(settings.workerGroup).pipe(Effect.andThen(Effect.never), Effect.raceFirst(heartbeat))
})

rootRuntime.contextEffect.pipe(
  Effect.flatMap((context) => runWorker().pipe(Effect.provide(context))),
  Effect.scoped,
  Effect.tapCause(Effect.logError),
  Effect.ensuring(rootRuntime.disposeEffect),
  BunRuntime.runMain,
)
