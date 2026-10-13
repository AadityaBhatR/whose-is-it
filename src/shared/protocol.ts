// Shared wire protocol between the game server and the desktop client.
// Nothing in here ever carries plaintext image data: images travel as
// AES-256-GCM ciphertext that only players in the lobby can decrypt.

export type Phase = 'lobby' | 'upload' | 'slideshow' | 'results'
export type Tier = 1 | 2 | 3 | 4

export const TIER_INFO: Record<Tier, { name: string; points: number; blurb: string }> = {
  1: { name: 'Static', points: 100, blurb: 'Grayscale, heavy grain, blur' },
  2: { name: 'Posterize', points: 150, blurb: 'Few-tone duotone, pixelated, scanlines' },
  3: { name: 'Sketch', points: 200, blurb: 'Edge outlines only, speckle noise' },
  4: { name: 'Ink', points: 250, blurb: 'Pure black/white dither, warped' }
}

export const SPEED_BONUS_MAX = 50
export const FOOLER_BONUS = 25

export const LIMITS = {
  minPlayersToStart: 3,
  maxPlayersCap: 12,
  nameMax: 20,
  lobbyNameMax: 32,
  codeLength: 6,
  maxImageBytes: 1_500_000, // ciphertext bytes per image
  slideSecondsMin: 10,
  slideSecondsMax: 60,
  uploadSecondsMin: 60,
  uploadSecondsMax: 300,
  imagesPerPlayerMax: 3
} as const

export interface LobbySettings {
  imagesPerPlayer: number // 1..3
  slideSeconds: number // 10..60
  uploadSeconds: number // 60..300
  maxPlayers: number // 3..12
}

export const DEFAULT_SETTINGS: LobbySettings = {
  imagesPerPlayer: 3,
  slideSeconds: 20,
  uploadSeconds: 120,
  maxPlayers: 10
}

/** Ciphertext blob: base64 IV + raw bytes (ArrayBuffer on client, Buffer on server). */
export interface Sealed<B = ArrayBuffer> {
  iv: string
  data: B
}

export interface PlayerView {
  id: string
  name: string
  connected: boolean
  isHost: boolean
  submitted: boolean
  publicKey: string // base64 raw P-256 ECDH public key
}

export interface LobbyView {
  id: string
  code: string
  name: string
  phase: Phase
  hostId: string
  settings: LobbySettings
  players: PlayerView[]
  /** ms remaining in the upload phase (when phase === 'upload') */
  uploadRemainingMs: number | null
}

export interface LobbySummary {
  id: string
  name: string
  hostName: string
  players: number
  maxPlayers: number
}

export interface SlideShow {
  slideId: string
  index: number // 0-based
  total: number
  tier: Tier
  remainingMs: number
  durationMs: number
  isYours: boolean
  /** players you may pick from (uploaders minus yourself) */
  options: { id: string; name: string }[]
  image: Sealed
  /** if you already guessed (e.g. after a reconnect) */
  yourGuess: string | null
}

export interface SlideProgress {
  slideId: string
  guessed: number
  eligible: number
}

export interface Standing {
  id: string
  name: string
  score: number
  correct: number
  fooled: number
  rank: number
}

export interface Reveal {
  index: number
  tier: Tier
  ownerId: string
  ownerName: string
  correctGuessers: string[]
  wrongGuesses: number
}

export interface Results {
  standings: Standing[]
  reveals: Reveal[]
}

export type Ack<T = object> = ({ ok: true } & T) | { ok: false; error: string }

// ---- client -> server payloads ----
export interface CreatePayload {
  lobbyName: string
  playerName: string
  publicKey: string
  settings: LobbySettings
}
export interface JoinPayload {
  code: string
  lobbyId?: string
  playerName: string
  publicKey: string
}
export interface JoinedAck {
  lobbyId: string
  playerId: string
  token: string
}
export interface StartPayload {
  /** game key wrapped for every non-host player, keyed by playerId */
  wrappedKeys: Record<string, Sealed<string>>
}
export interface UploadImage {
  tier: Tier
  iv: string
  data: ArrayBuffer
}
