<!-- Documents the local agent workflow, operator commands, configuration, and recovery behavior. -->

# Linear AI Workflow

A local development team powered by GPT-6 Astra. A PM refines a Linear ticket, a Developer implements it, QA verifies it, and the PM reviews the complete result before accepting it.

Start the system with `bun run dev`, just like Junior’s development services, and leave it running. Turbo runs the coordinator and workflow worker together. The coordinator watches Linear for tickets labeled `ai-workflow` and starts work automatically.

The coordinator runs on your Mac. Linear comments hold the team's requirements, reports, and handoffs. Effect Workflow, Effect Cluster, and Postgres persist execution so work can recover after interruptions. Code and test artifacts live in local Git worktrees. Model inference runs on OpenAI's service.

Linear AI features are not used. The integration reads issues and publishes ordinary comments through Linear's GraphQL API.

## How it works

```text
Add the ai-workflow label in Linear
        |
        v
Running watcher discovers and queues the ticket
        |
        v
PM refinement --> Developer implementation --> QA verification --> PM acceptance
                         ^                        |                    |
                         |________________________|____________________|
                                      Corrections
```

1. Create a ticket in the configured Linear team and add the `ai-workflow` label, or add the label to an existing ticket. The running coordinator discovers it, records a durable run with the configured repository and resolved base commit, and queues it. The worker creates its isolated Git worktree before the first PM assignment.
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

Each worker runs one ticket assignment at a time. Newly discovered tickets wait in a durable queue while it is busy. The coordinator uses outbound API requests and polls Linear for labeled tickets and discussion updates; no public endpoint or webhook tunnel is required. Work pauses while the Mac is asleep and reconciles when the coordinator resumes.

## Configuration

Configure the coordinator with these environment variables. Keep secrets out of Git and agent prompts. Like Junior, `src/env.ts` validates the shared environment with `@t3-oss/env-core` and `zod/v4`; empty strings are treated as unset, and defaults live in that schema. The services, CLI, and Drizzle tooling validate the complete environment when imported, including `REPOSITORY_PATH` and `BASE_BRANCH`.

| Variable               | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`         | Connection to the coordinator's local Postgres database           |
| `LINEAR_API_KEY`       | Credential used exclusively by the Linear adapter                 |
| `LINEAR_TEAM_ID`       | Team watched for tickets labeled `ai-workflow`                    |
| `REPOSITORY_PATH`      | Absolute path to the local repository used for discovered tickets |
| `BASE_BRANCH`          | Base branch used to create each ticket’s worktree                 |
| `WORKFLOW_SHARD_GROUP` | Worker group for discovery and execution; defaults to `local`     |
| `WORKTREE_ROOT`        | Absolute directory for managed ticket worktrees                   |
| `ARTIFACT_ROOT`        | Absolute directory for logs and verification artifacts            |
| `WORKER_ID`            | Stable identity of the machine owning local files                 |
| `WORKFLOW_RUNNER_HOST` | Cluster address; defaults to `127.0.0.1`                          |
| `WORKFLOW_RUNNER_PORT` | Cluster socket port; defaults to `34541`                          |
| `POLL_SECONDS`         | Linear polling interval; defaults to `30`                         |

The model is fixed to `gpt-6-astra`. Model access failures pause the run; the coordinator does not substitute another model. Codex uses its configured authentication. Repository commands do not receive the coordinator's Linear credential or database connection settings.

Defaults are a 30-second polling interval, three implementation attempts per refinement, a 120-minute active execution budget, and 1,000,000 reported tokens per run. Automatically discovered runs receive these limits when they enter the queue. Review a blocked run before extending its budget through the operator controls. The time limit interrupts an active Codex process. The token limit is checked between assignments using emitted usage; it is not a hard in-flight spending cap, and an interrupted turn may not emit complete usage.

## Running the system

Configure the repository and base branch once, then start the development services through Turbo:

```sh
bun install
cp .env.example .env
# Set LINEAR_API_KEY, LINEAR_TEAM_ID, REPOSITORY_PATH, and BASE_BRANCH in .env.
bun run db:up
# For a fresh database, generate and review the application schema migration, then apply it.
bun run db:generate
bun run db:migrate

# Run the coordinator watcher and workflow worker together through Turbo.
bun run dev
```

The root `dev` script runs `dev:coordinator` alongside `dev:worker`, using Turbo’s terminal UI to keep their logs visible. These are long-running development services. Turbo manages the local processes; Effect Workflow and Postgres retain execution state across process restarts. Leave them running while you manage work in Linear. Restart `bun run dev` after coordinator source changes; these tasks do not hot-reload during agent execution.

Set `REPOSITORY_PATH` to the checkout you want the agents to develop and `BASE_BRANCH` to its starting branch, such as `main`. The watcher uses these settings for every ticket it discovers in `LINEAR_TEAM_ID`. Each run records its resolved base commit and owning worker so subsequent configuration changes do not move existing work.

## Automatic ticket pickup

The `ai-workflow` label is the entry point for work. Add it when a ticket is ready for the agents, then follow their refinement, implementation report, QA findings, and final PM decision in that ticket’s comments.

The watcher checks the configured team on startup and every `POLL_SECONDS` thereafter. It discovers both newly created labeled tickets and existing tickets that receive the label later, including tickets added while the system was stopped or the Mac was asleep. Open, unarchived tickets with the exact `ai-workflow` label are eligible; completed or canceled tickets are skipped.

Before dispatching PM, the coordinator records enrollment in Postgres. Repeated polls, restarts, and multiple processes sharing that database do not create competing runs for the same ticket. Tickets already being worked on retain their current phase. A ticket accepted by PM stays complete even if its label remains; the watcher does not continuously re-enroll it.

Applying `ai-workflow` selects that ticket for local implementation commits and workflow comments. The worker takes queued work automatically as capacity becomes available. The label does not authorize pushing, merging, deployment, or Linear status changes. Removing the label before discovery prevents enrollment. Once a run is enrolled, use its pause control to stop further assignments; removing a label does not interrupt an agent mid-assignment.

When a run needs your input, its comment explains the blocker and includes a question ID. Reply with that ID alone on the first line and your answer on subsequent lines. Prefix the answer with `SCOPE:` when it changes the requirements. The coordinator records the response and resumes the waiting phase. Material scope changes return to PM refinement. Ordinary comments provide context without starting a separate run.

## Operator controls

Ticket selection happens in Linear. The CLI provides inspection and recovery controls for runs already discovered by the running system:

```sh
bun run cli -- list
bun run cli -- status <run-id>
bun run cli -- pause <run-id>
bun run cli -- resume <run-id>
```

`list` shows the run IDs associated with discovered tickets. `pause` prevents further assignments and requests a controlled stop of an active session. `resume` reconciles the current worktree, persisted workflow, and pending Linear writes before continuing. It never assumes an interrupted agent made no changes.

## Worker groups and machines

`WORKFLOW_SHARD_GROUP=local` is the default for the Turbo development services; set it to `default` to use the other group. The watcher and worker use the same selected group. The implementation follows Junior’s cluster routing: workflow activities, child workflows, deferred responses, and timers retain that group. Queued tickets wait for their owning worker to become available.

Every machine uses the same Postgres database and the same ordered group registry in `src/workflows/workflow-engine.ts`. Set `WORKFLOW_RUNNER_HOST` to a private address reachable by the other machines, and use a unique `WORKFLOW_RUNNER_PORT` when running multiple processes on one host. The cluster socket is intended for a trusted private network; it has no public-facing authentication layer.

`WORKER_ID` defaults to the hostname and must remain stable across restarts. Runs retain their owning machine, branch, and local paths. Run the watcher on the machine holding the configured repository. There is one worker owner per group; a second machine can own the other group. Add future groups consistently to the registry on every node, preserving existing order. Worktrees and artifacts are not automatically transferred during failover.

Application tables are defined in `src/db/schema.ts` using Drizzle. Generate and review migrations with `bun run db:generate`, then apply them with `bun run db:migrate` before starting the development services. The schema preserves SQL table names and columns, but persisted JSON uses snake_case throughout. Existing camelCase JSON records require an explicit data migration before resuming their runs; an existing database also needs its baseline reconciled before applying an initial migration. Effect Cluster initializes its own durable storage. Use a dedicated database. `bun run db:down` stops the provided development database and preserves its volume.

## Recovery and verification

`bun run cli -- list` lists runs. Status includes the current phase, question, latest report, owning worker, worktree, and accumulated usage.

A resume can include `--answer "..."`, `--extra-minutes 30`, `--extra-tokens 100000`, or `--extra-attempts 1`. If you intentionally committed recovery changes, inspect them and use `--accept-head` to restart implementation from that clean revision. New implementation still passes through QA.

If a process exits before its assignment result was saved, the worker publishes a blocker rather than repeating code execution. Saved results resume publication reconciliation. A process lease under `ARTIFACT_ROOT/agent.lock` prevents a surviving Codex process from overlapping a replacement. Stop the identified process group before resuming. If a crash left an incomplete lease with no PID, inspect local Codex processes before manually removing that lease directory.

Developer sessions use the ticket worktree as their writable root. PM and QA sessions use their assignment artifact directory as the writable root and inspect the target repository through its absolute path. Their prompts require reading the target repository's instructions; configure any required review tools in the shared Codex configuration. Changes to source detected after a review block the handoff.

```sh
bun run test  # Complete suite; shared Testcontainers Postgres, Docker required
```

Bun preloads `src/test/setup.ts` from `bunfig.toml` to start a shared disposable Postgres database and replace production database layers with `TestPgClientLive`, `TestDatabaseLive`, and `TestStoreLive`, following Junior. They query stored rows directly to verify transaction rollback, operator controls, handoff replay, and ambiguous-publication recovery, alongside automatic discovery, concurrent enrollment, cluster restart/resume, and worker process startup/shutdown. SQL remains real; Linear and Codex are faked. Tests do not send real Linear comments or make OpenAI requests. A live run requires your configured credentials, a ticket selected with `ai-workflow`, and the target repository's prepared test environment.

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

## Current implementation gaps

- **Recovery of a stale prepared handoff:** if the worktree changes after the report is saved but before publication, the activity retries while the run can remain `running`. The CLI accepts `resume` only for `blocked` or `paused` runs. Restore the report’s recorded clean revision to allow publication; `--accept-head` cannot currently replace an already prepared report. Automatic conversion of this case into a published, resumable blocker remains unimplemented.
- **Report completeness:** the coordinator validates structured fields, role transitions, refinement IDs, commit identity, and publication. AC-N/QA-N coverage, report templates, and the adequacy of test evidence are enforced by role instructions and PM review, not by an automated artifact or acceptance-matrix validator.

## Boundaries

The coordinator follows each target repository's instructions and permission rules. It preserves unrelated edits, confines implementation to its managed worktree, and pauses for missing user-owned prerequisites. It does not repair device signing, install development builds, or mutate persistent application databases merely to make testing pass.

Run limits bound autonomous retries. Exhaustion produces a blocked comment with the work completed and the decision needed. A workflow's persisted pause is distinct from an agent claiming the task is complete.

## Development

The application uses Bun, TypeScript, Effect, Effect Workflow, and Postgres. Turbo starts the long-running coordinator and workflow worker through `bun run dev`. Operator controls use `@effect/cli`: domain-owned `*.command.ts` files are composed in `src/commands.ts`. Domain `*.workflow.ts` files are registered through `src/workflows/index.ts`. Tests are co-located with source; shared helpers and layers live in `src/test/`. `src/runtime/layers/root.ts` exports the shared `RootLayer` and `rootRuntime`, which each process disposes when it exits. Application queries use Drizzle’s native Effect Postgres adapter in `src/db/live.ts`. Linear integration, agent execution, workspace management, and durable orchestration are separate services composed at the process boundary.

```sh
bun run format:fix
bun run lint:fix
bun run typecheck
bun run test
```

See [AGENTS.md](./AGENTS.md) for implementation rules.
