/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_SERVER?: string
}

interface HostStatus {
  enabled: boolean
  running: boolean
  localUrl: string
  error: string | null
}

interface Window {
  imggame?: {
    isElectron: boolean
    platform: string
    getConfig: () => Promise<{ defaultServer: string; defaultName: string; instance: number; host: HostStatus }>
    copyText: (text: string) => Promise<boolean>
    setHosting: (on: boolean) => Promise<HostStatus>
  }
}
