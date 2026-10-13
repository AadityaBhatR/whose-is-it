import { describe, expect, it } from 'vitest'
import {
  CODE_ALPHABET,
  cleanName,
  computeResults,
  generateCode,
  guessPoints,
  normalizeCode,
  orderSlides
} from '../server/game'
import { FOOLER_BONUS, TIER_INFO } from '../src/shared/protocol'

describe('codes', () => {
  it('uses 6 unambiguous characters and avoids taken codes', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const c = generateCode((x) => taken.has(x))
      expect(c).toHaveLength(6)
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch)
      expect(taken.has(c)).toBe(false)
      taken.add(c)
    }
    expect(CODE_ALPHABET).not.toMatch(/[0O1IL]/)
  })
  it('normalizes user input', () => {
    expect(normalizeCode(' ab-c 12x9 ')).toBe('ABC12X')
  })
})

describe('names', () => {
  it('strips control/bidi characters and trims', () => {
    expect(cleanName('  Bob‮\u0007   Smith ', 20)).toBe('Bob Smith')
    expect(cleanName('x'.repeat(50), 20)).toHaveLength(20)
  })
})

describe('slide ordering', () => {
  it('never shows the same owner twice in a row when avoidable', () => {
    for (let trial = 0; trial < 300; trial++) {
      const slides = [
        ...['a', 'a', 'a'].map((o) => ({ ownerId: o })),
        ...['b', 'b', 'b'].map((o) => ({ ownerId: o })),
        ...['c', 'c'].map((o) => ({ ownerId: o })),
        { ownerId: 'd' }
      ]
      const out = orderSlides(slides)
      expect(out).toHaveLength(slides.length)
      for (let i = 1; i < out.length; i++) expect(out[i].ownerId).not.toBe(out[i - 1].ownerId)
    }
  })
})

describe('scoring', () => {
  it('gives tier points plus a linear speed bonus', () => {
    expect(guessPoints(1, 0, 20000)).toBe(TIER_INFO[1].points + 50)
    expect(guessPoints(4, 10000, 20000)).toBe(TIER_INFO[4].points + 25)
    expect(guessPoints(3, 20000, 20000)).toBe(TIER_INFO[3].points)
    expect(guessPoints(3, 99999, 20000)).toBe(TIER_INFO[3].points)
  })

  it('awards fooler bonus to owners and ranks with tiebreaks', () => {
    const roster = [
      { id: 'a', name: 'Ann' },
      { id: 'b', name: 'Ben' },
      { id: 'c', name: 'Cat' }
    ]
    const res = computeResults(roster, [
      {
        ownerId: 'a',
        tier: 2,
        durationMs: 20000,
        guesses: new Map([
          ['b', { targetId: 'a', elapsedMs: 0 }], // correct, fast
          ['c', { targetId: 'b', elapsedMs: 5000 }] // wrong -> Ann +25
        ])
      },
      {
        ownerId: 'b',
        tier: 4,
        durationMs: 20000,
        guesses: new Map([
          ['a', { targetId: 'c', elapsedMs: 1000 }], // wrong -> Ben +25
          ['c', { targetId: 'a', elapsedMs: 1000 }] // wrong -> Ben +25
        ])
      }
    ])
    const by = Object.fromEntries(res.standings.map((s) => [s.id, s]))
    expect(by.a.score).toBe(FOOLER_BONUS)
    expect(by.b.score).toBe(TIER_INFO[2].points + 50 + 2 * FOOLER_BONUS)
    expect(by.c.score).toBe(0)
    expect(res.standings.map((s) => s.id)).toEqual(['b', 'a', 'c'])
    expect(res.reveals[0]).toMatchObject({ ownerName: 'Ann', correctGuessers: ['Ben'], wrongGuesses: 1 })
    expect(res.reveals[1]).toMatchObject({ ownerName: 'Ben', correctGuessers: [], wrongGuesses: 2 })
  })
})
