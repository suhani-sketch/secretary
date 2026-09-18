import { useState } from 'react'
import type { Item } from '../../shared/types'
import { formatDue } from '../../shared/format'
import { Marks, TypeGlyph, titleClass } from './calendar/grammar'

/**
 * The Things surface (spec §7, 9h): the structured counterpart to the calendar's density — every Thing (project) the
 * assistant is tracking, at a glance. Header and card chrome deliberately reuse the Calendar surface's own vocabulary
 * (`rounded-3xl bg-white/50`, the `rounded-xl bg-white/80 p-0.5` tab switch, the `bg-cocoa text-cream` active state) so
 * the two dense/structured surfaces the spec calls out read as one product, not two.
 *
 * Things are never created from here — spec 3a is explicit that a project is "inferred from conversation, never
 * created by hand" — so this surface has no "+ new" button, only a way to see and open what already exists.
 */

const dayAgo = (iso: string | null): string => {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const days = Math.floor(ms / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  const weeks = Math.floor(days / 7)
  return `${weeks} week${weeks === 1 ? '' : 's'} ago`
}

interface Props {
  active: Item[]
  archived: Item[]
  partsOf: Map<string, number>
  lastActivityAt: Map<string, string>
  onOpen: (project: Item) => void
}

export function ThingsSurface({ active, archived, partsOf, lastActivityAt, onOpen }: Props): React.JSX.Element {
  const [tab, setTab] = useState<'active' | 'archived'>('active')
  const rows = (tab === 'active' ? active : archived)
    .slice()
    .sort((a, b) => (lastActivityAt.get(b.id) ?? b.updated_at).localeCompare(lastActivityAt.get(a.id) ?? a.updated_at))

  return (
    <div className="flex flex-col min-h-0 h-full gap-4">
      <header className="flex items-center gap-3 rounded-3xl bg-white/50 px-5 py-3">
        <span className="text-xl font-semibold tracking-tight">Things</span>
        <span className="text-xs text-stone-400 hidden lg:inline whitespace-nowrap">
          every project the assistant is tracking — structured, at a glance
        </span>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex rounded-xl bg-white/80 p-0.5" role="tablist" aria-label="Things view">
            {(
              [
                ['active', `Active (${active.length})`],
                ['archived', `Done (${archived.length})`]
              ] as [typeof tab, string][]
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`rounded-lg px-3 py-1 text-sm ${tab === id ? 'bg-cocoa text-cream' : 'text-stone-600 hover:bg-white'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 rounded-3xl bg-white/50 p-5 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-stone-400 text-center">
            {tab === 'active' ? (
              <div>
                <div className="text-base text-stone-500 mb-1">Nothing here yet.</div>
                <div>A Thing appears once you mention something with real parts — "the TISS mailing is something I need to deal with."</div>
              </div>
            ) : (
              <div>Nothing finished yet.</div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 content-start">
            {rows.map((p) => {
              const open = partsOf.get(p.id) ?? 0
              const last = lastActivityAt.get(p.id)
              return (
                <button
                  key={p.id}
                  onClick={() => onOpen(p)}
                  className="item-in group text-left rounded-2xl bg-white/70 hover:bg-white p-4 flex flex-col gap-2 min-w-0"
                >
                  <div className="flex items-start gap-2">
                    <TypeGlyph item={p} />
                    <div className="min-w-0 flex-1">
                      <div className={`truncate font-medium ${titleClass(p)}`}>{p.title}</div>
                      <Marks item={p} className="mt-1" />
                    </div>
                  </div>
                  <div className="text-xs text-stone-500 flex items-center justify-between mt-auto pt-1">
                    <span>
                      {tab === 'active'
                        ? open === 0
                          ? 'no open parts'
                          : `${open} open part${open === 1 ? '' : 's'}`
                        : `${p.status === 'archived' ? 'archived' : 'done'}`}
                    </span>
                    {p.due_at_utc && <span>{formatDue(p.due_at_utc, p.due_precision)}</span>}
                  </div>
                  {last && <div className="text-[11px] text-stone-400">last activity {dayAgo(last)}</div>}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
