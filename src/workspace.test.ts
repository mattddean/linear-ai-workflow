import { afterEach, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Branch, CommitSha, Path } from './domain'
import { makeRun } from './test/fixtures'
import { Workspace } from './workspace'

// Exercises real Git snapshots and Whey's CLI with a controllable Rift copy process, including interrupted provisioning.

const directories: string[] = []
const originalPath = process.env.PATH

afterEach(async () => {
  process.env.PATH = originalPath
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function git(repo: Path, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(errors)
  return output.trim()
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'whey-test-'))
  directories.push(directory)
  const repo = Path.make(join(directory, 'repo'))
  const bin = join(directory, 'bin')
  await mkdir(repo)
  await mkdir(bin)
  await writeFile(
    join(bin, 'rift'),
    `#!/bin/sh
if [ "$1" != create ]; then exit 0; fi
shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --into) target="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$target/$name"
cp -R "$PWD/." "$target/$name/"
if [ -f "$PWD/../interrupt" ]; then
  rm "$PWD/../interrupt"
  exit 1
fi
`,
    { mode: 0o755 },
  )
  process.env.PATH = `${bin}:${originalPath}`
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'test@example.invalid'])
  await git(repo, ['config', 'user.name', 'Test'])
  await writeFile(join(repo, '.gitignore'), '.env\n.whey/\n')
  await writeFile(
    join(repo, '.whey.jsonc'),
    `{
    // JSONC is intentional; GUI dependencies must not be required for creation.
    "name": "test", "stateRoot": ".whey", "riftRoot": "../interactive",
    "hammerspoon": {"spaceName": "whey-{slug}"},
    "required": [{"name": "git", "check": ["git", "--version"]},
      {"name": "rift", "check": ["rift", "--help"]},
      {"name": "Ghostty", "app": "/missing/Gui.app"}],
    "ports": [],
    "projects": [{"id": "app", "source": ".", "riftName": "{slug}", "branch": "{slug}",
      "envFile": ".env", "env": {"COMPOSE_PROJECT_NAME": "test-{slug}"}}],
  }`,
  )
  await writeFile(join(repo, 'feature.txt'), 'base\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-m', 'base'])
  const baseSha = CommitSha.make(await git(repo, ['rev-parse', 'HEAD']))
  await writeFile(join(repo, 'feature.txt'), 'later\n')
  await git(repo, ['commit', '-am', 'later'])
  const initial = makeRun()
  const run = {
    ...initial,
    repo,
    baseSha,
    branch: Branch.make(`codex/${initial.id}`),
    workspace: Path.make(join(directory, 'isolates', initial.id)),
  }
  const prepare = () =>
    Effect.runPromise(
      Effect.flatMap(Workspace, (workspace) => workspace.prepare(run)).pipe(Effect.provide(Workspace.layer)),
    )
  const inspect = () =>
    Effect.runPromise(
      Effect.flatMap(Workspace, (workspace) => workspace.inspect(run)).pipe(Effect.provide(Workspace.layer)),
    )
  return { directory, run, prepare, inspect }
}

test('creates at the enrolled base, writes isolate env, and retains implementation commits on replay', async () => {
  const f = await fixture()
  const sourceHead = await git(f.run.repo, ['rev-parse', 'HEAD'])
  await f.prepare()
  expect(await f.inspect()).toBe(f.run.baseSha)
  expect(await readFile(join(f.run.workspace, 'feature.txt'), 'utf8')).toBe('base\n')
  expect(await readFile(join(f.run.workspace, '.env'), 'utf8')).toContain(`test-${f.run.id}`)
  await writeFile(join(f.run.workspace, 'feature.txt'), 'implemented\n')
  await git(f.run.workspace, ['commit', '-am', 'implementation'])
  const head = await f.inspect()
  await f.prepare()
  expect(await f.inspect()).toBe(head)
  expect(await git(f.run.repo, ['rev-parse', 'HEAD'])).toBe(sourceHead)
  expect(await git(f.run.repo, ['branch', '--list', f.run.branch])).toBe('')
})

test('resumes a copy interrupted before its completion checkpoint', async () => {
  const f = await fixture()
  await writeFile(join(f.directory, 'interrupt'), '')
  expect(await f.prepare().then(() => null, String)).not.toBeNull()
  await f.prepare()
  expect(await f.inspect()).toBe(f.run.baseSha)
})

test('refuses unrelated source edits without modifying them', async () => {
  const f = await fixture()
  await writeFile(join(f.run.repo, 'feature.txt'), 'unrelated\n')
  expect(await f.prepare().then(() => null, String)).toContain('uncommitted')
  expect(await readFile(join(f.run.repo, 'feature.txt'), 'utf8')).toBe('unrelated\n')
})

test('blocks altered partial snapshots rather than resetting them', async () => {
  const f = await fixture()
  await writeFile(join(f.directory, 'interrupt'), '')
  expect(await f.prepare().then(() => null, String)).not.toBeNull()
  await writeFile(join(f.run.workspace, 'feature.txt'), 'preserve\n')
  expect(await f.prepare().then(() => null, String)).toContain('modified snapshot')
  expect(await readFile(join(f.run.workspace, 'feature.txt'), 'utf8')).toBe('preserve\n')
})

test('rejects dirty review revisions and changed branches', async () => {
  const f = await fixture()
  await f.prepare()
  await writeFile(join(f.run.workspace, 'untracked'), 'keep')
  expect(await f.inspect().then(() => null, String)).toContain('uncommitted')
  await git(f.run.workspace, ['switch', '-c', 'another'])
  expect(await f.inspect().then(() => null, String)).toContain('branch changed')
})

test('does not adopt an existing unowned directory', async () => {
  const f = await fixture()
  await mkdir(f.run.workspace, { recursive: true })
  expect(await f.prepare().then(() => null, String)).toContain('Unowned snapshot')
})

for (const ownership of ['owned', 'foreign'] as const) {
  test(`migration hooks require an ${ownership === 'owned' ? 'owned' : 'owned, not foreign'} database`, async () => {
    const f = await fixture()
    await f.prepare()
    const configFile = join(f.run.repo, '.whey.jsonc')
    const config = {
      name: 'test',
      stateRoot: '.whey',
      riftRoot: '../interactive',
      hammerspoon: { spaceName: 'whey-{slug}' },
      required: [{ name: 'docker', check: ['docker', '--version'] }],
      ports: ['POSTGRES_PORT'],
      projects: [
        {
          id: 'app',
          source: '.',
          riftName: '{slug}',
          branch: '{slug}',
          envFile: '.env',
          env: {
            COMPOSE_PROJECT_NAME: 'test-{slug}',
            SHOPPING_LIST_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:{port.POSTGRES_PORT}/shopping_list',
          },
          database: {
            composeFile: 'docker/docker-compose.yml',
            service: 'db',
            urlEnv: 'SHOPPING_LIST_DB_URL',
            portKey: 'POSTGRES_PORT',
            containerPort: 5432,
            volume: 'data',
          },
          migrate: [{ cwd: '.', command: 'touch migration-ran' }],
        },
      ],
    }
    await writeFile(configFile, JSON.stringify(config))
    await writeFile(join(f.directory, 'ownership'), ownership)
    await writeFile(
      join(f.directory, 'bin', 'docker'),
      `#!/usr/bin/env bun
const fs = require('node:fs')
if (process.argv[2] === '--version') process.exit(0)
if (process.argv[2] === 'compose') { console.log('container'); process.exit(0) }
const root = new URL('../', import.meta.url)
const stateRoot = new URL('repo/.whey/spaces/test/', root)
const [file] = fs.readdirSync(stateRoot)
const state = JSON.parse(fs.readFileSync(new URL(file, stateRoot), 'utf8'))
const project = fs.readFileSync(new URL('ownership', root), 'utf8') === 'owned' ? 'test-' + state.slug : 'shared'
console.log(JSON.stringify([{ State: { Running: true }, Config: {
  Labels: { 'com.docker.compose.project': project }, Env: ['POSTGRES_DB=shopping_list'],
}, NetworkSettings: { Ports: { '5432/tcp': [{ HostPort: String(state.ports.POSTGRES_PORT) }] } },
Mounts: [{ Type: 'volume', Name: project + '_data' }] }]))
`,
      { mode: 0o755 },
    )
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('../whey/whey.mjs', import.meta.url).pathname,
        '--config',
        configFile,
        'start',
        f.run.id,
      ],
      { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
    )
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code).toBe(ownership === 'owned' ? 0 : 1)
    expect(await Bun.file(join(f.run.workspace, 'migration-ran')).exists()).toBe(ownership === 'owned')
    if (ownership === 'foreign') expect(stderr).toContain('must belong to this isolate')
  })
}
