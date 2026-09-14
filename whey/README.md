# Whey

Whey creates isolated development environments using Rift snapshots, dedicated ports, generated `.env` files,
Docker Compose projects and Postgres volumes. Optional desktop opening adds a macOS Space, Ghostty panes,
VS Code, and the existing iOS development build in Simulator. Git still owns commits inside each snapshot.

## Commands

Run from the coordinator repository. `--config` selects the target repository; relative paths inside the config
resolve from that file's directory, not the tool's installation directory. Without `--config`, Whey reads
`.whey.jsonc` from the current directory. JSONC comments and trailing commas are supported.

```sh
bun run whey --config /absolute/target/.whey.jsonc create feature-name
bun run whey --config /absolute/target/.whey.jsonc start feature-name
bun run whey --config /absolute/target/.whey.jsonc open feature-name
bun run whey --config /absolute/target/.whey.jsonc stop feature-name
bun run whey --config /absolute/target/.whey.jsonc destroy feature-name
bun run whey --config /absolute/target/.whey.jsonc list
```

- `create` allocates ports, copies the repository through Rift, and writes the isolate environment. It requires Git
  and Rift, not desktop apps. `--open` explicitly requests desktop startup after creation.
- `start` runs configured `start` hooks, then guarded `migrate` hooks, without GUI apps. Junior starts its dedicated
  Postgres/Electric containers, waits for readiness, and applies existing migrations. It does not generate migrations.
- `open` runs initialization before creating a new Space and launching configured commands/apps. Junior opens API,
  Expo, worker, and Caddy panes without an additional interactive Codex. A previously recorded Space is reused;
  this is not a process-health check. No builds or app installations are performed by the supplied Junior commands.
- `stop` closes isolate windows and its Space and runs stop hooks, preserving the snapshot and named database volume.
- `destroy` runs destruction hooks and removes snapshots, configured browser profiles, and state. Preserve local
  commits and required artifacts first; destruction is never an automatic consequence of PM acceptance.
- `inspect` returns the identity of a managed isolate as JSON and validates its branch and base ancestry.

## Managed ticket creation

The coordinator invokes the same CLI with all three managed inputs:

```sh
bun run whey --config /absolute/target/.whey.jsonc create RUN_ID \
  --base FULL_COMMIT_SHA --branch codex/ticket-run-id --root /absolute/isolates --json
```

Managed creation requires exactly one project with source `.`. Its directory is `ISOLATE_ROOT/RUN_ID`, independent
of the interactive `riftName` template. The coordinator records the base SHA when enrolling the ticket. Whey copies
a clean source checkout, then creates the requested branch at that exact SHA inside the snapshot. It never resets
the source or includes unrelated uncommitted edits in managed work. Ignored files such as installed dependencies
and `.env` are copied by Rift; agents must check dependencies against the selected revision when necessary.

JSON output contains `slug`, `projectPath`, `repo`, `branch`, and `baseSha`; it excludes environment credentials.
Identity mismatches, unowned directories, missing snapshots, and modified partial copies block provisioning.
Ownership and copy checkpoints are saved before copying, using atomic state-file replacement. A retry examines an
existing partial copy rather than blindly recreating it. Ready isolates retain subsequent implementation commits.

Rift copies `.git`; it does not share a Git object store with the source checkout. To preserve an accepted branch
without pushing or merging, explicitly fetch it from the isolate into a chosen local destination branch:

```sh
git -C /absolute/source fetch /absolute/isolate codex/ticket-run-id:refs/heads/codex/ticket-run-id
```

## Configuration and migration boundary

Configuration is owned by the target repository. `stateRoot` holds `.whey/spaces/CONFIG_NAME/SLUG.json` and system
version metadata. Interactive snapshot placement uses `riftRoot`; managed creation overrides it with `--root`.
Run all later lifecycle commands with the same target config. State records the actual snapshot paths.

A project's `start` hooks provision its services. Its `migrate` hooks run only after the declared database passes
ownership verification. The `database` declaration specifies `composeFile`, `service`, `urlEnv`, `portKey`, `containerPort`, and
`volume`. The generated database URL must use localhost and the isolate's allocated port. Docker must report one
running database container with the isolate's Compose project label, matching published port, database name, and
project-scoped named volume. A directory name or `.env` file alone is not sufficient authorization.

Application migrations may run exclusively against Whey isolate databases. Never point migration hooks at shared
development, production, or coordinator databases. Migration generation remains manual. Test suites may continue
using their own disposable Testcontainers databases, generated URLs, and cleanup lifecycle.

Junior's config uses Bun, per-isolate Compose/Caddy/Expo/API/worker ports, and `EXPO_PUBLIC_API_URL`. Caddy's admin
endpoint is disabled inside isolates to avoid a shared listener. It launches native development services without the
shared Cloudflare tunnel. Existing iOS development builds and device/signing prerequisites must already be prepared.

## Desktop prerequisites

Install Rift and Hammerspoon once:

```sh
npm install -g rift-snapshot
brew install --cask hammerspoon
```

Enable Hammerspoon IPC in `~/.hammerspoon/init.lua`, reload it, and grant its macOS Accessibility permission:

```lua
require("hs.ipc")
```

The bundled `hs` CLI is used directly. Desktop opening also checks configured apps/tools. Hammerspoon's experimental
Spaces APIs may briefly show Mission Control. Initial window placement is applied on opening; it does not keep
retiling windows. The Simulator opener connects to that isolate's Expo endpoint. Verify the app is serving the intended
isolate before collecting evidence; neither a Space nor an open Simulator proves the app or server is healthy.
