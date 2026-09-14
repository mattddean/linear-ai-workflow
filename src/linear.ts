import { Context, Effect, Layer, Redacted, Schedule, Schema } from 'effect'

import type { AppError, IssueId, IssueKey, Snapshot } from './domain'

import { Settings } from './config'
import { Comment, Issue, error } from './domain'

// Reads team-scoped issues and paginated comments, and reconciles comment publication through Linear’s GraphQL API.

export class Linear extends Context.Tag('Linear')<
  Linear,
  {
    readonly discover: Effect.Effect<readonly Issue[], AppError>
    readonly read: (id: IssueId | typeof IssueKey.Type) => Effect.Effect<Snapshot, AppError>
    readonly post: (input: { issueId: IssueId; body: string; eventMarker: string }) => Effect.Effect<Comment, AppError>
  }
>() {}
const Page = Schema.Struct({
  nodes: Schema.Array(Comment),
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
})
const IssueResponse = Schema.Struct({ issue: Issue })
const CommentsResponse = Schema.Struct({ issue: Schema.Struct({ comments: Page }) })
const CreatedResponse = Schema.Struct({
  commentCreate: Schema.Struct({ success: Schema.Boolean, comment: Schema.NullOr(Comment) }),
})
const DiscoveryResponse = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        ...Issue.fields,
        archivedAt: Schema.NullOr(Schema.String),
        state: Schema.Struct({ type: Schema.String }),
      }),
    ),
    pageInfo: Page.fields.pageInfo,
  }),
})
const Envelope = Schema.Struct({
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  data: Schema.optional(Schema.Unknown),
})
const commentFields = 'id body createdAt user { id }'

export const LinearLive = Layer.effect(
  Linear,
  Effect.gen(function* () {
    const settings = yield* Settings
    const request = Effect.fn('Linear.request')(function* (input: {
      query: string
      variables: Readonly<Record<string, string | null>>
    }) {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch('https://api.linear.app/graphql', {
            method: 'POST',
            signal,
            headers: { Authorization: Redacted.value(settings.linearKey), 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          }),
        catch: () => error('transport', 'Linear request failed; publication may need reconciliation'),
      }).pipe(
        Effect.timeoutFail({
          duration: '30 seconds',
          onTimeout: () => error('transport', 'Linear request timed out; reconcile before retrying'),
        }),
      )
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'))
        yield* Effect.sleep(`${Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 300) : 30} seconds`)
        return yield* error('transport', 'Linear rate limit reached')
      }
      if (!response.ok)
        return yield* error(response.status >= 500 ? 'transport' : 'linear', `Linear returned HTTP ${response.status}`)
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => error('transport', 'Unable to read Linear response'),
      }).pipe(
        Effect.timeoutFail({
          duration: '30 seconds',
          onTimeout: () => error('transport', 'Linear response body timed out'),
        }),
      )
      const envelope = yield* Schema.decodeUnknown(Schema.parseJson(Envelope))(text).pipe(
        Effect.mapError(() => error('linear', 'Invalid Linear response')),
      )
      if (envelope.errors?.length)
        return yield* error('linear', 'Linear returned GraphQL errors; verify credentials, scope, and API schema')
      return envelope.data
    })
    const readRequest = (input: Parameters<typeof request>[0]) =>
      request(input).pipe(
        Effect.retry({
          schedule: Schedule.exponential('1 second').pipe(Schedule.intersect(Schedule.recurs(2))),
          while: (failure) => failure.kind === 'transport',
        }),
      )
    const discover = Effect.fn('Linear.discover')(
      function* () {
        const issues: Issue[] = []
        let after: string | null = null
        for (;;) {
          const page: typeof DiscoveryResponse.Type = yield* readRequest({
            query: `query Discover($teamId: ID!, $after: String) {
            issues(first: 100, after: $after, includeArchived: false, filter: {
              team: { id: { eq: $teamId } }, labels: { name: { eq: "ai-workflow" } },
              state: { type: { nin: ["completed", "canceled"] } }
            }) {
              nodes { id identifier title description updatedAt team { id } archivedAt state { type } }
              pageInfo { hasNextPage endCursor }
            }
          }`,
            variables: { teamId: settings.teamId, after },
          }).pipe(Effect.flatMap(Schema.decodeUnknown(DiscoveryResponse)))
          for (const issue of page.issues.nodes) {
            if (issue.team.id !== settings.teamId)
              return yield* error('linear', 'Discovered issue is outside the configured team')
            if (issue.archivedAt === null && !['completed', 'canceled'].includes(issue.state.type)) issues.push(issue)
          }
          if (!page.issues.pageInfo.hasNextPage) break
          const next = page.issues.pageInfo.endCursor
          if (next === null || next === after)
            return yield* error('linear', 'Linear discovery pagination did not advance')
          after = next
        }
        return issues
      },
      Effect.mapError((failure) => error('linear', `Ticket discovery failed: ${failure.message}`)),
    )
    const read = Effect.fn('Linear.read')(function* (id: IssueId | typeof IssueKey.Type) {
      const data = yield* readRequest({
        query: 'query Issue($id: String!) { issue(id: $id) { id identifier title description updatedAt team { id } } }',
        variables: { id },
      })
      const { issue } = yield* Schema.decodeUnknown(IssueResponse)(data).pipe(
        Effect.mapError(() => error('linear', 'Issue is unavailable or malformed')),
      )
      if (issue.team.id !== settings.teamId)
        return yield* error('linear', 'Issue is outside the configured Linear team')
      const comments: Comment[] = []
      let after: string | null = null
      for (;;) {
        const page: typeof CommentsResponse.Type = yield* readRequest({
          query: `query Comments($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { nodes { ${commentFields} } pageInfo { hasNextPage endCursor } } } }`,
          variables: { id: issue.id, after },
        }).pipe(
          Effect.flatMap(Schema.decodeUnknown(CommentsResponse)),
          Effect.mapError(() => error('linear', 'Invalid Linear comment page')),
        )
        comments.push(...page.issue.comments.nodes)
        if (!page.issue.comments.pageInfo.hasNextPage) break
        const next = page.issue.comments.pageInfo.endCursor
        if (next === null || next === after) return yield* error('linear', 'Linear pagination did not advance')
        after = next
      }
      return {
        issue,
        comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      }
    })
    const post = Effect.fn('Linear.post')(function* (input) {
      // Reconcile before every attempt, including after an ambiguous successful write.
      const snapshot = yield* read(input.issueId)
      const existing = snapshot.comments.find((comment) => comment.body.startsWith(`${input.eventMarker}\n`))
      if (existing) {
        if (existing.body !== input.body)
          return yield* error('linear', 'Event marker exists with a different body; human reconciliation required')
        return existing
      }
      const data = yield* request({
        query: `mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { ${commentFields} } } }`,
        variables: { issueId: input.issueId, body: input.body },
      })
      const created = yield* Schema.decodeUnknown(CreatedResponse)(data).pipe(
        Effect.mapError(() => error('linear', 'Invalid comment creation result; reconcile before retrying')),
      )
      if (!created.commentCreate.success || created.commentCreate.comment === null)
        return yield* error('linear', 'Linear did not confirm comment creation')
      // Fetch the persisted handoff rather than trusting an agent's draft or mutation echo.
      const confirmed = yield* read(input.issueId)
      const comment = confirmed.comments.find((item) => item.id === created.commentCreate.comment?.id)
      if (!comment || comment.body !== input.body)
        return yield* error('transport', 'Published comment is not yet confirmed; retry reconciliation')
      return comment
    })
    return Linear.of({
      discover: discover(),
      read,
      post,
    })
  }),
)
