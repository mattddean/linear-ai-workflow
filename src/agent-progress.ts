import { Option, Schema } from 'effect'
import { fileURLToPath } from 'node:url'

import type { Run } from './domain'

import { Result } from './domain'

// Extracts public Codex updates and formats the confirmed isolate milestone without exposing tool output or reasoning.

export type AgentProgress = { readonly key: string; readonly message: string }
const MessageEvent = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal('item.completed'),
    item: Schema.Struct({
      id: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
      type: Schema.Literal('agent_message'),
      text: Schema.String,
    }),
  }),
)
const decodeMessage = Schema.decodeUnknownOption(MessageEvent)
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Result))

export function agentProgress(line: string): AgentProgress | undefined {
  const event = decodeMessage(line)
  if (Option.isNone(event) || Option.isSome(decodeResult(event.value.item.text))) return
  const text = event.value.item.text.trim()
  if (text.length === 0) return
  return { key: event.value.item.id, message: text.length > 500 ? `${text.slice(0, 497)}…` : text }
}

export function isolateProgress(run: Run): AgentProgress {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const command = [
    process.execPath,
    fileURLToPath(new URL('../whey/whey.mjs', import.meta.url)),
    '--config',
    `${run.repo}/.whey.jsonc`,
    'open',
    run.id,
  ]
    .map(quote)
    .join(' ')
  return { key: 'isolate', message: `Isolate ready (headless): \`${run.workspace}\`.\n\nOpen/reopen: \`${command}\`` }
}
