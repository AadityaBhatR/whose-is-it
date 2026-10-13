import { LogOut, RotateCcw } from 'lucide-react'
import { TierLabel } from '../components/TierLabel'
import { Avatar, Button, Card, Notice, PageHeader } from '../components/ui'
import { game, useGameState } from '../store'

const ordinal = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`

export function ResultsScreen() {
  const s = useGameState()
  const lobby = s.lobby
  const r = s.results
  const isHost = lobby?.hostId === s.me

  if (!r) return <div className="boot">Loading results…</div>

  const top = r.standings.slice(0, 3)

  return (
    <div className="page">
      <PageHeader title="Results" subtitle={lobby?.name} />

      {r.reveals.length === 0 ? (
        <Notice>Not enough players submitted photos to play a round.</Notice>
      ) : (
        <div className="leaders">
          {top.map((p) => (
            <div key={p.id} className={`leader ${p.rank === 1 ? 'first' : ''} ${p.id === s.me ? 'me' : ''}`}>
              <span className="leader-rank">{ordinal(p.rank)}</span>
              <div className="leader-who">
                <Avatar name={p.name} />
                <span className="leader-name">{p.name}</span>
              </div>
              <span className="leader-score">
                {p.score.toLocaleString()} <span className="muted">pts</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="layout-2">
        <Card title="Scoreboard" padded={false}>
          <table className="table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Player</th>
                <th className="num">Correct</th>
                <th className="num">Fooled</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {r.standings.map((p) => (
                <tr key={p.id} className={p.id === s.me ? 'is-me' : ''}>
                  <td className="num muted">{p.rank}</td>
                  <td className="strong">
                    {p.name}
                    {p.id === s.me && <span className="muted"> (you)</span>}
                  </td>
                  <td className="num">{p.correct}</td>
                  <td className="num">{p.fooled}</td>
                  <td className="num strong">{p.score.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Answers" description="Images are not shown. They were deleted during the game." padded={false}>
          <ul className="list answers">
            {r.reveals.map((rv) => (
              <li key={rv.index}>
                <span className="answer-num muted">{rv.index + 1}</span>
                <div className="answer-main">
                  <div>
                    <span className="strong">{rv.ownerId === s.me ? 'Your photo' : `${rv.ownerName}'s photo`}</span>
                  </div>
                  <span className="muted small">
                    {rv.correctGuessers.length ? `Correct: ${rv.correctGuessers.join(', ')}` : 'Nobody guessed correctly'}
                    {rv.wrongGuesses > 0 && ` · ${rv.wrongGuesses} fooled`}
                  </span>
                </div>
                <TierLabel tier={rv.tier} />
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="footer-bar">
        <Button variant="ghost" icon={LogOut} onClick={() => game.leave()}>
          Leave lobby
        </Button>
        {isHost ? (
          <Button variant="primary" size="lg" icon={RotateCcw} onClick={() => game.playAgain()}>
            Play again
          </Button>
        ) : (
          <span className="muted small">Waiting for the host to start another round.</span>
        )}
      </div>
    </div>
  )
}
