import { describe, expect, it } from 'vitest'
import { obfuscatePixels } from '../src/renderer/src/obfuscate/tiers'
import type { Tier } from '../src/shared/protocol'

const N = 256

/** A synthetic "photo": gradient background, a bright disc and a dark bar. */
function scene(): Uint8ClampedArray<ArrayBuffer> {
  const d = new Uint8ClampedArray(N * N * 4)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4
      let r = 60 + x / 4
      let g = 80 + y / 5
      let b = 120
      if ((x - 128) ** 2 + (y - 110) ** 2 < 55 ** 2) [r, g, b] = [240, 200, 60]
      if (y > 190 && y < 215 && x > 40 && x < 216) [r, g, b] = [20, 20, 30]
      d[i] = r
      d[i + 1] = g
      d[i + 2] = b
      d[i + 3] = 255
    }
  return d
}

describe('obfuscation tiers', () => {
  for (const tier of [1, 2, 3, 4] as Tier[]) {
    it(`tier ${tier} keeps a recognizable image of the right size`, () => {
      const src = scene()
      const out = obfuscatePixels(src, N, N, tier, 1234)
      expect(out.rgba.length).toBe(N * N * 4)
      expect(out.tier).toBe(tier)
      expect(out.fellBack).toBe(false)
    })
  }

  it('sketch and ink are pure black/white (no color left)', () => {
    for (const tier of [3, 4] as Tier[]) {
      const { rgba } = obfuscatePixels(scene(), N, N, tier, 7)
      for (let i = 0; i < rgba.length; i += 4) {
        expect(rgba[i]).toBe(rgba[i + 1])
        expect(rgba[i + 1]).toBe(rgba[i + 2])
        expect([0, 15, 245, 255]).toContain(rgba[i])
      }
    }
  })

  it('static is grayscale', () => {
    const { rgba } = obfuscatePixels(scene(), N, N, 1, 7)
    for (let i = 0; i < rgba.length; i += 4) expect(rgba[i]).toBe(rgba[i + 2])
  })

  it('does not just copy the source pixels', () => {
    const src = scene()
    for (const tier of [1, 2, 3, 4] as Tier[]) {
      const { rgba } = obfuscatePixels(src, N, N, tier, 99)
      let same = 0
      for (let i = 0; i < rgba.length; i += 4) if (rgba[i] === src[i] && rgba[i + 1] === src[i + 1]) same++
      expect(same / (N * N)).toBeLessThan(0.2)
    }
  })

  it('falls back to an easier tier when the image is featureless', () => {
    const flat = new Uint8ClampedArray(N * N * 4).fill(128)
    const out = obfuscatePixels(flat, N, N, 4, 5)
    expect(out.tier).toBe(1)
    expect(out.fellBack).toBe(true)
  })

  it('is deterministic for a seed and varies across seeds', () => {
    const a = obfuscatePixels(scene(), N, N, 2, 42).rgba
    const b = obfuscatePixels(scene(), N, N, 2, 42).rgba
    const c = obfuscatePixels(scene(), N, N, 2, 43).rgba
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false)
  })
})
