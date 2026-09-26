import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { startGateway } from './tunnel-gateway.mjs'
import { decodeRegistration, gatewayIdentity } from './tunnel-protocol.mjs'

// Verifies concurrent local routing, streaming, WebSockets, and gateway ownership without Cloudflare credentials.

const cleanup = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function availablePort() {
  const listener = net.createServer()
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  return port
}

async function until(check, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error('Condition did not become true')
}

async function fixture() {
  const settings = {
    domain: 'dev.example.test',
    port: await availablePort(),
    configFile: '/unused/test-cloudflared.yml',
    apiPortKey: 'PORT',
    expoPortKey: 'EXPO_PORT',
  }
  let launches = 0
  const spawnTunnel = () => {
    launches++
    return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  }
  const gateway = await startGateway(settings, spawnTunnel)
  cleanup.push(gateway.stop)
  const origin = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request, server) => {
      if (new URL(request.url).pathname === '/ws' && server.upgrade(request)) return
      return new Response(
        `${request.headers.get('host')} ${request.method} ${new URL(request.url).pathname}${new URL(request.url).search} ${await request.text()}`,
        {
          headers: { 'set-cookie': 'session=value; Secure; HttpOnly' },
        },
      )
    },
    websocket: { message: (socket, message) => socket.send(message) },
  })
  cleanup.push(() => origin.stop(true))
  const get = (id, pathname = '/') =>
    fetch(`http://127.0.0.1:${settings.port}${pathname}`, {
      headers: { host: `api-${id}.${settings.domain}` },
    })
  return { settings, gateway, origin, get, spawnTunnel, launches: () => launches }
}

async function register(settings, isolateId, apiPort, expoPort = apiPort) {
  const { key, socketPath } = gatewayIdentity(settings)
  const socket = net.createConnection(socketPath)
  cleanup.push(() => socket.destroy())
  const reply = await new Promise((resolve, reject) => {
    let data = ''
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      data += chunk.toString()
      if (data.includes('\n')) resolve(JSON.parse(data.trim()))
    })
    socket.on('connect', () =>
      socket.write(
        `${JSON.stringify({
          gateway_key: key,
          isolate_id: isolateId,
          api_port: apiPort,
          expo_port: expoPort,
        })}\n`,
      ),
    )
  })
  return { socket, reply }
}

test('two isolates route independently, preserve requests and cookies, and unregister independently', async () => {
  const f = await fixture()
  const second = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('second isolate') })
  cleanup.push(() => second.stop(true))
  const [a, b] = await Promise.all([
    register(f.settings, 'a', f.origin.port, second.port),
    register(f.settings, 'b', second.port),
  ])
  expect(a.reply.status).toBe('ready')
  expect(b.reply.status).toBe('ready')
  const response = await fetch(`http://127.0.0.1:${f.settings.port}/upload?x=1`, {
    method: 'POST',
    headers: { host: `api-a.${f.settings.domain}` },
    body: 'hello',
  })
  expect(await response.text()).toBe(`api-a.${f.settings.domain} POST /upload?x=1 hello`)
  expect(response.headers.get('set-cookie')).toContain('session=value')
  const expoResponse = await fetch(`http://127.0.0.1:${f.settings.port}/`, {
    headers: { host: `expo-a.${f.settings.domain}` },
  })
  expect(await expoResponse.text()).toBe('second isolate')
  expect(await (await f.get('b')).text()).toBe('second isolate')
  expect((await f.get('unknown')).status).toBe(404)
  const duplicate = await register(f.settings, 'a', second.port)
  expect(duplicate.reply.status).toBe('error')
  expect(await (await f.get('a')).text()).toContain(`api-a.${f.settings.domain}`)
  a.socket.destroy()
  await until(async () => (await f.get('a')).status === 404)
  expect(await (await f.get('b')).text()).toBe('second isolate')
  expect(f.launches()).toBe(1)
})

test('Expo WebSockets pass through and close when their isolate unregisters', async () => {
  const f = await fixture()
  const client = await register(f.settings, 'websocket', f.origin.port)
  const socket = new WebSocket(`ws://127.0.0.1:${f.settings.port}/ws`, {
    headers: { host: `expo-websocket.${f.settings.domain}` },
  })
  cleanup.push(() => socket.close())
  const message = await new Promise((resolve, reject) => {
    socket.onopen = () => socket.send('metro-hot-reload')
    socket.onmessage = (event) => resolve(event.data)
    socket.onerror = reject
  })
  expect(message).toBe('metro-hot-reload')
  const closed = new Promise((resolve) => {
    socket.onclose = resolve
  })
  client.socket.destroy()
  await closed
  await f.gateway.stop()
  const replacement = net.createServer()
  await new Promise((resolve, reject) => {
    replacement.once('error', reject)
    replacement.listen(f.settings.port, '127.0.0.1', resolve)
  })
  await new Promise((resolve) => replacement.close(resolve))
})

test('streaming responses deliver data before the upstream response ends', async () => {
  const f = await fixture()
  let stream
  const origin = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller
            controller.enqueue(new TextEncoder().encode('data: first\n\n'))
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  })
  cleanup.push(() => origin.stop(true))
  await register(f.settings, 'stream', origin.port)
  const response = await f.get('stream')
  const reader = response.body.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n')
  stream.close()
  expect((await reader.read()).done).toBe(true)
})

test('a second gateway cannot start another connector on the occupied listener', async () => {
  const f = await fixture()
  await expect(startGateway(f.settings, f.spawnTunnel)).rejects.toThrow()
  expect(f.launches()).toBe(1)
  expect((await register(f.settings, 'still-live', f.origin.port)).reply.status).toBe('ready')
})

test('registration rejects invalid ports, hostnames, and routing back to the gateway', async () => {
  expect(() => decodeRegistration({ isolate_id: '../bad', api_port: 80, expo_port: 80, gateway_key: 'x' })).toThrow()
  expect(() => decodeRegistration({ isolate_id: 'valid', api_port: 0, expo_port: 80, gateway_key: 'x' })).toThrow()
  const f = await fixture()
  expect((await register(f.settings, 'loop', f.settings.port)).reply.status).toBe('error')
})

test('concurrent dev clients start one connector and a killed client leaves the other working', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'whey-tunnel-test-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(
    path.join(directory, 'cloudflared'),
    `#!/usr/bin/env bun
// Records connector launches without contacting Cloudflare.
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(path.join(directory, 'launches'))}, 'started')
setInterval(() => {}, 1000)
`,
    { mode: 0o755 },
  )
  const configFile = path.join(directory, 'cloudflared.yml')
  await writeFile(configFile, '# Fake connector ignores this file.\n')
  const settings = {
    domain: 'dev.example.test',
    port: await availablePort(),
    configFile,
    apiPortKey: 'PORT',
    expoPortKey: 'EXPO_PORT',
  }
  const origin = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('alive') })
  cleanup.push(() => origin.stop(true))
  const clients = ['first', 'second'].map((id) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      import { attachTunnel } from ${JSON.stringify(path.join(import.meta.dir, 'tunnel-client.mjs'))};
      await attachTunnel(${JSON.stringify(settings)}, ${JSON.stringify({ isolate_id: id, api_port: origin.port, expo_port: origin.port })}, ${JSON.stringify(path.join(directory, 'gateway.log'))});
    `,
      ],
      {
        cwd: directory,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (data) => {
      output += data.toString()
    })
    child.stderr.on('data', (data) => {
      output += data.toString()
    })
    cleanup.push(() => child.kill())
    return { child, output: () => output }
  })
  await until(() => clients.every((client) => client.output().includes('Routes registered')))
  cleanup.push(async () => {
    for (const client of clients) client.child.kill()
    await until(() => !existsSync(gatewayIdentity(settings).socketPath), 500)
  })
  await until(() => existsSync(path.join(directory, 'launches')))
  expect((await readFile(path.join(directory, 'launches'), 'utf8')).trim()).toBe('started')
  const get = (id) => fetch(`http://127.0.0.1:${settings.port}`, { headers: { host: `api-${id}.${settings.domain}` } })
  clients[0].child.kill('SIGKILL')
  await until(async () => (await get('first')).status === 404)
  expect(await (await get('second')).text()).toBe('alive')
  clients[1].child.kill('SIGTERM')
  // The final client leaves a short grace period so a restarting dev task can reuse the connector.
  await until(() => !existsSync(gatewayIdentity(settings).socketPath), 500)
  expect(existsSync(gatewayIdentity(settings).socketPath)).toBe(false)
}, 20000)
