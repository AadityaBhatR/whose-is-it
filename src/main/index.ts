// Electron main process.
// The game window is excluded from screen capture:
//   - Windows 10 2004+/11: SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
//   - macOS: NSWindow.sharingType = none
// DevTools are disabled in packaged builds so image bytes can't be pulled out.
// Optional "host mode" runs the game server inside this app.
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  session,
  type MenuItemConstructorOptions
} from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startServer, type RunningServer } from '../../server/createServer'

const isDev = !app.isPackaged
const HOST_PORT = 3000

// CLI flags used by the local playtest script: --server=URL --instance=N --name=X
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const instance = Number(arg('instance') ?? 0)
if (instance > 0) app.setPath('userData', join(app.getPath('userData'), `instance-${instance}`))

// Only one copy per user profile (playtest instances use separate profiles).
if (instance === 0 && !app.requestSingleInstanceLock()) app.quit()

// Server address baked in at build time (VITE_DEFAULT_SERVER), overridable for testing.
const bakedServer = (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) ?? ''

// ------------------------------------------------------------ settings (userData/settings.json)
interface Settings {
  hostServer: boolean
}
const settingsPath = () => join(app.getPath('userData'), 'settings.json')
function loadSettings(): Settings {
  try {
    return { hostServer: false, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) }
  } catch {
    return { hostServer: false }
  }
}
function saveSettings(s: Settings) {
  try {
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
  } catch {
    /* non-fatal */
  }
}

// ------------------------------------------------------------ embedded server (host mode)
let server: RunningServer | null = null
let serverError: string | null = null

async function setHosting(on: boolean) {
  serverError = null
  if (on && !server) {
    try {
      server = await startServer({ port: HOST_PORT, host: '127.0.0.1', log: (m) => console.log(`[host] ${m}`) })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      serverError =
        e.code === 'EADDRINUSE'
          ? `Port ${HOST_PORT} is already in use. Is the standalone server already running?`
          : `Could not start the server: ${e.message}`
    }
  } else if (!on && server) {
    await server.close()
    server = null
  }
  return hostStatus()
}

function hostStatus() {
  return {
    enabled: loadSettings().hostServer,
    running: !!server,
    localUrl: `http://localhost:${HOST_PORT}`,
    error: serverError
  }
}

// ------------------------------------------------------------ IPC
ipcMain.handle('config:get', () => ({
  defaultServer: arg('server') ?? process.env.IMGGAME_SERVER ?? bakedServer,
  defaultName: arg('name') ?? '',
  instance,
  host: hostStatus()
}))

ipcMain.handle('clipboard:write', (_e, text: unknown) => {
  if (typeof text !== 'string' || text.length > 200) return false
  clipboard.writeText(text)
  return true
})

ipcMain.handle('host:set', async (_e, on: unknown) => {
  const enabled = on === true
  saveSettings({ ...loadSettings(), hostServer: enabled })
  return setHosting(enabled)
})

// ------------------------------------------------------------ window
function buildMenu() {
  const template: MenuItemConstructorOptions[] = []
  if (process.platform === 'darwin') {
    template.push({ role: 'appMenu' })
    template.push({ role: 'editMenu' }) // copy/paste in text fields
    template.push({ role: 'windowMenu' })
    if (isDev) template.push({ role: 'viewMenu' })
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  } else {
    Menu.setApplicationMenu(isDev ? Menu.buildFromTemplate([{ role: 'viewMenu' }]) : null)
  }
}

function createWindow() {
  const small = instance > 0
  const win = new BrowserWindow({
    width: small ? 1000 : 1280,
    height: small ? 740 : 860,
    x: small ? 30 + ((instance - 1) % 2) * 1010 : undefined,
    y: small ? 20 + Math.floor((instance - 1) / 2) * 380 : undefined,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0a0a0b',
    title: instance ? `Whose Is It — Player ${instance}` : 'Whose Is It',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: isDev,
      spellcheck: false
    }
  })

  // The important bit: keep this window out of screenshots / recordings / screen share.
  win.setContentProtection(true)

  win.once('ready-to-show', () => win.show())
  win.on('page-title-updated', (e) => e.preventDefault())

  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e, url) => {
    if (!(isDev && process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)))
      e.preventDefault()
  })
  wc.on('before-input-event', (e, input) => {
    if (isDev) return
    const k = input.key.toLowerCase()
    const mod = input.control || input.meta
    if (k === 'f12' || (mod && input.shift && ['i', 'j', 'c'].includes(k)) || (input.meta && input.alt && k === 'i'))
      e.preventDefault()
  })
  wc.on('context-menu', (e) => e.preventDefault())

  if (isDev && process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  // No camera/mic/geolocation/etc. Clipboard goes through IPC above.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  buildMenu()
  if (loadSettings().hostServer) await setHosting(true)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault())
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  server?.close()
})
