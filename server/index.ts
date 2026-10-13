// Standalone server entry: `npm run server`
import { startServer, type RunningServer } from './createServer'

async function main() {
  let server: RunningServer
  try {
    server = await startServer({
      port: Number(process.env.PORT ?? 3000),
      host: process.env.HOST ?? '127.0.0.1',
      trustProxy: process.env.TRUST_PROXY === '1'
    })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'EADDRINUSE')
      console.error('[server] Port is already in use. Is the server (or the app in host mode) already running?')
    else console.error('[server] Failed to start:', e.message)
    process.exit(1)
  }
  const stop = async () => {
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main()
