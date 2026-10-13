import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LobbyManager, TIMING } from '../server/lobbyManager'
import { DEFAULT_SETTINGS } from '../src/shared/protocol'

const KEY = 'B' + 'A'.repeat(87) // 88-char base64 stand-in for a P-256 public key
const IV = 'AAAAAAAAAAAAAAAA'
const WRAP = { iv: IV, data: 'd3JhcHBlZA==' }

type Sent = { socket: string; event: string; payload: any }

function setup() {
  const sent: Sent[] = []
  const m = new LobbyManager((socket, event, payload) => sent.push({ socket, event, payload }))
  const last = (socket: string, event: string) => [...sent].reverse().find((s) => s.socket === socket && s.event === event)?.payload
  const all = (socket: string, event: string) => sent.filter((s) => s.socket === socket && s.event === event).map((s) => s.payload)
  return { m, sent, last, all }
}

function img(bytes = 2000, tier = 3) {
  return { tier, iv: IV, data: Buffer.alloc(bytes, 7) }
}

/** host + 2 players, game started. */
function startedGame(settings = DEFAULT_SETTINGS) {
  const t = setup()
  const host = t.m.create('s-host', { lobbyName: 'L', playerName: 'Host', publicKey: KEY, settings })
  if (!host.ok) throw new Error(host.error)
  const code = t.last('s-host', 'lobby:state').code
  const p1 = t.m.join('s-p1', 'k1', { code, playerName: 'Pia', publicKey: KEY })
  const p2 = t.m.join('s-p2', 'k2', { code, playerName: 'Raj', publicKey: KEY })
  if (!p1.ok || !p2.ok) throw new Error('join failed')
  const start = t.m.start('s-host', { wrappedKeys: { [p1.playerId]: WRAP, [p2.playerId]: WRAP } })
  expect(start).toEqual({ ok: true })
  return { ...t, code, host, p1, p2 }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('lobby lifecycle', () => {
  it('creates a lobby with a code and lists it publicly without the code', () => {
    const { m, last } = setup()
    const r = m.create('s1', { lobbyName: 'Fun', playerName: 'Ann', publicKey: KEY, settings: DEFAULT_SETTINGS })
    expect(r.ok).toBe(true)
    const state = last('s1', 'lobby:state')
    expect(state.code).toMatch(/^[A-Z2-9]{6}$/)
    const list = m.list()
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(state.code)
  })

  it('requires the right code (also when joining from the list) and locks out guessers', () => {
    const { m, last } = setup()
    m.create('s1', { lobbyName: 'Fun', playerName: 'Ann', publicKey: KEY, settings: DEFAULT_SETTINGS })
    const { code, id } = last('s1', 'lobby:state')
    const wrong = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA'
    for (let i = 0; i < TIMING.joinMaxFails; i++)
      expect(m.join(`x${i}`, 'attacker', { code: wrong, lobbyId: id, playerName: 'Eve', publicKey: KEY }).ok).toBe(false)
    const locked = m.join('x9', 'attacker', { code, lobbyId: id, playerName: 'Eve', publicKey: KEY })
    expect(locked.ok).toBe(false)
    if (!locked.ok) expect(locked.error).toMatch(/Too many/)
    vi.advanceTimersByTime(TIMING.joinLockoutMs + 1)
    expect(m.join('x10', 'attacker', { code, lobbyId: id, playerName: 'Eve', publicKey: KEY }).ok).toBe(true)
  })

  it('rejects duplicate names and bad keys', () => {
    const { m, last } = setup()
    m.create('s1', { lobbyName: 'Fun', playerName: 'Ann', publicKey: KEY, settings: DEFAULT_SETTINGS })
    const { code } = last('s1', 'lobby:state')
    expect(m.join('s2', 'k', { code, playerName: 'ann', publicKey: KEY }).ok).toBe(false)
    expect(m.join('s3', 'k', { code, playerName: 'Bo', publicKey: 'nope' }).ok).toBe(false)
  })

  it('needs 3 players and a key for every player to start', () => {
    const { m, last } = setup()
    m.create('s1', { lobbyName: 'Fun', playerName: 'Ann', publicKey: KEY, settings: DEFAULT_SETTINGS })
    const { code } = last('s1', 'lobby:state')
    const b = m.join('s2', 'k', { code, playerName: 'Bo', publicKey: KEY })
    expect(m.start('s1', { wrappedKeys: {} }).ok).toBe(false)
    const c = m.join('s3', 'k', { code, playerName: 'Cy', publicKey: KEY })
    if (!b.ok || !c.ok) throw new Error()
    expect(m.start('s2', { wrappedKeys: {} }).ok).toBe(false) // not host
    const partial = m.start('s1', { wrappedKeys: { [b.playerId]: WRAP } })
    expect(partial).toEqual({ ok: false, error: 'PLAYERS_CHANGED' })
  })

  it('delivers each player their wrapped key and rejects late joins', () => {
    const { m, last, code } = startedGame()
    expect(last('s-p1', 'game:key')).toEqual(WRAP)
    expect(last('s-host', 'game:key')).toBeUndefined()
    expect(m.join('s-late', 'k', { code, playerName: 'Late', publicKey: KEY }).ok).toBe(false)
  })

  it('transfers host when the host leaves the lobby', () => {
    const { m, last } = setup()
    const a = m.create('s1', { lobbyName: 'Fun', playerName: 'Ann', publicKey: KEY, settings: DEFAULT_SETTINGS })
    const { code } = last('s1', 'lobby:state')
    const b = m.join('s2', 'k', { code, playerName: 'Bo', publicKey: KEY })
    if (!a.ok || !b.ok) throw new Error()
    m.leave('s1')
    expect(last('s2', 'lobby:state').hostId).toBe(b.playerId)
  })
})

describe('game flow', () => {
  it('validates uploads', () => {
    const { m } = startedGame()
    expect(m.upload('s-p1', []).ok).toBe(false)
    expect(m.upload('s-p1', [img(10)]).ok).toBe(false) // too small
    expect(m.upload('s-p1', [img(2_000_000)]).ok).toBe(false) // too big
    expect(m.upload('s-p1', [{ ...img(), tier: 9 }]).ok).toBe(false)
    expect(m.upload('s-p1', [img(), img(), img(), img()]).ok).toBe(false) // > 3
    expect(m.upload('s-p1', [img()]).ok).toBe(true)
    expect(m.upload('s-p1', [img()]).ok).toBe(false) // already submitted
  })

  it('runs the slideshow, purges every image, and only reveals owners at the end', () => {
    const t = startedGame({ ...DEFAULT_SETTINGS, imagesPerPlayer: 2, slideSeconds: 20 })
    const { m, all, last, host, p1, p2 } = t
    m.upload('s-host', [img(3000), img(3000, 4)])
    m.upload('s-p1', [img(3000)])
    expect(m.imageBytesHeld()).toBe(9000)
    m.upload('s-p2', [img(3000, 1)]) // everyone submitted -> slideshow starts
    expect(last('s-host', 'lobby:state').phase).toBe('slideshow')

    const ids = { 's-host': host, 's-p1': p1, 's-p2': p2 } as Record<string, any>
    let shown = 0
    const owners: string[] = []
    for (let i = 0; i < 4; i++) {
      const slides = ['s-host', 's-p1', 's-p2'].map((s) => last(s, 'slide:show'))
      const slide = slides[0]
      expect(slide.index).toBe(i)
      shown++
      // Slide payload never says who the owner is (only `isYours` to the owner).
      expect(Object.keys(slide)).not.toContain('ownerId')
      const ownerSock = ['s-host', 's-p1', 's-p2'].find((_s, k) => slides[k].isYours)!
      owners.push(ownerSock)
      // Owner can't guess their own slide.
      expect(m.guess(ownerSock, slide.slideId, ids['s-p1'].playerId).ok).toBe(false)
      // Everyone else guesses the owner (correct).
      for (const s of ['s-host', 's-p1', 's-p2'].filter((x) => x !== ownerSock)) {
        const r = m.guess(s, slide.slideId, ids[ownerSock].playerId)
        expect(r.ok).toBe(true)
        expect(m.guess(s, slide.slideId, ids[ownerSock].playerId).ok).toBe(false) // locked in
      }
      const before = m.imageBytesHeld()
      vi.advanceTimersByTime(TIMING.allGuessedDelayMs + 1)
      expect(m.imageBytesHeld()).toBe(before - 3000) // purged as soon as the slide ended
      expect(last('s-p1', 'slide:end').slideId).toBe(slide.slideId)
      vi.advanceTimersByTime(TIMING.betweenSlidesMs + 1)
    }
    expect(shown).toBe(4)
    for (let i = 1; i < owners.length; i++) {
      // the host has 2 slides; ordering should split them up
      if (owners[i] === 's-host') expect(owners[i - 1]).not.toBe('s-host')
    }
    expect(m.imageBytesHeld()).toBe(0)
    const results = last('s-p2', 'game:results')
    expect(results.reveals).toHaveLength(4)
    expect(results.standings).toHaveLength(3)
    expect(last('s-p2', 'lobby:state').phase).toBe('results')
    // Results never carry image data.
    expect(JSON.stringify(results)).not.toMatch(/data|iv/)
    // Each slide payload went out exactly once per player.
    expect(all('s-p1', 'slide:show')).toHaveLength(4)
  })

  it('ends slides on the timer if people do not guess, and ends upload on the timer', () => {
    const { m, last } = startedGame({ ...DEFAULT_SETTINGS, imagesPerPlayer: 1, uploadSeconds: 60, slideSeconds: 10 })
    m.upload('s-host', [img()])
    m.upload('s-p1', [img()])
    vi.advanceTimersByTime(60_000 + 1) // p2 never uploads
    expect(last('s-host', 'lobby:state').phase).toBe('slideshow')
    vi.advanceTimersByTime(10_000 + 1)
    vi.advanceTimersByTime(TIMING.betweenSlidesMs + 1)
    vi.advanceTimersByTime(10_000 + 1)
    expect(last('s-host', 'lobby:state').phase).toBe('slideshow') // tallying beat
    vi.advanceTimersByTime(TIMING.betweenSlidesMs + 1)
    expect(last('s-host', 'lobby:state').phase).toBe('results')
    expect(m.imageBytesHeld()).toBe(0)
  })

  it('skips straight to results when fewer than 2 people uploaded', () => {
    const { m, last } = startedGame({ ...DEFAULT_SETTINGS, uploadSeconds: 60 })
    m.upload('s-host', [img()])
    vi.advanceTimersByTime(60_001)
    expect(last('s-p1', 'game:results').reveals).toHaveLength(0)
    expect(m.imageBytesHeld()).toBe(0)
  })

  it('lets a player reconnect mid-slide and get the slide back', () => {
    const { m, last, p1 } = startedGame({ ...DEFAULT_SETTINGS, imagesPerPlayer: 1 })
    m.upload('s-host', [img()])
    m.upload('s-p1', [img()])
    m.upload('s-p2', [img()])
    m.disconnect('s-p1')
    const r = m.resume('s-p1b', p1.token)
    expect(r.ok).toBe(true)
    expect(last('s-p1b', 'slide:show')).toBeTruthy()
    expect(last('s-p1b', 'game:key')).toEqual(WRAP)
  })

  it('play again returns to the lobby with fresh state; idle lobbies get swept', () => {
    const { m, last } = startedGame({ ...DEFAULT_SETTINGS, uploadSeconds: 60 })
    vi.advanceTimersByTime(60_001) // nobody uploaded
    expect(last('s-host', 'lobby:state').phase).toBe('results')
    expect(m.playAgain('s-p1').ok).toBe(false)
    expect(m.playAgain('s-host').ok).toBe(true)
    const st = last('s-p1', 'lobby:state')
    expect(st.phase).toBe('lobby')
    expect(st.players.every((p: any) => !p.submitted)).toBe(true)
    vi.advanceTimersByTime(TIMING.idleLobbyMs + 1)
    m.sweep()
    expect(m.lobbyCount()).toBe(0)
    expect(last('s-p1', 'lobby:closed')).toBeTruthy()
  })

  it('destroys a lobby once everyone is gone past the grace period', () => {
    const { m } = startedGame()
    m.disconnect('s-host')
    m.disconnect('s-p1')
    m.disconnect('s-p2')
    expect(m.lobbyCount()).toBe(1)
    vi.advanceTimersByTime(TIMING.reconnectGraceMs + 1)
    expect(m.lobbyCount()).toBe(0)
  })
})
