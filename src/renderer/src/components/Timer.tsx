import { fmtSecs, useNow } from '../hooks'

export function Timer({ endsAt, durationMs, label }: { endsAt: number; durationMs: number; label?: string }) {
  const now = useNow(200)
  const left = Math.max(0, endsAt - now)
  const frac = durationMs > 0 ? left / durationMs : 0
  return (
    <div className={`timer ${left < 5000 ? 'low' : ''}`}>
      <div className="timer-row">
        {label && <span>{label}</span>}
        <span className="timer-value">{fmtSecs(left)}</span>
      </div>
      <div className="timer-track">
        <div className="timer-fill" style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  )
}
