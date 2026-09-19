import { Context, Effect, Layer, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'

import type { AppError } from './domain'

import { error } from './domain'

// Executes authenticated GraphQL requests and validates envelopes and operation data without retrying mutations.

type GraphQLRequest<A, I> = {
  readonly query: string
  readonly variables: Readonly<Record<string, string | null>>
  readonly schema: Schema.Codec<A, I>
}

const Envelope = Schema.Struct({
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.String,
        extensions: Schema.optional(Schema.Struct({ userPresentableMessage: Schema.optional(Schema.String) })),
      }),
    ),
  ),
  data: Schema.optional(Schema.Unknown),
})

export class GraphQLClient extends Context.Service<
  GraphQLClient,
  { readonly execute: <A, I>(input: GraphQLRequest<A, I>) => Effect.Effect<A, AppError> }
>()('linear-ai-workflow/graphql-client/GraphQLClient') {
  static readonly layer = (
    endpoint: string,
    authorization: Redacted.Redacted<string>,
  ): Layer.Layer<GraphQLClient, never, HttpClient.HttpClient> =>
    Layer.effect(
      GraphQLClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const execute = Effect.fn('GraphQLClient.execute')(function* <A, I>(input: GraphQLRequest<A, I>) {
          const request = yield* HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.setHeaders({ Authorization: Redacted.value(authorization), Accept: 'application/json' }),
            HttpClientRequest.bodyJson({ query: input.query, variables: input.variables }),
            Effect.mapError(() => error('linear', 'Unable to encode GraphQL request')),
          )
          const response = yield* client.execute(request).pipe(
            Effect.mapError(() => error('transport', 'GraphQL request failed; publication may need reconciliation')),
            Effect.timeoutOrElse({
              duration: '30 seconds',
              orElse: () => Effect.fail(error('transport', 'GraphQL request timed out; reconcile before retrying')),
            }),
          )
          if (response.status === 429) {
            const seconds = Number(response.headers['retry-after'])
            yield* Effect.sleep(`${Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : 30} seconds`)
            return yield* error('transport', 'GraphQL rate limit reached')
          }
          if (response.status < 200 || response.status >= 300)
            return yield* error(
              response.status >= 500 ? 'transport' : 'linear',
              `GraphQL returned HTTP ${response.status}`,
            )
          const text = yield* response.text.pipe(
            Effect.mapError(() => error('transport', 'Unable to read GraphQL response')),
            Effect.timeoutOrElse({
              duration: '30 seconds',
              orElse: () => Effect.fail(error('transport', 'GraphQL response body timed out')),
            }),
          )
          const envelope = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope))(text).pipe(
            Effect.mapError(() => error('linear', 'Invalid GraphQL response')),
          )
          if (envelope.errors?.length)
            return yield* error(
              'linear',
              `GraphQL: ${envelope.errors.map((item) => item.extensions?.userPresentableMessage ?? item.message).join('; ')}`,
            )
          return yield* Schema.decodeUnknownEffect(input.schema)(envelope.data).pipe(
            Effect.mapError(() =>
              error('linear', 'Invalid GraphQL operation data; reconcile mutations before retrying'),
            ),
          )
        })
        return GraphQLClient.of({ execute })
      }),
    )
}
