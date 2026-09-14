import { Command } from '@effect/cli'
import { BunContext, BunRuntime } from '@effect/platform-bun'
import { Effect } from 'effect'

import { rootRuntime } from './runtime/layers/root'
import { statusCommand, listCommand, pauseCommand, resumeCommand } from './ticket.command'

// Composes feature commands at the CLI process boundary and disposes the shared root runtime on exit.

const command = Command.make('linear-ai-workflow').pipe(
  Command.withSubcommands([statusCommand, listCommand, pauseCommand, resumeCommand]),
)
Command.run(command, { name: 'Linear AI Workflow', version: '0.1.0' })(process.argv).pipe(
  Effect.provide(BunContext.layer),
  Effect.tapErrorCause(Effect.logError),
  Effect.ensuring(rootRuntime.disposeEffect),
  BunRuntime.runMain,
)
