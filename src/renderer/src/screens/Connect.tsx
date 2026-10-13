import { useState } from 'react'
import { LIMITS } from '../../../shared/protocol'
import { Button, Field, LogoMark, Notice } from '../components/ui'
import { classifyUrl, game, useGameState } from '../store'

export function ConnectScreen() {
  const s = useGameState()
  const [name, setName] = useState(s.name)
  const [url, setUrl] = useState(s.serverUrl)
  const [advanced, setAdvanced] = useState(!s.defaultServer)
  const busy = s.conn === 'connecting'
  const target = advanced ? url : s.host?.running ? s.host.localUrl : s.defaultServer || url
  const sec = classifyUrl(/^(https?|wss?):\/\//i.test(target) ? target : `https://${target}`)
  const canGo = name.trim().length > 0 && target.trim().length > 0 && !busy
  const isApp = !!window.imggame?.isElectron

  const submit = () => {
    if (!canGo) return
    if (advanced) game.setServerOverride(url === s.defaultServer ? '' : url)
    game.connect(target, name)
  }

  return (
    <div className="auth">
      <div className="auth-panel">
        <div className="auth-brand">
          <LogoMark size={28} />
          <h1>Whose Is It</h1>
          <p>Upload a photo, see it scrambled, and guess which photo belongs to whom.</p>
        </div>

        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Field label="Display name">
            <input
              autoFocus
              value={name}
              maxLength={LIMITS.nameMax}
              placeholder="How others will see you"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          {advanced && (
            <Field
              label="Server address"
              hint={
                sec === 'tls'
                  ? 'Encrypted connection.'
                  : sec === 'local'
                    ? 'A server running on this computer.'
                    : 'Not encrypted. Use the https:// address provided by the host.'
              }
            >
              <input
                value={url}
                placeholder="https://your-pc.your-tailnet.ts.net"
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
          )}

          {s.connError && <Notice tone="danger">{s.connError}</Notice>}

          <Button variant="primary" size="lg" disabled={!canGo}>
            {busy ? 'Connecting…' : 'Continue'}
          </Button>
        </form>

        <div className="auth-foot">
          {s.defaultServer && (
            <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>
              {advanced ? 'Use the default server' : 'Use a different server'}
            </button>
          )}
          <button type="button" className="link" onClick={() => game.setLab(true)}>
            Preview filters offline
          </button>
        </div>

        {isApp && (
          <div className="host-toggle">
            <label className="check">
              <input
                type="checkbox"
                checked={!!s.host?.enabled}
                onChange={(e) => game.setHosting(e.target.checked)}
              />
              <span>
                <strong>Host the game server on this computer</strong>
                <small>
                  {s.host?.running
                    ? `Running at ${s.host.localUrl}. It starts automatically whenever this app opens.`
                    : 'Only the person hosting needs this. Expose it with Tailscale Funnel (see README).'}
                </small>
              </span>
            </label>
            {s.host?.error && <Notice tone="danger">{s.host.error}</Notice>}
          </div>
        )}
      </div>
    </div>
  )
}
