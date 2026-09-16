import type { DaySummary, Item, PriorityEntry } from '../../../shared/types'

/**
 * Visual grammar (spec §8 6c) — one vocabulary for every calendar surface, so Day, Week, Month and Agenda read alike.
 *
 * Importance is one axis (critical · high · normal · low), hardness another (hard deadline · soft target). Both are
 * shown, and never by colour alone: every tone travels with a glyph and a word. Types are visually distinct — event as a
 * solid block, work block lighter, session, deadline as a strong marker, due task in the Due area, reminder as a bell,
 * commitment with its own marker, happening ephemeral, constraint hatched.
 */

export type ImportanceLevel = 0 | 1 | 2 | 3

export const IMPORTANCE: Record<ImportanceLevel, { word: string; glyph: string; text: string; badge: string; weight: string }> = {
  0: { word: 'critical', glyph: '‼', text: 'text-rose-900', badge: 'bg-rose-100 text-rose-900', weight: 'font-semibold' },
  1: { word: 'high', glyph: '!', text: 'text-amber-900', badge: 'bg-amber-100 text-amber-900', weight: 'font-medium' },
  2: { word: 'normal', glyph: '•', text: 'text-stone-600', badge: 'bg-stone-100 text-stone-600', weight: '' },
  3: { word: 'low', glyph: '·', text: 'text-stone-400', badge: 'bg-stone-50 text-stone-400', weight: 'font-light' }
}

export const importanceOf = (i: Item): ImportanceLevel => (Math.max(0, Math.min(3, i.importance ?? 2)) as ImportanceLevel)
export const isHard = (i: Item): boolean => i.hardness === 'hard' || i.kind === 'deadline'

/** Type grammar for anything that can appear on a calendar surface. */
export type Grammar = 'event' | 'commitment' | 'work_block' | 'session' | 'deadline' | 'task' | 'reminder' | 'happening' | 'constraint' | 'waiting' | 'note' | 'project' | 'checklist_item' | 'idea'
export const TYPE: Record<Grammar, { glyph: string; word: string; chip: string }> = {
  event: { glyph: '▪', word: 'event', chip: 'bg-[#8B6A55] text-[#FAF6F0]' },
  commitment: { glyph: '🤝', word: 'appointment', chip: 'bg-[#9C6E5A] text-[#FAF6F0]' },
  work_block: { glyph: '▤', word: 'work block', chip: 'bg-[#D9B79F] text-[#3A2E28]' },
  session: { glyph: '📘', word: 'session', chip: 'bg-[#8FA3B5] text-[#FAF6F0]' },
  deadline: { glyph: '◆', word: 'deadline', chip: 'bg-[#3A2E28] text-[#FAF6F0]' },
  task: { glyph: '☐', word: 'task', chip: 'bg-white text-[#3A2E28] ring-1 ring-stone-200' },
  reminder: { glyph: '🔔', word: 'reminder', chip: 'bg-white text-[#3A2E28] ring-1 ring-stone-200' },
  happening: { glyph: '⏱', word: 'happening', chip: 'border border-dashed border-[#B5836D] text-stone-600' },
  constraint: { glyph: '▨', word: 'unavailable', chip: 'bg-stone-200/60 text-stone-500' },
  waiting: { glyph: '⏳', word: 'waiting on', chip: 'bg-sky-50 text-sky-900' },
  note: { glyph: '📝', word: 'note', chip: 'bg-white text-stone-600 ring-1 ring-stone-200' },
  project: { glyph: '◼', word: 'thing', chip: 'bg-[#B5836D]/25 text-[#3A2E28]' },
  checklist_item: { glyph: '☐', word: 'step', chip: 'bg-white text-stone-600 ring-1 ring-stone-200' },
  idea: { glyph: '○', word: 'idea', chip: 'bg-white text-stone-400 ring-1 ring-stone-200' }
}

export const grammarOf = (i: Item): Grammar => (isHard(i) && i.kind !== 'commitment' ? 'deadline' : i.kind === 'commitment' ? 'commitment' : i.kind === 'waiting' ? 'waiting' : i.kind === 'project' ? 'project' : i.kind === 'checklist_item' ? 'checklist_item' : i.kind === 'idea' ? 'idea' : i.kind === 'note' ? 'note' : 'task')

/** Both axes of an item, as glyph + word each: "◆ hard deadline" and "! high". The tone is extra, never the only signal. */
export function Marks({ item, overdue, className = '' }: { item: Item; overdue?: boolean; className?: string }): React.JSX.Element {
  const imp = IMPORTANCE[importanceOf(item)]
  const t = TYPE[grammarOf(item)]
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {overdue && (
        <span className="inline-flex items-center gap-0.5 rounded px-1 text-[10px] bg-amber-100 text-amber-900" title="overdue">
          <span aria-hidden>⚠</span>overdue
        </span>
      )}
      <span className={`inline-flex items-center gap-0.5 rounded px-1 text-[10px] ${imp.badge}`} title={`${imp.word} importance`}>
        <span aria-hidden>{imp.glyph}</span>
        {imp.word}
      </span>
      {isHard(item) && (
        <span className="inline-flex items-center gap-0.5 rounded px-1 text-[10px] bg-[#3A2E28] text-[#FAF6F0]" title="hard deadline — the date is not negotiable">
          <span aria-hidden>◆</span>hard
        </span>
      )}
      {item.hardness === 'soft' && <span className="inline-flex items-center rounded px-1 text-[10px] bg-stone-100 text-stone-500">soft target</span>}
      {item.kind === 'commitment' && (
        <span className="inline-flex items-center gap-0.5 rounded px-1 text-[10px] bg-rose-50 text-rose-900" title="a promise to someone">
          <span aria-hidden>{t.glyph}</span>to {item.committed_to ?? 'someone'}
        </span>
      )}
    </span>
  )
}

/** The leading glyph for a row: the type first (deadline is a strong marker), the importance tone on it. */
export function TypeGlyph({ item, overdue }: { item: Item; overdue?: boolean }): React.JSX.Element {
  const g = grammarOf(item)
  const imp = IMPORTANCE[importanceOf(item)]
  const glyph = overdue ? '⚠' : TYPE[g].glyph
  return (
    <span className={`w-5 text-center shrink-0 ${overdue ? 'text-amber-800' : g === 'deadline' ? 'text-[#3A2E28] font-bold' : imp.text} ${imp.weight}`} title={`${TYPE[g].word} · ${imp.word}${isHard(item) ? ' · hard' : ''}${overdue ? ' · overdue' : ''}`} aria-label={`${TYPE[g].word}, ${imp.word}${isHard(item) ? ', hard deadline' : ''}${overdue ? ', overdue' : ''}`}>
      {glyph}
    </span>
  )
}

/** Title weight follows importance too, so the eye lands on what matters even in monochrome. */
export const titleClass = (i: Item): string => IMPORTANCE[importanceOf(i)].weight

/**
 * The compact priority summary a day carries BEFORE its panel is opened (spec 6c): counts as chips, each with a glyph and a
 * word, plus the top priorities by name. Built only from DaySummary + PriorityEntry so Month cells (6d) can use it too.
 */
export function PrioritySummary({ summary, priorities, compact }: { summary: DaySummary; priorities?: PriorityEntry[]; compact?: boolean }): React.JSX.Element | null {
  if (summary.is_past) return null
  const chips: { glyph: string; text: string; cls: string; title: string }[] = []
  if (summary.overdue && (summary.is_today || !compact)) chips.push({ glyph: '⚠', text: `${summary.overdue} overdue`, cls: 'bg-amber-100 text-amber-900', title: 'unresolved from earlier' })
  const critical = priorities?.filter((p) => importanceOf(p.item) === 0 && (!compact || summary.is_today || !p.overdue)).length ?? 0
  if (critical) chips.push({ glyph: '‼', text: `${critical} critical`, cls: 'bg-rose-100 text-rose-900', title: 'critical importance' })
  if (summary.hard_deadlines) chips.push({ glyph: '◆', text: `${summary.hard_deadlines} hard deadline${summary.hard_deadlines === 1 ? '' : 's'}`, cls: 'bg-[#3A2E28] text-[#FAF6F0]', title: 'dates that are not negotiable' })
  if (summary.commitments) chips.push({ glyph: '🤝', text: `${summary.commitments} promise${summary.commitments === 1 ? '' : 's'}`, cls: 'bg-rose-50 text-rose-900', title: 'commitments to named people' })
  if (summary.high_importance) chips.push({ glyph: '!', text: `${summary.high_importance} high`, cls: 'bg-amber-50 text-amber-900', title: 'high importance' })
  if (summary.conflicts) chips.push({ glyph: '✕', text: `${summary.conflicts} clash${summary.conflicts === 1 ? '' : 'es'}`, cls: 'bg-rose-100 text-rose-900', title: 'overlapping bookings' })
  if (summary.scheduled_minutes) chips.push({ glyph: '▪', text: `${Math.round(summary.scheduled_minutes / 6) / 10} h booked`, cls: 'bg-[#8B6A55]/15 text-[#3A2E28]', title: 'time already scheduled' })
  if (summary.due && !compact) chips.push({ glyph: '☐', text: `${summary.due} due`, cls: 'bg-white text-stone-700 ring-1 ring-stone-200', title: 'date-bound, no time set aside' })
  if (summary.reminders && !compact) chips.push({ glyph: '🔔', text: `${summary.reminders}`, cls: 'bg-white text-stone-700 ring-1 ring-stone-200', title: 'reminders' })
  const top = (priorities ?? []).filter((p) => !compact || summary.is_today || !p.overdue).slice(0, compact ? 1 : 3)
  if (!chips.length && !top.length) return compact ? null : <span className="text-xs text-stone-400">Nothing pressing.</span>
  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${compact ? 'text-[10px]' : 'text-xs'}`}>
      {chips.map((c) => (
        <span key={c.text} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${c.cls}`} title={c.title}>
          <span aria-hidden>{c.glyph}</span>
          {c.text}
        </span>
      ))}
      {top.length > 0 && (
        <span className="text-stone-600 truncate" title={top.map((p) => p.item.title).join(', ')}>
          {compact ? '' : 'first: '}
          {top.map((p) => p.item.title).join(compact ? '' : ' · ')}
        </span>
      )}
    </div>
  )
}

/** A one-line legend so the grammar is learnable at a glance; shown on the calendar surface, never in the way. */
export function Legend(): React.JSX.Element {
  const items: Grammar[] = ['event', 'commitment', 'work_block', 'deadline', 'task', 'reminder', 'happening', 'constraint']
  return (
    <div className="flex items-center gap-2 flex-wrap text-[10px] text-stone-500">
      {items.map((g) => (
        <span key={g} className="inline-flex items-center gap-1">
          <span className={`inline-flex items-center justify-center w-4 h-4 rounded ${TYPE[g].chip}`} aria-hidden>
            {TYPE[g].glyph}
          </span>
          {TYPE[g].word}
        </span>
      ))}
      <span className="inline-flex items-center gap-1 ml-2">
        <span className="text-rose-900">‼ critical</span> <span className="text-amber-900">! high</span> <span className="text-stone-600">• normal</span> <span className="text-stone-400">· low</span>
      </span>
    </div>
  )
}
