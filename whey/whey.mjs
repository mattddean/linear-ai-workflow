#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// Provisions isolated repository snapshots and optionally manages their desktop windows and services.

const { values: options, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    root: { type: 'string' },
    base: { type: 'string' },
    branch: { type: 'string' },
    json: { type: 'boolean' },
    open: { type: 'boolean' },
  },
})
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.resolve(options.config ?? path.join(process.cwd(), '.whey.jsonc'))
const repoRoot = path.dirname(configPath)
const hammerspoonBridgePath = path.join(scriptDir, 'hammerspoon.lua')
const config =
  positionals[0] === 'help' || !positionals[0] ? null : Bun.JSONC.parse(fs.readFileSync(configPath, 'utf8'))
const wheySystemVersion = '0.1.0'

function fail(message) {
  console.error(message)
  process.exit(1)
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function expandHome(value) {
  if (value === '~') {
    return os.homedir()
  }

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2))
  }

  return value
}

function absolutePath(value, base = repoRoot) {
  const expanded = expandHome(value)
  return path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    input: options.input,
    stdio: options.stdio ?? 'inherit',
    encoding: 'utf8',
  })

  if (result.error) {
    fail(`${command} failed: ${result.error.message}`)
  }

  if (result.status !== 0) {
    fail(options.failure ?? `${[command, ...args].join(' ')} failed.`)
  }

  return result.stdout ?? ''
}

function runQuiet(command, args, name) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'ignore',
    encoding: 'utf8',
  })

  if (result.error || result.status !== 0) {
    fail(`${name} is required and unavailable.`)
  }
}

function luaString(value) {
  return JSON.stringify(value)
}

function hammerspoonIpcTimeoutSeconds() {
  const value = Number(config.hammerspoon.ipcTimeoutSeconds)
  return Number.isFinite(value) && value > 0 ? value : 60
}

function runHammerspoon(action, payload = {}) {
  const payloadFile = path.join(
    os.tmpdir(),
    `junior-whey-hs-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  )
  const commandPayload = {
    ...payload,
    action,
    missionControlWaitSeconds: config.hammerspoon.missionControlWaitSeconds,
  }
  const code = `local m = dofile(${luaString(hammerspoonBridgePath)}); m.main(${luaString(payloadFile)})`

  fs.writeFileSync(payloadFile, JSON.stringify(commandPayload))

  const result = spawnSync(
    requiredCheckCommand('hammerspoon'),
    ['-t', String(hammerspoonIpcTimeoutSeconds()), '-c', code],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'pipe',
      encoding: 'utf8',
    },
  )

  fs.rmSync(payloadFile, { force: true })

  if (result.error) {
    fail(`hammerspoon failed: ${result.error.message}`)
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
  const line = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.startsWith('{') && value.endsWith('}'))
    .at(-1)

  if (!line) {
    if (output.trim()) {
      process.stderr.write(output)
    }
    fail(`${action} did not return a Hammerspoon JSON result.`)
  }

  const message = JSON.parse(line)

  if (result.status !== 0 || !message.ok) {
    fail(message.error ?? `Hammerspoon action '${action}' failed.`)
  }

  return message.result
}

function requiredNamesFor(command, state) {
  if (command === 'create') return ['git', 'rift']
  if (command === 'open') {
    return config.required.map((item) => item.name)
  }

  if (command === 'start') return ['docker']
  if (command === 'stop') {
    return state?.macosSpaceId || state?.ghosttyWindowId
      ? ['docker', 'hammerspoon', 'Hammerspoon', 'Ghostty']
      : ['docker']
  }

  if (command === 'destroy') {
    return state?.macosSpaceId || state?.ghosttyWindowId
      ? ['git', 'rift', 'docker', 'hammerspoon', 'Hammerspoon', 'Ghostty']
      : ['git', 'rift', 'docker']
  }

  return []
}

function preflight(command, state) {
  const names = new Set(requiredNamesFor(command, state))

  for (const requirement of config.required) {
    if (!names.has(requirement.name)) {
      continue
    }

    if (requirement.app) {
      if (!fs.existsSync(absolutePath(requirement.app, '/'))) {
        fail(`${requirement.name} is required and unavailable.`)
      }
      continue
    }

    if (requirement.check) {
      const [binary, ...args] = requirement.check
      runQuiet(binary, args, requirement.name)
      continue
    }

    fail(`${requirement.name} is required but has no check.`)
  }
}

function requiredAppPath(name) {
  const requirement = config.required.find((item) => item.name === name)

  if (!requirement?.app) {
    fail(`${name} app path is not configured.`)
  }

  return absolutePath(requirement.app, '/')
}

function requiredCheckCommand(name) {
  const requirement = config.required.find((item) => item.name === name)

  if (!requirement?.check?.[0]) {
    fail(`${name} check command is not configured.`)
  }

  return absolutePath(requirement.check[0], '/')
}

function stateRoot() {
  return absolutePath(config.stateRoot)
}

function spacesRoot() {
  return path.join(stateRoot(), 'spaces')
}

function metaFile() {
  return path.join(stateRoot(), 'meta.json')
}

function ensureDirectory(dir, label) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    fail(`Failed to create ${label} at ${dir}: ${error.message}`)
  }
}

function ensureStateRoot() {
  const root = stateRoot()
  const metaPath = metaFile()

  ensureDirectory(root, 'Whey state root')
  ensureDirectory(spacesRoot(), 'Whey Spaces state directory')

  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))

    if (meta.version !== wheySystemVersion) {
      fail(`Whey state version ${meta.version} is not supported by Whey system ${wheySystemVersion}.`)
    }

    return
  }

  fs.writeFileSync(metaPath, `${JSON.stringify({ version: wheySystemVersion }, null, 2)}\n`)
}

function riftRoot() {
  return options.root ? path.resolve(options.root) : absolutePath(config.riftRoot)
}

function browserRoot() {
  return absolutePath(config.browserRoot)
}

function stateFile(slug) {
  return path.join(spacesRoot(), config.name, `${slug}.json`)
}

function readState(slug) {
  ensureStateRoot()
  const file = stateFile(slug)

  if (!fs.existsSync(file)) {
    fail(`No isolate found for '${slug}'. Create it with: bun run whey create ${slug}`)
  }

  return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')))
}

function saveState(state) {
  ensureStateRoot()
  const file = stateFile(state.slug)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // This state file is the source of truth for later stop/destroy operations.
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

function normalizeState(state) {
  state.ports ??= {}
  state.spaceName ??= spaceNameFor(state.slug, state.ports)
  state.terminalSpaceName ??= state.spaceName
  state.projects ??= {}
  state.ghosttyWindowId ??= ''
  state.macosSpaceId ??= null
  state.parkingSpaceId ??= null
  state.windowIds ??= []
  state.windowGroups ??= {}
  state.openerSignatures ??= {}

  return state
}

function render(value, context) {
  return value.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_, key) => {
    if (key === 'slug') {
      return context.slug
    }

    if (key === 'spaceName') {
      return context.spaceName
    }

    if (key === 'terminalSpaceName') {
      return context.terminalSpaceName
    }

    if (key === 'repoRoot') {
      return repoRoot
    }

    if (key === 'riftRoot') {
      return riftRoot()
    }

    if (key === 'stateRoot') {
      return stateRoot()
    }

    if (key === 'browserRoot') {
      return browserRoot()
    }

    if (key === 'projectPath') {
      return context.projectPath
    }

    if (key.startsWith('port.')) {
      const portKey = key.slice('port.'.length)
      const port = context.ports[portKey]

      if (!port) {
        fail(`Missing port '${portKey}'.`)
      }

      return String(port)
    }

    fail(`Unknown template value '${key}'.`)
  })
}

function spaceNameFor(slug, ports = {}) {
  return render(config.hammerspoon.spaceName, {
    slug,
    spaceName: '',
    terminalSpaceName: '',
    projectPath: '',
    ports,
  })
}

function terminalSpaceNameFor(slug, ports = {}) {
  return spaceNameFor(slug, ports)
}

function layoutConfig() {
  return config.hammerspoon.layout
}

function terminalGroup() {
  return layoutConfig()?.terminalGroup ?? 'terminal'
}

function appGroup() {
  return layoutConfig()?.appGroup ?? 'apps'
}

function sourcePathFor(project) {
  return absolutePath(project.source)
}

function riftPathFor(project, state) {
  return path.join(
    riftRoot(),
    render(project.riftName, {
      slug: state.slug,
      spaceName: state.spaceName,
      terminalSpaceName: state.terminalSpaceName,
      projectPath: '',
      ports: state.ports,
    }),
  )
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function shellCommandFor(launch, cwd, envFile, title) {
  return [
    `cd ${shellQuote(cwd)}`,
    'set -a',
    `source ${shellQuote(envFile)}`,
    'set +a',
    `printf '\\033]0;%s\\007' ${shellQuote(title)}`,
    `echo ${shellQuote(`[${title}] ${launch.command}`)}`,
    launch.command,
    '',
  ].join('\n')
}

function appleString(value) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '')
  return `"${escaped.replace(/\n/g, '" & linefeed & "')}"`
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function prepareChromiumProfile(profile) {
  fs.mkdirSync(profile, { recursive: true })
  fs.closeSync(fs.openSync(path.join(profile, 'First Run'), 'a'))

  const localStatePath = path.join(profile, 'Local State')
  const localState = readJsonFile(localStatePath, {})
  localState.browser = {
    ...(localState.browser ?? {}),
    enabled_labs_experiments: localState.browser?.enabled_labs_experiments ?? [],
    has_seen_welcome_page: true,
  }
  localState.distribution = {
    ...(localState.distribution ?? {}),
    do_not_create_desktop_shortcut: true,
    do_not_create_quick_launch_shortcut: true,
    import_bookmarks: false,
    import_history: false,
    import_search_engine: false,
    make_chrome_default: false,
    skip_first_run_ui: true,
    suppress_first_run_bubble: true,
  }
  writeJsonFile(localStatePath, localState)

  const preferencesPath = path.join(profile, 'Default', 'Preferences')
  const preferences = readJsonFile(preferencesPath, {})
  preferences.browser = {
    ...(preferences.browser ?? {}),
    has_seen_welcome_page: true,
  }
  preferences.credentials_enable_service = false
  preferences.profile = {
    ...(preferences.profile ?? {}),
    password_manager_enabled: false,
  }
  preferences.signin = {
    ...(preferences.signin ?? {}),
    allowed: false,
  }
  preferences.sync_promo = {
    ...(preferences.sync_promo ?? {}),
    show_on_first_run_allowed: false,
  }
  writeJsonFile(preferencesPath, preferences)
}

function projectEnv(project, state, projectPath) {
  const values = {}

  for (const [key, value] of Object.entries(project.env)) {
    values[key] = render(value, {
      slug: state.slug,
      spaceName: state.spaceName,
      terminalSpaceName: state.terminalSpaceName,
      projectPath,
      ports: state.ports,
    })
  }

  return values
}

function updateEnvFile(file, values) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : []
  const keys = new Set(Object.keys(values))
  const seen = new Set()
  const output = []

  for (let index = 0; index < existing.length; index += 1) {
    const line = existing[index]

    if (line === '' && index === existing.length - 1) {
      continue
    }

    const equalsIndex = line.indexOf('=')
    const key = equalsIndex > 0 ? line.slice(0, equalsIndex) : ''

    if (keys.has(key)) {
      output.push(`${key}=${values[key]}`)
      seen.add(key)
      continue
    }

    output.push(line)
  }

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      output.push(`${key}=${value}`)
    }
  }

  fs.writeFileSync(file, `${output.join('\n')}\n`)
}

function syncProjectEnv(project, state) {
  const projectState = state.projects[project.id]

  if (!projectState) {
    fail(`State for project '${project.id}' is missing.`)
  }

  const envFile = path.join(projectState.path, project.envFile)
  const values = projectEnv(project, state, projectState.path)
  updateEnvFile(envFile, values)
  projectState.envFile = envFile
}

function syncEnvFiles(state) {
  for (const project of config.projects) {
    syncProjectEnv(project, state)
  }

  saveState(state)
}

async function allocatePorts(keys) {
  const servers = []
  const ports = {}

  for (const key of keys) {
    const server = await new Promise((resolve, reject) => {
      const listener = net.createServer()
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', () => resolve(listener))
    })

    servers.push(server)
    ports[key] = server.address().port
  }

  for (const server of servers) {
    server.close()
  }

  return ports
}

async function ensureConfiguredPorts(state) {
  const missingKeys = config.ports.filter((key) => !state.ports[key])

  if (missingKeys.length === 0) {
    return
  }

  Object.assign(state.ports, await allocatePorts(missingKeys))
  saveState(state)
}

function snapshotGit(projectPath, args) {
  return run('git', ['-C', projectPath, ...args], { stdio: 'pipe' }).trim()
}

function createRiftProject(project, state) {
  const sourcePath = sourcePathFor(project)
  const projectPath = riftPathFor(project, state)
  const managed = state.managed
  let checkpoint = state.projects[project.id]

  if (checkpoint?.phase === 'ready') return checkpoint.path
  if (!checkpoint) {
    if (fs.existsSync(projectPath)) fail(`Unowned snapshot already exists: ${projectPath}`)
    if (managed && snapshotGit(sourcePath, ['status', '--porcelain', '--untracked-files=all'])) {
      fail('Source checkout has uncommitted files. Commit or preserve them before creating a managed isolate.')
    }
    checkpoint = {
      path: projectPath,
      envFile: '',
      phase: 'copying',
      sourceSha: snapshotGit(sourcePath, ['rev-parse', 'HEAD']),
    }
    // Persist ownership before Rift starts; a retry must inspect an existing copy rather than overwrite it.
    state.projects[project.id] = checkpoint
    saveState(state)
  }

  if (!fs.existsSync(projectPath)) {
    fs.mkdirSync(riftRoot(), { recursive: true })
    run('rift', ['init', '--here'], { cwd: sourcePath, stdio: 'pipe' })
    run('rift', ['create', '--name', path.basename(projectPath), '--into', riftRoot(), '--copy-all', '--no-hooks'], {
      cwd: sourcePath,
      stdio: 'pipe',
    })
  }

  const branch =
    managed?.branch ??
    render(project.branch, {
      slug: state.slug,
      spaceName: state.spaceName,
      terminalSpaceName: state.terminalSpaceName,
      projectPath,
      ports: state.ports,
    })
  const currentBranch = snapshotGit(projectPath, ['branch', '--show-current'])
  const head = snapshotGit(projectPath, ['rev-parse', 'HEAD'])
  if (managed) {
    if (snapshotGit(projectPath, ['status', '--porcelain', '--untracked-files=all'])) {
      fail(`Incomplete or modified snapshot at ${projectPath}; reconcile it without discarding work.`)
    }
    if (currentBranch === branch && head === managed.baseSha) {
      checkpoint.phase = 'ready'
      saveState(state)
      return projectPath
    }
    if (head !== checkpoint.sourceSha) fail(`Snapshot revision changed during creation: ${projectPath}`)
    snapshotGit(projectPath, ['switch', '--no-track', '-c', branch, managed.baseSha])
  } else if (currentBranch !== branch) {
    snapshotGit(projectPath, ['switch', '-c', branch])
  }
  checkpoint.phase = 'ready'
  saveState(state)
  return projectPath
}

function managedSummary(state) {
  const project = config.projects[0]
  const projectState = state.projects[project.id]
  if (!state.managed || projectState?.phase !== 'ready') fail('Managed isolate is not ready.')
  if (!fs.existsSync(projectState.path)) fail(`Managed isolate is missing: ${projectState.path}`)
  if (snapshotGit(projectState.path, ['branch', '--show-current']) !== state.managed.branch) {
    fail('Managed isolate branch changed.')
  }
  snapshotGit(projectState.path, ['merge-base', '--is-ancestor', state.managed.baseSha, 'HEAD'])
  return { slug: state.slug, projectPath: projectState.path, ...state.managed }
}

function printSummary(state) {
  console.log()
  console.log(state.slug)
  console.log(`  status:    ${state.macosSpaceId ? 'open' : 'closed'}`)
  console.log(`  space:     ${state.spaceName}${state.macosSpaceId ? ` (${state.macosSpaceId})` : ''}`)

  for (const project of config.projects) {
    const projectState = state.projects[project.id]

    if (!projectState) {
      continue
    }

    console.log(`  ${project.id}: ${projectState.path}`)
  }

  for (const project of config.projects) {
    const projectState = state.projects[project.id]
    const context = summaryContext(state, projectState?.path ?? '')

    for (const opener of project.open ?? []) {
      if (opener.url) {
        console.log(`  ${project.id} ${opener.app}: ${render(opener.url, context)}`)
      } else if (opener.args) {
        console.log(`  ${project.id} ${opener.app}: ${opener.args.map((arg) => render(arg, context)).join(' ')}`)
      } else if (opener.expo) {
        console.log(`  ${project.id} ${opener.app}: ${expoOpenUrl(opener, context)}`)
      }
    }
  }
}

function summaryContext(state, projectPath) {
  return {
    slug: state.slug,
    spaceName: state.spaceName,
    terminalSpaceName: state.terminalSpaceName,
    projectPath,
    ports: state.ports,
  }
}

function expoOpenUrl(opener, context) {
  const url = new URL(render(opener.expo.endpoint, context))
  url.searchParams.set('platform', opener.expo.platform)

  if (opener.expo.runtime) {
    url.searchParams.set('runtime', opener.expo.runtime)
  }

  return url.toString()
}

function listWindows() {
  return runHammerspoon('listWindows')
}

function windowId(window) {
  return String(window['window-id'])
}

function appName(window) {
  return String(window['app-name'])
}

function windowSpaceIds(window) {
  return (window['space-ids'] ?? []).map((id) => Number(id))
}

async function closeAppWindowsOutsideIsolateSpace(name, state) {
  const targetSpaceId = Number(state.macosSpaceId)
  const windowIds = listWindows()
    .filter((window) => appName(window) === name)
    .filter((window) => !windowSpaceIds(window).includes(targetSpaceId))
    .map(windowId)

  if (windowIds.length === 0) {
    return
  }

  closeWindowIds(windowIds)
  await sleep(1000)
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForAppWindows(before, name, reuseExisting = false) {
  const beforeIds = new Set(before.map(windowId))

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const windows = listWindows()
    const matches = windows.filter((window) => {
      if (appName(window) !== name) {
        return false
      }

      return reuseExisting || !beforeIds.has(windowId(window))
    })

    if (matches.length > 0) {
      return matches
    }

    await sleep(250)
  }

  fail(`No new ${name} window appeared in Hammerspoon.`)
}

async function waitForExpoOpenEndpoint(opener, context) {
  const url = expoOpenUrl(opener, context)
  const started = Date.now()
  const waitMs = opener.expo.waitMs ?? 120000
  let lastStatus = 'no response'

  while (Date.now() - started < waitMs) {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    }).catch(() => null)

    if (response?.ok) {
      return url
    }

    lastStatus = response ? `${response.status} ${response.statusText}` : 'no response'
    await sleep(1000)
  }

  fail(`Expo dev server did not become ready at ${url} (${lastStatus}).`)
}

async function openExpoSimulator(opener, context) {
  const url = await waitForExpoOpenEndpoint(opener, context)
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
  }).catch(() => null)

  if (!response) {
    fail(`Expo iOS launch failed at ${url}.`)
  }

  if (!response.ok) {
    const message = await response.text()
    fail(`Expo iOS launch failed at ${url}: ${response.status} ${response.statusText}\n${message}`)
  }
}

function openBrowserWithAppleScript(opener, context) {
  const url = render(opener.url, context)
  const lines = [
    `tell application ${appleString(opener.app)}`,
    'set isolateWindow to make new window',
    'repeat 50 times',
    'if (count tabs of isolateWindow) > 0 then exit repeat',
    'delay 0.1',
    'end repeat',
    `set URL of item 1 of tabs of isolateWindow to ${appleString(url)}`,
    'activate',
    'return id of isolateWindow',
    'end tell',
  ]

  run('osascript', ['-e', lines.join('\n')], {
    stdio: 'pipe',
    failure: `${opener.app} AppleScript launch failed.`,
  })
}

function openAppWithShortcut(opener) {
  const shortcut = opener.shortcut

  if (!shortcut?.key) {
    fail(`${opener.app} shortcut opener requires shortcut.key.`)
  }

  runHammerspoon('appShortcut', {
    app: opener.app,
    delaySeconds: shortcut.delaySeconds,
    key: shortcut.key,
    modifiers: shortcut.modifiers ?? [],
  })
}

function ensureIsolateSpace(state) {
  const result = runHammerspoon('ensureSpace', {
    spaceId: state.macosSpaceId,
    parkingSpaceId: state.parkingSpaceId,
    screen: config.hammerspoon.screen,
  })

  state.macosSpaceId = result.spaceId
  state.parkingSpaceId = result.parkingSpaceId

  return result
}

function requireIsolateSpace(state) {
  if (!state.macosSpaceId) {
    fail(`Isolate '${state.slug}' is not open in a native macOS Space. Run: bun run whey open ${state.slug}`)
  }
}

function switchIsolateSpace(state) {
  requireIsolateSpace(state)
  runHammerspoon('gotoSpace', { spaceId: state.macosSpaceId })
}

function stopIsolateSpace(state) {
  if (!state.macosSpaceId) {
    return
  }

  const result = runHammerspoon('stopSpace', {
    spaceId: state.macosSpaceId,
    parkingSpaceId: state.parkingSpaceId,
    windowIds: state.windowIds,
  })

  state.parkingSpaceId = result.parkingSpaceId ?? state.parkingSpaceId
  state.macosSpaceId = null
  state.windowIds = []
  state.windowGroups = {}
}

function moveWindowsToSpace(windows, state) {
  requireIsolateSpace(state)

  const targetSpaceId = Number(state.macosSpaceId)
  const windowIds = windows.filter((window) => !windowSpaceIds(window).includes(targetSpaceId)).map(windowId)

  if (windowIds.length === 0) {
    return
  }

  runHammerspoon('moveWindowsToSpace', {
    spaceId: state.macosSpaceId,
    windowIds,
  })
}

function closeWindowIds(windowIds) {
  runHammerspoon('closeWindows', { windowIds })
}

function openerWindowsInIsolate(opener, state) {
  const name = openerWindowAppName(opener)
  const spaceId = Number(state.macosSpaceId)

  return listWindows().filter((window) => appName(window) === name && windowSpaceIds(window).includes(spaceId))
}

function recordWindows(state, group, windows) {
  const windowIds = windows.map(windowId)
  const existingGroupIds = state.windowGroups[group] ?? []

  state.windowGroups[group] = [...new Set([...existingGroupIds, ...windowIds])]
  state.windowIds = [...new Set([...state.windowIds, ...windowIds])]
}

function openerWindowAppName(opener) {
  return opener.windowAppName ?? opener.hammerspoonAppName ?? opener.app
}

function openerWindowGroup(opener) {
  return opener.windowGroup ?? opener.hammerspoonGroup ?? appGroup()
}

function openerStateKey(project, opener, index) {
  return `${project.id}:${opener.key ?? opener.name ?? opener.app}:${index}`
}

function openerSignature(opener, context) {
  return JSON.stringify({
    app: opener.app,
    args: opener.args?.map((arg) => render(arg, context)),
    browserArgs: opener.browserArgs?.map((arg) => render(arg, context)),
    expo: opener.expo ? expoOpenUrl(opener, context) : undefined,
    openMethod: opener.openMethod,
    openMode: opener.openMode,
    profile: opener.profile ? render(opener.profile, context) : undefined,
    profileKind: opener.profileKind,
    replaceOnSignatureChange: opener.replaceOnSignatureChange,
    shortcut: opener.shortcut,
    url: opener.url ? render(opener.url, context) : undefined,
  })
}

function configuredGroupApps() {
  const groups = new Map([[terminalGroup(), new Set(['Ghostty'])]])

  for (const project of config.projects) {
    for (const opener of project.open ?? []) {
      const group = openerWindowGroup(opener)
      const names = groups.get(group) ?? new Set()
      names.add(openerWindowAppName(opener))
      groups.set(group, names)
    }
  }

  return groups
}

function discoverWindowGroups(state, windows) {
  const groups = {}
  const spaceId = Number(state.macosSpaceId)

  for (const [group, names] of configuredGroupApps()) {
    groups[group] = windows
      .filter((window) => names.has(appName(window)) && windowSpaceIds(window).includes(spaceId))
      .map(windowId)
  }

  return groups
}

function activeWindowGroups(state) {
  const windows = listWindows()
  const existingWindowIds = new Set(windows.map(windowId))
  const groups = {}

  for (const [group, windowIds] of Object.entries(state.windowGroups)) {
    groups[group] = windowIds.filter((id) => existingWindowIds.has(id))
  }

  for (const [group, windowIds] of Object.entries(discoverWindowGroups(state, windows))) {
    groups[group] = [...new Set([...(groups[group] ?? []), ...windowIds])]
  }

  state.windowGroups = groups
  state.windowIds = Object.values(groups).flat()

  return groups
}

function applyIsolateLayout(state) {
  const layout = layoutConfig()

  if (!layout || !state.macosSpaceId) {
    return
  }

  const groups = activeWindowGroups(state)
  const windowIds = Object.values(groups).flat()

  if (windowIds.length === 0) {
    return
  }

  runHammerspoon('applyLayout', {
    spaceId: state.macosSpaceId,
    groups,
    layout,
  })
}

function applyIsolate(state) {
  switchIsolateSpace(state)
  applyIsolateLayout(state)
}

function launchCommandsFor(state) {
  const commands = []

  for (const project of config.projects) {
    const projectState = state.projects[project.id]

    if (!projectState) {
      fail(`State for project '${project.id}' is missing.`)
    }

    for (const launch of project.launch ?? []) {
      const cwd = path.resolve(projectState.path, launch.cwd)
      commands.push({
        title: `${state.slug}:${project.id}:${launch.name}`,
        cwd,
        envFile: projectState.envFile,
        launch,
      })
    }
  }

  return commands
}

function launchGhostty(commands) {
  if (commands.length === 0) {
    fail('No launch commands are configured.')
  }

  const [first, ...rest] = commands
  const terminalByName = new Map([[first.launch.name, 'rootTerminal']])
  const lines = [
    `tell application ${appleString(requiredAppPath('Ghostty'))}`,
    'activate',
    'set config0 to new surface configuration',
    `set initial working directory of config0 to ${appleString(first.cwd)}`,
    'set command of config0 to "/bin/zsh"',
    `set initial input of config0 to ${appleString(shellCommandFor(first.launch, first.cwd, first.envFile, first.title))}`,
    'set isolateWindow to new window with configuration config0',
    'set isolateTab to selected tab of isolateWindow',
    'set rootTerminal to focused terminal of isolateTab',
  ]

  rest.forEach((command, index) => {
    const configName = `config${index + 1}`
    const terminalName = `terminal${index + 1}`
    const targetName = command.launch.target ?? first.launch.name
    const targetTerminal = terminalByName.get(targetName)
    const direction = command.launch.split ?? 'right'

    if (!targetTerminal) {
      fail(`Launch command '${command.launch.name}' targets unknown pane '${targetName}'.`)
    }

    lines.push(
      `set ${configName} to new surface configuration`,
      `set initial working directory of ${configName} to ${appleString(command.cwd)}`,
      `set command of ${configName} to "/bin/zsh"`,
      `set initial input of ${configName} to ${appleString(shellCommandFor(command.launch, command.cwd, command.envFile, command.title))}`,
      `set ${terminalName} to split ${targetTerminal} direction ${direction} with configuration ${configName}`,
    )

    terminalByName.set(command.launch.name, terminalName)
  })

  lines.push('return id of isolateWindow', 'end tell')

  return run('osascript', ['-e', lines.join('\n')], {
    stdio: 'pipe',
    failure: 'Ghostty launch failed.',
  }).trim()
}

function closeGhosttyWindow(state) {
  if (!state.ghosttyWindowId) {
    return
  }

  const script = [
    `tell application ${appleString(requiredAppPath('Ghostty'))}`,
    'repeat with candidate in windows',
    `if id of candidate is ${appleString(state.ghosttyWindowId)} then`,
    'close window candidate',
    'return',
    'end if',
    'end repeat',
    'end tell',
  ].join('\n')

  run('osascript', ['-e', script], {
    stdio: 'pipe',
    failure: 'Ghostty window close failed.',
  })
}

async function openProjectUrls(project, state, options = {}) {
  const projectState = state.projects[project.id]

  if (!projectState) {
    fail(`State for project '${project.id}' is missing.`)
  }

  const context = summaryContext(state, projectState.path)

  for (const [openerIndex, opener] of (project.open ?? []).entries()) {
    const appName = openerWindowAppName(opener)
    const stateKey = openerStateKey(project, opener, openerIndex)
    const signature = openerSignature(opener, context)
    switchIsolateSpace(state)

    if (options.onlyMissing) {
      const existingWindows = openerWindowsInIsolate(opener, state)

      if (existingWindows.length > 0 && state.openerSignatures[stateKey] === signature) {
        recordWindows(state, openerWindowGroup(opener), existingWindows)
        continue
      }

      if (existingWindows.length > 0 && opener.replaceOnSignatureChange) {
        closeWindowIds(existingWindows.map(windowId))
        await sleep(1000)
      }
    }

    if (opener.closeExistingWindowsOutsideSpace) {
      await closeAppWindowsOutsideIsolateSpace(appName, state)
    }

    const before = listWindows()

    if (opener.expo) {
      await openExpoSimulator(opener, context)
    } else if (opener.args) {
      run('open', ['-na', opener.app, '--args', ...opener.args.map((arg) => render(arg, context))])
    } else if (opener.openMethod === 'app-shortcut') {
      openAppWithShortcut(opener)
    } else if (opener.openMethod === 'applescript-browser') {
      openBrowserWithAppleScript(opener, context)
    } else {
      const profile = opener.profile ? absolutePath(render(opener.profile, context)) : null
      const url = render(opener.url, context)
      const browserArgs = (opener.browserArgs ?? []).map((arg) => render(arg, context))
      const targetArgs = opener.openMode === 'app' ? [`--app=${url}`] : ['--new-window', url]
      const openTarget = profile ? ['-na', opener.app] : ['-a', opener.app]

      if (profile) {
        if (opener.profileKind === 'chromium') {
          prepareChromiumProfile(profile)
        } else {
          fs.mkdirSync(profile, { recursive: true })
        }
      }

      run('open', [
        ...openTarget,
        '--args',
        ...(profile ? [`--user-data-dir=${profile}`] : []),
        ...browserArgs,
        ...targetArgs,
      ])
    }

    const windows = await waitForAppWindows(before, appName, opener.reuseExisting)
    moveWindowsToSpace(windows, state)
    recordWindows(state, openerWindowGroup(opener), windows)
    state.openerSignatures[stateKey] = signature
  }
}

function runProjectLifecycleCommands(project, state, lifecycle) {
  const projectState = state.projects[project.id]

  if (!projectState) {
    return
  }

  const values = projectEnv(project, state, projectState.path)
  const env = { ...process.env, ...values }

  for (const command of project[lifecycle] ?? []) {
    run('/bin/zsh', ['-lc', command.command], {
      cwd: path.resolve(projectState.path, command.cwd),
      env,
    })
  }
}

function runProjectStop(project, state) {
  runProjectLifecycleCommands(project, state, 'stop')
}

function runProjectDestroy(project, state) {
  runProjectLifecycleCommands(project, state, 'destroy')
}

async function cmdCreate(rawName) {
  const slug = slugify(rawName)

  if (!slug) {
    fail('Isolate name must contain letters or numbers.')
  }

  preflight('create')
  const managedRequested = options.base || options.branch || options.root
  if (managedRequested && (!options.base || !options.branch || !options.root)) {
    fail('Managed creation requires --base, --branch, and --root together.')
  }
  if (managedRequested && (config.projects.length !== 1 || sourcePathFor(config.projects[0]) !== repoRoot)) {
    fail('Managed creation requires exactly one project whose source is the target repository.')
  }
  if (options.base && !/^[a-f0-9]{40}$/.test(options.base)) fail('--base must be an exact commit SHA.')
  if (options.branch) snapshotGit(repoRoot, ['check-ref-format', '--branch', options.branch])

  const file = stateFile(slug)
  const state = fs.existsSync(file)
    ? normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')))
    : normalizeState({
        slug,
        spaceName: spaceNameFor(slug),
        terminalSpaceName: terminalSpaceNameFor(slug),
        ports: await allocatePorts(config.ports),
        projects: {},
        ghosttyWindowId: '',
        macosSpaceId: null,
        parkingSpaceId: null,
        windowIds: [],
        windowGroups: {},
      })

  if (managedRequested) {
    const expected = { baseSha: options.base, branch: options.branch, repo: repoRoot }
    if (fs.existsSync(file) && JSON.stringify(state.managed) !== JSON.stringify(expected)) {
      fail('Isolate identity does not match this run.')
    }
    state.managed = expected
    const project = config.projects[0]
    // Managed directory names are run IDs, independent of a project's interactive naming template.
    project.riftName = '{slug}'
    if (state.projects[project.id] && state.projects[project.id].path !== riftPathFor(project, state)) {
      fail('Isolate path does not match this run.')
    }
  }
  await ensureConfiguredPorts(state)
  saveState(state)

  for (const project of config.projects) {
    createRiftProject(project, state)
    syncProjectEnv(project, state)
  }

  saveState(state)

  if (options.open) {
    await cmdOpen(slug)
    return
  }

  if (options.json) console.log(JSON.stringify(managedSummary(state)))
  else {
    printSummary(state)
    console.log(`Open it with: bun run whey --config ${configPath} open ${slug}`)
  }
}

function verifyIsolateDatabase(project, state) {
  const database = project.database
  if (!database) fail('Migration hooks require an isolate database declaration.')
  const projectState = state.projects[project.id]
  const values = projectEnv(project, state, projectState.path)
  const url = new URL(values[database.urlEnv])
  const projectName = values.COMPOSE_PROJECT_NAME
  const port = String(state.ports[database.portKey])
  if (
    !projectName?.endsWith(`-${state.slug}`) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.port !== port
  ) {
    fail('Migration URL must target this isolate’s local Postgres port and Compose project.')
  }
  const containerId = run(
    'docker',
    ['compose', '--env-file', projectState.envFile, '-f', database.composeFile, 'ps', '--quiet', database.service],
    { cwd: projectState.path, env: { ...process.env, ...values }, stdio: 'pipe' },
  ).trim()
  if (!containerId || containerId.includes('\n')) fail('Expected one isolate database container.')
  const [container] = JSON.parse(run('docker', ['inspect', containerId], { stdio: 'pipe' }))
  const bindings = container.NetworkSettings.Ports[`${database.containerPort}/tcp`] ?? []
  if (
    !container.State.Running ||
    container.Config.Labels['com.docker.compose.project'] !== projectName ||
    !bindings.some((binding) => binding.HostPort === port) ||
    !container.Mounts.some((mount) => mount.Type === 'volume' && mount.Name === `${projectName}_${database.volume}`) ||
    !container.Config.Env.includes(`POSTGRES_DB=${url.pathname.slice(1)}`)
  ) {
    fail('Database container, published port, database name, and volume must belong to this isolate before migrating.')
  }
}

async function cmdStart(rawName) {
  preflight('start')
  const state = readState(slugify(rawName))
  if (state.managed) managedSummary(state)
  for (const project of config.projects) {
    if (state.projects[project.id]?.phase !== 'ready') fail('Isolate provisioning has not completed.')
  }
  await ensureConfiguredPorts(state)
  syncEnvFiles(state)
  for (const project of config.projects) {
    runProjectLifecycleCommands(project, state, 'start')
    if (project.migrate?.length) {
      verifyIsolateDatabase(project, state)
      runProjectLifecycleCommands(project, state, 'migrate')
    }
  }
}

async function cmdOpen(rawName) {
  const slug = slugify(rawName)
  preflight('open')

  const state = readState(slug)
  await ensureConfiguredPorts(state)
  syncEnvFiles(state)

  if (state.macosSpaceId) {
    switchIsolateSpace(state)
    for (const project of config.projects) {
      await openProjectUrls(project, state, { onlyMissing: true })
    }
    applyIsolate(state)
    saveState(state)
    printSummary(state)
    return
  }

  await cmdStart(slug)
  ensureIsolateSpace(state)

  const beforeGhostty = listWindows()
  state.windowIds = []
  state.windowGroups = {}
  state.ghosttyWindowId = launchGhostty(launchCommandsFor(state))
  const ghosttyWindows = await waitForAppWindows(beforeGhostty, 'Ghostty')
  moveWindowsToSpace(ghosttyWindows, state)
  recordWindows(state, terminalGroup(), ghosttyWindows)

  for (const project of config.projects) {
    await openProjectUrls(project, state)
  }

  applyIsolate(state)
  saveState(state)
  printSummary(state)
}

async function cmdStop(rawName) {
  const slug = slugify(rawName)
  const state = readState(slug)
  preflight('stop', state)
  await ensureConfiguredPorts(state)
  syncEnvFiles(state)
  closeGhosttyWindow(state)
  stopIsolateSpace(state)

  for (const project of config.projects) {
    runProjectStop(project, state)
  }

  state.ghosttyWindowId = ''
  saveState(state)
  console.log(`Stopped ${slug}.`)
}

async function cmdDestroy(rawName) {
  const slug = slugify(rawName)
  const state = readState(slug)
  preflight('destroy', state)
  await ensureConfiguredPorts(state)
  closeGhosttyWindow(state)
  stopIsolateSpace(state)

  for (const project of config.projects) {
    runProjectDestroy(project, state)
  }

  for (const [projectId, projectState] of Object.entries(state.projects)) {
    if (!projectState) {
      continue
    }

    // Destructive: deletes the Rift snapshot directory recorded for this isolate,
    // including snapshots for projects that were later removed from the config.
    run('rift', ['remove', projectState.path], {
      failure: `Failed to remove Rift snapshot for '${projectId}'.`,
    })
  }

  for (const project of config.projects) {
    const projectState = state.projects[project.id]
    const context = summaryContext(state, projectState?.path ?? '')

    for (const opener of project.open ?? []) {
      if (!opener.profile) {
        continue
      }

      // Destructive: removes only browser profiles declared by this isolate config.
      fs.rmSync(absolutePath(render(opener.profile, context)), {
        force: true,
        recursive: true,
      })
    }
  }

  // Destructive: deletes this isolate's orchestration state after snapshots are gone.
  fs.rmSync(stateFile(slug), { force: true })
  console.log(`Destroyed ${slug}.`)
}

function cmdList() {
  ensureStateRoot()

  const dir = path.join(spacesRoot(), config.name)

  if (!fs.existsSync(dir)) {
    console.log('No isolates.')
    return
  }

  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()

  if (files.length === 0) {
    console.log('No isolates.')
    return
  }

  for (const file of files) {
    printSummary(normalizeState(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))))
  }
}

function usage() {
  console.log('Usage:')
  console.log('  bun run whey <command> [isolate-name]')
  console.log()
  console.log('Commands:')
  console.log('  create <isolate-name> [--open] [--base SHA --branch BRANCH --root PATH] [--json]')
  console.log('  --config PATH           Target repository .whey.jsonc (defaults to current directory).')
  console.log('  inspect <isolate-name>  Return managed isolate identity as JSON.')
  console.log('                          Create a Rift snapshot, allocate ports, and write isolate env files.')
  console.log('  start <isolate-name>    Run isolate initialization hooks without opening desktop apps.')
  console.log('  open <isolate-name>     Open the isolate, or switch to it when it is already open.')
  console.log('  stop <isolate-name>     Close isolate windows, remove the native Space, and run stop hooks.')
  console.log('  destroy <isolate-name>  Stop the isolate, remove Docker volumes, Rift snapshot, profiles, and state.')
  console.log('  list                    Show all isolates, open status, paths, and URLs.')
  console.log('  help                    Show this command reference.')
}

const [command, ...args] = positionals
const name = args.join(' ')

switch (command) {
  case undefined:
  case 'help':
    usage()
    break
  case 'create':
    {
      await cmdCreate(name)
    }
    break
  case 'inspect':
    console.log(JSON.stringify(managedSummary(readState(slugify(name)))))
    break
  case 'start':
    await cmdStart(name)
    break
  case 'open':
    await cmdOpen(name)
    break
  case 'stop':
    await cmdStop(name)
    break
  case 'destroy':
    await cmdDestroy(name)
    break
  case 'list':
    cmdList()
    break
  default:
    console.error(`Unknown Whey command: ${command}`)
    console.error()
    usage()
    process.exit(1)
}
