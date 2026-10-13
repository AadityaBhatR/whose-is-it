import { describe, expect, it } from 'vitest'
import {
  createGameKey,
  createIdentity,
  openImage,
  safetyCode,
  sealImage,
  unwrapGameKey,
  wrapGameKey
} from '../src/renderer/src/crypto'
import { isValidIv, isValidPublicKey } from '../server/game'

describe('end-to-end crypto', () => {
  it('produces keys/IVs the server accepts', async () => {
    const id = await createIdentity()
    expect(isValidPublicKey(id.publicKeyB64)).toBe(true)
    const gk = await createGameKey()
    const sealed = await sealImage(gk, new Uint8Array([1, 2, 3]).buffer, 'L')
    expect(isValidIv(sealed.iv)).toBe(true)
  })

  it('host wraps the game key so only the intended player can open it', async () => {
    const host = await createIdentity()
    const alice = await createIdentity()
    const mallory = await createIdentity()
    const gk = await createGameKey()
    const wrapped = await wrapGameKey(gk, host, alice.publicKeyB64, 'lobby-1', 'alice')

    const aliceKey = await unwrapGameKey(wrapped, alice, host.publicKeyB64, 'lobby-1', 'alice')
    const img = new TextEncoder().encode('fake webp bytes').buffer
    const sealed = await sealImage(gk, img, 'lobby-1')
    const opened = await openImage(aliceKey, sealed, 'lobby-1')
    expect(new TextDecoder().decode(opened)).toBe('fake webp bytes')

    await expect(unwrapGameKey(wrapped, mallory, host.publicKeyB64, 'lobby-1', 'alice')).rejects.toThrow()
    await expect(unwrapGameKey(wrapped, alice, host.publicKeyB64, 'lobby-2', 'alice')).rejects.toThrow()
    await expect(unwrapGameKey(wrapped, alice, host.publicKeyB64, 'lobby-1', 'bob')).rejects.toThrow()
  })

  it('rejects tampered ciphertext and wrong lobby binding', async () => {
    const gk = await createGameKey()
    const sealed = await sealImage(gk, new Uint8Array(100).buffer, 'L1')
    const bad = new Uint8Array(sealed.data.slice(0))
    bad[5] ^= 1
    await expect(openImage(gk, { iv: sealed.iv, data: bad.buffer }, 'L1')).rejects.toThrow()
    await expect(openImage(gk, sealed, 'L2')).rejects.toThrow()
  })

  it('safety code is order independent and changes when a key is swapped', async () => {
    const keys = await Promise.all([1, 2, 3].map(() => createIdentity().then((i) => i.publicKeyB64)))
    const a = await safetyCode(keys)
    const b = await safetyCode([...keys].reverse())
    expect(a).toBe(b)
    expect(a.split(' ')).toHaveLength(4)
    const swapped = await safetyCode([keys[0], keys[1], (await createIdentity()).publicKeyB64])
    expect(swapped).not.toBe(a)
  })
})
