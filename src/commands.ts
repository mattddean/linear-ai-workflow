import { BunServices, BunRuntime } from '@effect/platform-bun'
import { Effect, Layer } from 'effect'
import { Command } from 'effect/unstable/cli'

import { rootRuntime } from './runtime/root'
import { statusCommand, listCommand, pauseCommand, resumeCommand } from './ticket.command'

// Composes feature commands at the CLI process boundary and disposes the shared root runtime on exit.

const command = Command.make('linear-ai-workflow').pipe(
  Command.withSubcommands([statusCommand, listCommand, pauseCommand, resumeCommand]),
  Command.provide(Layer.effectContext(rootRuntime.contextEffect)),
)
Command.run(command, { version: '0.1.0' }).pipe(
  Effect.provide(BunServices.layer),
  Effect.tapCause(Effect.logError),
  Effect.ensuring(rootRuntime.disposeEffect),
  BunRuntime.runMain,
)
