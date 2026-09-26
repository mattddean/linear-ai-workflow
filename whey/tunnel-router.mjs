// Proxies registered isolate hosts to loopback services, preserving streaming bodies and WebSocket messages.

function headersFor(request) {
  const headers = new Headers(request.headers)
  const connectionHeaders = String(headers.get('connection') ?? '').split(',')
  for (const name of [
    ...connectionHeaders,
    'connection',
    'proxy-connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
  ]) {
    if (name.trim()) headers.delete(name.trim())
  }
  headers.set('x-forwarded-host', request.headers.get('host') ?? '')
  headers.set('x-forwarded-proto', 'https')
  return headers
}

export function createTunnelRouter(port, resolveRoute) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    idleTimeout: 0,
    fetch(request, server) {
      const host = String(request.headers.get('host') ?? '')
        .toLowerCase()
        .split(':')[0]
      const route = resolveRoute(host)
      if (!route) return new Response('No running isolate for this hostname.\n', { status: 404 })
      const url = new URL(request.url)
      const target = `http://127.0.0.1:${route.port}${url.pathname}${url.search}`
      const headers = headersFor(request)
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const success = server.upgrade(request, { data: { route, target, headers, pending: [] } })
        return success ? undefined : new Response('WebSocket upgrade failed.', { status: 400 })
      }
      return proxyRequest(request, route, target, headers)
    },
    websocket: {
      open(socket) {
        const { route, target, headers, pending } = socket.data
        const protocols = (headers.get('sec-websocket-protocol') ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
        for (const name of [
          'sec-websocket-key',
          'sec-websocket-version',
          'sec-websocket-extensions',
          'sec-websocket-protocol',
        ])
          headers.delete(name)
        const upstream = new WebSocket(target.replace('http:', 'ws:'), {
          headers: Object.fromEntries(headers),
          protocols,
        })
        upstream.binaryType = 'arraybuffer'
        const connection = {
          destroy: () => {
            upstream.onclose = null
            upstream.onerror = null
            upstream.terminate()
            socket.close(1001, 'Isolate disconnected')
          },
        }
        const timeout = setTimeout(connection.destroy, 10000)
        Object.assign(socket.data, { upstream, connection, timeout })
        route.connections.add(connection)
        upstream.onopen = () => {
          clearTimeout(timeout)
          for (const message of pending.splice(0)) upstream.send(message)
        }
        upstream.onmessage = (event) => socket.send(event.data)
        upstream.onclose = () => socket.close()
        upstream.onerror = () => socket.terminate()
      },
      message(socket, message) {
        const { upstream, pending } = socket.data
        if (upstream.readyState === WebSocket.OPEN) upstream.send(message)
        else pending.push(message)
      },
      close(socket) {
        const { upstream, route, connection, timeout } = socket.data
        clearTimeout(timeout)
        route.connections.delete(connection)
        upstream.onclose = null
        upstream.onerror = null
        upstream.terminate()
      },
    },
  })
}

async function proxyRequest(request, route, target, headers) {
  const controller = new AbortController()
  const connection = { destroy: () => controller.abort() }
  route.connections.add(connection)
  const done = () => route.connections.delete(connection)
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
      decompress: false,
      keepalive: false,
      signal: AbortSignal.any([request.signal, controller.signal]),
    })
    const responseHeaders = new Headers(response.headers)
    for (const name of ['connection', 'keep-alive', 'transfer-encoding']) responseHeaders.delete(name)
    if (!response.body) {
      done()
      return new Response(null, { status: response.status, headers: responseHeaders })
    }
    const reader = response.body.getReader()
    const body = new ReadableStream({
      async pull(output) {
        try {
          const chunk = await reader.read()
          if (chunk.done) {
            done()
            output.close()
          } else output.enqueue(chunk.value)
        } catch (error) {
          done()
          output.error(error)
        }
      },
      cancel() {
        done()
        controller.abort()
        return reader.cancel()
      },
    })
    return new Response(body, { status: response.status, headers: responseHeaders })
  } catch {
    done()
    return new Response('Isolate service is unavailable.\n', { status: 502 })
  }
}
