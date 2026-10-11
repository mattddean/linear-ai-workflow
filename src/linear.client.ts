import { Context, Effect, Layer, Schedule, Schema } from 'effect'

import type { AppError, CommentId, IssueId, IssueKey, Snapshot } from './domain'

import { Settings } from './config'
import { Comment, Issue, error } from './domain'
import { GraphQLClient } from './graphql-client'

// Reads team-scoped issues and paginated comments, and reconciles reactions and comment publication through Linear’s GraphQL API.

const Page = Schema.Struct({
  nodes: Schema.Array(Comment),
  pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
})
const StateResponse = Schema.Struct({
  issue: Schema.Struct({ id: Issue.fields.id, team: Issue.fields.team, state: Schema.Struct({ type: Schema.String }) }),
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
const ReferencedCommentResponse = Schema.Struct({
  comment: Schema.Struct({
    ...Comment.fields,
    parent: Schema.NullOr(Schema.Struct({ id: Comment.fields.id })),
    issue: Schema.Struct({ id: Issue.fields.id, team: Issue.fields.team }),
  }),
})
const CreatedResponse = Schema.Struct({
  commentCreate: Schema.Struct({ success: Schema.Boolean, comment: Schema.NullOr(Comment) }),
})
const Reactions = Schema.Array(Schema.Struct({ emoji: Schema.String, user: Comment.fields.user }))
const ReactionIssue = Schema.Struct({ id: Issue.fields.id, team: Issue.fields.team, reactions: Reactions })
const ReactionIssueResponse = Schema.Struct({
  viewer: Schema.Struct({ id: Schema.String }),
  issue: ReactionIssue,
})
const ReactionCommentResponse = Schema.Struct({
  viewer: Schema.Struct({ id: Schema.String }),
  comment: Schema.Struct({
    id: Comment.fields.id,
    issue: Schema.Struct({ id: Issue.fields.id, team: Issue.fields.team }),
    reactions: Reactions,
  }),
})
const ReactionCreatedResponse = Schema.Struct({ reactionCreate: Schema.Struct({ success: Schema.Boolean }) })
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

export class Linear extends Context.Service<
  Linear,
  {
    readonly isCanceled: (id: IssueId) => Effect.Effect<boolean, AppError>
    readonly discover: Effect.Effect<readonly Issue[], AppError>
    readonly threadParent: (input: { issueId: IssueId; commentId: CommentId }) => Effect.Effect<CommentId, AppError>
    readonly read: (
      id: IssueId | typeof IssueKey.Type,
      references?: readonly CommentId[],
    ) => Effect.Effect<Snapshot, AppError>
    readonly replies: (input: { issueId: IssueId; commentId: CommentId }) => Effect.Effect<readonly Comment[], AppError>
    readonly acknowledge: (input: {
      issueId: IssueId
      commentId?: CommentId | undefined
    }) => Effect.Effect<void, AppError>
    readonly post: (input: {
      issueId: IssueId
      body: string
      publicationId: CommentId
      parentId?: CommentId | undefined
    }) => Effect.Effect<Comment, AppError>
  }
>()('linear-ai-workflow/linear.client/Linear') {
  static readonly layer = Layer.effect(
    Linear,
    Effect.gen(function* () {
      const settings = yield* Settings
      const { execute: request } = yield* GraphQLClient
      const readRequest: typeof request = Effect.fn('Linear.readRequest')((input) =>
        request(input).pipe(
          Effect.retry({
            schedule: Schedule.max([Schedule.exponential('1 second'), Schedule.recurs(2)]),
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
      const read = Effect.fn('Linear.read')(function* (
        id: IssueId | typeof IssueKey.Type,
        references: readonly CommentId[] = [],
      ) {
        const { issue } = yield* readRequest({
          schema: IssueResponse,
          query:
            'query Issue($id: String!) { issue(id: $id) { id identifier title description updatedAt team { id } } }',
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
        const roots = new Set<CommentId>()
        for (const id of new Set(references)) {
          const { comment } = yield* readRequest({
            schema: ReferencedCommentResponse,
            query: `query ReferencedComment($id: String!) { comment(id: $id) { ${commentFields} parent { id } issue { id team { id } } } }`,
            variables: { id },
          })
          if (comment.id !== id || comment.issue.id !== issue.id || comment.issue.team.id !== settings.teamId)
            return yield* error('linear', 'Referenced comment is outside the requested issue or configured team')
          if (!comments.some((item) => item.id === comment.id))
            comments.push({ id: comment.id, body: comment.body, createdAt: comment.createdAt, user: comment.user })
          roots.add(comment.parent?.id ?? comment.id)
        }
        for (const root of roots) {
          for (const comment of yield* replies({ issueId: issue.id, commentId: root })) {
            if (!comments.some((item) => item.id === comment.id)) comments.push(comment)
          }
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
      const acknowledge = Effect.fn('Linear.acknowledge')(function* (input) {
        const existing = Effect.fn('Linear.acknowledgementExists')(function* () {
          if (input.commentId !== undefined) {
            const { viewer, comment } = yield* readRequest({
              schema: ReactionCommentResponse,
              query:
                'query CommentReactions($id: String!) { viewer { id } comment(id: $id) { id issue { id team { id } } reactions { emoji user { id } } } }',
              variables: { id: input.commentId },
            })
            if (
              comment.id !== input.commentId ||
              comment.issue.id !== input.issueId ||
              comment.issue.team.id !== settings.teamId
            )
              return yield* error('linear', 'Reaction target is outside the requested issue or configured team')
            return comment.reactions.some((reaction) => reaction.emoji === 'eyes' && reaction.user?.id === viewer.id)
          }
          const { viewer, issue } = yield* readRequest({
            schema: ReactionIssueResponse,
            query:
              'query IssueReactions($id: String!) { viewer { id } issue(id: $id) { id team { id } reactions { emoji user { id } } } }',
            variables: { id: input.issueId },
          })
          if (issue.id !== input.issueId || issue.team.id !== settings.teamId)
            return yield* error('linear', 'Reaction target is outside the requested issue or configured team')
          return issue.reactions.some((reaction) => reaction.emoji === 'eyes' && reaction.user?.id === viewer.id)
        })
        // Reconcile our own reaction before retrying an ambiguous write; other users' reactions do not acknowledge work.
        if (yield* existing()) return
        const created = yield* request({
          schema: ReactionCreatedResponse,
          // Linear counts an explicitly null target as defined; include only the selected association.
          query:
            input.commentId === undefined
              ? 'mutation Acknowledge($id: String!) { reactionCreate(input: { issueId: $id, emoji: "eyes" }) { success } }'
              : 'mutation Acknowledge($id: String!) { reactionCreate(input: { commentId: $id, emoji: "eyes" }) { success } }',
          variables: { id: input.commentId ?? input.issueId },
        })
        if (!created.reactionCreate.success) return yield* error('linear', 'Linear did not confirm reaction creation')
        if (!(yield* existing()))
          return yield* error('transport', 'Published reaction is not yet confirmed; retry reconciliation')
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
        const existing = comments.find((comment) => comment.id === input.publicationId)
        if (!existing && snapshot.comments.some((comment) => comment.id === input.publicationId))
          return yield* error('linear', 'Publication ID exists outside the expected comment thread')
        if (existing) {
          if (existing.body !== input.body)
            return yield* error('linear', 'Publication ID exists with a different body; human reconciliation required')
          return existing
        }
        const created = yield* request({
          schema: CreatedResponse,
          query: `mutation Comment($id: String!, $issueId: String!, $body: String!, $parentId: String) { commentCreate(input: { id: $id, issueId: $issueId, body: $body, parentId: $parentId }) { success comment { ${commentFields} } } }`,
          variables: { id: input.publicationId, issueId: input.issueId, body: input.body, parentId },
        })
        if (!created.commentCreate.success || created.commentCreate.comment === null)
          return yield* error('linear', 'Linear did not confirm comment creation')
        if (created.commentCreate.comment.id !== input.publicationId)
          return yield* error('linear', 'Linear returned a different publication ID')
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
        threadParent,
        isCanceled: Effect.fn('Linear.isCanceled')(function* (id) {
          const { issue } = yield* readRequest({
            schema: StateResponse,
            query: 'query IssueState($id: String!) { issue(id: $id) { id team { id } state { type } } }',
            variables: { id },
          })
          if (issue.id !== id || issue.team.id !== settings.teamId)
            return yield* error('linear', 'Issue is outside the enrolled issue and configured team')
          return issue.state.type === 'canceled'
        }),
        discover: discover(),
        acknowledge,
        replies,
        read,
        post,
      })
    }),
  )
}
