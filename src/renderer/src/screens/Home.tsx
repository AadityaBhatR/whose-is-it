import { LogIn, Plus, RefreshCw, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, LIMITS, type LobbySettings, type LobbySummary } from '../../../shared/protocol'
import { Button, Card, Empty, Field, Notice, PageHeader } from '../components/ui'
import { game, useGameState } from '../store'
import { SettingsEditor } from './SettingsEditor'

const cleanCode = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, LIMITS.codeLength)

export function HomeScreen() {
  const s = useGameState()
  const [lobbies, setLobbies] = useState<LobbySummary[]>([])
  const [lobbyName, setLobbyName] = useState(`${s.name}'s lobby`)
  const [settings, setSettings] = useState<LobbySettings>(DEFAULT_SETTINGS)
  const [code, setCode] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [pickedCode, setPickedCode] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => game.listLobbies().then(setLobbies), [])
  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [load])

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true)
    setErr(null)
    const e = await fn()
    setBusy(false)
    if (e) setErr(e)
  }

  return (
    <div className="page">
      <PageHeader
        title="Lobbies"
        subtitle={
          <>
            Signed in as <strong>{s.name}</strong>
          </>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => game.setLab(true)}>
              Filter preview
            </Button>
            <Button variant="ghost" onClick={() => game.disconnect()}>
              Sign out
            </Button>
          </>
        }
      />

      {err && <Notice tone="danger">{err}</Notice>}

      <div className="layout-split">
        <Card
          title="Open lobbies"
          description="Joining requires the lobby code from the host."
          actions={<Button variant="ghost" size="sm" icon={RefreshCw} onClick={load} aria-label="Refresh" />}
          padded={false}
        >
          {lobbies.length === 0 ? (
            <Empty icon={Users} title="No open lobbies">
              Create one, or join with a code.
            </Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Lobby</th>
                  <th>Host</th>
                  <th className="num">Players</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lobbies.map((l) => (
                  <tr key={l.id}>
                    <td className="strong">{l.name}</td>
                    <td className="muted">{l.hostName}</td>
                    <td className="num muted">
                      {l.players} / {l.maxPlayers}
                    </td>
                    <td className="right">
                      {picked === l.id ? (
                        <form
                          className="inline-form"
                          onSubmit={(e) => {
                            e.preventDefault()
                            if (pickedCode.length === LIMITS.codeLength) run(() => game.joinLobby(pickedCode, l.id))
                          }}
                        >
                          <input
                            autoFocus
                            className="mono code-sm"
                            value={pickedCode}
                            placeholder="CODE"
                            aria-label="Lobby code"
                            onChange={(e) => setPickedCode(cleanCode(e.target.value))}
                          />
                          <Button size="sm" variant="primary" disabled={busy || pickedCode.length !== LIMITS.codeLength}>
                            Join
                          </Button>
                          <Button size="sm" variant="ghost" type="button" onClick={() => setPicked(null)}>
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => {
                            setPicked(l.id)
                            setPickedCode('')
                          }}
                        >
                          Join
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="stack-lg">
          <Card title="Join with code">
            <form
              className="inline-form wide"
              onSubmit={(e) => {
                e.preventDefault()
                if (code.length === LIMITS.codeLength) run(() => game.joinLobby(code))
              }}
            >
              <input
                className="mono code-input"
                value={code}
                placeholder="ABC123"
                aria-label="Lobby code"
                onChange={(e) => setCode(cleanCode(e.target.value))}
              />
              <Button variant="primary" icon={LogIn} disabled={busy || code.length !== LIMITS.codeLength}>
                Join
              </Button>
            </form>
          </Card>

          <Card title="Create a lobby">
            <div className="stack">
              <Field label="Lobby name">
                <input value={lobbyName} maxLength={LIMITS.lobbyNameMax} onChange={(e) => setLobbyName(e.target.value)} />
              </Field>
              <SettingsEditor value={settings} onChange={setSettings} />
              <Button
                variant="primary"
                icon={Plus}
                disabled={busy}
                onClick={() => run(() => game.createLobby(lobbyName, settings))}
              >
                Create lobby
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
