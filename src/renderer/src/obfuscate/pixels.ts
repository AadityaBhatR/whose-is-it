// Pure pixel operations on grayscale float buffers. No DOM, so they're unit-testable.

export type Rng = () => number

/** Mulberry32 seeded PRNG. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function gaussian(rng: Rng): number {
  let u = 0
  while (u === 0) u = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

export interface Gray {
  w: number
  h: number
  v: Float32Array // 0..255
}

export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Gray {
  const v = new Float32Array(w * h)
  for (let i = 0, j = 0; i < v.length; i++, j += 4) v[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]
  return { w, h, v }
}

export function grayToRgba(g: Gray, out: Uint8ClampedArray): void {
  for (let i = 0, j = 0; i < g.v.length; i++, j += 4) {
    const x = g.v[i]
    out[j] = out[j + 1] = out[j + 2] = x
    out[j + 3] = 255
  }
}

/** Separable box blur with clamped edges. */
export function boxBlur(g: Gray, r: number): Gray {
  if (r <= 0) return g
  const { w, h } = g
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  const n = 2 * r + 1
  for (let y = 0; y < h; y++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += g.v[y * w + Math.min(w - 1, Math.max(0, k))]
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / n
      const add = Math.min(w - 1, x + r + 1)
      const sub = Math.max(0, x - r)
      sum += g.v[y * w + add] - g.v[y * w + sub]
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n
      const add = Math.min(h - 1, y + r + 1)
      const sub = Math.max(0, y - r)
      sum += tmp[add * w + x] - tmp[sub * w + x]
    }
  }
  return { w, h, v: out }
}

export function stats(v: Float32Array): { mean: number; std: number } {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]
  const mean = s / v.length
  let q = 0
  for (let i = 0; i < v.length; i++) q += (v[i] - mean) ** 2
  return { mean, std: Math.sqrt(q / v.length) }
}

/** Value at percentile p (0..1) using a 256-bin histogram (values clamped to 0..1023 scaled). */
export function percentile(v: Float32Array, p: number, maxVal = 255): number {
  const bins = 1024
  const hist = new Uint32Array(bins)
  for (let i = 0; i < v.length; i++) hist[Math.min(bins - 1, Math.max(0, Math.floor((v[i] / maxVal) * (bins - 1))))]++
  const target = p * v.length
  let acc = 0
  for (let b = 0; b < bins; b++) {
    acc += hist[b]
    if (acc >= target) return (b / (bins - 1)) * maxVal
  }
  return maxVal
}

/** Stretch so the 2nd..98th percentile spans 0..255, then apply contrast around 128. */
export function autoLevels(g: Gray, contrast = 1): Gray {
  const lo = percentile(g.v, 0.02)
  const hi = Math.max(lo + 1, percentile(g.v, 0.98))
  const out = new Float32Array(g.v.length)
  for (let i = 0; i < out.length; i++) {
    const x = ((g.v[i] - lo) / (hi - lo)) * 255
    out[i] = clamp((x - 128) * contrast + 128)
  }
  return { w: g.w, h: g.h, v: out }
}

export const clamp = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : x)

export function addNoise(g: Gray, sigma: number, rng: Rng): void {
  for (let i = 0; i < g.v.length; i++) g.v[i] = clamp(g.v[i] + gaussian(rng) * sigma)
}

export function vignette(g: Gray, strength: number): void {
  const { w, h } = g
  const cx = w / 2
  const cy = h / 2
  const maxD = cx * cx + cy * cy
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = ((x - cx) ** 2 + (y - cy) ** 2) / maxD
      g.v[y * w + x] *= 1 - strength * d
    }
}

/** Sobel gradient magnitude. */
export function sobel(g: Gray): Gray {
  const { w, h, v } = g
  const out = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx =
        -v[i - w - 1] - 2 * v[i - 1] - v[i + w - 1] + v[i - w + 1] + 2 * v[i + 1] + v[i + w + 1]
      const gy =
        -v[i - w - 1] - 2 * v[i - w] - v[i - w + 1] + v[i + w - 1] + 2 * v[i + w] + v[i + w + 1]
      out[i] = Math.sqrt(gx * gx + gy * gy)
    }
  return { w, h, v: out }
}

/** Binary dilation (square, radius r) on a 0/1 mask. */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let on = 0
      for (let k = -r; k <= r && !on; k++) {
        const xx = x + k
        if (xx >= 0 && xx < w && mask[y * w + xx]) on = 1
      }
      tmp[y * w + x] = on
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let on = 0
      for (let k = -r; k <= r && !on; k++) {
        const yy = y + k
        if (yy >= 0 && yy < h && tmp[yy * w + x]) on = 1
      }
      out[y * w + x] = on
    }
  return out
}

/** Local mean via integral image (window radius r). */
export function localMean(g: Gray, r: number): Float32Array {
  const { w, h, v } = g
  const W = w + 1
  const integ = new Float64Array(W * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += v[y * w + x]
      integ[(y + 1) * W + (x + 1)] = integ[y * W + (x + 1)] + row
    }
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w, x + r + 1)
      const s = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0]
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0))
    }
  }
  return out
}

/** Otsu's threshold for a 0..255 buffer. */
export function otsu(v: Float32Array): number {
  const hist = new Float64Array(256)
  for (let i = 0; i < v.length; i++) hist[Math.min(255, Math.max(0, Math.round(v[i])))]++
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let best = 0
  let thr = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = v.length - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) ** 2
    if (between > best) {
      best = between
      thr = t
    }
  }
  return thr
}

export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((x) => (x + 0.5) / 16)

/** Bilinear sample from a gray buffer. */
export function sample(g: Gray, x: number, y: number): number {
  const { w, h, v } = g
  x = Math.min(w - 1.001, Math.max(0, x))
  y = Math.min(h - 1.001, Math.max(0, y))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const i = y0 * w + x0
  return (
    v[i] * (1 - fx) * (1 - fy) + v[i + 1] * fx * (1 - fy) + v[i + w] * (1 - fx) * fy + v[i + w + 1] * fx * fy
  )
}

/** HSL (0..360, 0..1, 0..1) -> RGB 0..255 */
export function hsl(hue: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + hue / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}
