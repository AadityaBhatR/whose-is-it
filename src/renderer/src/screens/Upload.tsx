import { CheckCircle2, ImagePlus, RefreshCw, Send, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { TIER_INFO, type Tier } from '../../../shared/protocol'
import { ProtectedCanvas } from '../components/ProtectedCanvas'
import { TierLabel } from '../components/TierLabel'
import { Timer } from '../components/Timer'
import { Button, Card, Notice, PageHeader } from '../components/ui'
import { decodeFile, obfuscateBitmap, pickTiers, type Obfuscated } from '../obfuscate/pipeline'
import { game, useGameState } from '../store'
import { Verification } from './Lobby'

interface Slot {
  tier: Tier
  source: ImageBitmap | null // decoded original: stays on this machine, closed after submit
  result: Obfuscated | null
  busy: boolean
  rerolled: boolean
  error: string | null
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif'

export function UploadScreen() {
  const s = useGameState()
  const lobby = s.lobby!
  const me = lobby.players.find((p) => p.id === s.me)
  const n = lobby.settings.imagesPerPlayer
  const tiers = useMemo(() => pickTiers(n), [n])
  const [slots, setSlots] = useState<Slot[]>(() =>
    tiers.map((tier) => ({ tier, source: null, result: null, busy: false, rerolled: false, error: null }))
  )
  const [submitting, setSubmitting] = useState(false)
  const slotsRef = useRef(slots)
  slotsRef.current = slots

  useEffect(
    () => () => {
      for (const sl of slotsRef.current) {
        sl.source?.close()
        sl.result?.preview.close()
      }
    },
    []
  )

  const patch = (i: number, p: Partial<Slot>) => setSlots((cur) => cur.map((sl, j) => (j === i ? { ...sl, ...p } : sl)))

  const choose = async (i: number, file: File | undefined) => {
    if (!file) return
    patch(i, { busy: true, error: null })
    try {
      const source = await decodeFile(file)
      const result = await obfuscateBitmap(source, slotsRef.current[i].tier)
      const old = slotsRef.current[i]
      old.source?.close()
      old.result?.preview.close()
      patch(i, { source, result, busy: false, rerolled: false })
    } catch (e) {
      patch(i, { busy: false, error: (e as Error).message })
    }
  }

  const reroll = async (i: number) => {
    const sl = slotsRef.current[i]
    if (!sl.source || sl.rerolled) return
    patch(i, { busy: true })
    const result = await obfuscateBitmap(sl.source, sl.tier)
    sl.result?.preview.close()
    patch(i, { result, busy: false, rerolled: true })
  }

  const remove = (i: number) => {
    const sl = slotsRef.current[i]
    sl.source?.close()
    sl.result?.preview.close()
    patch(i, { source: null, result: null, rerolled: false, error: null })
  }

  const ready = slots.filter((sl) => sl.result)
  const submit = async () => {
    setSubmitting(true)
    const err = await game.submitImages(ready.map((sl) => ({ bytes: sl.result!.bytes, tier: sl.result!.tier })))
    setSubmitting(false)
    if (err) return game.toast(err, 'error')
    for (const sl of slotsRef.current) {
      sl.source?.close()
      new Uint8Array(sl.result?.bytes ?? new ArrayBuffer(0)).fill(0)
    }
  }

  const submittedCount = lobby.players.filter((p) => p.submitted).length
  const activeCount = lobby.players.filter((p) => p.connected).length
  const timer = s.uploadEndsAt && (
    <Timer endsAt={s.uploadEndsAt} durationMs={lobby.settings.uploadSeconds * 1000} label="Time remaining" />
  )

  if (me?.submitted) {
    return (
      <div className="center-page">
        <Card className="narrow">
          <div className="stack">
            <div className="state-head">
              <CheckCircle2 size={20} strokeWidth={1.75} className="ok" />
              <h2>Photos submitted</h2>
            </div>
            <p className="muted">
              Your photos were scrambled and encrypted on this computer before being sent. Waiting for the other
              players.
            </p>
            <div className="meter">
              <div className="meter-row">
                <span>Players submitted</span>
                <span className="strong">
                  {submittedCount} of {activeCount}
                </span>
              </div>
              <div className="timer-track">
                <div className="timer-fill" style={{ width: `${(submittedCount / Math.max(1, activeCount)) * 100}%` }} />
              </div>
            </div>
            {timer}
            <div className="divider" />
            <Verification code={s.safety} />
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="page">
      <PageHeader
        title="Submit your photos"
        subtitle={`Choose up to ${n} photo${n === 1 ? '' : 's'} of something personal. Only the scrambled version leaves this computer.`}
        actions={<div className="header-timer">{timer}</div>}
      />

      {s.keyState === 'failed' && (
        <Notice tone="danger">
          The encryption handshake failed, so uploads are disabled. Compare verification codes with the other players.
        </Notice>
      )}

      <div className={`slots slots-${n}`}>
        {slots.map((sl, i) => {
          const tier = sl.result?.tier ?? sl.tier
          return (
            <Card
              key={i}
              title={`Photo ${i + 1}`}
              actions={<TierLabel tier={tier} />}
              className="slot"
            >
              <div
                className="slot-body"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  choose(i, e.dataTransfer.files[0])
                }}
              >
                {sl.busy && <div className="slot-state">Processing…</div>}
                {!sl.busy && sl.result && <ProtectedCanvas bitmap={sl.result.preview} />}
                {!sl.busy && !sl.result && (
                  <label className="dropzone">
                    <input type="file" accept={ACCEPT} onChange={(e) => choose(i, e.target.files?.[0])} />
                    <ImagePlus size={22} strokeWidth={1.5} aria-hidden />
                    <strong>Choose a photo</strong>
                    <span>or drag and drop</span>
                    <span className="faint">JPG, PNG, WebP</span>
                  </label>
                )}
              </div>
              {sl.error && <Notice tone="danger">{sl.error}</Notice>}
              {sl.result?.fellBack && (
                <p className="hint">
                  Switched to {TIER_INFO[tier].name}: the harder filter made this photo unrecognizable.
                </p>
              )}
              <div className="slot-foot">
                <span className="hint">{TIER_INFO[tier].blurb}</span>
                {sl.result && (
                  <div className="row tight">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={RefreshCw}
                      disabled={sl.rerolled || sl.busy}
                      onClick={() => reroll(i)}
                      title="Generate a different scramble (once)"
                    >
                      {sl.rerolled ? 'Regenerated' : 'Regenerate'}
                    </Button>
                    <Button size="sm" variant="ghost" icon={X} disabled={sl.busy} onClick={() => remove(i)}>
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          )
        })}
      </div>

      <div className="footer-bar">
        <span className="muted small">
          {s.keyState === 'ready' ? 'Encryption key received.' : 'Waiting for the encryption key…'} {submittedCount} of{' '}
          {activeCount} players submitted.
        </span>
        <Button
          variant="primary"
          size="lg"
          icon={Send}
          disabled={ready.length === 0 || submitting || s.keyState !== 'ready' || slots.some((sl) => sl.busy)}
          onClick={submit}
        >
          {submitting ? 'Sending…' : `Submit ${ready.length || ''} photo${ready.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  )
}
