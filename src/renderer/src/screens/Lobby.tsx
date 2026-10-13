import { Check, Copy, LogOut, Play } from 'lucide-react'
import { useState } from 'react'
import { LIMITS } from '../../../shared/protocol'
import { copyText } from '../clipboard'
import { Avatar, Badge, Button, Card, PageHeader } from '../components/ui'
import { game, useGameState } from '../store'
import { SettingsEditor } from './SettingsEditor'

export function Verification({ code }: { code: string | null }) {
  return (
    <div className="verify">
      <div className="verify-row">
        <span className="verify-label">Verification code</span>
        <span className="verify-code mono">{code ?? '…'}</span>
      </div>
      <p className="hint">
        Everyone should see the same four words. A mismatch means someone may be intercepting the encryption.
      </p>
    </div>
  )
}

export function LobbyScreen() {
  const s = useGameState()
  const lobby = s.lobby!
  const isHost = lobby.hostId === s.me
  const [copied, setCopied] = useState(false)
  const [starting, setStarting] = useState(false)
  const connected = lobby.players.filter((p) => p.connected).length
  const canStart = connected >= LIMITS.minPlayersToStart

  const copy = async () => {
    const ok = await copyText(lobby.code)
    if (!ok) return game.toast('Could not copy. Select the code and copy it manually.', 'error')
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const start = async () => {
    setStarting(true)
    const err = await game.start()
    setStarting(false)
    if (err) game.toast(err, 'error')
  }

  return (
    <div className="page">
      <PageHeader
        title={lobby.name}
        subtitle={isHost ? 'Share the lobby code with the people you want to play with.' : 'Waiting for the host to start the game.'}
        actions={
          <div className="code-box">
            <div>
              <span className="code-box-label">Lobby code</span>
              <span className="code-box-value mono">{lobby.code}</span>
            </div>
            <Button icon={copied ? Check : Copy} onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        }
      />

      <div className="layout-2">
        <Card
          title="Players"
          actions={
            <span className="muted small">
              {lobby.players.length} of {lobby.settings.maxPlayers}
            </span>
          }
          padded={false}
        >
          <ul className="list">
            {lobby.players.map((p) => (
              <li key={p.id} className={p.connected ? '' : 'is-muted'}>
                <Avatar name={p.name} muted={!p.connected} />
                <span className="list-main">
                  {p.name}
                  {p.id === s.me && <span className="muted"> (you)</span>}
                </span>
                {!p.connected && <Badge tone="warn">Reconnecting</Badge>}
                {p.isHost && <Badge>Host</Badge>}
                {isHost && p.id !== s.me && (
                  <Button size="sm" variant="ghost" onClick={() => game.kick(p.id)}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <div className="card-section">
            <Verification code={s.safety} />
          </div>
        </Card>

        <Card title="Game settings" description={isHost ? undefined : 'Only the host can change these.'}>
          <div className="stack">
            <SettingsEditor
              value={lobby.settings}
              disabled={!isHost}
              minPlayers={lobby.players.length}
              onChange={(v) => game.updateSettings(v)}
            />
            <div className="divider" />
            <div>
              <h4 className="subhead">How scoring works</h4>
              <ul className="rules">
                <li>Each photo is scrambled with one of four filters. Harder filters are worth more.</li>
                <li>Correct guesses earn the filter's points plus up to 50 for speed.</li>
                <li>You earn 25 for each player who guesses wrong on your photo.</li>
                <li>Answers are revealed at the end. Images are deleted after each slide.</li>
              </ul>
            </div>
          </div>
        </Card>
      </div>

      <div className="footer-bar">
        <Button variant="ghost" icon={LogOut} onClick={() => game.leave()}>
          Leave lobby
        </Button>
        {isHost && (
          <div className="row">
            {!canStart && <span className="muted small">At least {LIMITS.minPlayersToStart} players are required.</span>}
            <Button variant="primary" size="lg" icon={Play} disabled={!canStart || starting} onClick={start}>
              {starting ? 'Starting…' : 'Start game'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
