// Client-side game controller: owns the socket, the crypto keys and UI state.
import { useSyncExternalStore } from 'react'
import { io, type Socket } from 'socket.io-client'
import type {
  JoinedAck,
  LobbySettings,
  LobbySummary,
  LobbyView,
  Results,
  SlideProgress,
  SlideShow,
  Tier
} from '../../shared/protocol'
import {
  createGameKey,
  createIdentity,
  openImage,
  safetyCode,
  sealImage,
  unwrapGameKey,
  wrapGameKey,
  type Identity
} from './crypto'

export type ConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting'
export type LinkSecurity = 'tls' | 'local' | 'insecure'

export interface SlideState {
  slideId: string
  index: number
  total: number
  tier: Tier
  endsAt: number
  durationMs: number
  isYours: boolean
  options: { id: string; name: string }[]
  bitmap: ImageBitmap | null
  error: string | null
  myGuess: string | null
  guessed: number
  eligible: number
  ended: boolean
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

export interface State {
  conn: ConnState
  connError: string | null
  serverUrl: string
  security: LinkSecurity
  name: string
  me: string | null
  lobby: LobbyView | null
  uploadEndsAt: number | null
  safety: string | null
  keyState: 'none' | 'ready' | 'failed'
  slide: SlideState | null
  results: Results | null
  toast: Toast | null
  lab: boolean
  /** baked-in / default server address (empty if none) */
  defaultServer: string
  host: HostStatus | null
  booting: boolean
}

const ls = {
  get(k: string): string {
    try {
      return localStorage.getItem(`wii.${k}`) ?? ''
    } catch {
      return ''
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(`wii.${k}`, v)
    } catch {
      /* storage unavailable: fine */
    }
  }
}

export function classifyUrl(url: string): LinkSecurity {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' || u.protocol === 'wss:') return 'tls'
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return 'local'
    return 'insecure'
  } catch {
    return 'insecure'
  }
}

type Listener = () => void

class Game {
  state: State = {
    conn: 'idle',
    connError: null,
    serverUrl: ls.get('serverOverride') || 'http://localhost:3000',
    security: 'local',
    name: ls.get('name'),
    me: null,
    lobby: null,
    uploadEndsAt: null,
    safety: null,
    keyState: 'none',
    slide: null,
    results: null,
    toast: null,
    lab: false,
    defaultServer: '',
    host: null,
    booting: true
  }

  private listeners = new Set<Listener>()
  private socket: Socket | null = null
  private identity: Identity | null = null
  private gameKey: CryptoKey | null = null
  private token: string | null = null
  private safetyFor = ''
  private toastSeq = 0

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  getState = () => this.state

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((l) => l())
  }

  toast(text: string, kind: Toast['kind'] = 'info') {
    const id = ++this.toastSeq
    this.set({ toast: { id, text, kind } })
    setTimeout(() => {
      if (this.state.toast?.id === id) this.set({ toast: null })
    }, 4200)
  }

  /** Load app config, then connect automatically when we already know who and where. */
  async boot() {
    const cfg = await window.imggame?.getConfig?.().catch(() => null)
    const envDefault = (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) ?? ''
    const defaultServer = cfg?.defaultServer || envDefault
    const override = ls.get('serverOverride')
    const name = cfg?.defaultName || this.state.name
    const host = cfg?.host ?? null
    // Host mode: talk to the embedded server directly.
    const serverUrl = host?.running ? host.localUrl : override || defaultServer || 'http://localhost:3000'
    this.set({ defaultServer, name, host, serverUrl, security: classifyUrl(serverUrl) })
    if (name && (host?.running || override || defaultServer)) await this.connect(serverUrl, name)
    this.set({ booting: false })
  }

  /** User explicitly picked a server address (Advanced). Empty = back to default. */
  setServerOverride(url: string) {
    ls.set('serverOverride', url.trim())
  }

  async setHosting(on: boolean) {
    const status = await window.imggame?.setHosting?.(on)
    if (!status) return
    this.set({ host: status })
    if (status.error) this.toast(status.error, 'error')
  }

  // ------------------------------------------------------------ connection

  connect(serverUrl: string, name: string): Promise<void> {
    serverUrl = serverUrl.trim().replace(/\/+$/, '')
    name = name.trim()
    if (!/^(https?|wss?):\/\//i.test(serverUrl)) serverUrl = `https://${serverUrl}`
    ls.set('name', name)
    this.socket?.removeAllListeners()
    this.socket?.disconnect()
    this.set({ conn: 'connecting', connError: null, serverUrl, name, security: classifyUrl(serverUrl) })

    return new Promise((resolve) => {
      const s = io(serverUrl, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 800,
        reconnectionDelayMax: 4000,
        timeout: 8000
      })
      this.socket = s
      let first = true
      s.on('connect', async () => {
        if (first) {
          first = false
          try {
            const hello = await s.timeout(5000).emitWithAck('hello')
            if (!hello?.ok) throw new Error()
          } catch {
            this.set({ conn: 'idle', connError: "That address is not a Whose Is It server." })
            s.disconnect()
            return resolve()
          }
          this.set({ conn: 'connected' })
          return resolve()
        }
        this.set({ conn: 'connected' })
        if (this.token) {
          const r = await this.ack<JoinedAck>('lobby:resume', this.token)
          if (!r.ok) {
            this.resetLobby()
            this.toast('Your seat expired while you were disconnected.', 'error')
          }
        }
      })
      s.on('connect_error', (err) => {
        if (first) {
          first = false
          s.disconnect()
          this.set({ conn: 'idle', connError: `Couldn't reach the server (${err.message}).` })
          resolve()
        }
      })
      s.on('disconnect', (reason) => {
        if (reason === 'io client disconnect') return
        this.set({ conn: 'reconnecting' })
      })
      this.bindGameEvents(s)
    })
  }

  disconnect() {
    this.socket?.removeAllListeners()
    this.socket?.disconnect()
    this.socket = null
    this.resetLobby()
    this.set({ conn: 'idle' })
  }

  private async ack<T = object>(event: string, ...args: unknown[]): Promise<({ ok: true } & T) | { ok: false; error: string }> {
    if (!this.socket?.connected) return { ok: false, error: 'Not connected.' }
    try {
      return await this.socket.timeout(15000).emitWithAck(event, ...args)
    } catch {
      return { ok: false, error: 'Server did not respond.' }
    }
  }

  private resetLobby() {
    this.token = null
    this.identity = null
    this.gameKey = null
    this.safetyFor = ''
    this.state.slide?.bitmap?.close()
    this.set({ lobby: null, uploadEndsAt: null, me: null, safety: null, keyState: 'none', slide: null, results: null })
  }

  // ------------------------------------------------------------ lobby actions

  async listLobbies(): Promise<LobbySummary[]> {
    const r = await this.ack<{ lobbies: LobbySummary[] }>('lobby:list')
    return r.ok ? r.lobbies : []
  }

  async createLobby(lobbyName: string, settings: LobbySettings): Promise<string | null> {
    this.identity = await createIdentity()
    const r = await this.ack<JoinedAck>('lobby:create', {
      lobbyName,
      playerName: this.state.name,
      publicKey: this.identity.publicKeyB64,
      settings
    })
    if (!r.ok) return r.error
    this.token = r.token
    this.set({ me: r.playerId })
    return null
  }

  async joinLobby(code: string, lobbyId?: string): Promise<string | null> {
    this.identity = await createIdentity()
    const r = await this.ack<JoinedAck>('lobby:join', {
      code,
      lobbyId,
      playerName: this.state.name,
      publicKey: this.identity.publicKeyB64
    })
    if (!r.ok) return r.error
    this.token = r.token
    this.set({ me: r.playerId })
    return null
  }

  async leave() {
    await this.ack('lobby:leave')
    this.resetLobby()
  }

  async kick(playerId: string) {
    const r = await this.ack('lobby:kick', playerId)
    if (!r.ok) this.toast(r.error, 'error')
  }

  async updateSettings(s: Partial<LobbySettings>) {
    const r = await this.ack('lobby:settings', s)
    if (!r.ok) this.toast(r.error, 'error')
  }

  async start(): Promise<string | null> {
    const lobby = this.state.lobby
    if (!lobby || !this.identity) return 'Not in a lobby.'
    for (let attempt = 0; attempt < 3; attempt++) {
      const players = this.state.lobby!.players.filter((p) => p.connected)
      const gameKey = await createGameKey()
      const wrappedKeys: Record<string, { iv: string; data: string }> = {}
      for (const p of players) {
        if (p.id === this.state.me) continue
        wrappedKeys[p.id] = await wrapGameKey(gameKey, this.identity, p.publicKey, lobby.id, p.id)
      }
      this.gameKey = gameKey
      this.set({ keyState: 'ready' })
      const r = await this.ack('game:start', { wrappedKeys })
      if (r.ok) return null
      this.gameKey = null
      this.set({ keyState: 'none' })
      if (r.error !== 'PLAYERS_CHANGED') return r.error
      await new Promise((res) => setTimeout(res, 300))
    }
    return 'Players kept changing, try again.'
  }

  async submitImages(images: { bytes: ArrayBuffer; tier: Tier }[]): Promise<string | null> {
    const lobby = this.state.lobby
    if (!lobby || !this.gameKey) return 'Encryption key not ready yet.'
    const sealed = []
    for (const img of images) {
      const s = await sealImage(this.gameKey, img.bytes, lobby.id)
      sealed.push({ tier: img.tier, iv: s.iv, data: s.data })
    }
    const r = await this.ack('upload:submit', sealed)
    return r.ok ? null : r.error
  }

  async guess(targetId: string) {
    const slide = this.state.slide
    if (!slide || slide.myGuess || slide.isYours || slide.ended) return
    this.set({ slide: { ...slide, myGuess: targetId } })
    const r = await this.ack('guess:submit', slide.slideId, targetId)
    if (!r.ok) {
      if (this.state.slide?.slideId === slide.slideId) this.set({ slide: { ...this.state.slide, myGuess: null } })
      this.toast(r.error, 'error')
    }
  }

  async playAgain() {
    const r = await this.ack('game:again')
    if (!r.ok) this.toast(r.error, 'error')
  }

  setLab(on: boolean) {
    this.set({ lab: on })
  }

  // ------------------------------------------------------------ server events

  private bindGameEvents(s: Socket) {
    s.on('lobby:state', (lobby: LobbyView) => {
      const patch: Partial<State> = {
        lobby,
        uploadEndsAt: lobby.uploadRemainingMs == null ? null : Date.now() + lobby.uploadRemainingMs
      }
      if (lobby.phase === 'lobby' && this.state.lobby?.phase !== 'lobby') {
        // Fresh round: drop everything from the previous game.
        this.gameKey = null
        this.state.slide?.bitmap?.close()
        Object.assign(patch, { keyState: 'none', slide: null, results: null })
      }
      this.set(patch)
      this.refreshSafety(lobby)
    })

    s.on('game:key', async (sealed: { iv: string; data: string }) => {
      const lobby = this.state.lobby
      const host = lobby?.players.find((p) => p.id === lobby.hostId)
      if (!lobby || !host || !this.identity || !this.state.me) return
      if (host.id === this.state.me) return
      try {
        this.gameKey = await unwrapGameKey(sealed, this.identity, host.publicKey, lobby.id, this.state.me)
        this.set({ keyState: 'ready' })
      } catch {
        this.gameKey = null
        this.set({ keyState: 'failed' })
        this.toast('Encryption handshake failed. Compare verification codes with the other players.', 'error')
      }
    })

    s.on('slide:show', async (p: SlideShow) => {
      const base: SlideState = {
        slideId: p.slideId,
        index: p.index,
        total: p.total,
        tier: p.tier,
        endsAt: Date.now() + p.remainingMs,
        durationMs: p.durationMs,
        isYours: p.isYours,
        options: p.options,
        bitmap: null,
        error: null,
        myGuess: p.yourGuess,
        guessed: 0,
        eligible: 0,
        ended: false
      }
      this.state.slide?.bitmap?.close()
      this.set({ slide: base })
      if (!this.gameKey || !this.state.lobby) {
        this.set({ slide: { ...base, error: 'Missing decryption key.' } })
        return
      }
      try {
        const plain = await openImage(this.gameKey, p.image, this.state.lobby.id)
        new Uint8Array(p.image.data).fill(0)
        const bitmap = await createImageBitmap(new Blob([plain], { type: 'image/webp' }))
        new Uint8Array(plain).fill(0)
        if (this.state.slide?.slideId !== p.slideId || this.state.slide.ended) {
          bitmap.close()
          return
        }
        this.set({ slide: { ...this.state.slide, bitmap } })
      } catch {
        if (this.state.slide?.slideId === p.slideId)
          this.set({ slide: { ...this.state.slide, error: "Couldn't decrypt this image." } })
      }
    })

    s.on('slide:progress', (p: SlideProgress) => {
      const slide = this.state.slide
      if (slide?.slideId === p.slideId) this.set({ slide: { ...slide, guessed: p.guessed, eligible: p.eligible } })
    })

    s.on('slide:end', (p: { slideId: string }) => {
      const slide = this.state.slide
      if (slide?.slideId !== p.slideId) return
      slide.bitmap?.close() // image is gone from this machine too
      this.set({ slide: { ...slide, bitmap: null, ended: true } })
    })

    s.on('game:results', (results: Results) => {
      this.state.slide?.bitmap?.close()
      this.gameKey = null
      this.set({ results, slide: null, keyState: 'none' })
    })

    s.on('lobby:kicked', () => {
      this.resetLobby()
      this.toast('The host removed you from the lobby.', 'error')
    })

    s.on('lobby:closed', (p: { reason?: string }) => {
      this.resetLobby()
      this.toast(p?.reason ?? 'Lobby closed.', 'error')
    })
  }

  private async refreshSafety(lobby: LobbyView) {
    const keys = lobby.players.map((p) => p.publicKey)
    const sig = [...keys].sort().join(',')
    if (sig === this.safetyFor) return
    this.safetyFor = sig
    const code = await safetyCode(keys)
    if (this.safetyFor === sig) this.set({ safety: code })
  }
}

export const game = new Game()

/** Subscribe a component to the whole (immutable) game state. */
export function useGameState(): State {
  return useSyncExternalStore(game.subscribe, game.getState)
}
