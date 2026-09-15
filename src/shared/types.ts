// Shared contracts between main process, preload and renderer.
// The renderer only ever sees these shapes — never the database or the API key.

export type ItemKind = 'task' | 'deadline' | 'project' | 'waiting' | 'note' | 'commitment' | 'idea'
export type ItemStatus = 'open' | 'done' | 'cancelled' | 'archived'
export type ReminderState = 'pending' | 'delivered' | 'acknowledged' | 'snoozed' | 'cancelled'
export type DuePrecision = 'exact' | 'day' | 'week' | 'vague'

export interface Item {
  id: string
  kind: ItemKind
  title: string
  details: string | null
  status: ItemStatus
  due_at_utc: string | null
  due_tz: string | null
  due_precision: DuePrecision | null
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

// ---------- Conversation (Phase 1) ----------

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  tier: number | null
  created_at: string
}

/** Ground truth of what the tool executor committed for one user message. Shown under the reply. */
export interface AppliedChange {
  tool: string
  /** Terse ground-truth line shown under the reply, e.g. `Created task "Call the bank" · reminder Thu 17 Sep 15:00` */
  summary: string
  /** Warm one-sentence confirmation composed in code from the committed result; used as the reply so no second model call is needed. */
  phrase: string
  itemId?: string
  reminderId?: string
}

export interface ChatResponse {
  userMessage: ChatMessage
  assistantMessage: ChatMessage
  applied: AppliedChange[]
  /** Set when the model or a tool failed; the DB is unchanged for that failure. */
  error: string | null
}

export type ChatStatus =
  | { kind: 'idle' }
  | { kind: 'thinking' }
  | { kind: 'tools'; count: number }
  | { kind: 'throttled'; retryInSeconds: number }

export interface ExtractionEntry {
  id: string
  message_id: string | null
  tools_json: string
  applied: number
  error: string | null
  created_at: string
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
  /** Which AI provider/model is configured, and whether a key was found (never the key itself). */
  ai: { provider: string; model: string; hasKey: boolean }
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

  // Conversation
  sendChat(text: string): Promise<ChatResponse>
  chatHistory(limit?: number): Promise<ChatMessage[]>
  listExtractions(limit?: number): Promise<ExtractionEntry[]>
  onChatStatus(cb: (status: ChatStatus) => void): () => void
  /** Main asks the renderer to put text in the input box (e.g. "Reschedule" from a toast button). */
  onChatPrefill(cb: (text: string) => void): () => void
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
  changed: 'app:changed',
  sendChat: 'chat:send',
  chatHistory: 'chat:history',
  listExtractions: 'chat:extractions',
  chatStatus: 'chat:status',
  chatPrefill: 'chat:prefill'
} as const
