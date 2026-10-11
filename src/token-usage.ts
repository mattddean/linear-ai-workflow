import { Option, Schema } from 'effect'

// Separates cached input from the tokens charged to the workflow's execution budget.

const UsageEvent = Schema.Struct({
  type: Schema.Literal('turn.completed'),
  usage: Schema.Struct({
    input_tokens: Schema.Int,
    cached_input_tokens: Schema.optional(Schema.Int),
    output_tokens: Schema.Int,
  }),
})
export interface TokenUsage {
  readonly tokens: number
  readonly cachedTokens: number
}
export function budgetTokens(usage: { tokens: number; cachedTokens?: number | undefined }): number {
  return usage.tokens - (usage.cachedTokens ?? 0)
}
export function countTokenUsage(
  log: string,
  previous?: TokenUsage,
): TokenUsage & { readonly sessionUsage?: TokenUsage } {
  let sessionUsage: TokenUsage | undefined
  for (const line of log.split('\n')) {
    const event = Schema.decodeUnknownOption(Schema.fromJsonString(UsageEvent))(line)
    if (Option.isNone(event)) continue
    const usage = event.value.usage
    sessionUsage = { tokens: usage.input_tokens + usage.output_tokens, cachedTokens: usage.cached_input_tokens ?? 0 }
  }
  if (sessionUsage === undefined) return { tokens: 0, cachedTokens: 0 }
  // Codex reports lifetime session totals, including turns completed before exec resume.
  return {
    tokens: Math.max(0, sessionUsage.tokens - (previous?.tokens ?? 0)),
    cachedTokens: Math.max(0, sessionUsage.cachedTokens - (previous?.cachedTokens ?? 0)),
    sessionUsage,
  }
}
