import { Check } from 'lucide-react'
import { ProtectedCanvas } from '../components/ProtectedCanvas'
import { TierLabel } from '../components/TierLabel'
import { Timer } from '../components/Timer'
import { Avatar, Card } from '../components/ui'
import { game, useGameState } from '../store'

export function SlideshowScreen() {
  const s = useGameState()
  const slide = s.slide
  const me = s.lobby?.players.find((p) => p.id === s.me)

  if (!slide) return <div className="boot">Preparing slides…</div>

  if (slide.ended) {
    const last = slide.index + 1 >= slide.total
    return (
      <div className="center-page">
        <Card className="narrow">
          <div className="stack center-text">
            <span className="eyebrow">
              Slide {slide.index + 1} of {slide.total} complete
            </span>
            <h2>{last ? 'Calculating results' : 'Next slide'}</h2>
            <p className="muted">The image has been deleted. Answers are revealed at the end.</p>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="slideshow">
      <div className="slide-head">
        <div className="row">
          <span className="slide-count">
            Slide {slide.index + 1} <span className="muted">of {slide.total}</span>
          </span>
          <TierLabel tier={slide.tier} />
        </div>
        <div className="header-timer">
          <Timer endsAt={slide.endsAt} durationMs={slide.durationMs} />
        </div>
      </div>

      <div className="slide-body">
        <div className="stage">
          {slide.error ? (
            <div className="stage-msg danger">{slide.error}</div>
          ) : slide.bitmap ? (
            <ProtectedCanvas bitmap={slide.bitmap} watermark={me?.name ?? s.name} className="stage-canvas" />
          ) : (
            <div className="stage-msg">Decrypting…</div>
          )}
        </div>

        <Card
          className="guess"
          title={slide.isYours ? 'This is your photo' : 'Whose photo is this?'}
          description={
            slide.isYours
              ? 'You earn 25 points for every player who guesses wrong.'
              : slide.myGuess
                ? 'Your answer is locked in.'
                : 'Faster answers earn up to 50 bonus points.'
          }
        >
          {!slide.isYours && (
            <div className="options" role="radiogroup">
              {slide.options.map((o) => {
                const picked = slide.myGuess === o.id
                return (
                  <button
                    key={o.id}
                    role="radio"
                    aria-checked={picked}
                    className={`option ${picked ? 'picked' : ''}`}
                    disabled={!!slide.myGuess}
                    onClick={() => game.guess(o.id)}
                  >
                    <Avatar name={o.name} />
                    <span className="option-name">{o.name}</span>
                    {picked && <Check size={16} strokeWidth={2} aria-hidden />}
                  </button>
                )
              })}
            </div>
          )}
          <div className="guess-foot">
            <span className="muted small">
              {slide.guessed} of {slide.eligible} answered
            </span>
          </div>
        </Card>
      </div>
    </div>
  )
}
