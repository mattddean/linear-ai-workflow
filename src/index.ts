import { BunRuntime } from '@effect/platform-bun'
import { Effect } from 'effect'

import { DiscoverySettingsLive } from './config'
import { watchTickets } from './discovery'
import { rootRuntime } from './runtime/layers/root'

// Starts the long-running ticket watcher as the coordinator’s development process.

watchTickets().pipe(
  Effect.provide(DiscoverySettingsLive),
  Effect.provide(rootRuntime),
  Effect.tapErrorCause(Effect.logError),
  Effect.ensuring(rootRuntime.disposeEffect),
  BunRuntime.runMain,
)
