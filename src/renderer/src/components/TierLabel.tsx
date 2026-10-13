import { TIER_INFO, type Tier } from '../../../shared/protocol'

export function TierLabel({ tier }: { tier: Tier }) {
  const t = TIER_INFO[tier]
  return (
    <span className={`tier tier-${tier}`}>
      <span className="tier-bars" aria-hidden>
        {[1, 2, 3, 4].map((n) => (
          <i key={n} className={n <= tier ? 'on' : ''} />
        ))}
      </span>
      {t.name}
      <span className="tier-pts">{t.points} pts</span>
    </span>
  )
}
