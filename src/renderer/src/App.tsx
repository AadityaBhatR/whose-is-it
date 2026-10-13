import { KeyRound, Lock, ShieldAlert, ShieldCheck, Unlock } from 'lucide-react'
import { useEffect } from 'react'
import { copyText } from './clipboard'
import { LogoMark } from './components/ui'
import { ConnectScreen } from './screens/Connect'
import { HomeScreen } from './screens/Home'
import { LabScreen } from './screens/Lab'
import { LobbyScreen } from './screens/Lobby'
import { ResultsScreen } from './screens/Results'
import { SlideshowScreen } from './screens/Slideshow'
import { UploadScreen } from './screens/Upload'
import { game, useGameState, type State } from './store'

function useGlobalProtections() {
  useEffect(() => {
    const block = (e: Event) => e.preventDefault()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'PrintScreen') {
        copyText('')
        game.toast('Screen capture is blocked in this window.')
      }
    }
    document.addEventListener('contextmenu', block)
    document.addEventListener('dragstart', block)
    window.addEventListener('keyup', onKey)
    return () => {
      document.removeEventListener('contextmenu', block)
      document.removeEventListener('dragstart', block)
      window.removeEventListener('keyup', onKey)
    }
  }, [])
}

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function StatusBar({ s }: { s: State }) {
  const connected = s.conn === 'connected' || s.conn === 'reconnecting'
  const bridge = window.imggame
  const protectedOS = bridge?.isElectron && (bridge.platform === 'win32' || bridge.platform === 'darwin')
  return (
    <div className="status">
      {connected && (
        <span className="status-item" title={s.serverUrl}>
          <span className={`dot ${s.conn === 'connected' ? 'dot-ok' : 'dot-warn'}`} />
          {s.conn === 'connected' ? hostOf(s.serverUrl) : 'Reconnecting'}
        </span>
      )}
      {connected && s.security === 'tls' && (
        <span className="status-item" title="Connection encrypted with TLS">
          <Lock size={13} strokeWidth={1.75} /> TLS
        </span>
      )}
      {connected && s.security === 'insecure' && (
        <span className="status-item warn" title="Use an https:// address for an encrypted connection">
          <Unlock size={13} strokeWidth={1.75} /> Unencrypted link
        </span>
      )}
      {s.lobby && (
        <span className="status-item" title="Images are end-to-end encrypted between players">
          <KeyRound size={13} strokeWidth={1.75} /> End-to-end encrypted
        </span>
      )}
      {protectedOS ? (
        <span className="status-item" title="This window is excluded from screenshots, recordings and screen share">
          <ShieldCheck size={13} strokeWidth={1.75} /> Capture protected
        </span>
      ) : (
        <span className="status-item warn" title="Screen capture can only be blocked in the Windows and macOS app">
          <ShieldAlert size={13} strokeWidth={1.75} /> Capture protection unavailable
        </span>
      )}
    </div>
  )
}

export function App() {
  useGlobalProtections()
  const s = useGameState()

  let screen: JSX.Element
  if (s.lab) screen = <LabScreen />
  else if (s.booting) screen = <div className="boot">Connecting…</div>
  else if (s.conn === 'idle' || s.conn === 'connecting') screen = <ConnectScreen />
  else if (!s.lobby) screen = <HomeScreen />
  else if (s.results || s.lobby.phase === 'results') screen = <ResultsScreen />
  else if (s.lobby.phase === 'upload') screen = <UploadScreen />
  else if (s.lobby.phase === 'slideshow') screen = <SlideshowScreen />
  else screen = <LobbyScreen />

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <LogoMark />
          <span>Whose Is It</span>
        </div>
        <StatusBar s={s} />
      </header>
      <main className="main">
        <div className="container">{screen}</div>
      </main>
      {s.toast && (
        <div key={s.toast.id} className={`toast toast-${s.toast.kind}`} role="status">
          {s.toast.text}
        </div>
      )}
    </div>
  )
}
