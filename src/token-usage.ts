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
export function countTokenUsage(log: string): TokenUsage {
  return log.split('\n').reduce<TokenUsage>(
    (sum, line) => {
      const event = Schema.decodeUnknownOption(Schema.parseJson(UsageEvent))(line)
      if (Option.isNone(event)) return sum
      const usage = event.value.usage
      return {
        tokens: sum.tokens + usage.input_tokens + usage.output_tokens,
        cachedTokens: sum.cachedTokens + (usage.cached_input_tokens ?? 0),
      }
    },
    { tokens: 0, cachedTokens: 0 },
  )
}
