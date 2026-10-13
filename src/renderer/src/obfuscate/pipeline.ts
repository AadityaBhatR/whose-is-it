// Browser glue: file -> normalized 512x512 canvas -> tier filter -> WebP bytes.
// The original photo never leaves this function: only the filtered WebP is returned.
import type { Tier } from '../../../shared/protocol'
import { makeRng } from './pixels'
import { obfuscatePixels } from './tiers'

export const OUT_SIZE = 512

export interface Obfuscated {
  bytes: ArrayBuffer // WebP
  tier: Tier
  fellBack: boolean
  /** small preview bitmap for the uploader's own screen */
  preview: ImageBitmap
}

function randomSeed(): number {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
}

/** Shuffle [1,2,3,4] and take n distinct tiers. */
export function pickTiers(n: number): Tier[] {
  const t: Tier[] = [1, 2, 3, 4]
  const r = new Uint32Array(4)
  globalThis.crypto.getRandomValues(r)
  for (let i = t.length - 1; i > 0; i--) {
    const j = r[i] % (i + 1)
    ;[t[i], t[j]] = [t[j], t[i]]
  }
  return t.slice(0, n)
}

/**
 * Center-ish square crop with jitter, small rotation, random mirror, resize to 512.
 * Drawing through a canvas also drops all EXIF/GPS/camera metadata.
 */
function normalize(bitmap: ImageBitmap, seed: number): ImageData {
  const rng = makeRng(seed)
  const canvas = new OffscreenCanvas(OUT_SIZE, OUT_SIZE)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const side = Math.min(bitmap.width, bitmap.height) * (0.82 + rng() * 0.18)
  const sx = (bitmap.width - side) * rng()
  const sy = (bitmap.height - side) * rng()
  const angle = ((rng() * 2 - 1) * 6 * Math.PI) / 180
  const flip = rng() < 0.5 ? -1 : 1
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, OUT_SIZE, OUT_SIZE)
  ctx.imageSmoothingQuality = 'high'
  ctx.translate(OUT_SIZE / 2, OUT_SIZE / 2)
  ctx.rotate(angle)
  ctx.scale(flip * 1.12, 1.12) // overscale so rotated corners stay filled
  ctx.drawImage(bitmap, sx, sy, side, side, -OUT_SIZE / 2, -OUT_SIZE / 2, OUT_SIZE, OUT_SIZE)
  return ctx.getImageData(0, 0, OUT_SIZE, OUT_SIZE)
}

export async function decodeFile(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error("Couldn't read that image. Try a JPG, PNG or WebP (HEIC isn't supported).")
  }
}

export async function obfuscateBitmap(bitmap: ImageBitmap, tier: Tier, seed = randomSeed()): Promise<Obfuscated> {
  const norm = normalize(bitmap, seed)
  const res = obfuscatePixels(norm.data, norm.width, norm.height, tier, seed)
  norm.data.fill(0)
  const canvas = new OffscreenCanvas(OUT_SIZE, OUT_SIZE)
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(res.rgba, OUT_SIZE, OUT_SIZE), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
  const bytes = await blob.arrayBuffer()
  const preview = await createImageBitmap(canvas)
  res.rgba.fill(0)
  return { bytes, tier: res.tier, fellBack: res.fellBack, preview }
}
