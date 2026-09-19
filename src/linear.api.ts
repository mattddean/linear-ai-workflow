import { Context, Effect, Layer, Schedule, Schema } from 'effect'

import type { AppError, CommentId, IssueId, IssueKey, Snapshot } from './domain'

import { Settings } from './config'
import { Comment, Issue, error } from './domain'
import { GraphQLClient } from './graphql-client'

// Reads team-scoped issues and paginated comments, and reconciles comment publication through Linear’s GraphQL API.

export class Linear extends Context.Tag('Linear')<
  Linear,
  {
    readonly discover: Effect.Effect<readonly Issue[], AppError>
    readonly read: (id: IssueId | typeof IssueKey.Type) => Effect.Effect<Snapshot, AppError>
    readonly replies: (input: { issueId: IssueId; commentId: CommentId }) => Effect.Effect<readonly Comment[], AppError>
    readonly post: (input: {
      issueId: IssueId
      body: string
      eventMarker: string
      parentId?: CommentId | undefined
    }) => Effect.Effect<Comment, AppError>
  }
>() {}
const Page = Schema.Struct({
  nodes: Schema.Array(Comment),
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
})
const IssueResponse = Schema.Struct({ issue: Issue })
const CommentsResponse = Schema.Struct({ issue: Schema.Struct({ comments: Page }) })
const RepliesResponse = Schema.Struct({
  comment: Schema.Struct({
    id: Comment.fields.id,
    issue: Schema.Struct({ id: Issue.fields.id, team: Issue.fields.team }),
    children: Page,
  }),
})
const ThreadResponse = Schema.Struct({
  comment: Schema.Struct({
    id: Comment.fields.id,
    parent: Schema.NullOr(Schema.Struct({ id: Comment.fields.id })),
    issue: Schema.Struct({ id: Issue.fields.id, team: Issue.fields.team }),
  }),
})
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
const commentFields = 'id body createdAt user { id }'

export const LinearLive = Layer.effect(
  Linear,
  Effect.gen(function* () {
    const settings = yield* Settings
    const { execute: request } = yield* GraphQLClient
    const readRequest: typeof request = Effect.fn('Linear.readRequest')((input) =>
      request(input).pipe(
        Effect.retry({
          schedule: Schedule.exponential('1 second').pipe(Schedule.intersect(Schedule.recurs(2))),
          while: (failure) => failure.kind === 'transport',
        }),
      ),
    )
    const discover = Effect.fn('Linear.discover')(
      function* () {
        const issues: Issue[] = []
        let after: string | null = null
        for (;;) {
          const page: typeof DiscoveryResponse.Type = yield* readRequest({
            schema: DiscoveryResponse,
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
          })
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
      const { issue } = yield* readRequest({
        schema: IssueResponse,
        query: 'query Issue($id: String!) { issue(id: $id) { id identifier title description updatedAt team { id } } }',
        variables: { id },
      })
      if (issue.team.id !== settings.teamId)
        return yield* error('linear', 'Issue is outside the configured Linear team')
      const comments: Comment[] = []
      let after: string | null = null
      for (;;) {
        const page: typeof CommentsResponse.Type = yield* readRequest({
          schema: CommentsResponse,
          query: `query Comments($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { nodes { ${commentFields} } pageInfo { hasNextPage endCursor } } } }`,
          variables: { id: issue.id, after },
        })
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
    const replies = Effect.fn('Linear.replies')(function* (input: { issueId: IssueId; commentId: CommentId }) {
      const comments: Comment[] = []
      let after: string | null = null
      for (;;) {
        const page: typeof RepliesResponse.Type = yield* readRequest({
          schema: RepliesResponse,
          query: `query Replies($id: String!, $after: String) { comment(id: $id) { id issue { id team { id } } children(first: 100, after: $after) { nodes { ${commentFields} } pageInfo { hasNextPage endCursor } } } }`,
          variables: { id: input.commentId, after },
        })
        if (
          page.comment.id !== input.commentId ||
          page.comment.issue.id !== input.issueId ||
          page.comment.issue.team.id !== settings.teamId
        )
          return yield* error('linear', 'Reply thread is outside the requested issue or configured team')
        comments.push(...page.comment.children.nodes)
        if (!page.comment.children.pageInfo.hasNextPage) break
        const next = page.comment.children.pageInfo.endCursor
        if (next === null || next === after) return yield* error('linear', 'Linear reply pagination did not advance')
        after = next
      }
      return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    })
    const threadParent = Effect.fn('Linear.threadParent')(function* (input: {
      issueId: IssueId
      commentId: CommentId
    }) {
      const { comment } = yield* readRequest({
        schema: ThreadResponse,
        query: 'query Thread($id: String!) { comment(id: $id) { id parent { id } issue { id team { id } } } }',
        variables: { id: input.commentId },
      })
      if (
        comment.id !== input.commentId ||
        comment.issue.id !== input.issueId ||
        comment.issue.team.id !== settings.teamId
      )
        return yield* error('linear', 'Reply target is outside the requested issue or configured team')
      // Linear permits one reply level: replying to a child must address its existing thread root.
      return comment.parent?.id ?? comment.id
    })
    const post = Effect.fn('Linear.post')(function* (input) {
      // Reconcile before every attempt, including after an ambiguous successful write.
      const snapshot = yield* read(input.issueId)
      const parentId = input.parentId
        ? yield* threadParent({ issueId: input.issueId, commentId: input.parentId })
        : null
      const comments = parentId ? yield* replies({ issueId: input.issueId, commentId: parentId }) : snapshot.comments
      const existing = comments.find((comment) => comment.body.startsWith(`${input.eventMarker}\n`))
      if (existing) {
        if (existing.body !== input.body)
          return yield* error('linear', 'Event marker exists with a different body; human reconciliation required')
        return existing
      }
      const created = yield* request({
        schema: CreatedResponse,
        query: `mutation Comment($issueId: String!, $body: String!, $parentId: String) { commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) { success comment { ${commentFields} } } }`,
        variables: { issueId: input.issueId, body: input.body, parentId },
      })
      if (!created.commentCreate.success || created.commentCreate.comment === null)
        return yield* error('linear', 'Linear did not confirm comment creation')
      // Fetch the persisted handoff rather than trusting an agent's draft or mutation echo.
      const confirmed = yield* read(input.issueId)
      const confirmedComments = parentId
        ? yield* replies({ issueId: input.issueId, commentId: parentId })
        : confirmed.comments
      const comment = confirmedComments.find((item) => item.id === created.commentCreate.comment?.id)
      if (!comment || comment.body !== input.body)
        return yield* error('transport', 'Published comment is not yet confirmed; retry reconciliation')
      return comment
    })
    return Linear.of({
      discover: discover(),
      replies,
      read,
      post,
    })
  }),
)
