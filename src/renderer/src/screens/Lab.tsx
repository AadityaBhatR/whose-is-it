import { ArrowLeft, ImagePlus, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { TIER_INFO, type Tier } from '../../../shared/protocol'
import { ProtectedCanvas } from '../components/ProtectedCanvas'
import { TierLabel } from '../components/TierLabel'
import { Button, Card, Notice, PageHeader } from '../components/ui'
import { decodeFile, obfuscateBitmap, type Obfuscated } from '../obfuscate/pipeline'
import { game } from '../store'

const ALL: Tier[] = [1, 2, 3, 4]

/** Offline filter preview for tuning. Nothing here touches the network. */
export function LabScreen() {
  const [source, setSource] = useState<ImageBitmap | null>(null)
  const [outs, setOuts] = useState<(Obfuscated | null)[]>([null, null, null, null])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef({ source, outs })
  ref.current = { source, outs }

  useEffect(
    () => () => {
      ref.current.source?.close()
      ref.current.outs.forEach((o) => o?.preview.close())
    },
    []
  )

  const run = async (bmp: ImageBitmap) => {
    setBusy(true)
    const next = await Promise.all(ALL.map((t) => obfuscateBitmap(bmp, t)))
    ref.current.outs.forEach((o) => o?.preview.close())
    setOuts(next)
    setBusy(false)
  }

  const pick = async (file?: File) => {
    if (!file) return
    setErr(null)
    try {
      const bmp = await decodeFile(file)
      ref.current.source?.close()
      setSource(bmp)
      await run(bmp)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Filter preview"
        subtitle="See all four scrambles on any photo. Nothing on this page leaves your computer."
        actions={
          <>
            <Button variant="ghost" icon={ArrowLeft} onClick={() => game.setLab(false)}>
              Back
            </Button>
            <Button icon={RefreshCw} disabled={!source || busy} onClick={() => source && run(source)}>
              Regenerate
            </Button>
            <label className="btn btn-primary btn-md">
              <ImagePlus size={16} strokeWidth={1.75} aria-hidden />
              Choose photo
              <input
                hidden
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
                onChange={(e) => pick(e.target.files?.[0])}
              />
            </label>
          </>
        }
      />
      {err && <Notice tone="danger">{err}</Notice>}
      <div className="lab-grid">
        {ALL.map((t, i) => (
          <Card
            key={t}
            className="lab-cell"
            title={<TierLabel tier={t} />}
            actions={
              <span className="muted small">
                {outs[i] ? `${Math.round(outs[i]!.bytes.byteLength / 1024)} KB` : ''}
                {outs[i]?.fellBack ? ` · fell back to ${TIER_INFO[outs[i]!.tier].name}` : ''}
              </span>
            }
          >
            <div className="slot-body">
              {busy ? (
                <div className="slot-state">Processing…</div>
              ) : outs[i] ? (
                <ProtectedCanvas bitmap={outs[i]!.preview} />
              ) : (
                <div className="slot-state">No photo selected</div>
              )}
            </div>
            <p className="hint">{TIER_INFO[t].blurb}</p>
          </Card>
        ))}
      </div>
    </div>
  )
}
