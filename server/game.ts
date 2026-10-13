// Pure game logic (no sockets, no timers) so it can be unit tested.
import { randomInt } from 'node:crypto'
import {
  FOOLER_BONUS,
  LIMITS,
  SPEED_BONUS_MAX,
  TIER_INFO,
  type LobbySettings,
  type Results,
  type Reveal,
  type Standing,
  type Tier
} from '../src/shared/protocol'

// No look-alike characters (0/O, 1/I/L).
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateCode(taken: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = ''
    for (let i = 0; i < LIMITS.codeLength; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    if (!taken(code)) return code
  }
  throw new Error('could not allocate lobby code')
}

export function normalizeCode(raw: unknown): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, LIMITS.codeLength)
}

export function cleanName(raw: unknown, max: number): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

export function cleanSettings(raw: Partial<LobbySettings> | undefined, base: LobbySettings): LobbySettings {
  const r = raw ?? {}
  return {
    imagesPerPlayer: clampInt(r.imagesPerPlayer, 1, LIMITS.imagesPerPlayerMax, base.imagesPerPlayer),
    slideSeconds: clampInt(r.slideSeconds, LIMITS.slideSecondsMin, LIMITS.slideSecondsMax, base.slideSeconds),
    uploadSeconds: clampInt(r.uploadSeconds, LIMITS.uploadSecondsMin, LIMITS.uploadSecondsMax, base.uploadSeconds),
    maxPlayers: clampInt(r.maxPlayers, LIMITS.minPlayersToStart, LIMITS.maxPlayersCap, base.maxPlayers)
  }
}

export function isValidPublicKey(raw: unknown): raw is string {
  // Uncompressed P-256 point = 65 bytes = 88 base64 chars.
  return typeof raw === 'string' && /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/.test(raw) && raw.length === 88
}

export function isValidIv(raw: unknown): raw is string {
  // 12-byte IV = 16 base64 chars.
  return typeof raw === 'string' && /^[A-Za-z0-9+/]{16}$/.test(raw)
}

export function isTier(v: unknown): v is Tier {
  return v === 1 || v === 2 || v === 3 || v === 4
}

export function shuffle<T>(arr: T[], rand: (n: number) => number = randomInt): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Order slides so the same owner never appears twice in a row when that's
 * possible. Greedy: at each step pick (randomly) among owners with the most
 * remaining slides, excluding the previous owner.
 */
export function orderSlides<T extends { ownerId: string }>(
  slides: T[],
  rand: (n: number) => number = randomInt
): T[] {
  const byOwner = new Map<string, T[]>()
  for (const s of shuffle(slides, rand)) {
    const list = byOwner.get(s.ownerId) ?? []
    list.push(s)
    byOwner.set(s.ownerId, list)
  }
  const out: T[] = []
  let prev: string | null = null
  while (out.length < slides.length) {
    const candidates = [...byOwner.entries()].filter(([o, l]) => l.length > 0 && o !== prev)
    const pool = candidates.length > 0 ? candidates : [...byOwner.entries()].filter(([, l]) => l.length > 0)
    const max = Math.max(...pool.map(([, l]) => l.length))
    const top = pool.filter(([, l]) => l.length === max)
    const [owner, list] = top[rand(top.length)]
    out.push(list.pop()!)
    prev = owner
  }
  return out
}

export function guessPoints(tier: Tier, elapsedMs: number, durationMs: number): number {
  const frac = Math.max(0, Math.min(1, 1 - elapsedMs / durationMs))
  return TIER_INFO[tier].points + Math.round(SPEED_BONUS_MAX * frac)
}

export interface ScoredSlide {
  ownerId: string
  tier: Tier
  durationMs: number
  guesses: Map<string, { targetId: string; elapsedMs: number }>
}

export function computeResults(
  roster: { id: string; name: string }[],
  slides: ScoredSlide[]
): Results {
  const nameOf = new Map(roster.map((p) => [p.id, p.name]))
  const acc = new Map<string, { score: number; correct: number; fooled: number; timeSum: number }>()
  for (const p of roster) acc.set(p.id, { score: 0, correct: 0, fooled: 0, timeSum: 0 })

  const reveals: Reveal[] = slides.map((s, index) => {
    const correctGuessers: string[] = []
    let wrong = 0
    for (const [guesserId, g] of s.guesses) {
      const a = acc.get(guesserId)
      if (!a) continue
      if (g.targetId === s.ownerId) {
        a.score += guessPoints(s.tier, g.elapsedMs, s.durationMs)
        a.correct += 1
        a.timeSum += g.elapsedMs
        correctGuessers.push(nameOf.get(guesserId) ?? '?')
      } else {
        wrong += 1
      }
    }
    const owner = acc.get(s.ownerId)
    if (owner) {
      owner.score += FOOLER_BONUS * wrong
      owner.fooled += wrong
    }
    return {
      index,
      tier: s.tier,
      ownerId: s.ownerId,
      ownerName: nameOf.get(s.ownerId) ?? '?',
      correctGuessers,
      wrongGuesses: wrong
    }
  })

  const sorted = roster
    .map((p) => ({ p, a: acc.get(p.id)! }))
    .sort((x, y) => {
      if (y.a.score !== x.a.score) return y.a.score - x.a.score
      if (y.a.correct !== x.a.correct) return y.a.correct - x.a.correct
      const ax = x.a.correct ? x.a.timeSum / x.a.correct : Infinity
      const ay = y.a.correct ? y.a.timeSum / y.a.correct : Infinity
      return ax - ay
    })

  const standings: Standing[] = []
  sorted.forEach(({ p, a }, i) => {
    const prev = standings[i - 1]
    const tied =
      prev && prev.score === a.score && prev.correct === a.correct && sorted[i - 1].a.timeSum === a.timeSum
    standings.push({
      id: p.id,
      name: p.name,
      score: a.score,
      correct: a.correct,
      fooled: a.fooled,
      rank: tied ? prev.rank : i + 1
    })
  })
  return { standings, reveals }
}
