import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('octopusDesktop', {
  platform: process.platform,
  electron: process.versions.electron,
})
