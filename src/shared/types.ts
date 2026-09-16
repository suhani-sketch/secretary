// Shared contracts between main process, preload and renderer.
// The renderer only ever sees these shapes — never the database or the API key.

export type ItemKind = 'task' | 'deadline' | 'project' | 'waiting' | 'note' | 'commitment' | 'idea' | 'checklist_item'
export type ItemStatus = 'open' | 'in_progress' | 'done' | 'cancelled' | 'blocked' | 'waiting' | 'archived'
export type ReminderState = 'pending' | 'delivered' | 'acknowledged' | 'snoozed' | 'cancelled' | 'paused'
export type DuePrecision = 'exact' | 'day' | 'week' | 'vague'
export type Hardness = 'hard' | 'soft'
export type TargetType = 'item' | 'event' | 'reminder' | 'date' | 'action'
export type Actor = 'user' | 'assistant' | 'system'

export interface Item {
  id: string
  kind: ItemKind
  title: string
  details: string | null
  status: ItemStatus
  due_at_utc: string | null
  due_tz: string | null
  due_precision: DuePrecision | null
  hardness: Hardness | null
  effort_minutes: number | null
  importance: number
  sort_order: number | null
  is_suggestion: number
  confidence: number | null
  waiting_on: string | null
  /** For kind=commitment: who the promise was made to ("I told Priya I'd send the draft tonight"). */
  committed_to: string | null
  source_msg_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface Reminder {
  id: string
  target_type: 'item' | 'event'
  target_id: string
  fire_at_utc: string
  rrule: string | null
  /** For recurring reminders: wall-clock anchor "yyyy-MM-ddTHH:mm" and the IANA zone it was stated in. */
  series_anchor_local: string | null
  series_tz: string | null
  offset_minutes: number | null
  condition_json: string | null
  state: ReminderState
  delivered_at: string | null
  surfaced_count: number
  created_at: string
  // joined for display
  item_title?: string | null
}

/** A note attached to an item, event, reminder, or a bare date ("I'll be travelling Friday"). */
export interface Note {
  id: string
  target_type: 'item' | 'event' | 'reminder' | 'date'
  /** For target_type 'date': an ISO date "yyyy-MM-dd". */
  target_id: string
  body: string
  source: 'user' | 'assistant'
  created_at: string
  updated_at: string
}

/** Availability constraint (spec §3): when the user is unavailable, or prefers/avoids a time. */
export interface Constraint {
  id: string
  kind: 'unavailable' | 'prefer' | 'avoid'
  label: string
  /** UTC window of the (first) occurrence; both null for an all-day-every-day style rule is not allowed. */
  starts_at: string | null
  ends_at: string | null
  /** RRULE body for standing constraints ("every Tuesday 2–5pm"); occurrences repeat the starts_at/ends_at window. */
  rrule: string | null
  source: 'stated' | 'inferred'
  created_at: string
}

/**
 * A living activity (spec §8 Phase 5): something happening in the real world right now — an egg on, a wash running, a
 * focus session. Never an item, never in Open, never history. Separate from `activities` on purpose.
 */
export interface Happening {
  id: string
  label: string
  kind: string | null
  metaphor: 'egg' | 'tea' | 'laundry' | 'plant' | 'download' | 'focus' | null
  started_at: string
  /** Null while open-ended ("I'm showering"). Set to the finish time when it ends. */
  ends_at: string | null
  state: 'running' | 'done' | 'abandoned'
  project_id: string | null
  created_at: string
}

export interface Link {
  from_item: string
  to_item: string
  type: 'part_of' | 'blocks' | 'relates_to' | string
}

export interface Activity {
  id: string
  target_type: TargetType | string
  target_id: string
  project_id: string | null
  verb: string
  actor: Actor
  summary: string
  before_json: string | null
  after_json: string | null
  reversible: number
  created_at: string
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

// ---------- Conversation ----------

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  tier: number | null
  created_at: string
}

/** Ground truth of what the tool executor committed. Shown under the reply. */
export interface AppliedChange {
  /** Small classifier for the personality layer (e.g. a happening's kind, "project" for a finished Thing). Never shown. */
  tag?: string
  tool: string
  /** Terse ground-truth line, e.g. `Created task "Call the bank" · reminder Thu 17 Sep 15:00` */
  summary: string
  /** Warm one-sentence confirmation composed in code from the committed result. */
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

/** Result of a manual (UI-driven) tool run — same tool layer as the model. */
export interface ToolRunResult {
  applied: AppliedChange[]
  error: string | null
  /** The tool declined to act and wants confirmation first (consequential change). */
  confirm: { question: string; wouldAffect: string[] } | null
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

  // Manual editing — same tool layer as the AI (spec hard rule 3)
  runTool(name: string, args: Record<string, unknown>): Promise<ToolRunResult>
  listActivities(limit?: number): Promise<Activity[]>
  /** Last N AI calls (from the scheduler log), for the debug panel. */
  listAiCalls(limit?: number): Promise<SchedulerLogEntry[]>
  /** All part_of / blocks / relates_to links, so the window can show which items belong to which project. */
  listLinks(): Promise<Link[]>
  /** All notes (items, reminders, dates), newest first. */
  listNotes(): Promise<Note[]>
  /** Timeline of one Thing: everything that happened to it or its parts, newest first. */
  activitiesForProject(projectId: string, limit?: number): Promise<Activity[]>
  /** History of one item (task, step, waiting item), newest first. */
  activitiesForItem(itemId: string, limit?: number): Promise<Activity[]>
  /** Availability constraints still in force (one-off ones that have ended are omitted). */
  listConstraints(): Promise<Constraint[]>
  /** Small persistent UI settings (scene choice etc.), stored in the settings table. */
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>
  /** Living activities: everything running now, plus ones that ended in the last few minutes (so the rail can fade them out). */
  listHappenings(): Promise<Happening[]>
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
  chatPrefill: 'chat:prefill',
  runTool: 'tools:run',
  listActivities: 'activities:list',
  listAiCalls: 'ai:calls',
  listLinks: 'links:list',
  listNotes: 'notes:list',
  activitiesForProject: 'activities:project',
  activitiesForItem: 'activities:item',
  listConstraints: 'constraints:list',
  getSetting: 'settings:get',
  setSetting: 'settings:set',
  listHappenings: 'happenings:list'
} as const
