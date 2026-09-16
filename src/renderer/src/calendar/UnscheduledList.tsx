import { useEffect, useMemo, useRef, useState } from 'react'
import type { Item } from '../../../shared/types'
import { formatDue, isOverdue } from '../../../shared/format'
import { Marks, TypeGlyph, titleClass } from './grammar'
import { useExternalDraggable } from './dragging'

/**
 * The unscheduled area (spec §8 6e): obligations that have a deadline but no time set aside — the days' `unscheduled`
 * plus today's carried-in `overdue`, from the same Day View Model. Drag one onto the grid and a work block is created
 * for it (the task itself is untouched; it then reads "time set aside"). Nothing here is a copy: every row is the item.
 */

interface Props {
  refreshKey: number
  onSelect: (date: string, itemId: string) => void
}

const localDateOf = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function UnscheduledList({ refreshKey, onSelect }: Props): React.JSX.Element {
  const ref = useRef<HTMLUListElement>(null)
  const [items, setItems] = useState<Item[]>([])
  useEffect(() => {
    let alive = true
    void window.api.listUnscheduled().then((r) => alive && setItems(r))
    return () => {
      alive = false
    }
  }, [refreshKey])
  const rows = useMemo(() => {
    const now = new Date().toISOString()
    return items.map((item) => ({ item, date: localDateOf(item.due_at_utc!), overdue: !!item.due_at_utc && isOverdue(item.due_at_utc, item.due_precision) && item.due_at_utc < now }))
  }, [items])
  useExternalDraggable(ref, [rows.map((r) => r.item.id).join(',')])
  return (
    <aside className="flex flex-col min-h-0 h-full">
      <h3 className="text-xs font-medium uppercase tracking-wide text-stone-500 mb-1">
        Unscheduled <span className="text-stone-400">({rows.length})</span>
      </h3>
      <p className="text-[10px] text-stone-400 mb-2">Deadline, no time set aside. Drag one onto the grid to block time for it.</p>
      <ul ref={ref} className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1 pr-1">
        {rows.map(({ item, date, overdue }) => (
          <li
            key={item.id}
            data-item-id={item.id}
            data-title={item.title}
            className={`cursor-grab active:cursor-grabbing rounded-xl px-2 py-1.5 text-sm bg-white/80 hover:bg-white ring-1 ${overdue ? 'ring-amber-300' : 'ring-stone-200'} select-none`}
            onClick={() => onSelect(date, item.id)}
            title="Drag onto the calendar to set time aside"
          >
            <div className="flex items-start gap-1.5">
              <TypeGlyph item={item} overdue={overdue} />
              <div className="min-w-0 flex-1">
                <div className={`break-words leading-snug ${titleClass(item)}`}>{item.title}</div>
                <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                  <Marks item={item} overdue={overdue} />
                  {item.due_at_utc && <span className="text-[10px] text-stone-500">{overdue ? 'was due' : 'due'} {formatDue(item.due_at_utc, item.due_precision)}</span>}
                </div>
              </div>
            </div>
          </li>
        ))}
        {!rows.length && <li className="text-xs text-stone-400 px-1">Everything with a deadline has time set aside.</li>}
      </ul>
    </aside>
  )
}
