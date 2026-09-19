import { FetchHttpClient } from '@effect/platform'
import { expect, spyOn, test } from 'bun:test'
import { Cause, Effect, Layer, Schema } from 'effect'

import { Settings } from './config'
import { CommentId, IssueId } from './domain'
import { GraphQLClientLive } from './graphql-client'
import { Linear, LinearLive } from './linear.api'
import { fixture, settings, userId } from './test/fixtures'

// Verifies Linear pagination, publication reconciliation, and GraphQL error handling with mocked HTTP responses.

const transportLayer = GraphQLClientLive('https://api.linear.app/graphql', settings.linearKey).pipe(
  Layer.provide(FetchHttpClient.layer),
)
const testLayer = LinearLive.pipe(Layer.provide(transportLayer), Layer.provide(Layer.succeed(Settings, settings)))

const fetchImplementation = (handler: (...args: Parameters<typeof fetch>) => Promise<Response>) =>
  Object.assign(
    (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      handler(url, {
        ...init,
        body: init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : (init?.body ?? null),
      }),
    { preconnect: fetch.preconnect },
  )

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
  const layer = testLayer
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
    fetchImplementation(async () =>
      Response.json({
        errors: [
          {
            message: 'incorrect parent',
            extensions: { userPresentableMessage: 'Parent comment must be a top level comment.' },
          },
        ],
      }),
    ),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const linear = yield* Linear
      return yield* linear.read(f.state.run.issueId).pipe(Effect.exit)
    }).pipe(Effect.provide(testLayer), Effect.ensuring(Effect.sync(() => fetchMock.mockRestore()))),
  )
  expect(result._tag).toBe('Failure')
  if (result._tag === 'Failure')
    expect(Cause.pretty(result.cause)).toContain('Parent comment must be a top level comment.')
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
        expect(request.variables).toEqual({ issueId: f.state.run.issueId, body: comment.body, parentId: null })
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
    ).pipe(Effect.provide(testLayer), Effect.ensuring(Effect.sync(() => fetchMock.mockRestore()))),
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
      Effect.provide(testLayer),
      Effect.ensuring(Effect.sync(() => fetchMock.mockRestore())),
    ),
  )
  expect(issues.map((issue) => issue.id)).toEqual([first.id, second.id])
  expect(requests).toBe(2)
})

test('replies are paginated from the requested comment thread and retain the full answer', async () => {
  const f = fixture()
  const parent = CommentId.make(crypto.randomUUID())
  const answer = {
    id: CommentId.make(crypto.randomUUID()),
    body: 'Ready\nThe device is connected.',
    createdAt: '2026-01-02T00:00:00Z',
    user: { id: userId },
  }
  let pages = 0
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    fetchImplementation(async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON request')
      expect(init.body).toContain('children(first: 100, after: $after)')
      expect(init.body).toContain(parent)
      expect(init.body).not.toContain('query Comments(')
      pages += 1
      const next = init.body.includes('reply-cursor')
      return Response.json({
        data: {
          comment: {
            id: parent,
            issue: { id: f.state.run.issueId, team: { id: settings.teamId } },
            children: {
              nodes: next ? [answer] : [],
              pageInfo: { hasNextPage: !next, endCursor: next ? null : 'reply-cursor' },
            },
          },
        },
      })
    }),
  )
  const replies = await Effect.runPromise(
    Effect.flatMap(Linear, (linear) => linear.replies({ issueId: f.state.run.issueId, commentId: parent })).pipe(
      Effect.provide(testLayer),
      Effect.ensuring(Effect.sync(() => fetchMock.mockRestore())),
    ),
  )
  expect(replies).toEqual([answer])
  expect(pages).toBe(2)
})

test('reply threads belonging to another issue are rejected', async () => {
  const f = fixture()
  const parent = CommentId.make(crypto.randomUUID())
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    fetchImplementation(async () =>
      Response.json({
        data: {
          comment: {
            id: parent,
            issue: { id: IssueId.make(crypto.randomUUID()), team: { id: settings.teamId } },
            children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      }),
    ),
  )
  const result = await Effect.runPromise(
    Effect.flatMap(Linear, (linear) =>
      linear.replies({ issueId: f.state.run.issueId, commentId: parent }).pipe(Effect.exit),
    ).pipe(Effect.provide(testLayer), Effect.ensuring(Effect.sync(() => fetchMock.mockRestore()))),
  )
  expect(result._tag).toBe('Failure')
})

test.each([false, true])('acknowledgements resolve nested reply=%s to its root and reconcile there', async (nested) => {
  const f = fixture()
  const parentId = CommentId.make(crypto.randomUUID())
  const comment = {
    id: CommentId.make(crypto.randomUUID()),
    body: '<!-- ack-event -->\n👀',
    createdAt: '2026-01-02T00:00:00Z',
    user: { id: userId },
  }
  const targetId = nested ? CommentId.make(crypto.randomUUID()) : parentId
  let writes = 0
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    fetchImplementation(async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected request body')
      const request = Schema.decodeUnknownSync(
        Schema.parseJson(
          Schema.Struct({
            query: Schema.String,
            variables: Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.String) }),
          }),
        ),
      )(init.body)
      if (request.query.includes('query Thread(')) {
        expect(request.variables.id).toBe(targetId)
        return Response.json({
          data: {
            comment: {
              id: targetId,
              parent: nested ? { id: parentId } : null,
              issue: { id: f.state.run.issueId, team: { id: settings.teamId } },
            },
          },
        })
      }
      if (request.query.includes('mutation Comment(')) {
        expect(request.variables.parentId).toBe(parentId)
        expect(request.query).toContain('parentId: $parentId')
        writes += 1
        return Response.json({ data: { commentCreate: { success: true, comment } } })
      }
      if (request.query.includes('query Replies(')) {
        expect(request.variables.id).toBe(parentId)
        return Response.json({
          data: {
            comment: {
              id: parentId,
              issue: { id: f.state.run.issueId, team: { id: settings.teamId } },
              children: { nodes: writes > 0 ? [comment] : [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        })
      }
      if (request.query.includes('query Issue(')) return Response.json({ data: { issue: f.state.snapshot.issue } })
      // The acknowledgement need not appear in the issue's top-level comment list.
      return Response.json({
        data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      })
    }),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const linear = yield* Linear
      const input = {
        issueId: f.state.run.issueId,
        body: comment.body,
        eventMarker: '<!-- ack-event -->',
        parentId: targetId,
      }
      expect(yield* linear.post(input)).toEqual(comment)
      expect(yield* linear.post(input)).toEqual(comment)
    }).pipe(Effect.provide(testLayer), Effect.ensuring(Effect.sync(() => fetchMock.mockRestore()))),
  )
  expect(writes).toBe(1)
})
