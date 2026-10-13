// The game server as a reusable function, so it can run either standalone
// (`npm run server`) or embedded in the host's desktop app ("host mode").
// - Socket.IO over WebSocket only; put it behind TLS (Tailscale Funnel / Cloudflare Tunnel).
// - All state in memory. No database, no disk writes, no payload logging.
// - Binds to 127.0.0.1 by default so only the local tunnel can reach it.
import { createServer, type Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { LIMITS } from '../src/shared/protocol'
import { LobbyManager } from './lobbyManager'

export const SERVER_VERSION = '1.1.0'

export interface ServerOptions {
  port?: number
  host?: string
  trustProxy?: boolean
  log?: (msg: string) => void
}

export interface RunningServer {
  port: number
  host: string
  close: () => Promise<void>
}

/** Token bucket per socket: 40 burst, 15/s refill. Heavy abuse => disconnect. */
function rateLimiter(socket: Socket) {
  let tokens = 40
  let last = Date.now()
  let strikes = 0
  return () => {
    const now = Date.now()
    tokens = Math.min(40, tokens + ((now - last) / 1000) * 15)
    last = now
    if (tokens >= 1) {
      tokens -= 1
      return true
    }
    if (++strikes > 50) socket.disconnect(true)
    return false
  }
}

export function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const port = opts.port ?? 3000
  const host = opts.host ?? '127.0.0.1'
  const log = opts.log ?? ((m: string) => console.log(`[server] ${m}`))

  const http: HttpServer = createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'whose-is-it', version: SERVER_VERSION }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  })

  const io = new Server(http, {
    transports: ['websocket'],
    maxHttpBufferSize: LIMITS.maxImageBytes * LIMITS.imagesPerPlayerMax + 64_000,
    pingInterval: 10_000,
    pingTimeout: 8_000,
    serveClient: false,
    cors: { origin: '*' }
  })

  const manager = new LobbyManager((socketId, event, payload) => {
    io.to(socketId).emit(event, payload)
  })
  const sweeper = setInterval(() => manager.sweep(), 30_000)
  sweeper.unref()

  const clientKey = (socket: Socket): string => {
    const fwd = socket.handshake.headers['x-forwarded-for']
    const ip = (opts.trustProxy && typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || socket.handshake.address
    // Behind a local tunnel every peer looks like loopback; fall back to the socket.
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return `sock:${socket.id}`
    return `ip:${ip}`
  }

  io.on('connection', (socket) => {
    const allow = rateLimiter(socket)
    const key = clientKey(socket)

    // Every handler: rate limited, ack-only, never throws.
    const on = <A extends unknown[]>(event: string, fn: (...args: A) => unknown) => {
      socket.on(event, (...raw: unknown[]) => {
        const ack = typeof raw[raw.length - 1] === 'function' ? (raw.pop() as (r: unknown) => void) : null
        if (!allow()) return ack?.({ ok: false, error: 'Slow down.' })
        try {
          const result = fn(...(raw as A))
          ack?.(result ?? { ok: true })
        } catch (err) {
          log(`handler ${event} failed: ${(err as Error).message}`)
          ack?.({ ok: false, error: 'Server error.' })
        }
      })
    }

    on('hello', () => ({ ok: true, version: SERVER_VERSION }))
    on('lobby:list', () => ({ ok: true, lobbies: manager.list() }))
    on('lobby:create', (p: never) => manager.create(socket.id, p))
    on('lobby:join', (p: never) => manager.join(socket.id, key, p))
    on('lobby:resume', (token: unknown) => manager.resume(socket.id, token))
    on('lobby:leave', () => {
      manager.leave(socket.id)
      return { ok: true }
    })
    on('lobby:kick', (id: unknown) => manager.kick(socket.id, id))
    on('lobby:settings', (s: never) => manager.updateSettings(socket.id, s))
    on('game:start', (p: never) => manager.start(socket.id, p))
    on('upload:submit', (images: unknown) => manager.upload(socket.id, images))
    on('guess:submit', (slideId: unknown, targetId: unknown) => manager.guess(socket.id, slideId, targetId))
    on('game:again', () => manager.playAgain(socket.id))

    socket.on('disconnect', () => manager.disconnect(socket.id))
  })

  return new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, host, () => {
      http.off('error', reject)
      log(`Whose Is It server v${SERVER_VERSION} listening on http://${host}:${port}`)
      if (host !== '127.0.0.1' && host !== 'localhost')
        log('WARNING: listening on a non-loopback address. Make sure TLS terminates in front of it.')
      resolve({
        port,
        host,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweeper)
            manager.shutdown()
            io.close(() => done())
          })
      })
    })
  })
}
