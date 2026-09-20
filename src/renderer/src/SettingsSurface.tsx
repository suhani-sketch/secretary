import { useEffect, useState } from 'react'
import type { AppInfo } from '../../shared/types'

/**
 * The Settings surface (spec §7, 9h): one real place for the preferences that don't already have a natural home —
 * scene choice lives in the room's own "scene" button, week start has a shortcut in the Calendar header, but
 * notification intensity, quiet hours and the default reminder time had no surface at all until now (8d's own
 * controls were conversation-only). Chrome deliberately reuses the same `rounded-2xl bg-white/60 p-4` section and
 * `text-xs font-medium uppercase tracking-wide text-stone-500` header the rail has used since Phase 1, and the same
 * `rounded-full` pill-button language the top navigation uses — so this reads as the same product's settings, not a
 * bolted-on preferences panel.
 *
 * Every write here goes through the exact tool a conversational instruction would ("be less pushy about reminders")
 * — never a raw settings row — so an activity is logged and the same validation applies either way (spec: manual
 * changes record activities exactly as AI changes do).
 */

type Intensity = 'normal' | 'low'

interface Props {
  theme: 'light' | 'dark'
  onSetTheme: (t: 'light' | 'dark') => void
  weekStart: number
  onSetWeekStart: (n: number) => void
  info: AppInfo | null
  say: (s: string) => void
  refresh: () => Promise<void>
  quick: (tool: string, args: Record<string, unknown>) => Promise<void>
  creatureName: string | null
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section
      className="rounded-xl p-4 flex flex-col gap-2"
      style={{
        background: 'var(--panel-bg-strong)',
        border: '1px solid var(--panel-hairline)',
        color: 'var(--panel-text)'
      }}
    >
      <div>
        <h2 className="chapter-heading" style={{ color: 'var(--color-accent)' }}>{title}</h2>
        {hint && (
          <p
            className="italic mt-1"
            style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontSize: 13, color: 'var(--panel-text-soft)' }}
          >
            {hint}
          </p>
        )}
      </div>
      {children}
    </section>
  )
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="rounded-full px-3.5 py-1 text-[13px] italic transition-colors"
      style={{
        fontFamily: '"Cormorant Garamond", Georgia, serif',
        letterSpacing: '0.05em',
        color: active ? 'var(--panel-text)' : 'var(--panel-text-soft)',
        background: active ? 'color-mix(in srgb, var(--color-accent) 22%, var(--panel-bg))' : 'color-mix(in srgb, var(--panel-bg-strong) 70%, transparent)',
        border: `1px solid color-mix(in srgb, var(--color-accent) ${active ? 55 : 30}%, transparent)`
      }}
    >
      {children}
    </button>
  )
}

export function SettingsSurface(p: Props): React.JSX.Element {
  const [intensity, setIntensity] = useState<Intensity>('normal')
  const [quietStart, setQuietStart] = useState('')
  const [quietEnd, setQuietEnd] = useState('')
  const [quietDraftStart, setQuietDraftStart] = useState('22:00')
  const [quietDraftEnd, setQuietDraftEnd] = useState('08:00')
  const [defaultReminderTime, setDefaultReminderTime] = useState<{ value: string; stated: boolean } | null>(null)
  const [reminderDraft, setReminderDraft] = useState('09:00')
  const [aiStatus, setAiStatus] = useState<{ hasKey: boolean; keyHint: string | null; model: string } | null>(null)
  const [keyDraft, setKeyDraft] = useState('')

  const loadPrefs = async (): Promise<void> => {
    const [ni, qs, qe, prefs, ai] = await Promise.all([
      window.api.getSetting('notify.intensity'),
      window.api.getSetting('notify.quiet_start'),
      window.api.getSetting('notify.quiet_end'),
      window.api.listPreferences(),
      window.api.aiGetStatus()
    ])
    setIntensity(ni === 'low' ? 'low' : 'normal')
    setQuietStart(qs ?? '')
    setQuietEnd(qe ?? '')
    if (qs) setQuietDraftStart(qs)
    if (qe) setQuietDraftEnd(qe)
    const drt = prefs.find((x) => x.key === 'default_reminder_time')
    setDefaultReminderTime(drt ? { value: drt.value, stated: drt.source === 'stated' } : null)
    if (drt) setReminderDraft(drt.value)
    setAiStatus(ai)
  }

  useEffect(() => {
    void loadPrefs()
  }, [])

  const setIntensityAndSave = async (level: Intensity): Promise<void> => {
    await p.quick('set_notification_intensity', { level })
    await loadPrefs()
  }
  const saveQuietHours = async (): Promise<void> => {
    await p.quick('set_quiet_hours', { start_local: quietDraftStart, end_local: quietDraftEnd })
    await loadPrefs()
  }
  const clearQuietHours = async (): Promise<void> => {
    await p.quick('set_quiet_hours', { clear: true })
    await loadPrefs()
  }
  const saveReminderTime = async (): Promise<void> => {
    await p.quick('set_preference', { key: 'default_reminder_time', value: reminderDraft })
    await loadPrefs()
  }
  const saveKey = async (): Promise<void> => {
    const res = await window.api.aiSetKey(keyDraft.trim())
    setAiStatus(res)
    setKeyDraft('')
    p.say(res.hasKey ? 'Key saved — chat is ready.' : 'Key cleared.')
  }

  return (
    <div className="surface-dark-panel flex flex-col min-h-0 h-full gap-4">
      <header
        className="flex items-center gap-3 rounded-2xl px-5 py-3"
        style={{
          background: 'var(--panel-bg)',
          border: '1px solid var(--panel-hairline)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)'
        }}
      >
        <span
          className="italic tracking-tight"
          style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontSize: 26, color: 'var(--panel-text)' }}
        >
          Settings
        </span>
        <span
          className="hidden lg:inline whitespace-nowrap italic opacity-70"
          style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontSize: 13, color: 'var(--panel-text-soft)' }}
        >
          how the Secretary behaves; quiet hours, defaults, the small things
        </span>
      </header>

      <div
        className="flex-1 min-h-0 rounded-2xl p-5 overflow-y-auto"
        style={{
          background: 'var(--panel-bg)',
          border: '1px solid var(--panel-hairline)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          color: 'var(--panel-text)'
        }}
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 content-start max-w-4xl">
          <Section title="Appearance">
            <div className="flex gap-2">
              <Pill active={p.theme === 'light'} onClick={() => p.onSetTheme('light')}>☀ light</Pill>
              <Pill active={p.theme === 'dark'} onClick={() => p.onSetTheme('dark')}>☾ dark</Pill>
            </div>
          </Section>

          <Section title="Calendar" hint="which day the week starts on">
            <div className="flex gap-2">
              {([[1, 'Mon'], [0, 'Sun'], [6, 'Sat']] as [number, string][]).map(([n, label]) => (
                <Pill key={n} active={p.weekStart === n} onClick={() => p.onSetWeekStart(n)}>{label}</Pill>
              ))}
            </div>
          </Section>

          <Section title="Notifications" hint='"be less pushy about reminders" does exactly this, said out loud'>
            <div className="flex gap-2">
              <Pill active={intensity === 'normal'} onClick={() => void setIntensityAndSave('normal')}>normal</Pill>
              <Pill active={intensity === 'low'} onClick={() => void setIntensityAndSave('low')}>less pushy</Pill>
            </div>
            {intensity === 'low' && (
              <p className="text-xs text-stone-400">Toasts won't demand a response, and deadline alerts only fire when something genuinely won't fit.</p>
            )}
          </Section>

          <Section title="Quiet hours" hint="reminders and deadline alerts wait until this window ends; nothing about the conversation itself is held back">
            {quietStart && quietEnd ? (
              <p className="text-sm text-stone-600">
                Quiet from <span className="font-medium">{quietStart}</span> to <span className="font-medium">{quietEnd}</span>
              </p>
            ) : (
              <p className="text-sm text-stone-400">Not set — notify any time.</p>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <input type="time" value={quietDraftStart} onChange={(e) => setQuietDraftStart(e.target.value)} className="bg-white/80 rounded-lg px-2 py-1 text-sm" />
              <span className="text-stone-400 text-xs">to</span>
              <input type="time" value={quietDraftEnd} onChange={(e) => setQuietDraftEnd(e.target.value)} className="bg-white/80 rounded-lg px-2 py-1 text-sm" />
              <button className="rounded-lg px-2.5 py-1 text-sm bg-cocoa text-cream hover:bg-cocoa/90" onClick={() => void saveQuietHours()}>Save</button>
              {quietStart && quietEnd && (
                <button className="rounded-lg px-2.5 py-1 text-sm bg-white/80 hover:bg-white text-stone-600" onClick={() => void clearQuietHours()}>Turn off</button>
              )}
            </div>
          </Section>

          <Section title="Reminders" hint="used when a reminder is asked for on a day with no clock time stated">
            <p className="text-sm text-stone-600">
              Default time: <span className="font-medium">{defaultReminderTime?.value ?? '09:00'}</span>
              {defaultReminderTime && !defaultReminderTime.stated && <span className="text-stone-400"> (the app's own default)</span>}
            </p>
            <div className="flex items-center gap-2">
              <input type="time" value={reminderDraft} onChange={(e) => setReminderDraft(e.target.value)} className="bg-white/80 rounded-lg px-2 py-1 text-sm" />
              <button className="rounded-lg px-2.5 py-1 text-sm bg-cocoa text-cream hover:bg-cocoa/90" onClick={() => void saveReminderTime()}>Save</button>
            </div>
          </Section>

          <Section title="Startup">
            {p.info && (
              <label className="flex items-center gap-2 cursor-pointer text-sm text-stone-600">
                <input
                  type="checkbox"
                  checked={p.info.openAtLogin}
                  onChange={async (e) => {
                    const on = await window.api.setOpenAtLogin(e.target.checked)
                    p.say(on ? 'Starts with Windows' : 'Will not start with Windows')
                    await p.refresh()
                  }}
                />
                Start with Windows
              </label>
            )}
          </Section>

          <Section title="The room" hint="favourite scenes and rotation live in the room's own scene button — a visual choice, kept beside what it changes">
            <p className="text-sm">{p.creatureName ? `Named ${p.creatureName}.` : 'Not yet named.'}</p>
          </Section>

          <Section title="AI key" hint="a free Gemini key from aistudio.google.com/apikey — this is what lets typed and spoken messages be understood">
            <p className="text-sm">
              {aiStatus?.hasKey ? (
                <>Key set{aiStatus.keyHint ? <span style={{ opacity: 0.7 }}> · ending {aiStatus.keyHint}</span> : null} · <span style={{ opacity: 0.7 }}>{aiStatus.model.split(',')[0]}</span></>
              ) : (
                <span style={{ opacity: 0.7 }}>No key set — chat will explain instead of working.</span>
              )}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="paste your Gemini key"
                className="bg-white/80 rounded-lg px-2 py-1 text-sm w-56"
              />
              <button className="rounded-lg px-2.5 py-1 text-sm bg-cocoa text-cream hover:bg-cocoa/90 disabled:opacity-40" disabled={!keyDraft.trim()} onClick={() => void saveKey()}>Save</button>
              {aiStatus?.hasKey && (
                <button className="rounded-lg px-2.5 py-1 text-sm bg-white/80 hover:bg-white text-stone-600" onClick={() => { setKeyDraft(''); void window.api.aiSetKey('').then((r) => { setAiStatus(r); p.say('Key cleared.') }) }}>Clear</button>
              )}
            </div>
          </Section>

          <Section title="Your data" hint="the whole database is one file on your machine; take a copy of it whenever you like">
            <div className="flex gap-2 flex-wrap">
              <button
                className="rounded-full px-3.5 py-1 text-[13px] italic transition-colors"
                style={{
                  fontFamily: '"Cormorant Garamond", Georgia, serif',
                  letterSpacing: '0.05em',
                  color: 'var(--panel-text)',
                  background: 'color-mix(in srgb, var(--color-accent) 22%, var(--panel-bg))',
                  border: '1px solid color-mix(in srgb, var(--color-accent) 55%, transparent)'
                }}
                onClick={async () => {
                  const r = await window.api.dataExport()
                  if (r.ok) p.say(`Backup saved to ${r.path.split(/[/\\]/).pop() ?? r.path}`)
                  else if (r.reason !== 'cancelled') p.say(`Backup failed: ${r.reason}`)
                }}
                title="Write a full copy of the database to a place you choose"
              >
                Save a backup…
              </button>
              <button
                className="rounded-full px-3.5 py-1 text-[13px] italic transition-colors"
                style={{
                  fontFamily: '"Cormorant Garamond", Georgia, serif',
                  letterSpacing: '0.05em',
                  color: 'var(--panel-text-soft)',
                  background: 'color-mix(in srgb, var(--panel-bg-strong) 70%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)'
                }}
                onClick={async () => {
                  const r = await window.api.dataReveal()
                  if (!r.ok) p.say(`Could not open the folder: ${r.reason}`)
                }}
                title="Open the folder that holds the live database"
              >
                Show the file
              </button>
            </div>
            <p className="italic text-xs mt-1" style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', color: 'var(--panel-text-soft)' }}>
              To restore a backup, quit Secretary and copy the saved <span className="font-medium">.db</span> file over the live one — the folder button above opens the right place.
            </p>
          </Section>
        </div>
      </div>
    </div>
  )
}
