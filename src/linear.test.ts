import { expect, spyOn, test } from 'bun:test'
import { Effect, Layer, Schema } from 'effect'

import { Settings } from './config'
import { CommentId, IssueId } from './domain'
import { Linear, LinearLive } from './linear'
import { fixture, settings, userId } from './test/fixtures'

// Verifies Linear pagination, publication reconciliation, and GraphQL error handling with mocked HTTP responses.

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
      if (typeof init?.body !== 'string') throw new Error('Expected JSON request')
      const body = init.body
      if (body.includes('query Issue(')) {
        expect(body).toContain('updatedAt')
        expect(body).not.toContain('updated_at')
        return Response.json({ data: { issue: f.state.snapshot.issue } })
      }
      expect(body).toContain('createdAt')
      expect(body).not.toContain('created_at')
      expect(body).toContain('pageInfo { hasNextPage endCursor }')
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

test('comment creation preserves native Linear request and response properties', async () => {
  const f = fixture()
  const comment = {
    id: CommentId.make(crypto.randomUUID()),
    body: '<!-- new-event -->\nReport',
    createdAt: '2026-01-02T00:00:00Z',
    user: { id: userId },
  }
  let published = false
  const requestSchema = Schema.parseJson(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.String) }),
    }),
  )
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    fetchImplementation(async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON request')
      const request = Schema.decodeUnknownSync(requestSchema)(init.body)
      if (request.query.includes('mutation Comment(')) {
        expect(request.variables).toEqual({ issueId: f.state.run.issueId, body: comment.body })
        expect(request.query).toContain('commentCreate(input:')
        expect(request.query).not.toContain('comment_create')
        expect(request.query).toContain('issueId: $issueId')
        published = true
        return Response.json({
          data: {
            commentCreate: {
              success: true,
              comment: { id: comment.id, body: comment.body, createdAt: comment.createdAt, user: comment.user },
            },
          },
        })
      }
      if (request.query.includes('query Issue(')) return Response.json({ data: { issue: f.state.snapshot.issue } })
      return Response.json({
        data: {
          issue: {
            comments: {
              nodes: published ? [comment] : [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      })
    }),
  )
  const result = await Effect.runPromise(
    Effect.flatMap(Linear, (linear) =>
      linear.post({ issueId: f.state.run.issueId, body: comment.body, eventMarker: '<!-- new-event -->' }),
    ).pipe(
      Effect.provide(LinearLive.pipe(Layer.provide(Layer.succeed(Settings, settings)))),
      Effect.ensuring(Effect.sync(() => fetchMock.mockRestore())),
    ),
  )
  expect(result).toEqual(comment)
  expect(published).toBe(true)
})

test('discovery queries the exact team and label, paginates, and excludes closed or archived issues', async () => {
  const first = fixture().state.snapshot.issue
  const second = { ...first, id: IssueId.make(crypto.randomUUID()) }
  const node = (issue: typeof first, type = 'started', archivedAt: string | null = null) => ({
    ...issue,
    archivedAt,
    state: { type },
  })
  let requests = 0
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    fetchImplementation(async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON request')
      const request = Schema.decodeUnknownSync(
        Schema.parseJson(
          Schema.Struct({
            query: Schema.String,
            variables: Schema.Struct({ teamId: Schema.String, after: Schema.NullOr(Schema.String) }),
          }),
        ),
      )(init.body)
      expect(request.variables.teamId).toBe(settings.teamId)
      expect(request.query).toContain('team: { id: { eq: $teamId } }')
      expect(request.query).toContain('labels: { name: { eq: "ai-workflow" } }')
      expect(request.query).toContain('nin: ["completed", "canceled"]')
      expect(request.query).toContain('includeArchived: false')
      expect(request.query).toContain('updatedAt')
      expect(request.query).not.toContain('updated_at')
      requests += 1
      expect(request.variables.after).toBe(requests === 1 ? null : 'next-page')
      return Response.json({
        data: {
          issues: {
            nodes:
              requests === 1
                ? [node(first), node(first, 'completed'), node(first, 'canceled'), node(first, 'started', '2026-01-01')]
                : [node(second)],
            pageInfo: { hasNextPage: requests === 1, endCursor: requests === 1 ? 'next-page' : null },
          },
        },
      })
    }),
  )
  const issues = await Effect.runPromise(
    Effect.flatMap(Linear, (linear) => linear.discover).pipe(
      Effect.provide(LinearLive.pipe(Layer.provide(Layer.succeed(Settings, settings)))),
      Effect.ensuring(Effect.sync(() => fetchMock.mockRestore())),
    ),
  )
  expect(issues.map((issue) => issue.id)).toEqual([first.id, second.id])
  expect(requests).toBe(2)
})
