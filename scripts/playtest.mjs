// Local playtest: starts the server and N game windows on this computer.
//   npm run playtest          -> 4 players
//   npm run playtest -- 3     -> 3 players
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electron = require('electron') // path to the Electron binary
const players = Math.max(1, Math.min(8, Number(process.argv[2] ?? 4)))
const port = process.env.PORT ?? '3000'
const names = ['Alex', 'Blair', 'Casey', 'Devin', 'Emery', 'Finley', 'Gray', 'Harper']

console.log('[playtest] building app…')
const build = spawnSync(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], {
  cwd: root,
  stdio: 'inherit'
})
if (build.status !== 0 || !existsSync(join(root, 'out/main/index.js'))) process.exit(1)

const children = []
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: port }
})
children.push(server)

setTimeout(() => {
  for (let i = 1; i <= players; i++) {
    const child = spawn(
      electron,
      ['.', `--instance=${i}`, `--server=http://localhost:${port}`, `--name=${names[i - 1]}`],
      { cwd: root, stdio: 'inherit' }
    )
    children.push(child)
  }
  console.log(`[playtest] ${players} windows open. Close this terminal (Ctrl+C) to stop everything.`)
}, 1200)

const stop = () => {
  for (const c of children) c.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
