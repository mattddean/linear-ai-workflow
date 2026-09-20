import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercises desktop preflight through the CLI using fake Hammerspoon and macOS launcher processes.

for (const mode of ['running', 'launch', 'unresponsive'] as const) {
  test(`Hammerspoon preflight handles ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'whey-desktop-test-'))
    try {
      const app = join(directory, 'Hammerspoon.app')
      const binary = join(directory, 'hs')
      await mkdir(app)
      await writeFile(
        binary,
        `#!/usr/bin/env bun
// Simulates IPC readiness, including a client that ignores its own timeout.
const mode = ${JSON.stringify(mode)}
if (mode === 'unresponsive') await new Promise(() => { setInterval(() => {}, 1000) })
const marker = Bun.file(new URL('./launched', import.meta.url))
if (mode === 'running') process.exit(0)
if (!await marker.exists()) process.exit(1)
process.exit(Date.now() - Number(await marker.text()) >= 200 ? 0 : 1)
`,
        { mode: 0o755 },
      )
      await writeFile(
        join(directory, 'open'),
        `#!/usr/bin/env bun
// Records the launch without opening a real desktop application.
await Bun.write(new URL('./launched', import.meta.url), String(Date.now()))
`,
        { mode: 0o755 },
      )
      const config = join(directory, '.whey.jsonc')
      await writeFile(
        config,
        JSON.stringify({
          name: 'test',
          stateRoot: '.whey',
          hammerspoon: { ipcTimeoutSeconds: 0.5 },
          required: [
            { name: 'hammerspoon', check: [binary, '-c', "return 'ok'"] },
            { name: 'Hammerspoon', app },
          ],
        }),
      )
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, 'whey.mjs'), '--config', config, 'open', 'missing'],
        { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' },
      )
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(code).toBe(1)
      expect(await Bun.file(join(directory, 'launched')).exists()).toBe(mode !== 'running')
      if (mode === 'unresponsive') {
        expect(stderr).toContain('Hammerspoon IPC did not become ready')
        expect(stderr).toContain('require("hs.ipc")')
      } else {
        // Reaching state lookup proves desktop preflight finished without running isolate lifecycle hooks.
        expect(stderr).toContain('missing')
        expect(stderr).not.toContain('Hammerspoon IPC did not become ready')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
