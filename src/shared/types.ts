// Shared contracts between main process, preload and renderer.
// The renderer only ever sees these shapes — never the database or the API key.

export type ItemKind = 'task' | 'deadline' | 'project' | 'waiting' | 'note' | 'commitment' | 'idea'
export type ItemStatus = 'open' | 'done' | 'cancelled' | 'archived'
export type ReminderState = 'pending' | 'delivered' | 'acknowledged' | 'snoozed' | 'cancelled'

export interface Item {
  id: string
  kind: ItemKind
  title: string
  details: string | null
  status: ItemStatus
  due_at_utc: string | null
  due_tz: string | null
  due_precision: string | null
  effort_minutes: number | null
  importance: number
  is_suggestion: number
  confidence: number | null
  waiting_on: string | null
  source_msg_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface Reminder {
  id: string
  item_id: string | null
  fire_at_utc: string
  rrule: string | null
  condition_json: string | null
  state: ReminderState
  delivered_at: string | null
  surfaced_count: number
  created_at: string
  // joined for display
  item_title?: string | null
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface SchedulerLogEntry {
  id: number
  at_utc: string
  level: LogLevel
  event: string
  detail: string | null
  reminder_id: string | null
}

export interface CreateItemInput {
  title: string
  /** Local wall-clock time as ISO string without zone (from <input type="datetime-local">), or null. */
  remindAtLocal: string | null
}

export interface AppInfo {
  version: string
  electron: string
  dbPath: string
  appPath: string
  execPath: string
  startedHidden: boolean
  openAtLogin: boolean
  timezone: string
  schedulerIntervalMs: number
}

/** The API exposed to the renderer via contextBridge as window.api */
export interface SecretaryApi {
  listItems(): Promise<Item[]>
  createItem(input: CreateItemInput): Promise<{ item: Item; reminder: Reminder | null }>
  completeItem(id: string): Promise<void>
  listReminders(): Promise<Reminder[]>
  createTestReminder(minutesFromNow: number): Promise<Reminder>
  cancelReminder(id: string): Promise<void>
  listLog(limit?: number): Promise<SchedulerLogEntry[]>
  clearLog(): Promise<void>
  getAppInfo(): Promise<AppInfo>
  setOpenAtLogin(enabled: boolean): Promise<boolean>
  sendTestNotification(): Promise<void>
  /** Subscribe to change events pushed from main; returns an unsubscribe function. */
  onChanged(cb: () => void): () => void
}

export const IPC = {
  listItems: 'items:list',
  createItem: 'items:create',
  completeItem: 'items:complete',
  listReminders: 'reminders:list',
  createTestReminder: 'reminders:createTest',
  cancelReminder: 'reminders:cancel',
  listLog: 'log:list',
  clearLog: 'log:clear',
  getAppInfo: 'app:info',
  setOpenAtLogin: 'app:setOpenAtLogin',
  sendTestNotification: 'app:testNotification',
  changed: 'app:changed'
} as const
