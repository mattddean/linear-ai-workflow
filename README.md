<!-- Documents the local agent workflow, operator commands, configuration, and recovery behavior. -->

# Linear AI Workflow

A local development team powered by GPT-6 Astra. A PM refines a Linear ticket, a Developer implements it, QA verifies it, and the PM reviews the complete result before accepting it.

The coordinator runs on your Mac. Linear comments hold the team's requirements, reports, and handoffs. Effect Workflow, Effect Cluster, and Postgres persist execution so work can recover after interruptions. Code and test artifacts live in local Git worktrees. Model inference runs on OpenAI's service.

Linear AI features are not used. The integration reads issues and publishes ordinary comments through Linear's GraphQL API.

## How it works

```text
Enroll a Linear issue
        |
        v
PM refinement --> Developer implementation --> QA verification --> PM acceptance
                         ^                        |                    |
                         |________________________|____________________|
                                      Corrections
```

1. Enroll a ticket with the CLI. The coordinator reads its description and comments and creates an isolated Git worktree from the selected base branch.
2. The PM examines the ticket and repository, then publishes a refinement comment containing scope, numbered acceptance criteria, assumptions, and a verification plan.
3. The Developer reads the published refinement, implements the change, runs the repository's required checks, and commits the result locally. Its handoff comment identifies the refinement and exact commit for QA.
4. QA independently inspects and tests that revision. Findings return to the Developer; a passing report goes to the PM.
5. The PM checks the original request, refinement, implementation, and QA evidence. It accepts the result or routes specific corrections to the appropriate role.

Each assignment uses a fresh local Codex session with `gpt-6-astra`. Agents communicate through persisted Linear comments; one agent's private conversation is never passed to another. The coordinator publishes an agent's report, confirms that Linear stored it, and fetches that comment before dispatching its recipient.

Approval means the local implementation satisfies the ticket. Pushing, merging, deploying, and changing Linear status are separate, explicitly authorized actions.

## Requirements

- macOS with Bun, Git, and a local Postgres database.
- An authenticated Codex CLI with access to `gpt-6-astra`.
- A Linear personal API key with access to the issues being enrolled and permission to create comments.
- A local checkout of the repository being developed.
- Any development servers, devices, and test prerequisites required by that repository.

Each worker runs one ticket assignment at a time. It uses outbound API requests and polls Linear for updates; no public endpoint or webhook tunnel is required. Work pauses while the Mac is asleep and reconciles when the coordinator resumes.

## Configuration

Configure the coordinator with these environment variables. Keep secrets out of Git and agent prompts.

| Variable               | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `DATABASE_URL`         | Connection to the coordinator's local Postgres database |
| `LINEAR_API_KEY`       | Credential used exclusively by the Linear adapter       |
| `LINEAR_TEAM_ID`       | Team whose issues may be enrolled                       |
| `WORKTREE_ROOT`        | Absolute directory for managed ticket worktrees         |
| `ARTIFACT_ROOT`        | Absolute directory for logs and verification artifacts  |
| `WORKER_ID`            | Stable identity of the machine owning local files       |
| `WORKFLOW_RUNNER_HOST` | Cluster address; defaults to `127.0.0.1`                |
| `WORKFLOW_RUNNER_PORT` | Cluster socket port; defaults to `34541`                |
| `POLL_SECONDS`         | Linear polling interval; defaults to `30`               |

The model is fixed to `gpt-6-astra`. Model access failures pause the run; the coordinator does not substitute another model. Codex uses its configured authentication. Repository commands do not receive the coordinator's Linear credential or database connection settings.

Defaults are a 30-second polling interval, three implementation attempts per refinement, a 120-minute active execution budget, and 1,000,000 reported tokens per run. Set `--max-attempts`, `--max-minutes`, and `--max-tokens` on `start`. The time limit interrupts an active Codex process. The token limit is checked between assignments using emitted usage; it is not a hard in-flight spending cap, and an interrupted turn may not emit complete usage.

## Usage

```sh
bun install
cp .env.example .env
# Set LINEAR_API_KEY and LINEAR_TEAM_ID in .env.
bun run db:up
# For a fresh database, generate and review the application schema migration, then apply it.
bun run db:generate
bun run db:migrate

# Start the durable worker and Linear polling loop.
bun run cli -- serve --worker local

# Enroll a ticket against a local repository and explicit base branch.
bun run cli -- start ENG-123 --repo /absolute/path/to/repository --base main --worker local

# Inspect, pause, or resume a run using the ID returned by start.
bun run cli -- status <run-id>
bun run cli -- pause <run-id>
bun run cli -- resume <run-id>
```

These CLI commands are the application's interface. Starting a ticket authorizes local implementation commits and workflow comments on that ticket. The coordinator does not automatically select other backlog items.

`pause` prevents further assignments and requests a controlled stop of an active session. `resume` reconciles the current worktree, persisted workflow, and pending Linear writes before continuing. It never assumes an interrupted agent made no changes.

When a run needs your input, its comment explains the blocker and includes a question ID. Reply on the issue with that ID and your answer. The coordinator records the response and resumes the waiting phase. Material scope changes return to PM refinement. Ordinary comments provide context without automatically launching an assignment.

## Worker groups and machines

`--worker local` is the default for `start` and `serve`. `--worker default` selects the other group. The implementation follows junior's cluster routing: workflow activities, child workflows, deferred responses, and timers retain the selected shard group. Clients check that a worker is reachable before enrollment.

Every machine uses the same Postgres database and the same ordered group registry in `src/workflows/workflow-engine.ts`. Set `WORKFLOW_RUNNER_HOST` to a private address reachable by the other machines, and use a unique `WORKFLOW_RUNNER_PORT` when running multiple processes on one host. The cluster socket is intended for a trusted private network; it has no public-facing authentication layer.

`WORKER_ID` defaults to the hostname and must remain stable across restarts. Runs retain their owning machine, branch, and local paths. Enroll from that machine. There is one worker owner per group; a second machine can own the other group. Add future groups consistently to the registry on every node, preserving existing order. Worktrees and artifacts are not automatically transferred during failover.

Application tables are defined in `src/db/schema.ts` using Drizzle. Generate and review migrations with `bun run db:generate`, then apply them with `bun run db:migrate` before starting the CLI. The schema preserves SQL table names and columns, but persisted JSON uses snake_case throughout. Existing camelCase JSON records require an explicit data migration before resuming their runs; an existing database also needs its baseline reconciled before applying an initial migration. Effect Cluster initializes its own durable storage. Use a dedicated database. `bun run db:down` stops the provided development database and preserves its volume.

## Recovery and verification

`bun run cli -- list` lists runs. Status includes the current phase, question, latest report, owning worker, worktree, and accumulated usage.

A resume can include `--answer "..."`, `--extra-minutes 30`, `--extra-tokens 100000`, or `--extra-attempts 1`. If you intentionally committed recovery changes, inspect them and use `--accept-head` to restart implementation from that clean revision. New implementation still passes through QA.

After an unclean process exit, the worker publishes a blocker rather than repeating code execution. A process lease under `ARTIFACT_ROOT/agent.lock` prevents a surviving Codex process from overlapping a replacement. Stop the identified process group before resuming. If a crash left an incomplete lease with no PID, inspect local Codex processes before manually removing that lease directory.

Developer sessions use the ticket worktree as their writable root. PM and QA sessions use their assignment artifact directory as the writable root and inspect the target repository through its absolute path. Their prompts require reading the target repository's instructions; configure any required review tools in the shared Codex configuration. Changes to source detected after a review block the handoff.

```sh
bun run test  # Complete suite; shared Testcontainers Postgres, Docker required
```

Bun preloads `src/test/setup.ts` from `bunfig.toml` to start a shared disposable Postgres database and replace production database layers with `TestPgClientLive`, `TestDatabaseLive`, and `TestStoreLive`, following Junior. They query stored rows directly to verify transaction rollback, operator controls, handoff replay, and ambiguous-publication recovery, alongside cluster restart/resume and CLI startup/shutdown. SQL remains real; Linear and Codex are faked. Tests do not send real Linear comments or make OpenAI requests. A live run requires your configured credentials, an explicitly enrolled ticket, and the target repository's prepared test environment.

## Roles

Each assignment loads [shared runtime instructions](./prompts/shared.md) and exactly one role prompt:

- [PM instructions](./prompts/pm.md) for refinement and final acceptance.
- [Developer instructions](./prompts/developer.md) for implementation and fixes.
- [QA instructions](./prompts/qa.md) for independent verification.

These prompts define the agents' structured results and reports. The coordinator validates each result, adds trusted metadata, and publishes the report as a Linear comment before dispatching the next role.

### PM

The PM owns requirement clarity and final acceptance. Its refinement preserves the original request and provides stable `AC-N` criteria with observable results. It resolves routine ambiguity from the repository and asks only questions essential to correctness or scope.

At acceptance, the PM inspects the actual diff and audits each criterion against Developer and QA evidence. It also checks that its own refinement accurately represents the original ticket. A QA pass alone is not final approval.

### Developer

The Developer owns source changes and fixes. It follows the target repository's `AGENTS.md`, skills, architecture, and required checks. It implements the smallest complete change and reports the base commit, final commit, worktree, executed checks, and relevant artifacts.

It sends product ambiguities back to PM and implementation results to QA. It does not change the acceptance criteria or approve its own work.

### QA

QA independently verifies the reviewed commit and maps every acceptance criterion to evidence. It reports reproducible defects with stable `QA-N` identifiers, expected and observed results, and artifact references.

QA does not modify implementation source. Missing infrastructure, required device checks, or human confirmation produces a blocker rather than a pass. Every implementation revision returns through QA before PM acceptance.

## State and recovery

| Storage                  | Responsibility                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Linear comments          | Visible requirements, findings, handoffs, and human answers                                       |
| Local Postgres           | Durable workflow execution, assignments, checkpoints, pending publications, and retry bookkeeping |
| Local Git worktrees      | Implementation branches and immutable review commits                                              |
| Local artifact directory | Command logs, screenshots, and other verification evidence                                        |

Each workflow comment identifies its run, event, role, phase, outcome, predecessor comment, refinement comment, reviewed commit, and next owner. Comments are appended rather than rewritten; revised refinements explicitly supersede earlier ones.

Effect Workflow persists execution progress and waits. A recorded assignment and an exclusive execution lease prevent competing dispatches. External effects still require reconciliation: durability does not make a comment publication or a Codex process exactly-once.

Before posting a comment, the coordinator persists its body and unique event ID. If the request times out, it searches the issue's comments for that event before retrying. A handoff advances only after publication is confirmed. Interrupted agent assignments are reconciled against process state, logs, and worktree changes before another session starts.

QA and PM approval apply to one refinement and one exact commit. A new refinement invalidates downstream acceptance; new code requires QA again. Changes to issue requirements during an assignment are checked before its handoff is accepted.

## Boundaries

The coordinator follows each target repository's instructions and permission rules. It preserves unrelated edits, confines implementation to its managed worktree, and pauses for missing user-owned prerequisites. It does not repair device signing, install development builds, or mutate persistent application databases merely to make testing pass.

Run limits bound autonomous retries. Exhaustion produces a blocked comment with the work completed and the decision needed. A workflow's persisted pause is distinct from an agent claiming the task is complete.

## Development

The application uses Bun, TypeScript, Effect, Effect Workflow, and Postgres. Its CLI is built with `@effect/cli`: domain-owned `*.command.ts` files are composed in `src/commands.ts`. Domain `*.workflow.ts` files are registered through `src/workflows/index.ts`. Tests are co-located with source; shared helpers and layers live in `src/test/`. `src/runtime/layers/root.ts` exports the shared `RootLayer` and `rootRuntime`, which is disposed when the CLI exits. Application queries use Drizzle’s native Effect Postgres adapter in `src/db/live.ts`. Linear integration, agent execution, workspace management, and durable orchestration are separate services composed at the process boundary.

```sh
bun run format:fix
bun run lint:fix
bun run typecheck
bun run test
```

See [AGENTS.md](./AGENTS.md) for implementation rules.
