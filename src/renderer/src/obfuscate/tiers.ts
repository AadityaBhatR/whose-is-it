// The four obfuscation tiers. Each takes an RGBA buffer (already normalized to a
// square) and returns a new RGBA buffer plus a recognizability check.
// Goal: the OBJECT stays readable; the clues about WHOSE it is (room, light,
// colors, skin tone, camera) are destroyed.
import type { Tier } from '../../../shared/protocol'
import {
  BAYER4,
  addNoise,
  autoLevels,
  boxBlur,
  clamp,
  dilate,
  gaussian,
  grayToRgba,
  hsl,
  localMean,
  makeRng,
  otsu,
  percentile,
  sample,
  sobel,
  stats,
  toGray,
  vignette,
  type Gray,
  type Rng
} from './pixels'

export interface TierOutput {
  rgba: Uint8ClampedArray<ArrayBuffer>
  /** passes the "still recognizable" guard */
  ok: boolean
  metric: number
}

type TierFn = (src: Uint8ClampedArray, w: number, h: number, rng: Rng) => TierOutput

/** Tier 1 "Static": grayscale, crushed contrast, blur, heavy grain, vignette. */
const staticTier: TierFn = (src, w, h, rng) => {
  const base = toGray(src, w, h)
  const contrast = stats(base.v).std
  let g = autoLevels(boxBlur(boxBlur(base, 2), 1), 1.35)
  g = { ...g, v: g.v.slice() }
  addNoise(g, 30 + rng() * 10, rng)
  vignette(g, 0.55)
  const out = new Uint8ClampedArray(w * h * 4)
  grayToRgba(g, out)
  return { rgba: out, ok: contrast > 10, metric: contrast }
}

/** Tier 2 "Posterize": pixelate, 4 adaptive tones, random duotone palette, scanlines, noise. */
const posterizeTier: TierFn = (src, w, h, rng) => {
  const base = toGray(src, w, h)
  const contrast = stats(base.v).std
  const g = autoLevels(boxBlur(base, 1), 1.1)
  const block = 6 + Math.floor(rng() * 3) // 6..8 px
  const px = new Float32Array(w * h)
  for (let by = 0; by < h; by += block)
    for (let bx = 0; bx < w; bx += block) {
      let s = 0
      let n = 0
      for (let y = by; y < Math.min(h, by + block); y++)
        for (let x = bx; x < Math.min(w, bx + block); x++) {
          s += g.v[y * w + x]
          n++
        }
      const m = s / n
      for (let y = by; y < Math.min(h, by + block); y++)
        for (let x = bx; x < Math.min(w, bx + block); x++) px[y * w + x] = m
    }
  // Adaptive cut points (quartiles) so all 4 tones get used.
  const cuts = [0.25, 0.5, 0.75].map((p) => percentile(px, p))
  const hueA = rng() * 360
  const hueB = (hueA + 150 + rng() * 60) % 360
  const dark = hsl(hueA, 0.7, 0.12)
  const light = hsl(hueB, 0.65, 0.82)
  const tones = [0, 1, 2, 3].map((k) => {
    const t = k / 3
    return dark.map((d, c) => d + (light[c] - d) * t) as [number, number, number]
  })
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const scan = y % 3 === 0 ? 0.8 : 1
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const v = px[i]
      const level = v < cuts[0] ? 0 : v < cuts[1] ? 1 : v < cuts[2] ? 2 : 3
      const t = tones[level]
      const j = i * 4
      for (let c = 0; c < 3; c++) out[j + c] = clamp(t[c] * scan + gaussian(rng) * 14)
      out[j + 3] = 255
    }
  }
  return { rgba: out, ok: contrast > 10, metric: contrast }
}

/** Tier 3 "Sketch": edges only, black lines on white, speckle noise. */
const sketchTier: TierFn = (src, w, h, rng) => {
  const g = autoLevels(boxBlur(boxBlur(toGray(src, w, h), 1), 1), 1)
  const mag = sobel(g)
  const keep = 0.1 + rng() * 0.04 // keep the strongest 10-14% of edges
  let thr = percentile(mag.v, 1 - keep, 1442)
  const maxMag = percentile(mag.v, 0.999, 1442)
  thr = Math.max(thr, 25)
  let mask: Uint8Array = new Uint8Array(w * h)
  for (let i = 0; i < mask.length; i++) mask[i] = mag.v[i] > thr ? 1 : 0
  mask = dilate(mask, w, h, 1)
  let on = 0
  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    let black = mask[i] === 1
    if (black) on++
    if (rng() < 0.018) black = !black // salt & pepper
    const v = black ? 15 : 245
    out[j] = out[j + 1] = out[j + 2] = v
    out[j + 3] = 255
  }
  const frac = on / mask.length
  return { rgba: out, ok: maxMag > 60 && frac > 0.03 && frac < 0.35, metric: frac }
}

/** Tier 4 "Ink": pure black/white threshold + ordered dither, flipped-pixel noise, wavy warp. */
const inkTier: TierFn = (src, w, h, rng) => {
  const g = autoLevels(boxBlur(toGray(src, w, h), 2), 1.15)
  const local = localMean(g, 18)
  const global = otsu(g.v)
  // Wavy warp first (sample source through a sine displacement field).
  const amp = 3 + rng() * 3
  const per = 70 + rng() * 40
  const ph1 = rng() * Math.PI * 2
  const ph2 = rng() * Math.PI * 2
  const warped: Gray = { w, h, v: new Float32Array(w * h) }
  const warpedT = new Float32Array(w * h)
  const thrBuf: Gray = { w, h, v: new Float32Array(w * h) }
  for (let i = 0; i < w * h; i++) thrBuf.v[i] = 0.55 * global + 0.45 * local[i] - 4
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = x + amp * Math.sin((y / per) * Math.PI * 2 + ph1)
      const sy = y + amp * Math.sin((x / per) * Math.PI * 2 + ph2)
      warped.v[y * w + x] = sample(g, sx, sy)
      warpedT[y * w + x] = sample(thrBuf, sx, sy)
    }
  const out = new Uint8ClampedArray(w * h * 4)
  let black = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const d = (BAYER4[(y & 3) * 4 + (x & 3)] - 0.5) * 44
      let isBlack = warped.v[i] < warpedT[i] + d
      if (rng() < 0.03) isBlack = !isBlack
      if (isBlack) black++
      const v = isBlack ? 0 : 255
      const j = i * 4
      out[j] = out[j + 1] = out[j + 2] = v
      out[j + 3] = 255
    }
  const frac = black / (w * h)
  return { rgba: out, ok: frac > 0.08 && frac < 0.85 && stats(g.v).std > 12, metric: frac }
}

const TIERS: Record<Tier, TierFn> = { 1: staticTier, 2: posterizeTier, 3: sketchTier, 4: inkTier }

/**
 * Apply `tier`; if the result fails its recognizability guard, fall back to the
 * next easier tier. Tier 1 is always accepted.
 */
export function obfuscatePixels(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  tier: Tier,
  seed: number
): { rgba: Uint8ClampedArray<ArrayBuffer>; tier: Tier; fellBack: boolean } {
  let t = tier
  for (;;) {
    const res = TIERS[t](src, w, h, makeRng(seed + t * 7919))
    if (res.ok || t === 1) return { rgba: res.rgba, tier: t, fellBack: t !== tier }
    t = (t - 1) as Tier
  }
}
