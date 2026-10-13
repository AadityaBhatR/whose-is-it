// End-to-end encryption for images, using only WebCrypto (built into Electron/Chromium).
//
//  1. Every player makes a throwaway ECDH P-256 key pair when they join a lobby.
//  2. At game start the host creates a random AES-256-GCM "game key" and wraps a
//     copy for each player with ECDH(host, player) -> HKDF -> AES-GCM.
//  3. Images are encrypted with the game key on the uploader's machine and only
//     decrypted on viewers' screens. The server relays ciphertext it can't read.
//  4. A safety code (hash of every public key in the lobby) lets players confirm
//     nobody in the middle swapped keys: everyone should see the same emoji.
//
// Keys live only in memory and are dropped when the game ends.

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()

export function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export interface Identity {
  privateKey: CryptoKey
  publicKeyB64: string
}

export async function createIdentity(): Promise<Identity> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits'
  ])) as CryptoKeyPair
  const raw = await subtle.exportKey('raw', pair.publicKey)
  return { privateKey: pair.privateKey, publicKeyB64: b64(raw) }
}

async function wrappingKey(me: Identity, theirPublicB64: string, lobbyId: string): Promise<CryptoKey> {
  const theirs = await subtle.importKey('raw', unb64(theirPublicB64), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = await subtle.deriveBits({ name: 'ECDH', public: theirs }, me.privateKey, 256)
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(lobbyId), info: enc.encode('whose-is-it/wrap/v1') },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

export async function createGameKey(): Promise<CryptoKey> {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

const newIv = () => globalThis.crypto.getRandomValues(new Uint8Array(12))

/** Host: wrap the game key for one player. */
export async function wrapGameKey(
  gameKey: CryptoKey,
  me: Identity,
  playerPublicB64: string,
  lobbyId: string,
  playerId: string
): Promise<{ iv: string; data: string }> {
  const wk = await wrappingKey(me, playerPublicB64, lobbyId)
  const raw = await subtle.exportKey('raw', gameKey)
  const iv = newIv()
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`key:${playerId}`) }, wk, raw)
  new Uint8Array(raw).fill(0)
  return { iv: b64(iv), data: b64(ct) }
}

/** Player: unwrap the game key the host sent us. */
export async function unwrapGameKey(
  sealed: { iv: string; data: string },
  me: Identity,
  hostPublicB64: string,
  lobbyId: string,
  myId: string
): Promise<CryptoKey> {
  const wk = await wrappingKey(me, hostPublicB64, lobbyId)
  const raw = await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: enc.encode(`key:${myId}`) },
    wk,
    unb64(sealed.data)
  )
  const key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  new Uint8Array(raw).fill(0)
  return key
}

export async function sealImage(gameKey: CryptoKey, bytes: ArrayBuffer, lobbyId: string) {
  const iv = newIv()
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`img:${lobbyId}`) }, gameKey, bytes)
  return { iv: b64(iv), data }
}

export async function openImage(
  gameKey: CryptoKey,
  sealed: { iv: string; data: ArrayBuffer },
  lobbyId: string
): Promise<ArrayBuffer> {
  return subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: enc.encode(`img:${lobbyId}`) },
    gameKey,
    sealed.data
  )
}

const WORDS = [
  'amber', 'anchor', 'apex', 'arrow', 'aspen', 'atlas', 'basil', 'beacon', 'birch', 'bison', 'blaze', 'bolt',
  'cedar', 'cinder', 'cobalt', 'comet', 'coral', 'crane', 'delta', 'dune', 'ember', 'falcon', 'fern', 'fjord',
  'flint', 'forge', 'garnet', 'glacier', 'granite', 'harbor', 'hazel', 'heron', 'indigo', 'iris', 'jade', 'juniper',
  'kestrel', 'lagoon', 'lantern', 'lumen', 'maple', 'marble', 'meadow', 'mesa', 'nectar', 'nova', 'oasis', 'onyx',
  'orbit', 'pebble', 'pine', 'prism', 'quartz', 'raven', 'ridge', 'saffron', 'sierra', 'slate', 'summit', 'tidal',
  'timber', 'umber', 'willow', 'zephyr'
]

/** Four words (24 bits) from SHA-256 over every public key in the lobby, sorted. */
export async function safetyCode(publicKeys: string[]): Promise<string> {
  const joined = [...publicKeys].sort().join('|')
  const h = new Uint8Array(await subtle.digest('SHA-256', enc.encode(`whose-is-it/safety/v1|${joined}`)))
  const bits = (h[0] << 16) | (h[1] << 8) | h[2]
  return [18, 12, 6, 0].map((s) => WORDS[(bits >> s) & 63]).join(' ')
}
