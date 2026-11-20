import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('octopusDesktop', {
  platform: process.platform,
  electron: process.versions.electron,
  /** 在资源管理器（Finder / 文件管理器）里打开本舱目录；只接受绝对路径。 */
  revealPath: (target: string) => ipcRenderer.invoke('octopus:reveal-path', target),
})
