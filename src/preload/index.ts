import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type ChatStatus, type SecretaryApi } from '../shared/types'

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
  },

  sendChat: (text) => ipcRenderer.invoke(IPC.sendChat, text),
  chatHistory: (limit) => ipcRenderer.invoke(IPC.chatHistory, limit),
  listExtractions: (limit) => ipcRenderer.invoke(IPC.listExtractions, limit),
  onChatStatus: (cb) => {
    const handler = (_e: unknown, s: ChatStatus): void => cb(s)
    ipcRenderer.on(IPC.chatStatus, handler)
    return () => ipcRenderer.removeListener(IPC.chatStatus, handler)
  },
  onChatPrefill: (cb) => {
    const handler = (_e: unknown, text: string): void => cb(text)
    ipcRenderer.on(IPC.chatPrefill, handler)
    return () => ipcRenderer.removeListener(IPC.chatPrefill, handler)
  },

  runTool: (name, args) => ipcRenderer.invoke(IPC.runTool, name, args),
  listActivities: (limit) => ipcRenderer.invoke(IPC.listActivities, limit),
  listAiCalls: (limit) => ipcRenderer.invoke(IPC.listAiCalls, limit),
  listLinks: () => ipcRenderer.invoke(IPC.listLinks),
  listNotes: () => ipcRenderer.invoke(IPC.listNotes),
  activitiesForProject: (projectId, limit) => ipcRenderer.invoke(IPC.activitiesForProject, projectId, limit),
  activitiesForItem: (itemId, limit) => ipcRenderer.invoke(IPC.activitiesForItem, itemId, limit),
  listConstraints: () => ipcRenderer.invoke(IPC.listConstraints),
  getSetting: (key) => ipcRenderer.invoke(IPC.getSetting, key),
  setSetting: (key, value) => ipcRenderer.invoke(IPC.setSetting, key, value),
  listHappenings: () => ipcRenderer.invoke(IPC.listHappenings)
}

contextBridge.exposeInMainWorld('api', api)
