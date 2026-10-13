// Authoritative, in-memory game state. Nothing here is ever written to disk.
// Image ciphertext is held only between upload and the end of its slide,
// then zero-filled and dropped.
import { randomBytes, randomUUID } from 'node:crypto'
import {
  DEFAULT_SETTINGS,
  LIMITS,
  type Ack,
  type CreatePayload,
  type JoinPayload,
  type JoinedAck,
  type LobbySettings,
  type LobbySummary,
  type LobbyView,
  type Phase,
  type Results,
  type Sealed,
  type SlideShow,
  type StartPayload,
  type Tier
} from '../src/shared/protocol'
import {
  cleanName,
  cleanSettings,
  computeResults,
  generateCode,
  isTier,
  isValidIv,
  isValidPublicKey,
  normalizeCode,
  orderSlides
} from './game'

export type Send = (socketId: string, event: string, payload?: unknown) => void

export const TIMING = {
  reconnectGraceMs: 60_000,
  idleLobbyMs: 10 * 60_000,
  betweenSlidesMs: 2_500,
  allGuessedDelayMs: 700,
  joinLockoutMs: 30_000,
  joinMaxFails: 5,
  globalJoinFailsPerSec: 50,
  maxLobbies: 500
}

interface Player {
  id: string
  token: string
  name: string
  publicKey: string
  socketId: string | null
  connected: boolean
  left: boolean
  joinedAt: number
  submitted: boolean
  wrappedKey: Sealed<string> | null
  dropTimer: NodeJS.Timeout | null
}

interface Slide {
  id: string
  ownerId: string
  tier: Tier
  image: { iv: string; data: Buffer } | null
  guesses: Map<string, { targetId: string; elapsedMs: number }>
  startedAt: number
  durationMs: number
}

interface Lobby {
  id: string
  code: string
  name: string
  hostId: string
  settings: LobbySettings
  phase: Phase
  players: Map<string, Player>
  lastActivity: number
  roster: { id: string; name: string }[]
  uploaderIds: string[]
  pending: Slide[] // uploaded during upload phase
  slides: Slide[] // ordered, during slideshow
  slideIndex: number
  slideLive: boolean
  phaseTimer: NodeJS.Timeout | null
  uploadEndsAt: number | null
  results: Results | null
}

type Ref = { lobbyId: string; playerId: string }

const fail = (error: string) => ({ ok: false as const, error })

export class LobbyManager {
  private lobbies = new Map<string, Lobby>()
  private byCode = new Map<string, string>()
  private byToken = new Map<string, Ref>()
  private bySocket = new Map<string, Ref>()
  private joinFails = new Map<string, { fails: number; lockedUntil: number }>()
  private globalFails: number[] = []

  constructor(private send: Send, private now: () => number = Date.now) {}

  // ------------------------------------------------------------ queries

  list(): LobbySummary[] {
    return [...this.lobbies.values()]
      .filter((l) => l.phase === 'lobby')
      .map((l) => ({
        id: l.id,
        name: l.name,
        hostName: l.players.get(l.hostId)?.name ?? '?',
        players: l.players.size,
        maxPlayers: l.settings.maxPlayers
      }))
  }

  lobbyCount(): number {
    return this.lobbies.size
  }

  /** Total ciphertext bytes currently held in memory (for tests / health). */
  imageBytesHeld(): number {
    let n = 0
    for (const l of this.lobbies.values())
      for (const s of [...l.pending, ...l.slides]) n += s.image?.data.length ?? 0
    return n
  }

  // ------------------------------------------------------------ lobby lifecycle

  create(socketId: string, p: CreatePayload): Ack<JoinedAck> {
    if (this.bySocket.has(socketId)) return fail('You are already in a lobby.')
    if (this.lobbies.size >= TIMING.maxLobbies) return fail('Server is full, try again later.')
    const playerName = cleanName(p?.playerName, LIMITS.nameMax)
    const lobbyName = cleanName(p?.lobbyName, LIMITS.lobbyNameMax) || `${playerName}'s lobby`
    if (!playerName) return fail('Enter a name.')
    if (!isValidPublicKey(p?.publicKey)) return fail('Bad key.')

    const lobby: Lobby = {
      id: randomUUID(),
      code: generateCode((c) => this.byCode.has(c)),
      name: lobbyName,
      hostId: '',
      settings: cleanSettings(p?.settings, DEFAULT_SETTINGS),
      phase: 'lobby',
      players: new Map(),
      lastActivity: this.now(),
      roster: [],
      uploaderIds: [],
      pending: [],
      slides: [],
      slideIndex: -1,
      slideLive: false,
      phaseTimer: null,
      uploadEndsAt: null,
      results: null
    }
    this.lobbies.set(lobby.id, lobby)
    this.byCode.set(lobby.code, lobby.id)
    const player = this.addPlayer(lobby, socketId, playerName, p.publicKey)
    lobby.hostId = player.id
    this.broadcastState(lobby)
    return { ok: true, lobbyId: lobby.id, playerId: player.id, token: player.token }
  }

  join(socketId: string, clientKey: string, p: JoinPayload): Ack<JoinedAck> {
    if (this.bySocket.has(socketId)) return fail('You are already in a lobby.')
    const lockKey = clientKey
    const lock = this.joinFails.get(lockKey)
    const now = this.now()
    if (lock && lock.lockedUntil > now)
      return fail(`Too many wrong codes. Wait ${Math.ceil((lock.lockedUntil - now) / 1000)}s.`)
    this.globalFails = this.globalFails.filter((t) => now - t < 1000)
    if (this.globalFails.length >= TIMING.globalJoinFailsPerSec) return fail('Server busy, try again.')

    const code = normalizeCode(p?.code)
    const lobbyId = this.byCode.get(code)
    const lobby = lobbyId ? this.lobbies.get(lobbyId) : undefined
    if (!lobby || (p?.lobbyId && p.lobbyId !== lobby.id)) {
      this.globalFails.push(now)
      const entry = !lock || (lock.lockedUntil !== 0 && lock.lockedUntil <= now) ? { fails: 0, lockedUntil: 0 } : lock
      entry.fails += 1
      if (entry.fails >= TIMING.joinMaxFails) {
        entry.fails = 0
        entry.lockedUntil = now + TIMING.joinLockoutMs
      }
      this.joinFails.set(lockKey, entry)
      return fail('Wrong code.')
    }
    this.joinFails.delete(lockKey)

    if (lobby.phase !== 'lobby') return fail('That game already started.')
    if (lobby.players.size >= lobby.settings.maxPlayers) return fail('Lobby is full.')
    const playerName = cleanName(p?.playerName, LIMITS.nameMax)
    if (!playerName) return fail('Enter a name.')
    if (!isValidPublicKey(p?.publicKey)) return fail('Bad key.')
    const taken = [...lobby.players.values()].some((x) => x.name.toLowerCase() === playerName.toLowerCase())
    if (taken) return fail('Someone in that lobby already has that name.')

    const player = this.addPlayer(lobby, socketId, playerName, p.publicKey)
    this.touch(lobby)
    this.broadcastState(lobby)
    return { ok: true, lobbyId: lobby.id, playerId: player.id, token: player.token }
  }

  resume(socketId: string, token: unknown): Ack<JoinedAck> {
    const ref = typeof token === 'string' ? this.byToken.get(token) : undefined
    const lobby = ref && this.lobbies.get(ref.lobbyId)
    const player = ref && lobby?.players.get(ref.playerId)
    if (!ref || !lobby || !player || player.left) return fail('Session expired.')
    if (player.socketId) this.bySocket.delete(player.socketId)
    player.socketId = socketId
    player.connected = true
    if (player.dropTimer) clearTimeout(player.dropTimer)
    player.dropTimer = null
    this.bySocket.set(socketId, ref)
    this.ensureHost(lobby)
    this.touch(lobby)
    this.broadcastState(lobby)
    // Re-deliver whatever the player needs for the current phase.
    if (lobby.phase === 'upload' || lobby.phase === 'slideshow') {
      if (player.wrappedKey) this.send(socketId, 'game:key', player.wrappedKey)
    }
    if (lobby.phase === 'slideshow' && lobby.slideLive) this.sendSlide(lobby, player)
    if (lobby.phase === 'results' && lobby.results) this.send(socketId, 'game:results', lobby.results)
    return { ok: true, lobbyId: lobby.id, playerId: player.id, token: player.token }
  }

  leave(socketId: string): void {
    const ctx = this.ctx(socketId)
    if (!ctx) return
    const { lobby, player } = ctx
    this.bySocket.delete(socketId)
    this.byToken.delete(player.token)
    player.socketId = null
    player.connected = false
    player.left = true
    if (lobby.phase === 'lobby' || lobby.phase === 'results') this.removePlayer(lobby, player)
    this.afterPresenceChange(lobby)
  }

  disconnect(socketId: string): void {
    const ref = this.bySocket.get(socketId)
    this.bySocket.delete(socketId)
    if (!ref) return
    const lobby = this.lobbies.get(ref.lobbyId)
    const player = lobby?.players.get(ref.playerId)
    if (!lobby || !player || player.socketId !== socketId) return
    player.connected = false
    player.socketId = null
    player.dropTimer = setTimeout(() => {
      player.dropTimer = null
      if (player.connected || !this.lobbies.has(lobby.id)) return
      if (lobby.phase === 'lobby' || lobby.phase === 'results') this.removePlayer(lobby, player)
      else {
        player.left = true
        this.byToken.delete(player.token)
      }
      this.afterPresenceChange(lobby)
    }, TIMING.reconnectGraceMs)
    this.afterPresenceChange(lobby)
  }

  kick(socketId: string, targetId: unknown): Ack {
    const ctx = this.ctx(socketId)
    if (!ctx) return fail('Not in a lobby.')
    const { lobby, player } = ctx
    if (lobby.hostId !== player.id) return fail('Only the host can kick.')
    if (lobby.phase !== 'lobby') return fail('Can only kick in the lobby.')
    const target = typeof targetId === 'string' ? lobby.players.get(targetId) : undefined
    if (!target || target.id === player.id) return fail('No such player.')
    if (target.socketId) {
      this.send(target.socketId, 'lobby:kicked')
      this.bySocket.delete(target.socketId)
    }
    this.removePlayer(lobby, target)
    this.touch(lobby)
    this.broadcastState(lobby)
    return { ok: true }
  }

  updateSettings(socketId: string, s: Partial<LobbySettings>): Ack {
    const ctx = this.ctx(socketId)
    if (!ctx) return fail('Not in a lobby.')
    const { lobby, player } = ctx
    if (lobby.hostId !== player.id) return fail('Only the host can change settings.')
    if (lobby.phase !== 'lobby') return fail('Game already started.')
    const next = cleanSettings(s, lobby.settings)
    if (next.maxPlayers < lobby.players.size) next.maxPlayers = lobby.players.size
    lobby.settings = next
    this.touch(lobby)
    this.broadcastState(lobby)
    return { ok: true }
  }

  // ------------------------------------------------------------ game flow

  start(socketId: string, p: StartPayload): Ack {
    const ctx = this.ctx(socketId)
    if (!ctx) return fail('Not in a lobby.')
    const { lobby, player } = ctx
    if (lobby.hostId !== player.id) return fail('Only the host can start.')
    if (lobby.phase !== 'lobby') return fail('Game already started.')

    // Anyone currently disconnected is dropped from this game.
    for (const pl of [...lobby.players.values()]) if (!pl.connected) this.removePlayer(lobby, pl)
    if (lobby.players.size < LIMITS.minPlayersToStart)
      return fail(`Need at least ${LIMITS.minPlayersToStart} players.`)

    const wrapped = p?.wrappedKeys ?? {}
    const others = [...lobby.players.values()].filter((x) => x.id !== lobby.hostId)
    const ids = Object.keys(wrapped)
    if (ids.length !== others.length || others.some((o) => !wrapped[o.id]))
      return fail('PLAYERS_CHANGED')
    for (const o of others) {
      const w = wrapped[o.id]
      if (!isValidIv(w?.iv) || typeof w?.data !== 'string' || w.data.length > 200) return fail('Bad key bundle.')
    }

    lobby.phase = 'upload'
    lobby.roster = [...lobby.players.values()].map((x) => ({ id: x.id, name: x.name }))
    lobby.pending = []
    lobby.results = null
    for (const pl of lobby.players.values()) {
      pl.submitted = false
      pl.wrappedKey = pl.id === lobby.hostId ? null : { iv: wrapped[pl.id].iv, data: wrapped[pl.id].data }
      if (pl.wrappedKey && pl.socketId) this.send(pl.socketId, 'game:key', pl.wrappedKey)
    }
    const ms = lobby.settings.uploadSeconds * 1000
    lobby.uploadEndsAt = this.now() + ms
    lobby.phaseTimer = setTimeout(() => this.endUpload(lobby), ms)
    this.touch(lobby)
    this.broadcastState(lobby)
    return { ok: true }
  }

  upload(socketId: string, images: unknown): Ack {
    const ctx = this.ctx(socketId)
    if (!ctx) return fail('Not in a lobby.')
    const { lobby, player } = ctx
    if (lobby.phase !== 'upload') return fail('Not accepting uploads right now.')
    if (player.submitted) return fail('Already submitted.')
    if (!Array.isArray(images) || images.length < 1 || images.length > lobby.settings.imagesPerPlayer)
      return fail(`Upload 1-${lobby.settings.imagesPerPlayer} images.`)
    const slides: Slide[] = []
    for (const img of images as { tier?: unknown; iv?: unknown; data?: unknown }[]) {
      const data = img?.data
      if (!isTier(img?.tier) || !isValidIv(img?.iv)) return fail('Bad image.')
      if (!Buffer.isBuffer(data) || data.length < 64 || data.length > LIMITS.maxImageBytes)
        return fail('Image too large or empty.')
      slides.push({
        id: randomBytes(9).toString('base64url'),
        ownerId: player.id,
        tier: img.tier,
        image: { iv: img.iv, data: Buffer.from(data) },
        guesses: new Map(),
        startedAt: 0,
        durationMs: lobby.settings.slideSeconds * 1000
      })
      data.fill(0)
    }
    lobby.pending.push(...slides)
    player.submitted = true
    this.touch(lobby)
    this.broadcastState(lobby)
    this.maybeFinishUpload(lobby)
    return { ok: true }
  }

  guess(socketId: string, slideId: unknown, targetId: unknown): Ack {
    const ctx = this.ctx(socketId)
    if (!ctx) return fail('Not in a lobby.')
    const { lobby, player } = ctx
    const slide = lobby.slides[lobby.slideIndex]
    if (lobby.phase !== 'slideshow' || !lobby.slideLive || !slide || slide.id !== slideId)
      return fail('That slide is over.')
    if (slide.ownerId === player.id) return fail("You can't guess your own image.")
    if (!lobby.roster.some((r) => r.id === player.id)) return fail('Not in this game.')
    if (slide.guesses.has(player.id)) return fail('Already locked in.')
    if (typeof targetId !== 'string' || targetId === player.id || !lobby.uploaderIds.includes(targetId))
      return fail('Invalid choice.')
    const elapsed = Math.max(0, this.now() - slide.startedAt)
    slide.guesses.set(player.id, { targetId, elapsedMs: Math.min(elapsed, slide.durationMs) })
    this.touch(lobby)
    this.sendProgress(lobby)
    this.maybeFinishSlide(lobby)
    return { ok: true }
  }

  playAgain(socketId: string): Ack {
    const ctx = this.ctx(socketId)
    if (!ctx) return fail('Not in a lobby.')
    const { lobby, player } = ctx
    if (lobby.hostId !== player.id) return fail('Only the host can restart.')
    if (lobby.phase !== 'results') return fail('Game is not over.')
    for (const pl of [...lobby.players.values()]) if (!pl.connected || pl.left) this.removePlayer(lobby, pl)
    lobby.phase = 'lobby'
    lobby.roster = []
    lobby.uploaderIds = []
    lobby.results = null
    lobby.uploadEndsAt = null
    for (const pl of lobby.players.values()) {
      pl.submitted = false
      pl.wrappedKey = null
    }
    this.ensureHost(lobby)
    this.touch(lobby)
    this.broadcastState(lobby)
    return { ok: true }
  }

  /** Periodic cleanup: idle lobbies are destroyed. */
  sweep(): void {
    const now = this.now()
    for (const l of [...this.lobbies.values()]) {
      if (now - l.lastActivity > TIMING.idleLobbyMs) this.destroy(l, 'Lobby closed after being idle.')
    }
    for (const [k, v] of this.joinFails) if (v.lockedUntil < now && v.lockedUntil !== 0) this.joinFails.delete(k)
    if (this.joinFails.size > 10_000) this.joinFails.clear()
  }

  shutdown(): void {
    for (const l of [...this.lobbies.values()]) this.destroy(l, 'Server shutting down.')
  }

  // ------------------------------------------------------------ internals

  private ctx(socketId: string) {
    const ref = this.bySocket.get(socketId)
    const lobby = ref && this.lobbies.get(ref.lobbyId)
    const player = ref && lobby?.players.get(ref.playerId)
    return lobby && player ? { lobby, player } : null
  }

  private addPlayer(lobby: Lobby, socketId: string, name: string, publicKey: string): Player {
    const player: Player = {
      id: randomBytes(8).toString('base64url'),
      token: randomBytes(24).toString('base64url'),
      name,
      publicKey,
      socketId,
      connected: true,
      left: false,
      joinedAt: this.now(),
      submitted: false,
      wrappedKey: null,
      dropTimer: null
    }
    lobby.players.set(player.id, player)
    this.byToken.set(player.token, { lobbyId: lobby.id, playerId: player.id })
    this.bySocket.set(socketId, { lobbyId: lobby.id, playerId: player.id })
    return player
  }

  private removePlayer(lobby: Lobby, player: Player) {
    if (player.dropTimer) clearTimeout(player.dropTimer)
    lobby.players.delete(player.id)
    this.byToken.delete(player.token)
    if (player.socketId) this.bySocket.delete(player.socketId)
  }

  private ensureHost(lobby: Lobby) {
    const host = lobby.players.get(lobby.hostId)
    if (host && host.connected && !host.left) return
    const next = [...lobby.players.values()]
      .filter((p) => p.connected && !p.left)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0]
    if (next) lobby.hostId = next.id
  }

  private afterPresenceChange(lobby: Lobby) {
    if (!this.lobbies.has(lobby.id)) return
    const anyone = [...lobby.players.values()].some((p) => p.connected)
    if (lobby.players.size === 0) return this.destroy(lobby, 'empty')
    if (!anyone) {
      const pending = [...lobby.players.values()].some((p) => p.dropTimer)
      if (!pending) return this.destroy(lobby, 'empty')
    }
    this.ensureHost(lobby)
    this.broadcastState(lobby)
    if (lobby.phase === 'upload') this.maybeFinishUpload(lobby)
    if (lobby.phase === 'slideshow') {
      this.sendProgress(lobby)
      this.maybeFinishSlide(lobby)
    }
  }

  private destroy(lobby: Lobby, reason: string) {
    if (lobby.phaseTimer) clearTimeout(lobby.phaseTimer)
    for (const s of [...lobby.pending, ...lobby.slides]) this.purge(s)
    lobby.pending = []
    lobby.slides = []
    for (const p of lobby.players.values()) {
      if (p.dropTimer) clearTimeout(p.dropTimer)
      this.byToken.delete(p.token)
      if (p.socketId) {
        if (reason !== 'empty') this.send(p.socketId, 'lobby:closed', { reason })
        this.bySocket.delete(p.socketId)
      }
    }
    this.byCode.delete(lobby.code)
    this.lobbies.delete(lobby.id)
  }

  private purge(slide: Slide) {
    if (slide.image) {
      slide.image.data.fill(0)
      slide.image = null
    }
  }

  private touch(lobby: Lobby) {
    lobby.lastActivity = this.now()
  }

  private view(lobby: Lobby): LobbyView {
    return {
      id: lobby.id,
      code: lobby.code,
      name: lobby.name,
      phase: lobby.phase,
      hostId: lobby.hostId,
      settings: lobby.settings,
      players: [...lobby.players.values()]
        .filter((p) => !p.left)
        .map((p) => ({
          id: p.id,
          name: p.name,
          connected: p.connected,
          isHost: p.id === lobby.hostId,
          submitted: p.submitted,
          publicKey: p.publicKey
        })),
      uploadRemainingMs:
        lobby.phase === 'upload' && lobby.uploadEndsAt ? Math.max(0, lobby.uploadEndsAt - this.now()) : null
    }
  }

  private broadcastState(lobby: Lobby) {
    const v = this.view(lobby)
    for (const p of lobby.players.values()) if (p.socketId) this.send(p.socketId, 'lobby:state', v)
  }

  private maybeFinishUpload(lobby: Lobby) {
    if (lobby.phase !== 'upload') return
    const active = [...lobby.players.values()].filter((p) => p.connected && !p.left)
    if (active.length > 0 && active.every((p) => p.submitted)) this.endUpload(lobby)
  }

  private endUpload(lobby: Lobby) {
    if (lobby.phase !== 'upload') return
    if (lobby.phaseTimer) clearTimeout(lobby.phaseTimer)
    lobby.phaseTimer = null
    lobby.uploadEndsAt = null
    lobby.slides = orderSlides(lobby.pending)
    lobby.pending = []
    lobby.uploaderIds = [...new Set(lobby.slides.map((s) => s.ownerId))]
    if (lobby.slides.length === 0 || lobby.uploaderIds.length < 2) {
      // Not enough material for a game: everybody would know the answer.
      for (const s of lobby.slides) this.purge(s)
      lobby.slides = []
      this.finish(lobby)
      return
    }
    lobby.phase = 'slideshow'
    lobby.slideIndex = -1
    this.broadcastState(lobby)
    this.showSlide(lobby, 0)
  }

  private showSlide(lobby: Lobby, i: number) {
    const slide = lobby.slides[i]
    if (!slide) return this.finish(lobby)
    lobby.slideIndex = i
    lobby.slideLive = true
    slide.startedAt = this.now()
    for (const p of lobby.players.values()) this.sendSlide(lobby, p)
    this.sendProgress(lobby)
    lobby.phaseTimer = setTimeout(() => this.endSlide(lobby), slide.durationMs)
  }

  private sendSlide(lobby: Lobby, p: Player) {
    const slide = lobby.slides[lobby.slideIndex]
    if (!slide?.image || !p.socketId || !lobby.roster.some((r) => r.id === p.id)) return
    const payload: Omit<SlideShow, 'image'> & { image: { iv: string; data: Buffer } } = {
      slideId: slide.id,
      index: lobby.slideIndex,
      total: lobby.slides.length,
      tier: slide.tier,
      remainingMs: Math.max(0, slide.startedAt + slide.durationMs - this.now()),
      durationMs: slide.durationMs,
      isYours: slide.ownerId === p.id,
      options: lobby.roster.filter((r) => r.id !== p.id && lobby.uploaderIds.includes(r.id)),
      image: slide.image,
      yourGuess: slide.guesses.get(p.id)?.targetId ?? null
    }
    this.send(p.socketId, 'slide:show', payload)
  }

  private eligible(lobby: Lobby, slide: Slide) {
    return lobby.roster
      .map((r) => lobby.players.get(r.id))
      .filter((p): p is Player => !!p && p.connected && !p.left && p.id !== slide.ownerId)
  }

  private sendProgress(lobby: Lobby) {
    const slide = lobby.slides[lobby.slideIndex]
    if (!slide || !lobby.slideLive) return
    const eligible = this.eligible(lobby, slide)
    const guessed = eligible.filter((p) => slide.guesses.has(p.id)).length
    for (const p of lobby.players.values())
      if (p.socketId)
        this.send(p.socketId, 'slide:progress', { slideId: slide.id, guessed, eligible: eligible.length })
  }

  private maybeFinishSlide(lobby: Lobby) {
    const slide = lobby.slides[lobby.slideIndex]
    if (!slide || !lobby.slideLive) return
    const eligible = this.eligible(lobby, slide)
    if (eligible.every((p) => slide.guesses.has(p.id))) {
      if (lobby.phaseTimer) clearTimeout(lobby.phaseTimer)
      lobby.phaseTimer = setTimeout(() => this.endSlide(lobby), TIMING.allGuessedDelayMs)
    }
  }

  private endSlide(lobby: Lobby) {
    if (!lobby.slideLive) return
    if (lobby.phaseTimer) clearTimeout(lobby.phaseTimer)
    const slide = lobby.slides[lobby.slideIndex]
    lobby.slideLive = false
    this.purge(slide) // ciphertext gone for good
    for (const p of lobby.players.values()) if (p.socketId) this.send(p.socketId, 'slide:end', { slideId: slide.id })
    const next = lobby.slideIndex + 1
    // Short pause between slides (and a "tallying…" beat before results).
    lobby.phaseTimer = setTimeout(
      () => (next >= lobby.slides.length ? this.finish(lobby) : this.showSlide(lobby, next)),
      TIMING.betweenSlidesMs
    )
  }

  private finish(lobby: Lobby) {
    if (lobby.phaseTimer) clearTimeout(lobby.phaseTimer)
    lobby.phaseTimer = null
    lobby.slideLive = false
    for (const s of lobby.slides) this.purge(s)
    lobby.results = computeResults(lobby.roster, lobby.slides)
    lobby.slides = []
    lobby.slideIndex = -1
    lobby.phase = 'results'
    for (const p of lobby.players.values()) p.wrappedKey = null
    this.touch(lobby)
    this.broadcastState(lobby)
    for (const p of lobby.players.values()) if (p.socketId) this.send(p.socketId, 'game:results', lobby.results)
  }
}
