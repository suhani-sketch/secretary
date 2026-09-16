import { useMemo, useRef } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import listPlugin from '@fullcalendar/list'
import interactionPlugin from '@fullcalendar/interaction'
import type { CalendarApi, DateSelectArg, DatesSetArg, EventClickArg, EventContentArg, EventDropArg, EventInput } from '@fullcalendar/core'
import type { EventResizeDoneArg } from '@fullcalendar/interaction'

/**
 * The ONLY file that imports FullCalendar. Everything else speaks this small interface, so a library upgrade (v6 → v7)
 * or a swap touches this file alone. Pinned to 6.1.21 across all @fullcalendar packages (they must match).
 *
 * Our model in, our callbacks out. The adapter knows nothing about items, reminders or SQLite.
 */

export type GridView = 'month' | 'week' | 'day' | 'list'

/** What the grid draws. `kind` drives the visual grammar; `data` is handed back untouched in callbacks. */
export interface GridEntry {
  id: string
  title: string
  startUtc: string
  endUtc: string | null
  allDay: boolean
  kind: 'event' | 'commitment' | 'work_block' | 'session' | 'due' | 'reminder' | 'happening' | 'constraint'
  /** Whether the user may drag/resize it. Due markers and constraints are never movable here. */
  editable: boolean
  /** Extra colour hint (importance band etc.). Never the only signal — the renderer adds icon/label too. */
  tone?: 'critical' | 'high' | 'normal' | 'low' | 'muted'
  data?: unknown
}

export interface GridCallbacks {
  onEntryClick?: (entry: GridEntry) => void
  onDayClick?: (dateLocal: string) => void
  onEntryMoved?: (entry: GridEntry, newStartUtc: string, newEndUtc: string | null, allDay: boolean, revert: () => void) => void
  onEntryResized?: (entry: GridEntry, newStartUtc: string, newEndUtc: string, revert: () => void) => void
  onRangeSelected?: (startUtc: string, endUtc: string, allDay: boolean) => void
  onExternalDrop?: (payload: unknown, startUtc: string, endUtc: string | null, allDay: boolean) => void
  onVisibleRangeChanged?: (startUtc: string, endUtc: string) => void
}

interface Props extends GridCallbacks {
  view: GridView
  dateLocal: string
  entries: GridEntry[]
  renderEntry?: (entry: GridEntry) => React.ReactNode
  renderDayCell?: (dateLocal: string) => React.ReactNode
  /** Business/awake hours shown lighter; outside them the grid is shaded. */
  dayStartHour?: number
  dayEndHour?: number
  /** Show the all-day row (the Due strip in week view). The day view has its own Due list and hides it. */
  allDayRow?: boolean
}

const VIEW_NAME: Record<GridView, string> = { month: 'dayGridMonth', week: 'timeGridWeek', day: 'timeGridDay', list: 'listWeek' }

const toIso = (d: Date | null): string | null => (d ? d.toISOString() : null)
const localDate = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function CalendarGrid(p: Props): React.JSX.Element {
  const ref = useRef<FullCalendar>(null)
  const byId = useMemo(() => new Map(p.entries.map((e) => [e.id, e])), [p.entries])

  const events: EventInput[] = useMemo(
    () =>
      p.entries.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.startUtc,
        end: e.endUtc ?? undefined,
        allDay: e.allDay,
        editable: e.editable,
        durationEditable: e.editable && !e.allDay,
        display: e.kind === 'constraint' ? 'background' : 'auto',
        classNames: [`k-${e.kind}`, e.tone ? `t-${e.tone}` : ''].filter(Boolean),
        extendedProps: { entry: e }
      })),
    [p.entries]
  )

  // Keep the library's own navigation in step with our date/view props.
  const api = (): CalendarApi | null => ref.current?.getApi() ?? null
  const wanted = VIEW_NAME[p.view]
  const a = api()
  if (a) {
    if (a.view.type !== wanted) a.changeView(wanted, p.dateLocal)
    else if (localDate(a.getDate()) !== p.dateLocal && p.view === 'day') a.gotoDate(p.dateLocal)
  }

  return (
    <FullCalendar
      ref={ref}
      plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
      initialView={wanted}
      initialDate={p.dateLocal}
      headerToolbar={false}
      height="100%"
      expandRows
      nowIndicator
      firstDay={1}
      slotMinTime={`${String(p.dayStartHour ?? 6).padStart(2, '0')}:00:00`}
      slotMaxTime={`${String(p.dayEndHour ?? 24).padStart(2, '0')}:00:00`}
      slotDuration="00:30:00"
      snapDuration="00:15:00"
      scrollTime="08:00:00"
      allDaySlot={p.allDayRow ?? true}
      allDayText="due"
      dayMaxEvents={4}
      selectable={!!p.onRangeSelected}
      selectMirror
      editable
      droppable={!!p.onExternalDrop}
      eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
      slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
      events={events}
      eventContent={(arg: EventContentArg) => {
        const entry = arg.event.extendedProps['entry'] as GridEntry | undefined
        if (!entry || !p.renderEntry) return true
        return <>{p.renderEntry(entry)}</>
      }}
      dayCellContent={(arg) => {
        const extra = p.renderDayCell?.(localDate(arg.date))
        return (
          <div className="fc-daycell">
            <span className="fc-daynum">{arg.dayNumberText}</span>
            {extra}
          </div>
        )
      }}
      eventClick={(arg: EventClickArg) => {
        const entry = byId.get(arg.event.id)
        if (entry) p.onEntryClick?.(entry)
      }}
      dateClick={(arg) => p.onDayClick?.(localDate(arg.date))}
      select={(arg: DateSelectArg) => {
        p.onRangeSelected?.(arg.start.toISOString(), arg.end.toISOString(), arg.allDay)
        api()?.unselect()
      }}
      eventDrop={(arg: EventDropArg) => {
        const entry = byId.get(arg.event.id)
        if (!entry) return arg.revert()
        p.onEntryMoved?.(entry, arg.event.start!.toISOString(), toIso(arg.event.end), arg.event.allDay, arg.revert)
      }}
      eventResize={(arg: EventResizeDoneArg) => {
        const entry = byId.get(arg.event.id)
        if (!entry || !arg.event.end) return arg.revert()
        p.onEntryResized?.(entry, arg.event.start!.toISOString(), arg.event.end.toISOString(), arg.revert)
      }}
      eventReceive={(arg) => {
        // Something dragged in from outside (the unscheduled list): hand the payload up and drop the library's copy —
        // the real row comes back through our data after the tool layer has written it.
        const payload = arg.event.extendedProps['payload']
        p.onExternalDrop?.(payload, arg.event.start!.toISOString(), toIso(arg.event.end), arg.event.allDay)
        arg.event.remove()
      }}
      datesSet={(arg: DatesSetArg) => p.onVisibleRangeChanged?.(arg.start.toISOString(), arg.end.toISOString())}
    />
  )
}

export { Draggable as ExternalDraggable } from '@fullcalendar/interaction'
