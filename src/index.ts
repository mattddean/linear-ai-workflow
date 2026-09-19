import { BunRuntime } from '@effect/platform-bun'
import { Effect } from 'effect'

import { DiscoverySettings } from './config'
import { watchTickets } from './discovery'
import { rootRuntime } from './runtime/layers/root'

// Starts the long-running ticket watcher as the coordinator’s development process.

rootRuntime.contextEffect.pipe(
  Effect.flatMap((context) => watchTickets().pipe(Effect.provide(context))),
  Effect.provide(DiscoverySettings.layer),
  Effect.tapCause(Effect.logError),
  Effect.ensuring(rootRuntime.disposeEffect),
  BunRuntime.runMain,
)
