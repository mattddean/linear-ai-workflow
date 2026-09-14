<!-- Governs how coding agents structure, modify, and verify the coordinator repository. -->

# AGENTS.md

Instructions for agents developing Linear AI Workflow itself. PM, Developer, and QA runtime prompts are product behavior; this file governs changes to the coordinator repository.

## Product contract

Linear AI Workflow runs a local PM → Developer → QA → PM development team. It uses ordinary Linear GraphQL issue/comment operations, local Codex sessions pinned to `gpt-6-astra`, Effect Workflow, Effect Cluster, and Postgres.

- Linear comments are the agents' communication channel. Publish and confirm a handoff before its recipient runs; construct the recipient's input from the persisted comment.
- The database owns durable execution state. Do not reconstruct the entire workflow from comments or introduce a second orchestration engine.
- Keep code execution, orchestration, and artifacts local. OpenAI performs model inference; Linear stores issue discussion.
- Use polling to automatically enroll open tickets labeled `ai-workflow` in the configured team. Run the watcher and worker through Turbo development tasks. Do not add webhooks, Linear AI integration, or hosted execution.
- Keep one ticket assignment active per worker. Use Effect Cluster with Junior’s local/default shard-group routing, selected by `WORKFLOW_SHARD_GROUP`. Preserve machine ownership of local worktrees; do not implicitly move code or artifacts when a worker changes.
- PM alone accepts a result after independent QA. Acceptance does not authorize pushing, merging, deployment, or Linear status changes.

## Code quality

Place a concise, non-JSDoc description of each authored file’s responsibility immediately after all imports, before implementation code. For files without imports that support comments, place it at the top. If that description needs unrelated responsibilities, reconsider the module boundary. Preserve strict JSON and generated file formats.

Write only the code needed for the requested behavior. Favor readable functions, clear service boundaries, and existing patterns. Avoid speculative abstractions, compatibility layers, unrelated refactors, and explanatory comments for obvious code. Explain non-obvious ordering, retries, leases, and idempotency with concise comments.

Use kebab-case filenames. Domain workflow definitions use `*.workflow.ts`; feature command definitions use `*.command.ts`. Keep feature commands next to their domain modules. `src/commands.ts` is the composition and process entry point, not a place to implement feature commands.

Match Junior’s layout: put shared workflow infrastructure and registration in `src/workflows/`, co-locate `*.test.ts` files with the modules they exercise, and put shared test setup, fixtures, and layers in `src/test/`. Do not create an `integration/` directory or separate integration test command. `bunfig.toml` preloads `src/test/setup.ts`, so `bun test` runs the complete suite against its disposable database.

Use **snake_case throughout database data layers and APIs we own**: table exports, SQL tables and columns, Drizzle property names, query projections and write objects, persisted JSON keys (including nested records), and request/response DTO fields for our own APIs. Do not expose camelCase aliases for database fields.

Keep camelCase for domain/service code and PascalCase for types, schemas, and Effect services. Use explicit typed boundary codecs to convert snake_case payloads to domain values and back. Third-party integrations must use the third party's native property names in requests, responses, schemas, and SDK calls. Do not introduce snake_case aliases or rename third-party fields to satisfy our own API convention. For example, Linear uses `createdAt`, `pageInfo`, and `commentCreate`. Convert to our database representation only when persisting that data. Third-party protocol and Effect Cluster storage formats remain owned by their libraries; do not rename their internals.

Infer types where possible; give public APIs and complex functions explicit return types. Do not use `any`, non-null assertions, `@ts-ignore`, or `@ts-expect-error`. Do not use type assertions to hide mismatches; literal `as const` is allowed. Validate external payloads with Effect Schema and derive types from schemas. Keep `unknown` at untrusted input boundaries, not in domain models. Use specific ID and state types instead of interchangeable strings.

## Effect architecture

When in doubt about how to structure any feature, service, database access, or infrastructure, inspect the corresponding implementation in Junior before choosing a pattern. Match its conventions unless this project has a concrete reason to differ.

Use the local [junior repository](../junior.mtdn.dev/junior.mtdn.dev) as a reference for good Effect practices. Before implementing Effect services, durable workflows, or CLI commands, consult the relevant working examples there:

- [Environment schema](../junior.mtdn.dev/junior.mtdn.dev/apps/express/env.ts): shared `@t3-oss/env-core` configuration with `zod/v4`.
- [Effect guidance in AGENTS.md](../junior.mtdn.dev/junior.mtdn.dev/AGENTS.md): named operations, service requirements, Layers, and runtime boundaries.
- [Workflow engine](../junior.mtdn.dev/junior.mtdn.dev/apps/express/workflows/workflow-engine.ts) and [workflow registration](../junior.mtdn.dev/junior.mtdn.dev/apps/express/workflows/index.ts): durable infrastructure and composition roots.
- [Photo-processing workflow](../junior.mtdn.dev/junior.mtdn.dev/apps/express/shopping-photo-processing.workflow.ts): a domain-owned workflow implementation.
- [CLI composition](../junior.mtdn.dev/junior.mtdn.dev/apps/express/commands.ts): `@effect/cli` commands and the process runtime boundary.
- [Workflow tests and test layers](../junior.mtdn.dev/junior.mtdn.dev/apps/express/workflows): persistence and recovery verification patterns.

Adapt these patterns to this project's requirements and installed Effect versions. Junior is a reference, not a dependency or a source of app-specific requirements; this repository's instructions remain authoritative.

- Use named `Effect.fn` for meaningful effectful operations and service methods. Keep pure transformations pure.
- Model failures with typed errors and handle them at the layer that can act on them. Distinguish retryable transport failures, invalid responses, permission failures, and human blockers.
- Keep service requirements on Effects; provide Layers at composition roots. Do not create private runtimes inside domain services.
- Use `Effect.runPromise` or `Effect.runFork` only at process/framework boundaries. Use scoped resources and interruption for processes, leases, and database connections.
- Compose CLI commands with `@effect/cli` in domain-owned `*.command.ts` modules and aggregate them in `src/commands.ts`. Aggregate domain `*.workflow.ts` layers in `src/workflows/index.ts` and start them through `registerWorkflows()`.
- Use Effect Workflow's durable execution and waiting mechanisms. Verify installed APIs against the actual package types and official documentation; never invent persistence or recovery guarantees.
- Keep the workflow definition separate from Linear transport, Codex process execution, Git operations, and artifact storage. Make those boundaries replaceable in tests.

## Environment configuration

Follow Junior’s `@t3-oss/env-core` pattern: define application environment variables, validation, coercion, and defaults together in `src/env.ts`, using `createEnv`, `zod/v4`, `runtimeEnv: process.env`, and `emptyStringAsUndefined: true`. Import `env` in runtime configuration and Drizzle tooling; do not add parallel Effect Config schemas or direct application-variable reads elsewhere.

Keep `src/config.ts` as a thin adapter into replaceable Effect settings services. Brand domain values and wrap credentials with `Redacted` at that boundary. The Postgres layer uses `PgClient.layer` with the validated, redacted database URL. Keep test-container settings, child-process environment forwarding, and third-party library configuration at their existing boundaries. The test preload must provide the complete test environment before application modules import `env`; `TestPgClientLive` continues to require its dedicated `TEST_DATABASE_URL`.

## Database and root runtime

- Use Drizzle schemas and its native Effect Postgres adapter, following Junior's `apps/express/shopping-db.ts`, `shopping-schema.ts`, and `shopping-store.ts`. Use typed query builders for application reads and writes. Keep raw SQL limited to PostgreSQL primitives such as connection-bound advisory locks and expressions unsupported by the query builder.
- Define application tables in `src/db/schema.ts`. Do not create tables during CLI startup. Edit schema sources; the user generates and applies migrations for persistent databases. Tests may initialize only their own disposable database. Effect Cluster owns its internal storage setup.
- Compose shared services in `src/runtime/layers/root.ts`. Follow the [Josiah root runtime](../../josiah/tests/src/lib/runtime/layers/root.ts) pattern: named base/service layers, exported `RootLayer`, and one module-level `rootRuntime`. Dispose it at the process boundary. Domain services retain Effect requirements and never invoke the runtime themselves.

## Execution invariants

1. Every run belongs to one label-selected issue, repository, base commit, and managed worktree.
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

For persistence, transaction, replay, and lock behavior, use the Junior-style `src/test/setup.ts` preload and `TestPgClientLive` / `TestDatabaseLive` / `TestStoreLive` layers. These use real Postgres, never mocked SQL, and expose the same database for direct snake_case row assertions. The preload owns container cleanup and sets `TEST_DATABASE_URL` without a fallback to `.env`. Keep pure routing and transport tests focused with fake services; the shared preload still owns the suite’s database lifecycle.

Test orchestration with replaceable Linear and Codex services. Cover allowed transitions, QA rework, human-response correlation, stale revisions, retry limits, duplicate events, ambiguous comment publication, and interruption recovery. Test durable recovery against a disposable Postgres database owned by the test run; never use a user's persistent database for destructive tests.

Do not call real Linear or OpenAI services in default tests. Live tests require an explicitly authorized ticket, credentials, model access, and any target-repository prerequisites. Label mocked evidence accurately and never claim end-to-end verification from static checks alone.

Finish with a concise account of the behavior changed, verification performed, and unresolved limitations. Do not describe a blocked run as completed.
