# Whey

Whey creates isolated local development environments called isolates. Each
isolate gets a Rift snapshot, Docker Compose project, Postgres volume, Electric
port, Expo port, Express port, Caddy HTTPS ports, snapshot `.env` files, a
Ghostty terminal layout, VS Code, Simulator, and a native macOS Space.

Run Whey commands from the repository root:

```sh
pnpm whey <command> [isolate-name]
```

## Setup

Install the required isolate tools once:

```sh
brew install --cask hammerspoon
npm install -g rift-snapshot
```

Hammerspoon must be running with its command-line IPC enabled. Add this to
`~/.hammerspoon/init.lua`, then reload Hammerspoon:

```lua
require("hs.ipc")
```

Whey uses Hammerspoon's bundled CLI directly at
`/Applications/Hammerspoon.app/Contents/Frameworks/hs/hs`, so installing `hs`
onto your shell PATH is optional.

Grant Hammerspoon Accessibility access in macOS System Settings under Privacy &
Security -> Accessibility. Without that permission Hammerspoon can answer IPC
commands, but it cannot reliably move, size, or close isolate windows.

## Commands

Create an isolate:

```sh
pnpm whey create bulk-upload
```

The snapshot starts on a local Git branch matching the isolate name, for example
`bulk-upload`.

Create and immediately open an isolate:

```sh
pnpm whey create bulk-upload --open
```

Open the isolate:

```sh
pnpm whey open bulk-upload
```

Useful commands:

```sh
pnpm whey list
pnpm whey open bulk-upload
pnpm whey stop bulk-upload
pnpm whey destroy bulk-upload
```

`open` starts the isolate when Whey state does not have a native macOS Space
recorded. It creates the Space through Hammerspoon, opens the configured Ghostty
split layout, VS Code, Microsoft Edge, Codex, and Simulator, and applies initial
floating window frames: Ghostty fills the screen behind the app windows, VS Code
fills the space up to Simulator, Simulator gets the right side, and Microsoft
Edge and Codex open behind Ghostty without taking tiled slots.

For Junior, the Ghostty panes run Turbo, foreground `docker compose up`, and
Codex. Turbo runs Expo, Express, Caddy, and Drizzle Studio; Codex occupies the
bottom half of the Ghostty window. Express waits for Postgres, runs the API
database migration and seed script, then starts the API.

If Whey state already has a native macOS Space recorded, `open` just switches
to that Space and assumes the isolate windows are already there. After opening,
Hammerspoon does not keep tiling the windows, so you can drag and resize them
normally.

Simulator is opened through Expo's local `/_expo/open` endpoint so it loads the
active isolate's Metro server. If an existing Simulator window is on a different
Space, the launcher closes that stale window first so Expo can reopen Simulator
directly inside the active isolate Space.

Microsoft Edge opens Drizzle Studio at `https://local.drizzle.studio` with the
isolate's Drizzle port in the query string. Whey asks Edge to create the window
through AppleScript instead of Chromium command-line flags, so it uses your
normal Edge profile and window preferences while opening a separate Edge window
for each isolate. If the Edge opener configuration changes while an isolate is
already open, Whey replaces the existing Edge window in that isolate so stale
blank windows do not stick around. Codex opens through the app's real New Window
shortcut, then sits behind the main Ghostty/VS Code/Simulator working layer.

`stop` closes the isolate windows, removes the native macOS Space, and runs
`docker compose down --remove-orphans` for the isolate while leaving the Rift
snapshot, Whey state, and named Postgres volume in place. `destroy` closes the
windows and Space, runs `docker compose down --volumes --remove-orphans`, then
removes the Rift snapshot, browser profiles, and Whey state.

Native Space automation uses Hammerspoon's experimental `hs.spaces` APIs, so
Mission Control may briefly appear while Spaces are created, opened, or removed.
Whey gives Hammerspoon IPC calls a longer timeout via `ipcTimeoutSeconds` in
`../.whey.json` because Space creation and cleanup can take longer than the
`hs` CLI default.

## State

By default, Rift snapshots are created in the checkout parent at `../rift`
(`/Users/matthewdean/static/org/me/junior.mtdn.dev/rift` in the current local
layout).

Whey state is rooted at `.whey`: Space state files live in `.whey/spaces`, and
`.whey/meta.json` records the Whey system version
used for that state.

Each isolate gets its own app, API, Electric, Postgres, Caddy, and Drizzle
Studio ports. Existing isolates pick up newly configured ports the next time
they are opened, stopped, or destroyed.

Only the `.whey` root is configurable via `stateRoot` in `../.whey.json`;
everything inside that directory is owned by Whey.

Isolate behavior is configured in `../.whey.json`. The orchestrator only updates
each project's `.env`, and Caddy and other project files read those values from
the environment.

Isolates reuse the SSL hosts from the local Caddy setup:
`local.junior.mtdn.dev` for Expo and `api.shopping.local.junior.mtdn.dev` for
the API. The API URL always goes through Whey Caddy so Electric shape streams
keep the same HTTP/2-capable local proxy path as normal development.
