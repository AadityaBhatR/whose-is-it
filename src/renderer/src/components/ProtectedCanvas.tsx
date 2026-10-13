import { EyeOff } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useWindowFocus } from '../hooks'

interface Props {
  bitmap: ImageBitmap | null
  /** viewer's name, tiled faintly over the image to deter phone-camera photos */
  watermark?: string
  className?: string
  size?: number
}

/**
 * Images are only ever painted onto a <canvas> (no <img>, no URL to save),
 * wiped whenever the window loses focus, and wiped on unmount.
 */
export function ProtectedCanvas({ bitmap, watermark, className, size = 512 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const focused = useWindowFocus()

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, size, size)
    if (!bitmap || !focused) return
    try {
      ctx.drawImage(bitmap, 0, 0, size, size)
    } catch {
      return // bitmap was closed underneath us
    }
    if (watermark) {
      const stamp = `${watermark} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      ctx.save()
      ctx.globalAlpha = 0.2
      ctx.font = `600 ${Math.round(size / 32)}px 'Inter Variable', system-ui, sans-serif`
      ctx.translate(size / 2, size / 2)
      ctx.rotate(-Math.PI / 6)
      for (let y = -size; y < size; y += size / 6)
        for (let x = -size; x < size; x += size / 2.6) {
          const off = (Math.round(y / (size / 6)) % 2) * (size / 5.2)
          ctx.fillStyle = '#7a7a85'
          ctx.fillText(stamp, x + off, y)
        }
      ctx.restore()
    }
    return () => ctx.clearRect(0, 0, size, size)
  }, [bitmap, focused, watermark, size])

  return (
    <div className={`protected ${className ?? ''}`}>
      <canvas
        ref={ref}
        width={size}
        height={size}
        draggable={false}
        onContextMenu={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
      />
      {!focused && bitmap && (
        <div className="protected-cover">
          <EyeOff size={20} strokeWidth={1.5} aria-hidden />
          <strong>Hidden while the window is inactive</strong>
          <span>Click back into the game to view the image.</span>
        </div>
      )}
    </div>
  )
}
