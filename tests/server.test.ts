import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { io, type Socket } from 'socket.io-client'
import { startServer, type RunningServer } from '../server/createServer'

let server: RunningServer
let client: Socket

beforeAll(async () => {
  server = await startServer({ port: 34567, log: () => {} })
  client = io('http://127.0.0.1:34567', { transports: ['websocket'] })
  await new Promise<void>((r) => client.on('connect', () => r()))
})
afterAll(async () => {
  client.close()
  await server.close()
})

describe('server over a real socket', () => {
  it('answers hello and lists lobbies', async () => {
    expect(await client.emitWithAck('hello')).toMatchObject({ ok: true })
    expect(await client.emitWithAck('lobby:list')).toEqual({ ok: true, lobbies: [] })
  })

  it('serves /health and nothing else', async () => {
    const health = await fetch('http://127.0.0.1:34567/health').then((r) => r.json())
    expect(health).toMatchObject({ ok: true, app: 'whose-is-it' })
    expect((await fetch('http://127.0.0.1:34567/')).status).toBe(404)
  })

  it('refuses a second server on the same port', async () => {
    await expect(startServer({ port: 34567, log: () => {} })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})
