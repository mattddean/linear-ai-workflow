import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'

import { decodeRegistration, decodeTunnelSettings, gatewayIdentity, tunnelUrls } from './tunnel-protocol.mjs'
import { createTunnelRouter } from './tunnel-router.mjs'

// Owns one shared cloudflared process and routes whose lifetime follows private client connections.

export async function startGateway(
  settings,
  spawnTunnel = () =>
    spawn('cloudflared', ['tunnel', '--config', settings.configFile, 'run'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    }),
  idleMs = 10000,
) {
  const { key, socketPath } = gatewayIdentity(settings)
  const routes = new Map()
  const clients = new Set()
  // Binding the public listener elects the only owner before it touches the socket or starts cloudflared.
  const router = createTunnelRouter(settings.port, (host) => routes.get(host))
  let idleTimer
  let tunnel
  let stopping
  let finish
  const closed = new Promise((resolve) => {
    finish = resolve
  })
  const control = net.createServer((socket) => {
    clients.add(socket)
    socket.setTimeout(5000, () => socket.destroy())
    let buffer = ''
    let ownedRoutes = []
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.length > 4096 || ownedRoutes.length) {
        socket.destroy()
        return
      }
      if (!buffer.includes('\n')) return
      try {
        const record = decodeRegistration(JSON.parse(buffer.trim()))
        if (record.gateway_key !== key) throw new Error('Gateway configuration does not match this client.')
        if (record.api_port === settings.port || record.expo_port === settings.port) {
          throw new Error('An isolate cannot route to the gateway itself.')
        }
        const urls = tunnelUrls(settings.domain, record.isolate_id)
        const requested = [
          { host: new URL(urls.api_url).hostname, port: record.api_port, connections: new Set() },
          { host: new URL(urls.expo_url).hostname, port: record.expo_port, connections: new Set() },
        ]
        if (requested.some((route) => routes.has(route.host)))
          throw new Error('This isolate already has an active tunnel client.')
        clearTimeout(idleTimer)
        ownedRoutes = requested
        for (const route of ownedRoutes) routes.set(route.host, route)
        socket.setTimeout(0)
        socket.write(`${JSON.stringify({ status: 'ready', ...urls })}\n`)
        console.log(`Registered ${record.isolate_id}`)
      } catch (error) {
        socket.end(`${JSON.stringify({ status: 'error', message: error.message })}\n`)
      }
    })
    socket.once('close', () => {
      clients.delete(socket)
      for (const route of ownedRoutes) {
        routes.delete(route.host)
        for (const connection of route.connections) connection.destroy()
      }
      if (routes.size === 0 && !stopping) scheduleIdle()
    })
  })

  function scheduleIdle() {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      void stop()
    }, idleMs)
  }

  function stop() {
    stopping ??= (async () => {
      clearTimeout(idleTimer)
      for (const socket of clients) socket.destroy()
      for (const route of routes.values()) for (const connection of route.connections) connection.destroy()
      routes.clear()
      await new Promise((resolve) => control.close(resolve))
      fs.rmSync(socketPath, { force: true })
      if (tunnel?.pid && tunnel.exitCode === null && tunnel.signalCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => tunnel.kill('SIGKILL'), 5000)
          tunnel.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
          tunnel.kill('SIGTERM')
        })
      }
      // Keep the election port until the socket and connector are gone so a replacement cannot race cleanup.
      // Bun 1.3.14 can leave stop() pending after a closed WebSocket; tracked connections are already destroyed.
      void router.stop(true)
      router.unref()
      finish()
    })()
    return stopping
  }

  try {
    fs.rmSync(socketPath, { force: true })
    await new Promise((resolve, reject) => {
      control.once('error', reject)
      control.listen(socketPath, resolve)
    })
    fs.chmodSync(socketPath, 0o600)
    tunnel = spawnTunnel()
    tunnel.once('error', (error) => {
      console.error(error.message)
      void stop()
    })
    tunnel.once('exit', (code, signal) => {
      if (!stopping) {
        console.error(`cloudflared exited (${code ?? signal}).`)
        void stop()
      }
    })
    scheduleIdle()
    return { stop, closed, socketPath }
  } catch (error) {
    await stop()
    throw error
  }
}

if (import.meta.main) {
  process.umask(0o077)
  try {
    const settings = decodeTunnelSettings(JSON.parse(process.argv[2]))
    fs.accessSync(settings.configFile, fs.constants.R_OK)
    const gateway = await startGateway(settings)
    process.once('SIGTERM', () => {
      void gateway.stop()
    })
    process.once('SIGINT', () => {
      void gateway.stop()
    })
    await gateway.closed
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
