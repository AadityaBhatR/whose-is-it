import { LIMITS, type LobbySettings } from '../../../shared/protocol'
import { Segmented } from '../components/ui'

const SLIDE = [10, 15, 20, 30, 45, 60]
const UPLOAD = [60, 90, 120, 180, 240, 300]
const fmtUpload = (n: number) => (n % 60 === 0 ? `${n / 60} min` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')} min`)

export function SettingsEditor({
  value,
  onChange,
  disabled,
  minPlayers = LIMITS.minPlayersToStart
}: {
  value: LobbySettings
  onChange: (s: LobbySettings) => void
  disabled?: boolean
  minPlayers?: number
}) {
  const set = (patch: Partial<LobbySettings>) => onChange({ ...value, ...patch })
  const players: number[] = []
  for (let n = Math.max(LIMITS.minPlayersToStart, minPlayers); n <= LIMITS.maxPlayersCap; n++) players.push(n)
  return (
    <div className="settings">
      <div className="setting">
        <span>Photos per player</span>
        <Segmented
          value={value.imagesPerPlayer}
          disabled={disabled}
          options={[1, 2, 3].map((n) => ({ value: n, label: String(n) }))}
          onChange={(n) => set({ imagesPerPlayer: n })}
        />
      </div>
      <label className="setting">
        <span>Time per slide</span>
        <select disabled={disabled} value={value.slideSeconds} onChange={(e) => set({ slideSeconds: +e.target.value })}>
          {SLIDE.map((n) => (
            <option key={n} value={n}>
              {n} sec
            </option>
          ))}
        </select>
      </label>
      <label className="setting">
        <span>Upload time</span>
        <select disabled={disabled} value={value.uploadSeconds} onChange={(e) => set({ uploadSeconds: +e.target.value })}>
          {UPLOAD.map((n) => (
            <option key={n} value={n}>
              {fmtUpload(n)}
            </option>
          ))}
        </select>
      </label>
      <label className="setting">
        <span>Max players</span>
        <select disabled={disabled} value={value.maxPlayers} onChange={(e) => set({ maxPlayers: +e.target.value })}>
          {players.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
