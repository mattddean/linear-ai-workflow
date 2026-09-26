import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeRegistration, decodeReply, gatewayIdentity } from './tunnel-protocol.mjs'

// Attaches a dev task to the shared gateway, starting it once and withdrawing routes when that task exits.

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.once('error', reject)
    socket.once('connect', () => resolve(socket))
  })
}

export async function attachTunnel(settings, registration, logPath) {
  const { key, socketPath } = gatewayIdentity(settings)
  const record = decodeRegistration({ ...registration, gateway_key: key })
  let socket = await connect(socketPath).catch(() => null)
  if (!socket) {
    if (!fs.existsSync(settings.configFile)) {
      throw new Error(`Create the Cloudflare configuration at ${settings.configFile} first; see whey/tunnels.md.`)
    }
    const log = fs.openSync(logPath, 'a', 0o600)
    const gateway = spawn(
      process.execPath,
      [fileURLToPath(new URL('./tunnel-gateway.mjs', import.meta.url)), JSON.stringify(settings)],
      {
        cwd: os.tmpdir(),
        detached: true,
        stdio: ['ignore', log, log],
        env: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir() },
      },
    )
    fs.closeSync(log)
    gateway.on('error', (error) => console.error(error.message))
    gateway.unref()
    const deadline = Date.now() + 10000
    while (!socket && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      socket = await connect(socketPath).catch(() => null)
    }
    if (!socket) throw new Error(`Shared tunnel gateway did not start. Check ${path.resolve(logPath)}.`)
  }

  await new Promise((resolve, reject) => {
    let stopping = false
    let registered = false
    let buffer = ''
    const timer = setTimeout(() => fail(new Error('Tunnel registration timed out.')), 5000)
    const stop = () => {
      stopping = true
      socket.destroy()
    }
    const parentTimer = setInterval(() => {
      if (process.ppid === 1) stop()
    }, 1000)
    const fail = (error) => {
      reject(error)
      socket.destroy()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    socket.on('error', fail)
    socket.once('close', () => {
      clearTimeout(timer)
      clearInterval(parentTimer)
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      if (stopping) resolve()
      else
        reject(
          new Error(
            registered ? 'Shared tunnel gateway disconnected; restart dev:tunnel.' : 'Tunnel registration failed.',
          ),
        )
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.length > 4096) {
        fail(new Error('Invalid gateway response.'))
        return
      }
      if (!buffer.includes('\n')) return
      try {
        const reply = decodeReply(JSON.parse(buffer.trim()))
        if (reply.status === 'error') throw new Error(reply.message)
        registered = true
        clearTimeout(timer)
        console.log(
          `API: ${reply.api_url}\nExpo: ${reply.expo_url}\nRoutes registered; Cloudflare DNS and TLS must be configured.`,
        )
      } catch (error) {
        fail(error)
      }
    })
    socket.write(`${JSON.stringify(record)}\n`)
  })
}
