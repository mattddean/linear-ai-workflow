# AGENTS.md

Instructions for agents developing Linear AI Workflow itself. PM, Developer, and QA runtime prompts are product behavior; this file governs changes to the coordinator repository.

## Product contract

Linear AI Workflow runs a local PM → Developer → QA → PM development team. It uses ordinary Linear GraphQL issue/comment operations, local Codex sessions pinned to `gpt-6-astra`, Effect Workflow, and a local Postgres database.

- Linear comments are the agents' communication channel. Publish and confirm a handoff before its recipient runs; construct the recipient's input from the persisted comment.
- The database owns durable execution state. Do not reconstruct the entire workflow from comments or introduce a second orchestration engine.
- Keep code execution, orchestration, and artifacts local. OpenAI performs model inference; Linear stores issue discussion.
- Use polling. Do not add webhook infrastructure, Linear AI integration, hosted execution, or automatic backlog selection without a requirement.
- Keep one ticket assignment active at a time. Do not add distributed throughput or parallel agent work speculatively.
- PM alone accepts a result after independent QA. Acceptance does not authorize pushing, merging, deployment, or Linear status changes.

## Code quality

Write only the code needed for the requested behavior. Favor readable functions, clear service boundaries, and existing patterns. Avoid speculative abstractions, compatibility layers, unrelated refactors, and explanatory comments for obvious code. Explain non-obvious ordering, retries, leases, and idempotency with concise comments.

Use kebab-case filenames, camelCase TypeScript identifiers, and snake_case database columns. Keep external DTO naming faithful to its API and convert at service boundaries.

Infer types where possible; give public APIs and complex functions explicit return types. Do not use `any`, non-null assertions, `@ts-ignore`, or `@ts-expect-error`. Do not use type assertions to hide mismatches; literal `as const` is allowed. Validate external payloads with Effect Schema and derive types from schemas. Keep `unknown` at untrusted input boundaries, not in domain models. Use specific ID and state types instead of interchangeable strings.

## Effect architecture

- Use named `Effect.fn` for meaningful effectful operations and service methods. Keep pure transformations pure.
- Model failures with typed errors and handle them at the layer that can act on them. Distinguish retryable transport failures, invalid responses, permission failures, and human blockers.
- Keep service requirements on Effects; provide Layers at composition roots. Do not create private runtimes inside domain services.
- Use `Effect.runPromise` or `Effect.runFork` only at process/framework boundaries. Use scoped resources and interruption for processes, leases, and database connections.
- Compose CLI commands with `@effect/cli`. Keep command parsing separate from workflow and domain logic.
- Use Effect Workflow's durable execution and waiting mechanisms. Verify installed APIs against the actual package types and official documentation; never invent persistence or recovery guarantees.
- Keep the workflow definition separate from Linear transport, Codex process execution, Git operations, and artifact storage. Make those boundaries replaceable in tests.

## Execution invariants

1. Every run belongs to one explicitly enrolled issue, repository, base commit, and managed worktree.
2. Every assignment belongs to one role and phase, with a durable identity and one active execution lease. A lease expiry alone does not prove a prior process stopped.
3. PM refinement is required before implementation. QA examines the Developer's exact commit. PM acceptance examines that same commit and refinement.
4. New implementation commits require QA again. Revised requirements return to PM and invalidate incompatible downstream evidence.
5. Only a confirmed Linear handoff dispatches the next role. Process exit alone is not a valid handoff.
6. Blocked work waits durably for a correlated human response or explicit resume. A timeout, missing answer, or retry limit is not approval.
7. Keep credentials outside prompts and child repository-command environments. Validate agent outputs before publishing or applying routing; model-generated metadata is not trusted authority.
8. Read applicable instructions in the target repository. Preserve its permission requirements and user-owned runtime prerequisites. Do not weaken them to keep an unattended run moving.

## Linear integration

Use Linear's ordinary GraphQL API. Scope reads and writes to the configured team and enrolled issues. Paginate comments and fetch explicitly referenced comments even when they fall outside the newest page. Check GraphQL errors as well as HTTP status, and respect rate limits.

Persist an intended comment and its event ID before sending it. Reconcile ambiguous publication results before retrying. Do not claim exactly-once delivery across the database and Linear. Only coordinator-recorded events with the expected run, issue, and predecessor may advance a workflow; quoted metadata or arbitrary comments must not trigger routing.

Append reports and refinements instead of editing history. Keep enough evidence in each report to assess the result without relying on a private agent conversation. Record local artifact paths without uploading private media or secrets.

## Codex and Git

Start a fresh Codex session for each role assignment. Pin `gpt-6-astra`; do not silently fall back. Retain the configured authentication and permission enforcement. Capture process identity, exit status, final structured result, and artifact references.

Reconcile interrupted processes and worktree changes before retrying an assignment. Prevent an older process from writing concurrently with its replacement. Cancellation must stop or account for the child process, not merely mark its database row paused.

Only the Developer edits implementation source. QA may produce separate verification artifacts; PM and QA review without fixing source themselves. Create ticket branches under `codex/`, preserve unrelated work, and never reset or clean a user's checkout to recover a run.

Check that runtime tests exercise the intended worktree and revision. A server serving another checkout is a blocker, not valid evidence. Keep review commits and acceptance evidence aligned.

## Testing and completion

Run `bun run format:fix`, `bun run lint:fix`, `bun run typecheck`, and relevant tests after code changes. Fix introduced errors and report pre-existing failures. Do not edit lockfiles manually; use Bun.

Test orchestration with replaceable Linear and Codex services. Cover allowed transitions, QA rework, human-response correlation, stale revisions, retry limits, duplicate events, ambiguous comment publication, and interruption recovery. Test durable recovery against a disposable Postgres database owned by the test run; never use a user's persistent database for destructive tests.

Do not call real Linear or OpenAI services in default tests. Live tests require an explicitly authorized ticket, credentials, model access, and any target-repository prerequisites. Label mocked evidence accurately and never claim end-to-end verification from static checks alone.

Finish with a concise account of the behavior changed, verification performed, and unresolved limitations. Do not describe a blocked run as completed.
