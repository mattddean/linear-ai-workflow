import { expect, test } from 'bun:test'
import { Effect, Layer, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import { GraphQLClient } from './graphql-client'

// Verifies schema validation and failure classification through an injected HTTP client without live requests.

const Result = Schema.Struct({ value: Schema.String })

test.each([
  { body: '{}', status: 200, kind: 'linear' },
  { body: '{"data":{"value":42}}', status: 200, kind: 'linear' },
  { body: 'not json', status: 200, kind: 'linear' },
  { body: '{"data":{"value":"partial"},"errors":[{"message":"denied"}]}', status: 200, kind: 'linear' },
  { body: '{}', status: 401, kind: 'linear' },
  { body: '{}', status: 503, kind: 'transport' },
])('GraphQL rejects invalid responses and classifies HTTP $status failures', async ({ body, status, kind }) => {
  let requests = 0
  const http = HttpClient.make((request) => {
    requests += 1
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })))
  })
  const layer = GraphQLClient.layer('https://example.test/graphql', Redacted.make('test-only')).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  )
  const result = await Effect.runPromise(
    Effect.flatMap(GraphQLClient, (client) =>
      client.execute({ query: 'mutation Test { value }', variables: {}, schema: Result }),
    ).pipe(Effect.result, Effect.provide(layer)),
  )
  expect(result._tag).toBe('Failure')
  if (result._tag === 'Failure') expect(result.failure.kind).toBe(kind)
  expect(requests).toBe(1)
})

test('GraphQL sends authenticated JSON and decodes operation data', async () => {
  const http = HttpClient.make((request) => {
    expect(request.method).toBe('POST')
    expect(request.url).toBe('https://example.test/graphql')
    expect(request.headers.authorization).toBe('test-only')
    expect(request.headers.accept).toBe('application/json')
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.body._tag).toBe('Uint8Array')
    if (request.body._tag === 'Uint8Array')
      expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
        query: 'query Test { value }',
        variables: { id: '123' },
      })
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: { value: 'decoded' } })))
  })
  const layer = GraphQLClient.layer('https://example.test/graphql', Redacted.make('test-only')).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  )
  const result = await Effect.runPromise(
    Effect.flatMap(GraphQLClient, (client) =>
      client.execute({ query: 'query Test { value }', variables: { id: '123' }, schema: Result }),
    ).pipe(Effect.provide(layer)),
  )
  expect(result).toEqual({ value: 'decoded' })
})
