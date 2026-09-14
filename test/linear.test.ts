import { expect, spyOn, test } from 'bun:test'
import { Effect, Layer } from 'effect'

import { Settings } from '../src/config'
import { CommentId } from '../src/domain'
import { Linear, LinearLive } from '../src/linear'
import { fixture, settings, userId } from './fixtures'

const fetchImplementation = (handler: (...args: Parameters<typeof fetch>) => Promise<Response>) =>
  Object.assign(handler, { preconnect: fetch.preconnect })

test('Linear adapter paginates comments and reconciles a published event without another mutation', async () => {
  const f = fixture()
  const first = {
    id: CommentId.make(crypto.randomUUID()),
    body: 'Earlier discussion',
    createdAt: '2026-01-01T00:00:00Z',
    user: { id: userId },
  }
  const second = { ...first, id: CommentId.make(crypto.randomUUID()), body: '<!-- event -->\nReport' }
  let pages = 0
  let requests = 0
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    fetchImplementation(async (_url, init) => {
      requests += 1
      const body = String(init?.body)
      if (body.includes('query Issue(')) return Response.json({ data: { issue: f.state.snapshot.issue } })
      pages += 1
      const next = body.includes('cursor-1')
      return Response.json({
        data: {
          issue: {
            comments: {
              nodes: [next ? second : first],
              pageInfo: { hasNextPage: !next, endCursor: next ? null : 'cursor-1' },
            },
          },
        },
      })
    }),
  )
  const layer = LinearLive.pipe(Layer.provide(Layer.succeed(Settings, settings)))
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const linear = yield* Linear
      return yield* linear.post({ issueId: f.state.run.issueId, body: second.body, eventMarker: '<!-- event -->' })
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => fetchMock.mockRestore()))),
  )
  expect(result.id).toBe(second.id)
  expect(pages).toBe(2)
  expect(requests).toBe(3)
})

test('GraphQL errors with HTTP 200 cannot be mistaken for success', async () => {
  const f = fixture()
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    fetchImplementation(async () => Response.json({ errors: [{ message: 'Access denied' }] })),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const linear = yield* Linear
      return yield* linear.read(f.state.run.issueId).pipe(Effect.exit)
    }).pipe(
      Effect.provide(LinearLive.pipe(Layer.provide(Layer.succeed(Settings, settings)))),
      Effect.ensuring(Effect.sync(() => fetchMock.mockRestore())),
    ),
  )
  expect(result._tag).toBe('Failure')
})
