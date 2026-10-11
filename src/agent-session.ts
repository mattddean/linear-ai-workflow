import { Option, Schema } from 'effect'

import { CodexSessionId } from './domain'

// Decodes Codex's session identity from its persisted JSON event stream.

const SessionEvent = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal('thread.started'),
    thread_id: CodexSessionId,
  }),
)

export function agentSession(log: string): CodexSessionId | undefined {
  for (const line of log.split('\n')) {
    const event = Schema.decodeUnknownOption(SessionEvent)(line)
    if (Option.isSome(event)) return event.value.thread_id
  }
}
