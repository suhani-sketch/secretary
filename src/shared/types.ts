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

/** Calendar event (spec §3 `events`). Timed or all-day; recurring via rrule with per-occurrence exceptions in exdates. */
export interface CalendarEvent {
  id: string
  title: string
  starts_at_utc: string
  ends_at_utc: string | null
  all_day: number
  tz: string
  rrule: string | null
  /** JSON array of excluded occurrence starts (UTC ISO). */
  exdates: string | null
  project_id: string | null
  kind: 'commitment' | 'work_block' | 'session' | null
  plan_id: string | null
  session_state: 'planned' | 'done' | 'missed' | 'moved' | null
  /** For a work block: the obligation it is time set aside for. */
  item_id: string | null
  created_at: string
  updated_at: string
}

/** Multi-day plan (spec §3 `plans`): generates sessions, tracks target effort against done effort. */
export interface Plan {
  id: string
  title: string
  project_id: string | null
  target_minutes: number | null
  starts_on: string
  ends_on: string | null
  rrule: string | null
  session_minutes: number | null
  deadline_item: string | null
  status: 'active' | 'paused' | 'done' | 'abandoned'
  created_at: string
  updated_at: string
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
  /** Calendar (Phase 6): expanded event occurrences in a UTC range (recurring series already unrolled, exceptions applied). */
  listEvents(fromUtc: string, toUtc: string): Promise<EventOccurrence[]>
  /** Everything the secretary knows about one local date, aggregated from the existing records (spec 6a). */
  getDay(dateLocal: string): Promise<DayBundle>
  /** The same Day View Model for a run of dates (Week takes seven, Month up to 42, Agenda a fortnight). */
  getDays(fromDateLocal: string, days: number): Promise<DayBundle[]>
}

/** One occurrence of an event: the series row plus this instance's start/end. `occurrence_start_utc` identifies it in `exdates`. */
export interface EventOccurrence extends CalendarEvent {
  occurrence_start_utc: string
  occurrence_end_utc: string | null
  is_recurring_instance: boolean
  /** For an occurrence that spans several days: how it relates to the date being viewed (spec 6a "multi-day things"). */
  span: 'single' | 'starts' | 'continues' | 'ends'
}

export type DayStatus = 'light' | 'normal' | 'busy' | 'overloaded'

/** A priority entry: the item plus WHY it ranks where it does, so views can show the reason and never a bare colour. */
export interface PriorityEntry {
  item: Item
  score: number
  reasons: string[]
  overdue: boolean
  blocked: boolean
  scheduled: boolean
}

/** Counts computed once, consumed by Month/Week/Agenda (spec 6a "the model exposes a day summary"). */
export interface DaySummary {
  date: string
  is_past: boolean
  is_today: boolean
  priorities: number
  due: number
  scheduled: number
  reminders: number
  overdue: number
  completed: number
  hard_deadlines: number
  high_importance: number
  commitments: number
  scheduled_minutes: number
  due_effort_minutes: number
  available_minutes: number
  conflicts: number
  /** null for past dates — there is nothing to prioritise or load. */
  status: DayStatus | null
}

/**
 * The Day View Model (spec 6a): the complete state of one date, assembled deterministically from existing records with
 * no model call. Day renders it; Week takes seven; Month takes `summary`; Agenda takes them chronologically. Four object
 * kinds stay four shapes: tasks (`unscheduled`), work blocks/events (`scheduled`), reminders, deadlines (items with hardness).
 */
export interface DayBundle {
  date: string
  summary: DaySummary
  /** What matters on this day, ordered. Empty for past dates. Overdue-and-unresolved is always included. */
  priorities: PriorityEntry[]
  /** Time-bound: event occurrences, work blocks, sessions. Spanning items carry `span`. */
  scheduled: EventOccurrence[]
  /** Date-bound obligations due this day with no time set aside for them. Never occupy a slot. */
  unscheduled: Item[]
  /** Open obligations from earlier days, still unresolved, carried in (today and future dates only). */
  overdue: Item[]
  /** Finished on this day — history, never workload. */
  completed: Item[]
  reminders: Reminder[]
  waiting: Item[]
  happenings: Happening[]
  /** Notes attached to the date itself AND notes on the things appearing that day (with what they are on). */
  notes: DayNote[]
  /** Things (projects) that the day's items belong to, for context. */
  projects: { project: Item; open_parts: number; items_today: string[] }[]
  /** Unavailable/prefer/avoid windows touching the day, as concrete windows. */
  constraints: Constraint[]
  /** What happened on this day (activities), newest first — the calendar is a record, not only a plan. */
  history: Activity[]
}

export interface DayNote {
  note: Note
  /** "the date", or the title of the item/event the note is attached to. */
  on: string
  on_kind: 'date' | 'item' | 'event' | 'reminder'
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
  listHappenings: 'happenings:list',
  listEvents: 'events:list',
  getDay: 'calendar:day',
  getDays: 'calendar:days'
} as const
