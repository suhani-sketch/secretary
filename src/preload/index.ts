import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type SecretaryApi } from '../shared/types'

// The renderer gets exactly this object and nothing else. No database, no keys, no Node.
const api: SecretaryApi = {
  listItems: () => ipcRenderer.invoke(IPC.listItems),
  createItem: (input) => ipcRenderer.invoke(IPC.createItem, input),
  completeItem: (id) => ipcRenderer.invoke(IPC.completeItem, id),
  listReminders: () => ipcRenderer.invoke(IPC.listReminders),
  createTestReminder: (minutes) => ipcRenderer.invoke(IPC.createTestReminder, minutes),
  cancelReminder: (id) => ipcRenderer.invoke(IPC.cancelReminder, id),
  listLog: (limit) => ipcRenderer.invoke(IPC.listLog, limit),
  clearLog: () => ipcRenderer.invoke(IPC.clearLog),
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke(IPC.setOpenAtLogin, enabled),
  sendTestNotification: () => ipcRenderer.invoke(IPC.sendTestNotification),
  onChanged: (cb) => {
    const handler = (): void => cb()
    ipcRenderer.on(IPC.changed, handler)
    return () => ipcRenderer.removeListener(IPC.changed, handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
