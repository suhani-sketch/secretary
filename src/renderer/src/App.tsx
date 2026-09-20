import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Activity,
  AppInfo,
  AppliedChange,
  ChatMessage,
  ChatStatus,
  ExtractionEntry,
  Constraint,
  Item,
  Link,
  Note,
  Reminder,
  SchedulerLogEntry,
  ToolRunResult
} from '../../shared/types'
import { Room, type EnvironmentId, type TimeChoice, type Weather } from './Room'
import { useCompanion, type CompanionState, type PersonalityWeights, type Gaze } from './companionState'
import { useCompanionModel } from './companion/model'
import { CompanionRenderer } from './companion/CompanionRenderer'
import { CompanionUtterance } from './companion/CompanionUtterance'
import { pickUtterance, pickTaskReminder, type UtteranceKind } from './companion/utterances'
import { computeCreatureBox, localRect, type Bounds } from './companion/positioning'
import { bandForHour } from './Room'
import { maybeMoment } from './creatureMoments'
import * as React from 'react'
import { ItemEditor, NoteEditor, ReminderEditor } from './Editors'
import { ItemHistory, ProjectView } from './ProjectView'
import { formatClock, formatDue, isOverdue } from '../../shared/format'
import { RightNow } from './Happenings'
import type { Happening } from '../../shared/types'
import { CalendarSurface, type CalendarMode } from './calendar/CalendarSurface'
import { CONSTRAINT_ICON } from './calendar/grammar'
import { ThingsSurface } from './ThingsSurface'
import { SettingsSurface } from './SettingsSurface'

const fmtLocal = (utcIso: string | null): string => (utcIso ? formatClock(utcIso) : '—')

const fmtLogTime = (utcIso: string): string =>
  new Date(utcIso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const levelColor: Record<string, string> = {
  info: 'text-stone-600',
  warn: 'text-amber-700 font-medium',
  error: 'text-red-700 font-semibold'
}

type Surface = 'conversation' | 'calendar' | 'things' | 'settings'
type UiMessage = ChatMessage & { applied?: AppliedChange[]; error?: string | null; pending?: boolean; proactive?: boolean }

/**
 * Voice (spec §8 Phase 7 "Voice"): the browser's recorder only produces webm/opus in this app (Electron/Chromium), but
 * Gemini's officially supported audio types do not include it — so the recording is decoded and re-encoded as a plain
 * 16-bit PCM WAV entirely client-side (Web Audio API), which IS supported, before it ever reaches the main process.
 */
async function blobToWavBase64(blob: Blob): Promise<{ base64: string; mimeType: string }> {
  const AudioCtxCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new AudioCtxCtor()
  let audioBuf: AudioBuffer
  try {
    audioBuf = await ctx.decodeAudioData(await blob.arrayBuffer())
  } finally {
    void ctx.close()
  }
  const length = audioBuf.length
  const channels: Float32Array[] = []
  for (let c = 0; c < audioBuf.numberOfChannels; c++) channels.push(audioBuf.getChannelData(c))
  const mono = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    let sum = 0
    for (const ch of channels) sum += ch[i]
    mono[i] = sum / channels.length
  }
  const bytesPerSample = 2
  const dataSize = length * bytesPerSample
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono — speech doesn't need stereo
  view.setUint32(24, audioBuf.sampleRate, true)
  view.setUint32(28, audioBuf.sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return { base64: btoa(binary), mimeType: 'audio/wav' }
}
type Editing =
  | { kind: 'item'; item: Item }
  | { kind: 'reminder'; reminder: Reminder }
  | { kind: 'note'; note: Note }
  | { kind: 'project'; project: Item; tab?: 'overview' | 'timeline' }
  | { kind: 'history'; item: Item }
  | null

export default function App(): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  const [links, setLinks] = useState<Link[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [constraints, setConstraints] = useState<Constraint[]>([])
  const [happenings, setHappenings] = useState<Happening[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [logs, setLogs] = useState<SchedulerLogEntry[]>([])
  const [aiCalls, setAiCalls] = useState<SchedulerLogEntry[]>([])
  const [activities, setActivities] = useState<Activity[]>([])
  const [extractions, setExtractions] = useState<ExtractionEntry[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<ChatStatus>({ kind: 'idle' })
  const [showDebug, setShowDebug] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [flashSeq, setFlashSeq] = useState(0)
  const [editing, setEditing] = useState<Editing>(null)
  // Micro-interactions (9i): the id of anything mid-"completing" — held visible, faded and struck through, for one
  // beat before the underlying complete_item/resolve_waiting call actually lands, so ticking something off reads as
  // an action with a result rather than an instant, silent disappearance.
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set())
  // Voice (7a): a mic button beside Send. Recording state is local UI only; the actual send reuses `status` (pushed
  // from main over the same onChatStatus channel as typed messages), so the "thinking…" indicator behaves identically.
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const recordStreamRef = useRef<MediaStream | null>(null)
  const recordTimerRef = useRef<number | null>(null)
  // Light / dark: one setting (`ui.theme`), applied as data-theme on <html>; the stylesheet does the rest.
  const [theme, setThemeState] = useState<'light' | 'dark'>(() => {
    try {
      const t = localStorage.getItem('ui.theme')
      return t === 'dark' ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  })
  const setTheme = (t: 'light' | 'dark', persist = true): void => {
    setThemeState(t)
    document.documentElement.dataset['theme'] = t
    try {
      localStorage.setItem('ui.theme', t)
    } catch {
      /* ignore */
    }
    if (persist) void window.api.setSetting('ui.theme', t)
  }
  // Calendar (Phase 6): a secondary view over the same records; conversation stays home.
  const [surface, setSurface] = useState<Surface>('conversation')
  const [calMode, setCalMode] = useState<CalendarMode>(() => {
    // Dev hook: "#calendar:2026-09-17,mode:week" opens the calendar in that mode.
    const m = /(?:^|,)mode:(month|week|day|agenda)/.exec(window.location.hash)?.[1]
    return (m as CalendarMode | undefined) ?? 'day'
  })
  const [calDate, setCalDate] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [refreshKey, setRefreshKey] = useState(0)
  // Week start (spec 6a): Monday by default, a setting, never hard-coded in views.
  const [weekStart, setWeekStart] = useState(1)
  useEffect(() => {
    void window.api.getSetting('calendar.weekStart').then((v) => v !== null && setWeekStart(Number(v)))
  }, [])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ---- Companion signals (Phase 4): derived from what the app is really doing ----
  const [lastToolNames, setLastToolNames] = useState<string[]>([])
  const [lastAppliedAt, setLastAppliedAt] = useState(0)
  const [celebrateAt, setCelebrateAt] = useState(0)
  const [quietlyExcitedAt, setQuietlyExcitedAt] = useState(0)
  const [pettedAt, setPettedAt] = useState(0)
  const [greetAt, setGreetAt] = useState(0)
  const [addressedAt, setAddressedAt] = useState(0)
  const [concernedAt, setConcernedAt] = useState(0)
  // Care surface (reshape "user can care FOR the creature"): four direct-address triggers the user can raise
  // conversationally. They move the creature; they never create tasks, reminders, or happenings (invariant 9).
  const [careSitAt, setCareSitAt] = useState(0)
  const [careSleepAt, setCareSleepAt] = useState(0)
  const [careTeaAt, setCareTeaAt] = useState(0)
  const [careLookAt, setCareLookAt] = useState(0)
  // Companion state — personality, roaming, spot persistence, awareness — is now owned by useCompanionModel
  // (renderer/companion/model.ts). See the pass description in that file. This block used to hold a scattered
  // set of state hooks and timer effects; they now live inside the model. App feeds AwarenessEvents into
  // companion.notice(), and reads companion.state / companion.gaze / companion.roamingIdx / etc.
  // Phase 2 (2026-09-19): the Companion is rendered at app level, not inside the world panel. Refs measure
  // the merged Conversation window and the world aside inside it; the world's local rect + the resolved
  // spot from Room feed positioning.ts to place her absolutely against the merged window.
  const windowRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLElement>(null)
  const [resolvedSpot, setResolvedSpot] = useState<{ x: number; y: number; scale: number; gaze: Gaze } | null>(null)
  const [worldLocal, setWorldLocal] = useState<Bounds | null>(null)
  // Creature-voice pass (2026-09-19): small floating utterances the creature murmurs beside her body — the
  // "Victorian aside". Distinct from chat proactive lines. Fires on time-of-day triggers (morning + dusk) and
  // on user-caused moments (petting, completion). One utterance at a time, auto-clears after 8s.
  const [utteranceText, setUtteranceText] = useState<string | null>(null)
  const lastUtteranceAtRef = useRef<number>(0)
  // Bubbles now persist until the user clicks them (per user request). No auto-timeouts anywhere. The
  // user dismisses by clicking the cloud; new utterances replace the current one immediately.
  const sayUtterance = useCallback((text: string) => {
    setUtteranceText(text)
    lastUtteranceAtRef.current = Date.now()
  }, [])
  // Utterance dispatcher — Phase 4 (2026-09-19). Prefers the GENERATIVE Victorian voice via Gemini so every
  // line is fresh and specifically aware of state. If the daily budget is exhausted, provider is offline,
  // or the call errors, falls back to the static utterance pool (utterances.ts) so she is never silent for
  // architectural reasons. Rate-limited by shared minimum gap so she doesn't chatter.
  const utterKind = useCallback((kind: UtteranceKind, opts: { forceIgnoreGap?: boolean } = {}) => {
    const now = Date.now()
    const MIN_GAP_MS = 90_000
    if (!opts.forceIgnoreGap && now - lastUtteranceAtRef.current < MIN_GAP_MS) return
    if (utteranceText !== null && !opts.forceIgnoreGap) return
    // Build context from the current app state.
    const heavy = overwhelmedRef.current
    const overdue = overdueRef.current
    const overdueTitles = overdue.slice(0, 3).map((i) => i.title)
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
    const recentDone = itemsRef.current.filter((it) => {
      if (it.status !== 'done') return false
      const doneAt = it.completed_at ? Date.parse(it.completed_at) : NaN
      return !Number.isNaN(doneAt) && doneAt > weekAgo
    })
    const ctx = {
      kindHint: kind,
      timeBand: bandForHour(new Date().getHours()),
      hour: new Date().getHours(),
      overdueCount: overdue.length,
      overdueTitles,
      recentlyDoneCount: recentDone.length,
      recentlyDoneTitles: recentDone.slice(0, 3).map((i) => i.title),
      overwhelmed: heavy,
      creatureName: creatureNameRef.current,
      weekdayName: new Date().toLocaleDateString(undefined, { weekday: 'long' }),
      messageCountLastHour: 0
    }
    const usePool = (): void => {
      const today = new Date().toISOString().slice(0, 10)
      const key = `utterance.pool.${kind}.${today}`
      let usedIdx = new Set<number>()
      try {
        const raw = localStorage.getItem(key)
        if (raw) usedIdx = new Set(JSON.parse(raw) as number[])
      } catch { /* ignore */ }
      const picked = pickUtterance(kind, usedIdx)
      if (!picked) return
      usedIdx.add(picked.index)
      try { localStorage.setItem(key, JSON.stringify(Array.from(usedIdx))) } catch { /* ignore */ }
      sayUtterance(picked.text)
    }
    // Attempt generative first; if it fails or returns null, fall through to pool.
    void window.api.companionGenerateUtterance(ctx).then((res) => {
      if (res && res.text && typeof res.text === 'string') {
        sayUtterance(res.text)
      } else {
        usePool()
      }
    }).catch(() => usePool())
  }, [sayUtterance, utteranceText])
  // Lamp-lit ambience (2026-09-19): the user can light the lamp at dusk; a warm glow washes the whole app.
  // Stored per-session in memory only — a fresh day, a fresh dusk, a fresh lighting of the lamp.
  const [lampOn, setLampOn] = useState(false)
  // Curtains — drawn closed at morning until the user clicks them to swing open (daylight streams in).
  const [curtainsOpen, setCurtainsOpen] = useState(true)
  // First-run onboarding — a chained sequence of introduction bubbles the first time the app opens. Each
  // waits for the user to dismiss the previous one. Persists a "completed" flag in localStorage so it
  // never runs a second time.
  const onboardingQueueRef = useRef<string[]>([])
  const onboardingActiveRef = useRef(false)
  const startOnboarding = useCallback((): void => {
    if (onboardingActiveRef.current) return
    let done = false
    try { done = localStorage.getItem('onboarding.completed') === '1' } catch { /* no storage */ }
    if (done) return
    onboardingActiveRef.current = true
    onboardingQueueRef.current = [
      'Welcome, my dearest chiku. I am babe, your constant companion. I shall be here whenever you need me, and often when you do not, I am afraid.',
      'You may address me by name at any time. Begin a message with "babe," and I shall reply as your friend rather than through your Secretary.',
      'Should you wish to hear my thoughts on demand, a small double-click upon me will summon a bubble. Otherwise I shall speak when the moment feels right.',
      'Do notice the lamp beside my chair. A gentle click will kindle it, and a warm glow shall spread across the whole page. Extinguish it likewise.',
      'The curtains, too, will draw and part at your touch. When they are open, daylight streams into the study. When drawn, we are cocooned.',
      'Small poems, gentle reminders, warm words for hard days: these I shall provide freely. That is all, chiku. Welcome home.'
    ]
  }, [])
  const advanceOnboarding = useCallback((): void => {
    if (!onboardingActiveRef.current) return
    const next = onboardingQueueRef.current.shift()
    if (next) {
      setUtteranceText(next)
      lastUtteranceAtRef.current = Date.now()
    } else {
      onboardingActiveRef.current = false
      try { localStorage.setItem('onboarding.completed', '1') } catch { /* ignore */ }
    }
  }, [])
  useEffect(() => {
    startOnboarding()
    // First bubble lands ~3 seconds after app opens so she settles at her spot first.
    const t = window.setTimeout(() => advanceOnboarding(), 3000)
    return () => window.clearTimeout(t)
  }, [startOnboarding, advanceOnboarding])
  useEffect(() => {
    const win = windowRef.current
    const world = worldRef.current
    if (!win || !world) return
    const remeasure = (): void => {
      setWorldLocal(localRect(world.getBoundingClientRect(), win.getBoundingClientRect()))
    }
    remeasure()
    const ro = new ResizeObserver(remeasure)
    ro.observe(win)
    ro.observe(world)
    // Also remeasure on window resize since parent grid tracks depend on viewport width.
    window.addEventListener('resize', remeasure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', remeasure)
    }
  }, [surface])
  // Return-from-away (reshape): a persistent 'closed at' marker in localStorage. If the gap is > 12h, the creature
  // greets on next open. Written on every unload; missing on first launch means no greeting.
  const [returnFromAway, setReturnFromAway] = useState(false)
  // Creature-presence pass: main fires a "noticing" pulse ~1s before a proactive message push, so the creature
  // visibly turns attentive first and the sequence "notice → speak → linger → return" reads as causality.
  const [proactiveNoticeAt, setProactiveNoticeAt] = useState(0)
  const [typingAt, setTypingAt] = useState(0)
  const [hour, setHour] = useState(new Date().getHours())
  // ---- Creature voice — all triggers ----
  // Anchor utterances: morning-curtains and evening-lamp. These are specific prompts tied to an actual UI
  // interaction, so they use hard-coded lines (not pooled) and fire at most once per day per band.
  useEffect(() => {
    const band = bandForHour(hour)
    if (band !== 'morning' && band !== 'evening') return
    const today = new Date().toISOString().slice(0, 10)
    const key = `utterance.anchor.${band}.${today}`
    let done = false
    try { done = localStorage.getItem(key) === '1' } catch { /* no storage */ }
    if (done) return
    if (band === 'evening' && lampOn) return
    if (band === 'morning' && !curtainsOpen) return
    const t = window.setTimeout(() => {
      if (band === 'morning') {
        setCurtainsOpen(false)
        sayUtterance('Good morrow — the day awaits. Might we draw back the curtains?')
      } else {
        sayUtterance('Twilight descends upon us. Perhaps you would kindle the lamp?')
      }
      try { localStorage.setItem(key, '1') } catch { /* ignore */ }
    }, 8000)
    return () => window.clearTimeout(t)
  }, [hour, sayUtterance, lampOn, curtainsOpen])
  // Welcome-back utterance: fires on mount when the user has been away >2h (using the same localStorage
  // marker returnFromAway uses). One-shot, ~4s after mount so she's had a moment to settle in her spot.
  useEffect(() => {
    let raw: string | null = null
    try { raw = localStorage.getItem('creature.last_close') } catch { /* ignore */ }
    if (!raw) return
    const then = Date.parse(raw)
    if (Number.isNaN(then)) return
    const gapMs = Date.now() - then
    if (gapMs < 2 * 3600 * 1000) return
    const t = window.setTimeout(() => utterKind('welcome_back', { forceIgnoreGap: true }), 4000)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Overdue comfort: if there are 3+ overdue items on mount and again periodically, she offers a warm word.
  // At most one comfort line per 4 hours per session; the pool itself is small so exhaustion silences her
  // naturally for the day. Uses overwhelmedRef so it never has to depend on `overdueItems` (which is declared
  // later in the component); the ref is synced by a small effect placed after that declaration.
  const lastOverdueComfortAtRef = useRef<number>(0)
  useEffect(() => {
    const check = (): void => {
      if (!overwhelmedRef.current) return
      const now = Date.now()
      if (now - lastOverdueComfortAtRef.current < 4 * 3600 * 1000) return
      utterKind('overdue_comfort')
      lastOverdueComfortAtRef.current = Date.now()
    }
    const t = window.setTimeout(check, 6000)
    // Re-check periodically so newly-arrived overdues can trigger even after mount.
    const iv = window.setInterval(check, 5 * 60_000)
    return () => { window.clearTimeout(t); window.clearInterval(iv) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Rotating time-of-day utterances beyond the two anchors — soft afternoon poems and late-night worries.
  // Once per day per band, offset randomly within the band so it's not clockwork.
  useEffect(() => {
    const band = bandForHour(hour)
    if (band !== 'afternoon' && band !== 'night') return
    // Note: bandForHour returns 'morning' | 'day' | 'evening' | 'night'. 'day' covers 11-17 (our "afternoon"
    // pool) — remap for the pool key.
    const kind: UtteranceKind = band === 'night' ? 'night' : 'afternoon'
    const today = new Date().toISOString().slice(0, 10)
    const key = `utterance.tod.${kind}.${today}`
    let done = false
    try { done = localStorage.getItem(key) === '1' } catch { /* ignore */ }
    if (done) return
    // Fire once, 3-8 minutes after entering the band, so multiple bands during a session all get a chance.
    const delayMs = (3 + Math.random() * 5) * 60_000
    const t = window.setTimeout(() => {
      utterKind(kind)
      try { localStorage.setItem(key, '1') } catch { /* ignore */ }
    }, delayMs)
    return () => window.clearTimeout(t)
  }, [hour, utterKind])
  // Idle-observation rotation. On an ordinary day: every 3–6 minutes, 55% chance to speak, mostly
  // observations / book asides / occasional love / rare poems. On an OVERWHELMED day (3+ overdue OR the
  // user's stated low-energy context): rotation TIGHTENS — every 90s–3min, 75% chance — and the pool
  // biases hard toward comfort / love / achievement-reminder. She leans in when it's hard, not away.
  // A poem is always rare and gets a longer hold so it can be read.
  const overwhelmedRef = useRef(false)
  // Refs synced in place after their sources are declared (temporal-dead-zone workaround so effects placed
  // higher in the component can still read the current values via ref.current).
  const itemsRef = useRef<Item[]>([])
  const overdueRef = useRef<Item[]>([])
  const creatureNameRef = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const tick = (): void => {
      if (cancelled) return
      const heavy = overwhelmedRef.current
      const speakChance = heavy ? 0.78 : 0.55
      if (Math.random() < speakChance) {
        const r = Math.random()
        let kind: UtteranceKind
        if (heavy) {
          // Heavy-day mix: comfort dominant, love + achievement close behind, some observation, rare poem.
          if (r < 0.35) kind = 'overwhelmed_comfort'
          else if (r < 0.60) kind = 'love'
          else if (r < 0.78) kind = 'overdue_comfort'
          else if (r < 0.90) kind = 'idle_observation'
          else kind = 'poem'
        } else {
          // Ordinary-day mix: observations + book, occasional love, rare poem.
          if (r < 0.55) kind = 'idle_observation'
          else if (r < 0.72) kind = 'book_aside'
          else if (r < 0.87) kind = 'love'
          else if (r < 0.95) kind = 'poem'
          else kind = 'idle_observation'
        }
        utterKind(kind)
      }
      const heavyPace = overwhelmedRef.current
      const nextMs = heavyPace
        ? (1.5 + Math.random() * 1.5) * 60_000    // 90s-3min when overwhelmed
        : (3 + Math.random() * 3) * 60_000        // 3-6min otherwise
      window.setTimeout(tick, nextMs)
    }
    const first = window.setTimeout(tick, (2 + Math.random() * 3) * 60_000)
    return () => {
      cancelled = true
      window.clearTimeout(first)
    }
  }, [utterKind])
  // Task-reminder rotation — she gently names a real overdue item by title, roughly every 8–15 minutes.
  // Reads the current overdue list from the ref; picks one at random; substitutes it into a Victorian
  // template. If nothing is overdue, she says nothing. She NEVER scolds; the templates are worded as a
  // friend's tender nudge.
  useEffect(() => {
    let cancelled = false
    const tick = (): void => {
      if (cancelled) return
      const overdue = overdueRef.current
      if (overdue.length > 0) {
        const heavy = overwhelmedRef.current
        // On heavy days, fire more often. On light days, gentle occasional nudge.
        if (Math.random() < (heavy ? 0.7 : 0.45)) {
          const pick = overdue[Math.floor(Math.random() * overdue.length)]
          const text = pickTaskReminder(pick.title)
          // Bypass the pool cooldown so task reminders can land even when observations are silent.
          // Do respect the "one bubble at a time" rule though.
          if (utteranceText === null) {
            setUtteranceText(text)
            lastUtteranceAtRef.current = Date.now()
          }
        }
      }
      const nextMs = (overwhelmedRef.current ? 6 : 8 + Math.random() * 7) * 60_000
      window.setTimeout(tick, nextMs)
    }
    // First reminder can come as early as 3 minutes in.
    const first = window.setTimeout(tick, (3 + Math.random() * 3) * 60_000)
    return () => {
      cancelled = true
      window.clearTimeout(first)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Achievement reminder — occasionally she surfaces something the user actually finished recently. Reads
  // real state (items done in the past 7 days) and names one as a small warm ledger entry. Rate-limited by
  // the shared cooldown. When overwhelmed, this fires more eagerly — the mind needs its own achievements
  // named on a hard day, not more of the undone.
  useEffect(() => {
    let cancelled = false
    const tick = (): void => {
      if (cancelled) return
      const heavy = overwhelmedRef.current
      const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
      const recentlyDone = itemsRef.current.filter((it) => {
        if (it.status !== 'done') return false
        const doneAt = it.completed_at ? Date.parse(it.completed_at) : NaN
        return !Number.isNaN(doneAt) && doneAt > weekAgo
      })
      if (recentlyDone.length > 0 && Math.random() < (heavy ? 0.75 : 0.35)) {
        const pick = recentlyDone[Math.floor(Math.random() * recentlyDone.length)]
        const opener = heavy
          ? [
              'And do not forget: you finished "',
              'Consider what you have already done. "',
              'Only yesterday, in a manner of speaking, you completed "',
              'A small ledger for the hard days: you did "'
            ][Math.floor(Math.random() * 4)]
          : [
              'It occurs to me — you finished "',
              'A quiet triumph, remembered: "',
              'One does not forget "'
            ][Math.floor(Math.random() * 3)]
        const closer = heavy
          ? '". That still counts, my dear. Always will.'
          : '". Duly noted, still, in my book.'
        // Bypass the pool machinery; this is a dynamically composed line. No timeout — bubble persists
        // until the user clicks to dismiss it.
        setUtteranceText(opener + pick.title + closer)
        lastUtteranceAtRef.current = Date.now()
      }
      const nextMs = (heavy ? 4 : 8 + Math.random() * 6) * 60_000
      window.setTimeout(tick, nextMs)
    }
    const first = window.setTimeout(tick, (5 + Math.random() * 5) * 60_000)
    return () => {
      cancelled = true
      window.clearTimeout(first)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [environment, setEnvironment] = useState<EnvironmentId>('trees')
  const [timeChoice, setTimeChoice] = useState<TimeChoice>('auto')
  // Room persistence (9g): favourites, rotation and the creature's own name, restored the same way
  // environment/timeOfDay already were — nothing here is new persistence machinery, just more settings.
  const [favorites, setFavorites] = useState<EnvironmentId[]>([])
  const [rotation, setRotation] = useState(false)
  const [creatureName, setCreatureName] = useState<string | null>(null)
  // creatureSeed / personality / initialSpotId / last-spot persistence — all consolidated into
  // useCompanionModel (renderer/companion/model.ts). App builds Signals from real inputs and feeds them in;
  // the Companion decides the rest.
  const prevOverdue = useRef<number | null>(null)
  useEffect(() => {
    const t = setInterval(() => setHour(new Date().getHours()), 30_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    // First open of the day → greeting. Remembered per day in this browser profile only; nothing is scored.
    const today = new Date().toDateString()
    let last: string | null = null
    try {
      last = localStorage.getItem('companion.greeted')
    } catch {
      /* no storage */
    }
    if (last !== today) {
      setGreetAt(Date.now())
      try {
        localStorage.setItem('companion.greeted', today)
      } catch {
        /* ignore */
      }
    }
    // The world panel was widened for the companion-home pass (2026-09-19); legacy 260×900 SVG scenes now sit as
    // a tall narrow strip in the wider box. Library (500×900, designed for this width and holding all the recent
    // illustrated work) is a much better default. If the persisted setting is any legacy scene AND the user has
    // never explicitly picked Library, upgrade the default to library and re-persist so the choice sticks. The
    // scene chip still exposes every other environment for a user who wants to switch back.
    void window.api.getSetting('scene.environment').then((v) => {
      if (v === 'library') { setEnvironment('library'); return }
      if (v && v !== 'trees' && v !== 'rain' && v !== 'coast' && v !== 'winter' && v !== 'fireplace') {
        // Not a known legacy scene — respect whatever it is.
        setEnvironment(v as EnvironmentId)
        return
      }
      setEnvironment('library')
      void window.api.setSetting('scene.environment', 'library')
    })
    void window.api.getSetting('scene.timeOfDay').then((v) => v && setTimeChoice(v as TimeChoice))
    void window.api.getSetting('ui.theme').then((v) => (v === 'dark' || v === 'light') && setTheme(v, false))
    void window.api.getSetting('scene.favorites').then((v) => {
      if (!v) return
      try {
        const arr = JSON.parse(v) as unknown
        if (Array.isArray(arr)) setFavorites(arr.filter((x): x is EnvironmentId => typeof x === 'string'))
      } catch {
        /* ignore a corrupted value — favourites simply start empty again */
      }
    })
    void window.api.getSetting('scene.rotation').then((v) => setRotation(v === '1'))
    void window.api.getSetting('creature.name').then((v) => setCreatureName(v))
    // (creature.seed / creature.personality / companion.last_spot are loaded by useCompanionModel — see
    // renderer/companion/model.ts. Nothing to duplicate here.)
    // Return-from-away (reshape): compare last-close timestamp against now. > 12h → greeting on next open,
    // then rewrite the marker. Missing marker (first ever run) → no greeting; that's what the naming moment is for.
    try {
      const raw = localStorage.getItem('creature.last_close')
      if (raw) {
        const then = Date.parse(raw)
        if (!Number.isNaN(then) && Date.now() - then > 12 * 3600 * 1000) {
          setReturnFromAway(true)
          setGreetAt(Date.now())
          setTimeout(() => setReturnFromAway(false), 8000) // once the greeting has landed, drop back
        }
      }
      const writeMarker = (): void => {
        try {
          localStorage.setItem('creature.last_close', new Date().toISOString())
        } catch {
          /* private mode / storage full — a missing marker just means no greeting next time */
        }
      }
      window.addEventListener('beforeunload', writeMarker)
      // On a hidden window (tray) we may not get beforeunload for a while — a periodic write keeps the marker
      // fresh enough that a real >12h close is unambiguous.
      const marker = setInterval(writeMarker, 5 * 60 * 1000)
      return () => {
        window.removeEventListener('beforeunload', writeMarker)
        clearInterval(marker)
      }
    } catch {
      /* localStorage unavailable — return-from-away simply never fires */
    }
    return undefined
  }, [])
  // Dev hook: "#state:working,light:night,env:rain" forces creature state / light band / environment for screenshots.
  const hashParts = Object.fromEntries(window.location.hash.replace('#', '').split(',').map((p) => p.split(':') as [string, string]))
  const forcedState = (hashParts['state'] as CompanionState | undefined) ?? null
  // Reduced motion (9i): the real signal is the OS/browser media query; ".reduce-motion" on <html> is the single
  // switch every animation/transition in styles.css checks, so nothing here has to know HOW motion got turned off.
  // "#motion:reduce" forces it on for screenshotting the reduced state without touching a real OS accessibility
  // setting (which this app has no business changing on someone's machine for a dev-hook test).
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const forced = hashParts['motion'] === 'reduce'
    const apply = (): void => {
      document.documentElement.classList.toggle('reduce-motion', forced || mq.matches)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (hashParts['light']) setTimeChoice(hashParts['light'] as TimeChoice)
    if (hashParts['env']) setEnvironment(hashParts['env'] as EnvironmentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Dev hook only: "#weather:cloudy" forces the room's weather for a screenshot (real weather is computed fresh
  // from today's date and has no other way to be tested on demand).
  const weatherOverride = hashParts['weather'] as Weather | undefined

  const refresh = useCallback(async () => {
    try {
      const [i, r, l, a, x, ac, act, lk, nt, cs, hp, cn] = await Promise.all([
        window.api.listItems(),
        window.api.listReminders(),
        window.api.listLog(50),
        window.api.getAppInfo(),
        window.api.listExtractions(20),
        window.api.listAiCalls(20),
        window.api.listActivities(40),
        window.api.listLinks(),
        window.api.listNotes(),
        window.api.listConstraints(),
        window.api.listHappenings(),
        // Re-read here too, not only at startup: the naming moment (9g) sets this through a chat exchange, not a
        // settings call, so it can change at any point in the session, not only on load.
        window.api.getSetting('creature.name')
      ])
      setItems(i)
      setLinks(lk)
      setNotes(nt)
      setConstraints(cs)
      setHappenings(hp)
      setReminders(r)
      setLogs(l)
      setInfo(a)
      setExtractions(x)
      setAiCalls(ac)
      setActivities(act)
      setCreatureName(cn)
      setRefreshKey((k) => k + 1)
    } catch (e) {
      setFlash((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void window.api.chatHistory(60).then((h) => setMessages(h))
    const offChanged = window.api.onChanged(() => void refresh())
    const offStatus = window.api.onChatStatus(setStatus)
    const offPrefill = window.api.onChatPrefill((text) => {
      setDraft(text)
      inputRef.current?.focus()
    })
    // Phase 8a: the morning briefing (and anything else main ever inserts outside a normal exchange) arrives here,
    // pushed directly rather than via a chatHistory refetch — appending by id can never race with or duplicate an
    // in-flight send the way overwriting the whole list from a refetch could.
    const offMessageAdded = window.api.onMessageAdded((message) => {
      const tagged = { ...message, proactive: true } as UiMessage
      setMessages((m) => (m.some((x) => x.id === message.id) ? m : [...m, tagged]))
    })
    // Creature-presence pass: the noticing pulse arrives ~1s before the message push. When it lands, the
    // creature's state machine reads proactiveNoticeAt as "look at the user attentively" for ~4.5s — visibly
    // before, during, and briefly after the message renders. If a pulse fires without a following message
    // (main-side failure), the creature harmlessly returns to normal within the same window.
    const offNoticing = window.api.onCreatureNoticing(() => {
      setProactiveNoticeAt(Date.now())
    })
    const t = setInterval(() => void refresh(), 10000)
    return () => {
      offChanged()
      offStatus()
      offPrefill()
      offMessageAdded()
      offNoticing()
      clearInterval(t)
    }
  }, [refresh])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, status])

  // Developer hook: "#project" / "#history" in the URL opens the first Thing's view / first item's history once loaded.
  const [autoOpened, setAutoOpened] = useState(false)
  useEffect(() => {
    if (autoOpened || !info) return
    const hash = window.location.hash.replace('#', '')
    const light = /^light:(\w+)$/.exec(hash)
    if (light) setTimeChoice(light[1] as TimeChoice)
    const th = /(?:^|,)theme:(dark|light)/.exec(hash)
    if (th) setTheme(th[1] as 'dark' | 'light', false)
    if (hash === 'calendar' || hash.startsWith('calendar:')) {
      setSurface('calendar')
      const d = /^calendar:(\d{4}-\d{2}-\d{2})/.exec(hash)
      if (d) setCalDate(d[1])
    } else if (hash === 'project' || hash === 'timeline') {
      const p = items.find((i) => i.kind === 'project' && i.status !== 'archived')
      if (p) setEditing({ kind: 'project', project: p, tab: hash === 'timeline' ? 'timeline' : 'overview' })
    } else if (hash === 'history') {
      setEditing({ kind: 'history', item: items[0] })
    } else if (hash.split(',').includes('things')) {
      setSurface('things')
    } else if (hash.split(',').includes('settings')) {
      setSurface('settings')
    }
    setAutoOpened(true)
  }, [items, info, autoOpened])

  const say = (msg: string): void => {
    setFlash(msg)
    setFlashSeq((n) => n + 1) // a fresh key each time, so consecutive confirmations each get their own entrance (9i)
    setTimeout(() => setFlash(null), 5000)
  }

  /** Manual edits use the same tool layer as the assistant. Notes appear in the conversation as system lines. */
  const runTool = async (name: string, args: Record<string, unknown>): Promise<ToolRunResult> => {
    const res = await window.api.runTool(name, args)
    const history = await window.api.chatHistory(60)
    setMessages((m) => {
      const known = new Set(m.map((x) => x.id))
      return [...m, ...history.filter((h) => !known.has(h.id))]
    })
    void refresh()
    return res
  }

  const quick = async (name: string, args: Record<string, unknown>): Promise<void> => {
    let res = await runTool(name, args)
    if (res.confirm) {
      if (!window.confirm(res.confirm.question)) return
      res = await runTool(name, { ...args, confirmed: true })
    }
    say(res.error ? `Couldn't: ${res.error}` : res.applied.map((a) => a.phrase).join(' '))
  }

  /**
   * Completing something (9i): the row fades and strikes through for one beat BEFORE the tool call actually runs,
   * rather than vanishing the instant the click lands — causality made visible, not just a state flip. Guarded
   * against a double-click re-firing the same completion while its own animation is still playing.
   */
  const completeWithFeedback = (tool: string, id: string, extra: Record<string, unknown> = {}): void => {
    if (completingIds.has(id)) return
    setCompletingIds((s) => new Set(s).add(id))
    // Phase 5: record the completion in Chiku's memory so future generative lines can reference her rhythm.
    const finishedItem = itemsRef.current.find((it) => it.id === id)
    if (finishedItem) {
      void window.api.companionMemoryCompletion(finishedItem.title).catch(() => { /* best effort */ })
    }
    setTimeout(() => {
      void quick(tool, { id, ...extra })
      setCompletingIds((s) => {
        if (!s.has(id)) return s
        const n = new Set(s)
        n.delete(id)
        return n
      })
      utterKind('task_complete')
    }, 260)
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || status.kind !== 'idle') return
    setDraft('')
    // Phase 6 (2026-09-19): if the user addressed the creature by name (whatever creatureName is set to,
    // e.g. "babe"), divert to her conversation route. Secretary tool pipeline is skipped; the creature
    // replies as a thought bubble instead of a chat message.
    const nameForAddress = (creatureNameRef.current || 'babe').trim()
    const addressRe = new RegExp(`^\\s*(hey\\s+)?${nameForAddress}\\b[\\s,:.!?]*`, 'i')
    if (nameForAddress && addressRe.test(text)) {
      // She's being addressed by name — mark it so her state machine turns attentive and gazes at the user
      // for a few seconds before the reply lands, so it feels like she looked up at you first.
      setAddressedAt(Date.now())
      setProactiveNoticeAt(Date.now())
      const heavy = overwhelmedRef.current
      const overdue = overdueRef.current
      const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
      const recentDone = itemsRef.current.filter((it) => {
        if (it.status !== 'done') return false
        const doneAt = it.completed_at ? Date.parse(it.completed_at) : NaN
        return !Number.isNaN(doneAt) && doneAt > weekAgo
      })
      void window.api.companionConverse(text, {
        overdueTitles: overdue.slice(0, 3).map((i) => i.title),
        recentlyDoneTitles: recentDone.slice(0, 3).map((i) => i.title),
        timeBand: bandForHour(new Date().getHours()),
        weekdayName: new Date().toLocaleDateString(undefined, { weekday: 'long' }),
        creatureName: creatureNameRef.current
      }).then((res) => {
        if (res && res.text) sayUtterance(res.text)
      }).catch(() => { /* silent */ })
      return
    }
    const tempId = `tmp-${Date.now()}`
    setMessages((m) => [...m, { id: tempId, role: 'user', content: text, tier: null, created_at: new Date().toISOString(), pending: true }])
    if (/\b(you|your|thanks|thank you|hey|hello|hi|good morning|good night|please)\b/i.test(text)) setAddressedAt(Date.now())
    // Occasional warm reactive murmur when the user speaks. Rate-limited by the shared cooldown so a fast
    // conversation never triggers a stream of asides.
    if (Math.random() < 0.35) utterKind('message_sent')
    // Care surface (reshape): the four "user cares FOR the creature" phrases the state machine listens for. The
    // signal is set client-side BEFORE the send fires, so the creature moves in the same tick the reply comes
    // back — the two systems (router REPLY, companion state) respond to the same phrase and appear as one.
    const low = text.toLowerCase()
    if (/^(?:come )?sit with me|keep me company|stay (?:here|with me)/.test(low)) setCareSitAt(Date.now())
    else if (/^(?:you should |go )?(?:take a nap|sleep|go to sleep|rest)/.test(low)) setCareSleepAt(Date.now())
    else if (/^(?:do you want |want )?(?:some )?tea\??$|^(?:let's )?have tea$/.test(low)) setCareTeaAt(Date.now())
    else if (/^(?:look at |see )(?:this|that|the sky|outside)|^look\.?$/.test(low)) setCareLookAt(Date.now())
    try {
      const res = await window.api.sendChat(text)
      setMessages((m) => [...m.filter((x) => x.id !== tempId), res.userMessage, { ...res.assistantMessage, applied: res.applied, error: res.error }])
      // Feed the creature: what happened, and whether it deserves a small celebration.
      setLastToolNames(res.applied.map((a) => a.tool))
      if (res.applied.length) setLastAppliedAt(Date.now())
      if (res.error) setConcernedAt(Date.now())
      const big = res.applied.some(
        (a) =>
          (a.tool === 'complete_item' && a.itemId && itemById.get(a.itemId)?.kind === 'project') ||
          (a.tool === 'complete_checklist_item' && /last step/.test(a.phrase)) ||
          a.tool === 'archive_project'
      )
      // An ordinary win — a task ticked off, a wait resolved — is worth noticing without the fuss a whole
      // project finishing gets (spec 9b "quietly excited" vs "celebrating").
      const small = !big && res.applied.some((a) => a.tool === 'complete_item' || a.tool === 'complete_checklist_item' || a.tool === 'resolve_waiting')
      if (big) setCelebrateAt(Date.now())
      else if (small) setQuietlyExcitedAt(Date.now())
    } catch (e) {
      setConcernedAt(Date.now())
      setMessages((m) => [
        ...m.filter((x) => x.id !== tempId),
        { id: tempId, role: 'user', content: text, tier: null, created_at: new Date().toISOString() },
        { id: `err-${Date.now()}`, role: 'assistant', content: `Something went wrong on my side: ${(e as Error).message}`, tier: null, created_at: new Date().toISOString(), error: (e as Error).message }
      ])
    }
    void refresh()
  }

  // Voice (7a): press to start, press again to stop and send; the recording is decoded to WAV and handed to the exact
  // same extraction pipeline as a typed brain dump (`window.api.sendVoice` → `enqueueVoice` in the main process).
  const startRecording = async (): Promise<void> => {
    if (recording || status.kind !== 'idle') return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recordStreamRef.current = stream
      recordedChunksRef.current = []
      const mr = new MediaRecorder(stream)
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data)
      }
      mr.start()
      mediaRecorderRef.current = mr
      setRecording(true)
      setRecordSeconds(0)
      recordTimerRef.current = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000)
    } catch (e) {
      say(`Couldn't use the microphone: ${(e as Error).message}`)
    }
  }

  const stopRecording = (cancel = false): void => {
    const mr = mediaRecorderRef.current
    if (!mr) return
    mr.onstop = () => {
      void (async () => {
        recordStreamRef.current?.getTracks().forEach((t) => t.stop())
        recordStreamRef.current = null
        if (recordTimerRef.current !== null) {
          window.clearInterval(recordTimerRef.current)
          recordTimerRef.current = null
        }
        setRecording(false)
        const chunks = recordedChunksRef.current
        recordedChunksRef.current = []
        if (cancel || !chunks.length) return
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' })
        if (blob.size < 800) {
          say("That recording was too short — hold the button a little longer.")
          return
        }
        const tempId = `tmp-voice-${Date.now()}`
        setMessages((m) => [...m, { id: tempId, role: 'user', content: '🎙️ …', tier: null, created_at: new Date().toISOString(), pending: true }])
        try {
          const { base64, mimeType } = await blobToWavBase64(blob)
          const res = await window.api.sendVoice(base64, mimeType)
          setMessages((m) => [...m.filter((x) => x.id !== tempId), res.userMessage, { ...res.assistantMessage, applied: res.applied, error: res.error }])
          setLastToolNames(res.applied.map((a) => a.tool))
          if (res.applied.length) setLastAppliedAt(Date.now())
          if (res.error) setConcernedAt(Date.now())
        } catch (e) {
          setConcernedAt(Date.now())
          setMessages((m) => [
            ...m.filter((x) => x.id !== tempId),
            { id: `err-${Date.now()}`, role: 'assistant', content: `Something went wrong on my side: ${(e as Error).message}`, tier: null, created_at: new Date().toISOString(), error: (e as Error).message }
          ])
        }
        void refresh()
      })()
    }
    mr.stop()
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const live = (i: Item): boolean => !['done', 'cancelled', 'archived'].includes(i.status)
  const openItems = items.filter(live)
  const pending = reminders.filter((r) => r.state === 'pending' || r.state === 'snoozed' || r.state === 'paused')
  const itemById = new Map(items.map((i) => [i.id, i]))
  // Objects accumulate naturally (9g): a real, always-freshly-computed count of finished Things, all time — never
  // a stored "unlock" flag. The room simply shows a small stack of mementos once this is genuinely true.
  const completedProjectsCount = items.filter((i) => i.kind === 'project' && (i.status === 'done' || i.status === 'archived')).length
  // Things: which project each item belongs to (part_of), and how many live parts each project has.
  const parentOf = new Map<string, Item>()
  const partsOf = new Map<string, number>()
  for (const l of links) {
    if (l.type !== 'part_of') continue
    const p = itemById.get(l.to_item)
    if (p) parentOf.set(l.from_item, p)
    const child = itemById.get(l.from_item)
    if (child && live(child)) partsOf.set(l.to_item, (partsOf.get(l.to_item) ?? 0) + 1)
  }
  const projects = openItems.filter((i) => i.kind === 'project')
  const archivedProjects = items.filter((i) => i.kind === 'project' && (i.status === 'done' || i.status === 'archived'))
  // Things surface (9h): the most recent activity touching each project, for a light "last activity" freshness cue —
  // the same information ProjectView's own timeline already shows in full, just the top line of it.
  const lastActivityAt = new Map<string, string>()
  for (const a of activities) {
    if (!a.project_id) continue
    const cur = lastActivityAt.get(a.project_id)
    if (!cur || a.created_at > cur) lastActivityAt.set(a.project_id, a.created_at)
  }
  // Blocked = has an open blocker via a `blocks` link. Computed here from the links table, never stored.
  const blockersOf = new Map<string, Item[]>()
  for (const l of links) {
    if (l.type !== 'blocks') continue
    const b = itemById.get(l.from_item)
    if (b && live(b)) blockersOf.set(l.to_item, [...(blockersOf.get(l.to_item) ?? []), b])
  }
  // Checklist steps render nested under their Thing, in sort order, not as standalone rows.
  const checklistOf = new Map<string, Item[]>()
  for (const it of openItems) {
    if (it.kind !== 'checklist_item') continue
    const p = parentOf.get(it.id)
    if (!p) continue
    const arr = checklistOf.get(p.id) ?? []
    arr.push(it)
    checklistOf.set(p.id, arr)
  }
  for (const arr of checklistOf.values()) arr.sort((a, b) => (a.sort_order ?? 1e9) - (b.sort_order ?? 1e9) || a.created_at.localeCompare(b.created_at))
  const waitingItems = openItems.filter((i) => i.kind === 'waiting').sort((a, b) => (a.due_at_utc ?? '9').localeCompare(b.due_at_utc ?? '9'))
  const followUpsOn = new Map<string, Reminder[]>()
  for (const r of pending) {
    const m = /"unless_resolved":"([0-9a-f-]{36})"/.exec(r.condition_json ?? '')
    if (m) followUpsOn.set(m[1], [...(followUpsOn.get(m[1]) ?? []), r])
  }
  // Ideas are "possible", never a hard task (spec §4 actionability threshold, §11G 9) — like waiting items, they get
  // surfaced elsewhere (get_forgetting's "possible" section) rather than sitting in Open and counting toward its number.
  const standalone = openItems.filter((i) => !(i.kind === 'checklist_item' && parentOf.has(i.id)) && i.kind !== 'waiting' && i.kind !== 'idea')
  const reorder = (project: Item, id: string, dir: -1 | 1): void => {
    const list = checklistOf.get(project.id) ?? []
    const idx = list.findIndex((c) => c.id === id)
    const j = idx + dir
    if (idx < 0 || j < 0 || j >= list.length) return
    const ids = list.map((c) => c.id)
    ;[ids[idx], ids[j]] = [ids[j], ids[idx]]
    void quick('reorder_checklist', { project_id: project.id, ordered_ids: ids })
  }

  // NOW is its own list — anything genuinely overdue (spec §7 Today).
  const now = Date.now()
  const overdueItems = openItems.filter((i) => isOverdue(i.due_at_utc, i.due_precision, now)).sort((a, b) => a.due_at_utc!.localeCompare(b.due_at_utc!))
  const overdueIds = new Set(overdueItems.map((i) => i.id))
  // Sync refs used by the creature-voice triggers (which live earlier in the component and can't touch these
  // variables directly due to temporal dead zone; the triggers read the refs instead).
  overwhelmedRef.current = overdueItems.length >= 3
  itemsRef.current = items
  overdueRef.current = overdueItems
  creatureNameRef.current = creatureName
  // DEADLINES: hard deadlines (or explicit kind='deadline') within 14 days, not already in NOW.
  const deadlineHorizon = now + 14 * 24 * 3600 * 1000
  const deadlineItems = openItems
    .filter((i) => (i.hardness === 'hard' || i.kind === 'deadline') && !overdueIds.has(i.id) && i.due_at_utc && new Date(i.due_at_utc).getTime() <= deadlineHorizon)
    .sort((a, b) => a.due_at_utc!.localeCompare(b.due_at_utc!))
  const deadlineIds = new Set(deadlineItems.map((i) => i.id))

  // Coming Up reflects exactly what exists (spec §5): alarms AND dated items, told apart, next 7 days.
  const horizon = now + 7 * 24 * 3600 * 1000
  const todayIso = new Date(now - new Date(now).getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const horizonIso = new Date(horizon - new Date(horizon).getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  // Day notes ("travelling Friday") sit in Coming Up as information, never as obligations.
  const dayNotes = notes.filter((n) => n.target_type === 'date' && n.target_id >= todayIso && n.target_id <= horizonIso)
  const notesOnItem = new Map<string, Note[]>()
  for (const n of notes) if (n.target_type === 'item') notesOnItem.set(n.target_id, [...(notesOnItem.get(n.target_id) ?? []), n])
  type Upcoming = { key: string; at: number; label: string; when: string; kind: 'alarm' | 'due' | 'note'; suggestion: boolean; open: () => void; item?: Item }
  const upcoming: Upcoming[] = [
    ...pending
      .filter((r) => new Date(r.fire_at_utc).getTime() <= horizon && !(r.target_type === 'item' && overdueIds.has(r.target_id)))
      .map((r) => ({
        key: 'r' + r.id,
        at: new Date(r.fire_at_utc).getTime(),
        label: (r.item_title ?? 'Reminder') + (r.rrule ? ' ↻' : '') + (r.state === 'paused' ? ' (paused)' : ''),
        when: formatClock(r.fire_at_utc),
        kind: 'alarm' as const,
        suggestion: false,
        open: () => setEditing({ kind: 'reminder', reminder: r }),
        item: r.target_type === 'item' ? itemById.get(r.target_id) : undefined
      })),
    // A dated item with a live alarm is already represented by its 🔔 row; only alarm-less dates get a 📅 row.
    // Hard deadlines live in their own section, so they never appear here twice.
    ...openItems
      .filter((i) => i.due_at_utc && new Date(i.due_at_utc).getTime() <= horizon && !overdueIds.has(i.id) && !deadlineIds.has(i.id))
      .filter((i) => !pending.some((r) => r.target_type === 'item' && r.target_id === i.id))
      .map((i) => ({
        key: 'i' + i.id,
        at: new Date(i.due_at_utc!).getTime(),
        label: i.title,
        when: formatDue(i.due_at_utc, i.due_precision),
        kind: 'due' as const,
        suggestion: !!i.is_suggestion,
        open: () => setEditing({ kind: 'item', item: i }),
        item: i
      })),
    ...dayNotes.map((n) => ({
      key: 'n' + n.id,
      at: new Date(n.target_id + 'T00:00').getTime() + 1,
      label: n.body,
      when: new Date(n.target_id + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
      kind: 'note' as const,
      suggestion: false,
      open: () => setEditing({ kind: 'note', note: n }),
      item: undefined as Item | undefined
    }))
  ].sort((a, b) => a.at - b.at)

  // Overdue count rising is a moment of concern, not a permanent frown.
  useEffect(() => {
    const n = overdueItems.length
    if (prevOverdue.current !== null && n > prevOverdue.current) setConcernedAt(Date.now())
    prevOverdue.current = n
  }, [overdueItems.length])

  // What is happening in the room right now (Phase 5): focus wins, then cooking, then something the user waits on.
  const runningHappenings = happenings.filter((h) => h.state === 'running')
  const happeningKind: 'focus' | 'cooking' | 'waiting' | null = runningHappenings.some((h) => h.kind === 'focus' || h.metaphor === 'focus')
    ? 'focus'
    : runningHappenings.some((h) => ['egg', 'tea', 'cooking'].includes(h.kind ?? '') || h.metaphor === 'egg' || h.metaphor === 'tea' || h.metaphor === 'plant')
      ? 'cooking'
      : runningHappenings.some((h) => ['laundry', 'charging', 'process'].includes(h.kind ?? '') || h.metaphor === 'laundry' || h.metaphor === 'download')
        ? 'waiting'
        : null

  // Emotional signals from real state (reshape "the creature cares about the user"). Never invented; every value
  // maps to a specific real thing the Secretary is already tracking:
  //   overwhelmed = 3+ overdue right now, OR a low-energy context entry today. When true, the creature stops the
  //     ordinary small-completion happy blip, no stretches, no unprompted glances — quieter presence, on purpose.
  //   deadlineHoursLeft = hours until the soonest hard-or-deadline item (already computed in `deadlineItems`).
  //   planning = the most recent tool round was a planning call, so the creature naturally moves to the desk
  //     alongside them (the chat.kind === 'tools' path already handles this; this signal is here for future use).
  const overwhelmed = overdueItems.length >= 3
  const deadlineHoursLeft = deadlineItems[0]?.due_at_utc ? (new Date(deadlineItems[0].due_at_utc!).getTime() - now) / 3600000 : null
  const planning = lastToolNames.some((n) => n === 'plan_week' || n === 'refine_week_plan' || n === 'recommend_now' || n === 'assess_deadline')
  // The Companion is a persistent application-level entity now (companion/model.ts). App still constructs
  // Signals — that's the raw awareness channel — but every companion-related decision (state, roaming, spot,
  // mood, attention, intention, persistence) is owned by the model.
  const companion = useCompanionModel({
    signals: {
      chat: status,
      typing: draft.trim().length > 0 && Date.now() - typingAt < 8000,
      recording,
      lastToolNames,
      lastAppliedAt,
      celebrateAt,
      quietlyExcitedAt,
      pettedAt,
      greetAt,
      addressedAt,
      concernedAt,
      waitingOpen: waitingItems.length,
      hour,
      happening: happeningKind,
      overwhelmed,
      deadlineHoursLeft,
      planning,
      returnFromAway,
      careSitAt,
      careSleepAt,
      careTeaAt,
      careLookAt,
      proactiveNoticeAt
    },
    force: forcedState
  })
  // Rare memorable moments (reshape "small unexpected moments"): overlays on top of the base state, at most one
  // per day for each moment key. Silent most of the time — which is the point. Weather comes from the Room's
  // deterministic per-day pick, so we recompute it here rather than plumb it through — pure and cheap.
  const moment = React.useMemo(() => {
    const nowMs = Date.now()
    // A rough "user activity" proxy — the last time draft was touched or a message applied.
    const lastUserActivityAt = Math.max(lastAppliedAt, typingAt, addressedAt)
    return maybeMoment({
      base: { state: companion.state, gaze: companion.gaze },
      signals: { chat: status, typing: false, recording, lastToolNames, lastAppliedAt, celebrateAt, quietlyExcitedAt, pettedAt, greetAt, addressedAt, concernedAt, waitingOpen: waitingItems.length, hour, happening: happeningKind, overwhelmed, deadlineHoursLeft, planning, returnFromAway, careSitAt, careSleepAt, careTeaAt, careLookAt, proactiveNoticeAt },
      now: nowMs,
      seed: companion.seed,
      personality: companion.personality,
      weather: null, // Room computes its own; we pass null and let personality's rainAffinity carry via seed alone
      lastUserActivityAt
    })
  // We deliberately don't depend on `now` — moments should stabilize on the tick companion updates on, not every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companion.state, companion.gaze, companion.seed, hour])

  return (
    <div className="h-full flex flex-col gap-2 px-5 pt-3 pb-4 overflow-hidden">
      {/* SURFACES (spec §7): Conversation is home; Calendar, Things and Settings are their own full-width screens. */}
      <nav className="flex items-center gap-1 text-sm" aria-label="Surfaces">
        {(
          [
            ['conversation', 'Conversation'],
            ['calendar', 'Calendar'],
            ['things', 'Things'],
            ['settings', 'Settings']
          ] as [Surface, string][]
        ).map(([id, label]) => (
          <button key={id} onClick={() => setSurface(id)} className={`nav-pill ${surface === id ? 'is-active' : ''}`} aria-current={surface === id ? 'page' : undefined}>
            {label}
          </button>
        ))}
        {/* Creature name + date — a small parchment card on the right side of the top nav (moved here from
            the world panel where it competed with the illustration). */}
        <div
          className="ml-auto flex flex-col gap-0.5 rounded-2xl px-3 py-1.5"
          style={{
            background: 'color-mix(in srgb, var(--color-warm-ivory) 88%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-accent) 40%, transparent)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
            color: 'var(--color-espresso)',
            lineHeight: 1
          }}
        >
          {creatureName && (
            <span
              className="italic text-right"
              style={{
                fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
                fontSize: 15,
                letterSpacing: '0.02em'
              }}
            >
              {creatureName}
            </span>
          )}
          <span
            className="opacity-80 text-right"
            style={{
              fontFamily: '"Cormorant Garamond", Georgia, serif',
              fontSize: 11,
              letterSpacing: '0.06em'
            }}
          >
            {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </span>
        </div>
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="rounded-full px-3 py-1 text-stone-500 hover:bg-white/60 hover:text-stone-800"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-pressed={theme === 'dark'}
        >
          {theme === 'dark' ? '☀ light' : '☾ dark'}
        </button>
      </nav>

      {surface === 'calendar' && (
        <div className="flex-1 min-h-0">
          <CalendarSurface
            dateLocal={calDate}
            onChangeDate={setCalDate}
            mode={calMode}
            onChangeMode={setCalMode}
            weekStart={weekStart}
            onChangeWeekStart={(n) => {
              setWeekStart(n)
              void window.api.setSetting('calendar.weekStart', String(n))
            }}
            onOpenEditor={(it) => setEditing(it.kind === 'project' ? { kind: 'project', project: it } : { kind: 'item', item: it })}
            onQuick={quick}
            refreshKey={refreshKey}
            initialSelection={hashParts['panel'] ? { kind: 'date' } : null}
          />
        </div>
      )}
      {surface === 'things' && (
        <div className="flex-1 min-h-0">
          <ThingsSurface
            active={projects}
            archived={archivedProjects}
            partsOf={partsOf}
            lastActivityAt={lastActivityAt}
            onOpen={(project) => setEditing({ kind: 'project', project })}
          />
        </div>
      )}
      {surface === 'settings' && (
        <div className="flex-1 min-h-0">
          <SettingsSurface
            theme={theme}
            onSetTheme={(t) => setTheme(t)}
            weekStart={weekStart}
            onSetWeekStart={(n) => {
              setWeekStart(n)
              void window.api.setSetting('calendar.weekStart', String(n))
            }}
            info={info}
            say={say}
            refresh={refresh}
            quick={quick}
            creatureName={creatureName}
          />
        </div>
      )}

      {surface === 'conversation' && (
      /* ONE architectural window (2026-09-19): the three regions used to be three separate cards with visible
         gaps between them, which read as "three boxes" rather than one place. Merged into a single outer surface
         with rounded corners + a single warm hairline border; the three children now touch, share the same
         background family, and are separated only by a subtle 1px vertical divider — the whole thing reads as one
         window looking into the Secretary's world. */
      <div ref={windowRef} className="flex-1 min-h-0 grid grid-cols-[minmax(420px,1.2fr)_minmax(0,1.35fr)_minmax(270px,0.65fr)] overflow-hidden rounded-2xl border border-[color:var(--color-zone-border)] shadow-[0_1px_3px_rgba(62,51,46,0.08)] relative" style={{ background: 'var(--color-zone-chat)' }}>
      {/* THE WORLD — a spatial region of the unified window, not its own card. overflow-visible is deliberate:
          it lets the creature roam past the world's own right edge into the chat region for a brief "peek" when
          the user is active (companion-home pass, style A). Clipping is handled by the merged outer window's
          rounded-2xl overflow-hidden, so nothing escapes the unified frame. */}
      <aside ref={worldRef} className="relative" style={{ background: 'var(--color-zone-world)' }}>
        <Room
          state={moment.state}
          gaze={moment.gaze}
          happening={happeningKind}
          environment={environment}
          time={timeChoice}
          onPet={() => { setPettedAt(Date.now()); companion.pet(); utterKind('pet') }}
          onChangeEnvironment={(e) => {
            setEnvironment(e)
            setRotation(false) // a direct pick is a direct pick — rotation (9g) stops choosing for the room
            void window.api.setSetting('scene.environment', e)
            void window.api.setSetting('scene.rotation', '0')
          }}
          onChangeTime={(t) => {
            setTimeChoice(t)
            void window.api.setSetting('scene.timeOfDay', t)
          }}
          favorites={favorites}
          rotation={rotation}
          onToggleFavorite={(e) => {
            const next = favorites.includes(e) ? favorites.filter((f) => f !== e) : [...favorites, e]
            setFavorites(next)
            void window.api.setSetting('scene.favorites', JSON.stringify(next))
          }}
          onToggleRotation={() => {
            const next = !rotation
            setRotation(next)
            void window.api.setSetting('scene.rotation', next ? '1' : '0')
          }}
          completedCount={completedProjectsCount}
          weatherOverride={weatherOverride}
          restingSpot={companion.restingSpot}
          initialSpotId={companion.initialSpotId}
          onSpotChange={companion.reportSpot}
          onSpotResolved={setResolvedSpot}
          roamingIdx={companion.roamingIdx}
        />
        <p className="absolute bottom-2 left-0 right-0 text-[11px] text-stone-500 text-center pointer-events-none">
          {status.kind === 'throttled' ? `one moment — retrying in ${status.retryInSeconds}s` : ''}
        </p>
      </aside>

      {/* CONVERSATION — the working region of the unified window, quiet paper */}
      <main className="flex flex-col min-h-0 px-5 py-3 border-l border-[color:var(--color-zone-border)]/60" style={{ background: 'var(--color-zone-chat)' }}>
        <header className="flex items-center justify-end mb-2 h-6">
          <div className="flex gap-3 text-xs text-stone-500">
            <button onClick={() => void quick('undo_last', {})} className="hover:text-stone-800" title="Undo the last change">
              undo
            </button>
            <button onClick={() => setShowDebug((v) => !v)} className="hover:text-stone-800">
              {showDebug ? 'hide debug' : 'debug'}
            </button>
          </div>
        </header>

        {info && !info.ai.hasKey && (
          <div className="mb-3 rounded-xl bg-amber-50 text-amber-900 text-sm px-4 py-2">
            No AI key set yet — go to <button className="underline font-medium" onClick={() => setSurface('settings')}>Settings</button> and paste in a free key from{' '}
            <a className="underline font-medium" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a>. Everything else still works by hand.
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto py-3 pr-1 flex flex-col gap-4">
          {messages.length === 0 && (
            <p className="text-sm text-ash italic m-auto text-center max-w-sm">
              Tell me what's on your mind. "Remind me to call the bank Thursday at 3", "the CV is done", "actually make it 4", "undo that".
            </p>
          )}
          {messages.map((m) => (
            <Bubble key={m.id} m={m} creatureName={creatureName} />
          ))}
          {status.kind !== 'idle' && <span className="self-start text-sm text-ash italic animate-pulse">…</span>}
        </div>

        {/* Input bar — Phase 2 polish: given a warm surface, subtle inner border, and focus ring so it reads as
            a real input, not a hairline strip. The previous bare-text textarea disappeared into the panel
            background. */}
        <div className="mt-3 flex items-end gap-2 rounded-2xl border border-[color:var(--color-zone-border)]/70 bg-[color:var(--color-paper-2)]/50 px-2 py-1.5 shadow-[inset_0_1px_2px_rgba(62,51,46,0.08)] focus-within:border-[color:var(--color-accent)]/70 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_20%,transparent)]">
          <textarea
            ref={inputRef}
            value={draft}
            disabled={recording}
            onChange={(e) => {
              setDraft(e.target.value)
              setTypingAt(Date.now())
            }}
            onKeyDown={onKey}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder={recording ? `listening — ${recordSeconds}s, press again to send` : 'tell me whats up chiku'}
            className="flex-1 resize-none bg-transparent px-2 py-1.5 outline-none text-[15px] leading-relaxed text-cocoa placeholder:text-[color:var(--color-ash)] placeholder:italic disabled:opacity-50"
          />
          {recording && (
            <button onClick={() => stopRecording(true)} title="Cancel — nothing sent" className="rounded-xl px-3 py-2 text-sm text-stone-500 hover:bg-paper">
              ✕
            </button>
          )}
          <button
            onClick={() => (recording ? stopRecording() : void startRecording())}
            disabled={!recording && status.kind !== 'idle'}
            title={recording ? 'Stop and send' : 'Record a voice message — speaks straight into the same extraction pipeline as typing'}
            aria-pressed={recording}
            className={`rounded-xl px-3 py-2 text-sm disabled:opacity-30 ${recording ? 'bg-accent text-cream animate-pulse' : 'text-cocoa hover:bg-paper'}`}
          >
            {recording ? `⏺ ${recordSeconds}s` : '🎤'}
          </button>
          <button onClick={() => void send()} disabled={recording || !draft.trim() || status.kind !== 'idle'} className="rounded-xl bg-cocoa text-cream px-4 py-2 text-sm disabled:opacity-30">
            Send
          </button>
        </div>
        {flash && <p key={flashSeq} className="mt-2 text-xs text-stone-500 flash-in">{flash}</p>}
      </main>

      {/* AWARENESS — the quiet right region of the unified window */}
      <aside className="flex flex-col gap-3 min-h-0 overflow-y-auto px-4 py-4 text-[13px] border-l border-[color:var(--color-zone-border)]/60" style={{ background: 'var(--color-zone-rail)' }}>
        {!showDebug ? (
          <>
            {(overdueItems.length > 0 || happenings.some((h) => h.state === 'running')) && (
              <section className="flex flex-col gap-1.5 min-h-0">
                <h2 className="chapter-heading text-[color:var(--color-accent)]">Right now</h2>
                <ul className="flex flex-col gap-1">
                  {overdueItems.slice(0, 8).map((it) => (
                    <li key={it.id} className={`item-in group text-sm flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/40 cursor-pointer ${completingIds.has(it.id) ? 'completing' : ''}`} onClick={() => setEditing({ kind: 'item', item: it })}>
                      <span className="mt-0.5 text-xs text-amber-800">⚠</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{it.title}</div>
                        <div className="text-xs text-amber-800/80">was due {formatDue(it.due_at_utc, it.due_precision)}</div>
                      </div>
                      <button
                        className="opacity-0 group-hover:opacity-100 text-xs text-stone-500 hover:text-emerald-700 px-1"
                        title="Done"
                        onClick={(e) => {
                          e.stopPropagation()
                          completeWithFeedback('complete_item', it.id)
                        }}
                      >
                        ✓
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="flex flex-col gap-1.5 min-h-0">
              <h2 className="chapter-heading text-[color:var(--color-accent)]">Coming up</h2>
              {upcoming.length === 0 && <p className="text-sm text-stone-400">Nothing dated, no alarms set.</p>}
              <ul className="flex flex-col gap-1 overflow-y-auto">
                {upcoming.slice(0, 10).map((u) => (
                  <li key={u.key} className={`item-in group text-sm flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/80 cursor-pointer ${u.item && completingIds.has(u.item.id) ? 'completing' : ''}`} onClick={u.open}>
                    <span className="mt-0.5 text-xs" title={u.kind === 'alarm' ? 'Reminder will fire' : u.kind === 'note' ? 'Note for that day' : 'Due date, no reminder'}>
                      {u.kind === 'alarm' ? '🔔' : u.kind === 'note' ? '📝' : '📅'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={`truncate ${u.suggestion || u.kind === 'note' ? 'italic text-stone-600' : ''}`}>
                        {u.label}
                        {u.suggestion && <span className="ml-1 text-[10px] not-italic text-stone-400">suggested</span>}
                      </div>
                      <div className="text-xs text-stone-500">
                        {u.when}
                        {u.kind === 'due' && <span className="text-stone-400"> · no reminder</span>}
                        {u.kind === 'note' && <span className="text-stone-400"> · note</span>}
                      </div>
                    </div>
                    {u.item && live(u.item) && (
                      <button
                        className="opacity-0 group-hover:opacity-100 text-xs text-stone-500 hover:text-emerald-700 px-1"
                        title="Done"
                        onClick={(e) => {
                          e.stopPropagation()
                          completeWithFeedback('complete_item', u.item!.id)
                        }}
                      >
                        ✓
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            <RightNow happenings={happenings} onFinish={(id, outcome) => void quick('finish_happening', { id, outcome })} />
            {deadlineItems.length > 0 && (
              <section className="flex flex-col gap-1.5 min-h-0">
                <h2 className="chapter-heading text-[color:var(--color-accent)]">Deadlines</h2>
                <ul className="flex flex-col gap-1">
                  {deadlineItems.slice(0, 6).map((it) => (
                    <li key={it.id} className={`item-in group text-sm flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/40 cursor-pointer ${completingIds.has(it.id) ? 'completing' : ''}`} onClick={() => setEditing({ kind: 'item', item: it })}>
                      <span className="mt-0.5 text-xs text-cocoa">◆</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{it.title}</div>
                        <div className="text-xs text-stone-500">due {formatDue(it.due_at_utc, it.due_precision)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {constraints.length > 0 && (
              <section className="flex flex-col gap-1 min-h-0">
                <h2 className="chapter-heading text-[color:var(--color-accent)]">Unavailable · preferences</h2>
                <ul className="flex flex-col gap-0.5 overflow-y-auto">
                  {constraints.slice(0, 8).map((c) => (
                    <li key={c.id} className="group text-xs flex items-center gap-2 rounded-lg px-1 py-0.5 hover:bg-white/80">
                      <span>{c.label.startsWith('buffer|') ? '↔' : CONSTRAINT_ICON[c.kind as 'unavailable' | 'avoid' | 'prefer']}</span>
                      {c.label.startsWith('buffer|') ? (
                        <span className="flex-1 truncate text-stone-700" title="A transition buffer: bookings tighter than this are flagged as a poor fit">
                          <span className="font-medium">buffer</span>
                          <span className="text-stone-500">{` · ${c.label.split('|')[2]} min ${c.label.split('|')[1] === 'around' ? 'either side of' : c.label.split('|')[1]} ${c.label.split('|')[3] ? `“${c.label.split('|')[3]}”` : 'anything'}`}</span>
                        </span>
                      ) : (
                      <span className="flex-1 truncate text-stone-700">
                        <span className="font-medium">{c.label}</span>
                        <span className="text-stone-500">
                          {' · '}
                          {c.starts_at ? formatClock(c.starts_at).replace(/ at 00:00$/, '') : ''}
                          {c.ends_at && c.starts_at && new Date(c.ends_at).getTime() - new Date(c.starts_at).getTime() < 23.9 * 3600000 ? `–${new Date(c.ends_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}` : ' (all day)'}
                          {c.rrule ? ' ↻' : ''}
                        </span>
                      </span>
                      )}
                      <button className="opacity-0 group-hover:opacity-100 text-stone-500 hover:text-red-700" title="Remove" onClick={() => void quick('remove_constraint', { id: c.id })}>
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {waitingItems.length > 0 && (
              <section className="flex flex-col gap-1.5 min-h-0">
                <h2 className="chapter-heading text-[color:var(--color-accent)]">Waiting for</h2>
                <ul className="flex flex-col gap-1 overflow-y-auto">
                  {waitingItems.map((w) => {
                    const late = isOverdue(w.due_at_utc, w.due_precision, now)
                    const fu = followUpsOn.get(w.id) ?? []
                    return (
                      <li key={w.id} className={`item-in group text-sm flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-white/80 cursor-pointer ${completingIds.has(w.id) ? 'completing' : ''}`} onClick={() => setEditing({ kind: 'item', item: w })}>
                        <span className="mt-0.5 text-xs">⏳</span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate">
                            <span className="font-medium">{w.waiting_on ?? 'someone'}</span>
                            {w.details ? <span className="text-stone-600"> · {w.details}</span> : null}
                          </div>
                          <div className={`text-xs truncate ${late ? 'text-amber-800' : 'text-stone-500'}`}>
                            {w.due_at_utc ? `${late ? 'expected ' : 'expected '}${formatDue(w.due_at_utc, w.due_precision)}${late ? ' · no word yet' : ''}` : `since ${new Date(w.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}
                            {parentOf.has(w.id) && <> · {parentOf.get(w.id)!.title}</>}
                            {fu.length > 0 && <> · follow-up {formatClock(fu[0].fire_at_utc)} unless resolved</>}
                          </div>
                        </div>
                        <button
                          className="opacity-0 group-hover:opacity-100 text-xs text-stone-500 hover:text-emerald-700 px-1 whitespace-nowrap"
                          title="They replied"
                          onClick={(e) => {
                            e.stopPropagation()
                            completeWithFeedback('resolve_waiting', w.id, { outcome: 'replied' })
                          }}
                        >
                          replied ✓
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
            <section className="flex flex-col gap-1.5 min-h-0 flex-1 mt-1 pt-3 border-t border-paper-2/60">
              <h2 className="chapter-heading text-[color:var(--color-accent)]">Also on the list · {standalone.filter((i) => !i.is_suggestion).length}</h2>
              {standalone.length === 0 && <p className="text-sm text-ash italic">Nothing else on the list.</p>}
              <ul className="flex flex-col gap-1 overflow-y-auto">
                {standalone.slice(0, 30).map((it) => (
                  <li
                    key={it.id}
                    className={`item-in group text-sm flex flex-col rounded-lg px-1 py-1 hover:bg-white/80 cursor-pointer ${completingIds.has(it.id) ? 'completing' : ''}`}
                    onClick={() => setEditing(it.kind === 'project' ? { kind: 'project', project: it } : { kind: 'item', item: it })}
                  >
                  <div className="flex items-start gap-2">
                    <span className={`text-[10px] mt-1 rounded px-1 ${it.kind === 'project' ? 'bg-accent/25 text-cocoa' : it.kind === 'commitment' ? 'bg-rose-100 text-rose-900' : 'bg-stone-200 text-stone-600'}`} title={it.kind === 'commitment' ? `Promised to ${it.committed_to ?? 'someone'}` : undefined}>
                      {it.is_suggestion ? 'suggested' : it.kind === 'project' ? 'thing' : it.kind === 'commitment' ? `to ${it.committed_to ?? 'someone'}` : it.kind.replace('_', ' ')}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={`truncate ${it.is_suggestion ? 'italic text-stone-500' : ''} ${it.kind === 'project' ? 'font-medium' : ''}`}>{it.title}</div>
                      {(it.due_at_utc || it.status !== 'open' || it.kind === 'project' || parentOf.has(it.id)) && (
                        <div className="text-xs text-stone-500 truncate">
                          {it.status !== 'open' && <span className="mr-1">{it.status.replace('_', ' ')}</span>}
                          {it.due_at_utc && <>due {formatDue(it.due_at_utc, it.due_precision)}{it.hardness === 'hard' ? ' · hard' : ''}</>}
                          {it.kind === 'project' && <span>{it.due_at_utc ? ' · ' : ''}{partsOf.get(it.id) ?? 0} open {(partsOf.get(it.id) ?? 0) === 1 ? 'part' : 'parts'}</span>}
                          {parentOf.has(it.id) && <span>{it.due_at_utc ? ' · ' : ''}part of {parentOf.get(it.id)!.title}</span>}
                        </div>
                      )}
                      {blockersOf.has(it.id) && (
                        <div className="text-xs text-amber-800 truncate">⛔ blocked by {blockersOf.get(it.id)!.map((b) => b.title).join(', ')}</div>
                      )}
                    </div>
                    <button
                      className="opacity-0 group-hover:opacity-100 text-xs text-stone-500 hover:text-emerald-700 px-1"
                      title="Done"
                      onClick={(e) => {
                        e.stopPropagation()
                        completeWithFeedback('complete_item', it.id)
                      }}
                    >
                      ✓
                    </button>
                  </div>
                  {it.kind === 'project' && (checklistOf.get(it.id)?.length ?? 0) > 0 && (
                    <ul className="ml-6 mt-1 flex flex-col gap-0.5">
                      {checklistOf.get(it.id)!.map((c, idx, arr) => (
                        <li key={c.id} className="group/step flex items-center gap-2 text-xs text-stone-700" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="w-4 h-4 rounded border border-stone-400 hover:bg-emerald-100 shrink-0"
                            title="Tick off"
                            onClick={() => void quick('complete_checklist_item', { id: c.id })}
                          />
                          <span className="truncate flex-1 cursor-pointer hover:underline" onClick={() => setEditing({ kind: 'item', item: c })}>
                            {c.title}
                          </span>
                          <span className="opacity-0 group-hover/step:opacity-100 flex gap-1 text-stone-400">
                            <button disabled={idx === 0} className="disabled:opacity-20 hover:text-stone-800" title="Move up" onClick={() => reorder(it, c.id, -1)}>↑</button>
                            <button disabled={idx === arr.length - 1} className="disabled:opacity-20 hover:text-stone-800" title="Move down" onClick={() => reorder(it, c.id, 1)}>↓</button>
                            <button className="hover:text-red-700" title="Strike off" onClick={() => void quick('remove_checklist_item', { id: c.id })}>×</button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : (
          <DebugPanel info={info} logs={logs} aiCalls={aiCalls} activities={activities} extractions={extractions} reminders={reminders} say={say} refresh={refresh} onOpenReminder={(r) => setEditing({ kind: 'reminder', reminder: r })} />
        )}
      </aside>
      {/* CompanionRenderer — she lives here at merged-window level. Two spot-selection rules apply:
          (1) If a bubble is showing, she's pinned to the chair-seat spot so the user can read her without her
              wandering off (user request 2026-09-19).
          (2) If her natural spot lands in the curtain area (scene x < 0.28), she's diverted to the chair
              instead so she never disappears behind the burgundy velvet. */}
      {resolvedSpot && worldLocal && (() => {
        const chairSpot = { x: 0.60, y: 0.78, scale: 0.85, gaze: resolvedSpot.gaze }
        const inCurtain = resolvedSpot.x < 0.28 && resolvedSpot.y < 0.75
        const effective = (utteranceText !== null || inCurtain) ? chairSpot : resolvedSpot
        const box = computeCreatureBox(effective, worldLocal)
        return (
          <>
            <CompanionRenderer
              state={moment.state}
              gaze={effective.gaze}
              dim={bandForHour(hour) === 'night' ? 0.28 : bandForHour(hour) === 'evening' ? 0.08 : 0}
              box={box}
              onPet={() => { setPettedAt(Date.now()); companion.pet(); utterKind('pet') }}
              onDoubleClick={() => {
                // On double-click she DEFINITELY speaks. Bypasses the shared cooldown so it always lands,
                // even if she has just spoken. Picks a kind at random weighted toward warmer/reflective
                // options so the summoned thought feels like a small gift rather than a task nag.
                const heavy = overwhelmedRef.current
                const pool: UtteranceKind[] = heavy
                  ? ['love', 'overwhelmed_comfort', 'love', 'poem', 'love']
                  : ['love', 'idle_observation', 'book_aside', 'poem', 'love', 'idle_observation']
                const kind = pool[Math.floor(Math.random() * pool.length)]
                utterKind(kind, { forceIgnoreGap: true })
              }}
            />
            <CompanionUtterance
              text={utteranceText}
              box={box}
              onDismiss={() => {
                setUtteranceText(null)
                if (onboardingActiveRef.current) {
                  // Give the user a breath, then bring in the next line.
                  window.setTimeout(() => advanceOnboarding(), 900)
                }
              }}
            />
          </>
        )
      })()}
      {/* Clickable lamp zone — mapped through the scene's actual rendered position within the letterboxed
          SVG. The Library uses preserveAspectRatio="xMidYMax meet" on viewBox 500×900 (aspect 0.556). When
          the world panel is wider aspect than the SVG, the SVG fills height and letterboxes horizontally
          (centered). Chair-lamp scene coords are (0.88, 0.70); we translate those into panel coordinates
          honouring the letterbox so the click zone lands over the visible lamp shade. */}
      {worldLocal && (() => {
        const svgAspect = 500 / 900
        const panelAspect = worldLocal.width / worldLocal.height
        let svgW: number, svgH: number, offsetX: number, offsetY: number
        if (panelAspect > svgAspect) {
          svgH = worldLocal.height
          svgW = svgH * svgAspect
          offsetX = (worldLocal.width - svgW) / 2
          offsetY = 0
        } else {
          svgW = worldLocal.width
          svgH = svgW / svgAspect
          offsetX = 0
          offsetY = worldLocal.height - svgH
        }
        // Chair-lamp shade in scene coords — moved up from y=0.70 to y=0.60 to land on the SHADE itself
        // (the previous y=0.70 was landing on the lamp base/stem, so the user had to click below the shade).
        const lampX = worldLocal.left + offsetX + 0.88 * svgW
        const lampY = worldLocal.top + offsetY + 0.60 * svgH
        return (
          <button
            className="absolute rounded-full lamp-click-zone"
            aria-label={lampOn ? 'Extinguish the lamp' : 'Light the lamp'}
            title={lampOn ? 'Extinguish the lamp' : 'Light the lamp'}
            onClick={() => { console.log('lamp clicked'); setLampOn((v) => !v); setUtteranceText(null) }}
            style={{
              left: lampX,
              top: lampY,
              width: svgW * 0.16,
              height: svgW * 0.22,
              transform: 'translate(-50%, -50%)',
              background: lampOn
                ? 'radial-gradient(circle, rgba(214,168,105,0.35) 0%, transparent 70%)'
                : 'radial-gradient(circle, rgba(214,168,105,0.06) 0%, transparent 70%)',
              cursor: 'pointer',
              border: 'none',
              zIndex: 30,
              transition: 'background .4s ease'
            }}
          />
        )
      })()}
      {/* Warm lamp-lit overlay — always rendered, opacity animates on lampOn/off so lighting the lamp fades a
          soft amber wash across the entire merged window. The gradient center is anchored near the chair-lamp
          in the world panel (~33% x, ~68% y of the merged window given the world ≈ 37.5% of it) so the light
          feels like it emanates FROM the lamp. Two layered blends: soft-light for atmospheric warmth, screen
          for a brighter core so the effect is unmistakably visible against dark surfaces. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(120% 90% at 33% 68%, rgba(214,168,105,0.35) 0%, rgba(214,168,105,0.14) 32%, transparent 68%)',
          mixBlendMode: 'soft-light',
          transition: 'opacity 1.4s ease',
          opacity: lampOn ? 1 : 0
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(50% 40% at 33% 68%, rgba(255,205,138,0.18) 0%, transparent 65%)',
          mixBlendMode: 'screen',
          transition: 'opacity 1.4s ease',
          opacity: lampOn ? 1 : 0
        }}
      />
      {/* --- Curtains over the pink dawn window (scene coords translated through the same letterbox math as
          the lamp) — the SVG is preserveAspectRatio="xMidYMax meet" so scene fractions can't be applied
          directly to panel fractions; they need to be mapped through the SVG's actual rendered rect. */}
      {worldLocal && (() => {
        const svgAspect = 500 / 900
        const panelAspect = worldLocal.width / worldLocal.height
        let svgW: number, svgH: number, offsetX: number, offsetY: number
        if (panelAspect > svgAspect) {
          svgH = worldLocal.height
          svgW = svgH * svgAspect
          offsetX = (worldLocal.width - svgW) / 2
          offsetY = 0
        } else {
          svgW = worldLocal.width
          svgH = svgW / svgAspect
          offsetX = 0
          offsetY = worldLocal.height - svgH
        }
        // Window frame in scene coords: x=18-120 (width 102), y=60-560 (height 500). Convert to panel-local px.
        const winL = offsetX + (18 / 500) * svgW
        const winT = offsetY + (60 / 900) * svgH
        const winW = (102 / 500) * svgW
        const winH = (500 / 900) * svgH
        const halfW = winW / 2
        // Curtain visuals: burgundy velvet with vertical gathered folds. Open state translates outward and
        // narrows slightly (gathered look).
        const curtainStyle = (side: 'left' | 'right'): React.CSSProperties => ({
          position: 'absolute',
          top: worldLocal.top + winT,
          height: winH,
          width: halfW * (curtainsOpen ? 0.32 : 1.02),
          background: side === 'left'
            ? 'repeating-linear-gradient(90deg, #3A1210 0px, #5A1E1A 8px, #3A1210 14px, #2A0E0C 22px)'
            : 'repeating-linear-gradient(270deg, #3A1210 0px, #5A1E1A 8px, #3A1210 14px, #2A0E0C 22px)',
          boxShadow: 'inset 0 0 12px rgba(0,0,0,0.5)',
          transition: 'transform 1.6s cubic-bezier(.4,0,.2,1), width 1.6s ease',
          cursor: 'pointer',
          zIndex: 6
        })
        return (
          <>
            <button
              className="curtain-click"
              aria-label={curtainsOpen ? 'Draw the curtains closed' : 'Draw the curtains open'}
              title={curtainsOpen ? 'Draw the curtains closed' : 'Draw the curtains open'}
              onClick={() => { setCurtainsOpen((v) => !v); setUtteranceText(null) }}
              style={{
                ...curtainStyle('left'),
                left: worldLocal.left + winL,
                transform: curtainsOpen ? `translateX(-20%)` : `translateX(0)`,
                transformOrigin: 'left center',
                borderTopLeftRadius: 6,
                borderTopRightRadius: 2,
                border: 'none',
                zIndex: 20
              }}
            />
            <button
              className="curtain-click"
              aria-label={curtainsOpen ? 'Draw the curtains closed' : 'Draw the curtains open'}
              title={curtainsOpen ? 'Draw the curtains closed' : 'Draw the curtains open'}
              onClick={() => { setCurtainsOpen((v) => !v); setUtteranceText(null) }}
              style={{
                ...curtainStyle('right'),
                left: worldLocal.left + winL + halfW,
                width: halfW * (curtainsOpen ? 0.32 : 1.02),
                transform: curtainsOpen ? `translateX(180%)` : `translateX(0)`,
                transformOrigin: 'right center',
                borderTopRightRadius: 6,
                borderTopLeftRadius: 2,
                border: 'none',
                zIndex: 20
              }}
            />
            {/* Curtain rod — brass, above the window, always visible */}
            <div
              aria-hidden
              className="absolute pointer-events-none"
              style={{
                left: worldLocal.left + winL - 6,
                top: worldLocal.top + winT - 4,
                width: winW + 12,
                height: 4,
                background: `linear-gradient(180deg, ${'#C79A56'}, #8A6733)`,
                borderRadius: 2,
                boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                zIndex: 7
              }}
            />
          </>
        )
      })()}
      {/* Daylight streaming in — three-layer beautiful sunrise wash anchored at the window position (~7% x,
          ~35% y). A soft-light warm-pink haze bathes the whole app; a bright screen-blend rose glow radiates
          from the window; a broader golden overlay adds warmth to the room. When curtains close, everything
          fades to nothing. Meant to feel like actual dawn spilling into the room. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(110% 90% at 7% 35%, rgba(238,196,190,0.45) 0%, rgba(245,215,196,0.22) 30%, transparent 65%)',
          mixBlendMode: 'soft-light',
          transition: 'opacity 1.6s ease',
          opacity: curtainsOpen ? 1 : 0
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(60% 55% at 7% 35%, rgba(255,206,196,0.40) 0%, rgba(255,220,190,0.15) 45%, transparent 75%)',
          mixBlendMode: 'screen',
          transition: 'opacity 1.6s ease',
          opacity: curtainsOpen ? 1 : 0
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(90% 80% at 15% 42%, rgba(255,235,205,0.22) 0%, transparent 60%)',
          mixBlendMode: 'lighten',
          transition: 'opacity 1.6s ease',
          opacity: curtainsOpen ? 1 : 0
        }}
      />
      </div>
      )}

      {/* Multi-surface Companion presence (Phase 3, 2026-09-19). On Calendar / Things / Settings surfaces
          the world panel doesn't exist, but the creature continues to live. She appears as a small fixed
          companion in the bottom-right corner of the viewport, still speaking, still receiving pets,
          preserving her state across surface switches. When you go back to Conversation she rejoins her
          world spot naturally. */}
      {surface !== 'conversation' && resolvedSpot && (
        <div
          className="fixed bottom-4 right-4 pointer-events-none"
          style={{ width: 160, height: 160, zIndex: 40 }}
        >
          <CompanionRenderer
            state={moment.state}
            gaze={resolvedSpot.gaze}
            dim={bandForHour(hour) === 'night' ? 0.28 : bandForHour(hour) === 'evening' ? 0.08 : 0}
            box={{ left: 80, top: 80, width: 140 }}
            onPet={() => { setPettedAt(Date.now()); companion.pet(); utterKind('pet') }}
          />
          <CompanionUtterance
            text={utteranceText}
            box={{ left: 80, top: 80, width: 140 }}
            onDismiss={() => {
              setUtteranceText(null)
              if (onboardingActiveRef.current) window.setTimeout(() => advanceOnboarding(), 900)
            }}
          />
        </div>
      )}

      {editing?.kind === 'item' && (
        <ItemEditor
          target={itemById.get(editing.item.id) ?? editing.item}
          reminders={reminders}
          projects={projects}
          parentId={parentOf.get(editing.item.id)?.id ?? null}
          notes={notesOnItem.get(editing.item.id) ?? []}
          blockers={blockersOf.get(editing.item.id) ?? []}
          candidates={openItems.filter((i) => i.id !== editing.item.id && i.kind !== 'project')}
          onHistory={() => setEditing(editing.item.kind === 'project' ? { kind: 'project', project: editing.item } : { kind: 'history', item: editing.item })}
          runTool={runTool}
          onDone={say}
          onClose={() => setEditing(null)}
          onOpenReminder={(r) => setEditing({ kind: 'reminder', reminder: r })}
        />
      )}
      {editing?.kind === 'reminder' && (
        <ReminderEditor target={reminders.find((r) => r.id === editing.reminder.id) ?? editing.reminder} runTool={runTool} onDone={say} onClose={() => setEditing(null)} />
      )}
      {editing?.kind === 'note' && <NoteEditor note={notes.find((n) => n.id === editing.note.id) ?? editing.note} runTool={runTool} onDone={say} onClose={() => setEditing(null)} />}
      {editing?.kind === 'project' && (
        <ProjectView
          project={itemById.get(editing.project.id) ?? editing.project}
          parts={items.filter((i) => parentOf.get(i.id)?.id === editing.project.id)}
          notes={notesOnItem.get(editing.project.id) ?? []}
          reminders={reminders}
          runTool={runTool}
          onOpenItem={(i) => setEditing({ kind: 'item', item: i })}
          onOpenReminder={(r) => setEditing({ kind: 'reminder', reminder: r })}
          onClose={() => setEditing(null)}
          initialTab={editing.tab}
        />
      )}
      {editing?.kind === 'history' && <ItemHistory item={editing.item} onClose={() => setEditing(null)} />}
    </div>
  )
}

/*
 * Bubble rendering — visual reset (product-thesis reshape, 2026-09-19):
 *   - System lines stay small centered pills (they're rare and their pill shape is fine).
 *   - User voice keeps a pill (need role distinction, one user), but it's a compact deep-cocoa signature aligned
 *     to the right — the user's voice is grounded and visible, not a scrollable log entry.
 *   - Ordinary assistant text loses the pill entirely — it's just warm cocoa text on the world, reading as
 *     spoken words on the shared surface. No hard border, no container, no chat-app grammar.
 *   - Proactive lines (from the creature) get a distinct treatment: a soft-rose left rule, indented, with a small
 *     dusty-rose creature glyph in the left margin. The message spatially originates from the creature's side
 *     of the world; it's visibly not a chat bubble.
 */
function Bubble({ m, creatureName }: { m: UiMessage; creatureName?: string | null }): React.JSX.Element {
  if (m.role === 'system') {
    return <div className="bubble-in self-center text-xs text-ash bg-paper/70 rounded-full px-3 py-1 max-w-[85%] truncate">{m.content}</div>
  }
  const user = m.role === 'user'
  if (user) {
    return (
      <div className="flex flex-col gap-1 max-w-[80%] self-end items-end">
        {/* User bubble — soft warm ivory (eggshell) with deep espresso text. Gentle on the eyes, still
            distinguishable as the user's own voice, sits harmoniously in the Victorian palette. */}
        <div
          className={`bubble-in rounded-2xl px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap ${m.pending ? 'opacity-60' : ''}`}
          style={{
            background: 'var(--color-warm-ivory)',
            color: 'var(--color-espresso)',
            border: '1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)'
          }}
        >
          {m.content}
        </div>
      </div>
    )
  }
  if (m.proactive) {
    return (
      <div className="bubble-in self-start max-w-[88%] flex items-start gap-2.5">
        <span aria-hidden className="mt-1 inline-flex items-center justify-center w-6 h-6 rounded-full text-cocoa text-[13px] shrink-0 border border-[color:var(--color-accent)]" style={{ background: 'var(--color-rose-50)' }} title={creatureName ? `From ${creatureName}` : 'From the room'}>
          ◕
        </span>
        <div className="flex-1 min-w-0 rounded-2xl rounded-tl-md px-3.5 py-2 border border-[color:var(--color-accent)]/40" style={{ background: 'var(--color-rose-50)' }}>
          <div className="text-[15px] leading-relaxed text-cocoa whitespace-pre-wrap italic">{m.content}</div>
          {creatureName && <div className="text-[10px] text-accent mt-0.5">— {creatureName}</div>}
        </div>
      </div>
    )
  }
  // Ordinary assistant reply — the Secretary's own voice. Distinct visual identity from Chiku: a soft paper
  // bubble with a warm brass gilt rule down the left edge, a small serif "S" mark in the top-left corner,
  // Cormorant italic first line to signal the librarian voice. Warm, competent, precise. Not the same as
  // the pink cloud (Chiku speaks in bubbles beside her body; the Secretary speaks here in the chat).
  return (
    <div className="flex flex-col gap-1 max-w-[85%] self-start items-start">
      <div
        className={`bubble-in relative rounded-2xl rounded-tl-md pl-6 pr-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-cocoa ${m.pending ? 'opacity-60' : ''}`}
        style={{
          background: 'var(--color-paper)',
          borderLeft: '3px solid var(--color-accent)',
          borderTop: '1px solid color-mix(in srgb, var(--color-accent) 22%, transparent)',
          borderRight: '1px solid color-mix(in srgb, var(--color-accent) 22%, transparent)',
          borderBottom: '1px solid color-mix(in srgb, var(--color-accent) 22%, transparent)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
        }}
      >
        <span
          aria-hidden
          className="absolute select-none"
          style={{
            top: 4,
            left: 6,
            fontFamily: '"Cormorant Garamond", "EB Garamond", Georgia, serif',
            fontStyle: 'italic',
            fontSize: 14,
            lineHeight: 1,
            color: 'var(--color-accent)',
            opacity: 0.78,
            letterSpacing: '0.02em'
          }}
        >
          S
        </span>
        {m.content}
      </div>
      {m.applied && m.applied.length > 0 && (
        <ul className="flex flex-col gap-0.5 mt-0.5">
          {m.applied.map((a, i) => (
            <li key={i} className="text-xs text-emerald-800 flex items-center gap-1">
              <span>✓</span>
              <span>{a.summary}</span>
            </li>
          ))}
        </ul>
      )}
      {m.tier === 0 && !m.pending && <span className="text-[10px] text-ash-2/60">instant · no model call</span>}
      {m.error && <div className="text-xs text-rose-900">{m.error}</div>}
    </div>
  )
}

function DebugPanel(props: {
  info: AppInfo | null
  logs: SchedulerLogEntry[]
  aiCalls: SchedulerLogEntry[]
  activities: Activity[]
  extractions: ExtractionEntry[]
  reminders: Reminder[]
  say: (s: string) => void
  refresh: () => Promise<void>
  onOpenReminder: (r: Reminder) => void
}): React.JSX.Element {
  const { info, logs, aiCalls, activities, extractions, reminders, say, refresh, onOpenReminder } = props
  const [tab, setTab] = useState<'scheduler' | 'ai' | 'activity' | 'extractions' | 'reminders'>('scheduler')
  const run = async (fn: () => Promise<string>): Promise<void> => {
    try {
      say(await fn())
    } catch (e) {
      say('Error: ' + (e as Error).message)
    }
    await refresh()
  }
  const tabs: [typeof tab, string][] = [
    ['scheduler', 'Scheduler'],
    ['ai', 'AI calls'],
    ['activity', 'Activity'],
    ['extractions', 'Extractions'],
    ['reminders', 'Reminders']
  ]
  return (
    <>
      <section className="rounded-2xl bg-white/70 p-3 text-[11px] flex flex-col gap-1">
        {info && (
          <>
            <Row k="AI" v={info.ai.hasKey ? `${info.ai.provider} / ${info.ai.model}` : 'no key'} />
            <Row k="DB" v={info.dbPath} />
            <Row k="Zone" v={info.timezone} />
            <label className="flex items-center gap-2 cursor-pointer mt-1">
              <input type="checkbox" checked={info.openAtLogin} onChange={(e) => run(async () => ((await window.api.setOpenAtLogin(e.target.checked)) ? 'Starts with Windows' : 'Will not start with Windows'))} />
              Start with Windows
            </label>
          </>
        )}
        <div className="flex flex-wrap gap-1 pt-1">
          <Btn onClick={() => run(async () => { const r = await window.api.createTestReminder(1); return `Test reminder at ${fmtLocal(r.fire_at_utc)}` })}>+1 min</Btn>
          <Btn onClick={() => run(async () => { await window.api.createTestReminder(-10); return 'Past reminder created; should be delivered as missed now' })}>10 min ago</Btn>
          <Btn onClick={() => run(async () => { await window.api.sendTestNotification(); return 'Toast requested' })}>Test toast</Btn>
          <Btn onClick={() => run(async () => { await window.api.clearLog(); return 'Log cleared' })}>Clear log</Btn>
        </div>
      </section>
      <div className="flex gap-1 flex-wrap">
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-lg px-2 py-0.5 text-[11px] ${tab === k ? 'bg-cocoa text-cream' : 'bg-white/60 text-stone-600'}`}>
            {l}
          </button>
        ))}
      </div>
      <section className="rounded-2xl bg-white/70 p-3 flex flex-col min-h-0 flex-1">
        {tab === 'scheduler' && (
          <ol className="overflow-y-auto font-mono text-[10px] leading-relaxed flex flex-col gap-0.5 flex-1">
            {logs.map((l) => (
              <li key={l.id} className={levelColor[l.level] ?? ''}>
                <span className="text-stone-400">{fmtLogTime(l.at_utc)}</span> <span className="font-semibold">{l.event}</span>
                {l.detail && <span> — {l.detail}</span>}
              </li>
            ))}
          </ol>
        )}
        {tab === 'ai' && (
          <ol className="overflow-y-auto font-mono text-[10px] leading-relaxed flex flex-col gap-0.5 flex-1">
            {aiCalls.length === 0 && <li className="text-stone-400">No AI calls yet.</li>}
            {aiCalls.map((l) => (
              <li key={l.id} className={levelColor[l.level] ?? ''}>
                <span className="text-stone-400">{fmtLogTime(l.at_utc)}</span> <span className="font-semibold">{l.event}</span>
                {l.detail && <span> — {l.detail.slice(0, 220)}</span>}
              </li>
            ))}
          </ol>
        )}
        {tab === 'activity' && (
          <ol className="overflow-y-auto text-[11px] leading-relaxed flex flex-col gap-1 flex-1">
            {activities.length === 0 && <li className="text-stone-400">Nothing has happened yet.</li>}
            {activities.map((a) => (
              <li key={a.id} className="flex gap-2">
                <span className="text-stone-400 whitespace-nowrap">{fmtLogTime(a.created_at)}</span>
                <span className={`rounded px-1 text-[10px] ${a.actor === 'system' ? 'bg-stone-100 text-stone-500' : a.actor === 'assistant' ? 'bg-accent/20' : 'bg-emerald-100'}`}>{a.actor}</span>
                <span className={a.reversible ? '' : 'text-stone-500'}>{a.summary}</span>
              </li>
            ))}
          </ol>
        )}
        {tab === 'extractions' && (
          <ol className="overflow-y-auto font-mono text-[10px] leading-relaxed flex flex-col gap-1 flex-1">
            {extractions.length === 0 && <li className="text-stone-400">None yet.</li>}
            {extractions.map((x) => (
              <li key={x.id} className={x.applied ? 'text-stone-600' : 'text-red-700'}>
                <span className="text-stone-400">{fmtLogTime(x.created_at)}</span> {x.applied ? '✓' : '✗'} {x.tools_json.slice(0, 300)}
                {x.error && <div>error: {x.error}</div>}
              </li>
            ))}
          </ol>
        )}
        {tab === 'reminders' && (
          <div className="overflow-y-auto text-[11px] flex-1">
            {reminders.slice(0, 40).map((r) => (
              <div key={r.id} className="flex gap-2 py-0.5 cursor-pointer hover:bg-white" onClick={() => onOpenReminder(r)}>
                <span className="w-20 shrink-0 text-stone-500">{r.state}</span>
                <span className="truncate flex-1">{r.item_title ?? 'Reminder'}{r.rrule ? ' ↻' : ''}</span>
                <span className="text-stone-500 whitespace-nowrap">{fmtLocal(r.fire_at_utc)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function Btn({ onClick, children }: { onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className="rounded-lg bg-accent/15 hover:bg-accent/30 px-2 py-0.5 text-[11px] text-cocoa">
      {children}
    </button>
  )
}

function Row({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div className="flex gap-2">
      <span className="text-stone-500 w-10 shrink-0">{k}</span>
      <span className="break-all select-all">{v}</span>
    </div>
  )
}
