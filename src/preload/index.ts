import { contextBridge, ipcRenderer } from 'electron'

// Minimal bridge. The renderer gets no Node access.
contextBridge.exposeInMainWorld('imggame', {
  isElectron: true,
  platform: process.platform,
  getConfig: () => ipcRenderer.invoke('config:get'),
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write', text),
  setHosting: (on: boolean) => ipcRenderer.invoke('host:set', on)
})
