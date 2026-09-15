import { getDb } from './db'
import type { LogLevel, SchedulerLogEntry } from '../shared/types'

/**
 * Scheduler debug log. Every scheduler/notifier action is written here so silent
 * failures can be seen. Also mirrored to the console.
 */
export function log(level: LogLevel, event: string, detail?: string, reminderId?: string | null): void {
  const at = new Date().toISOString()
  const line = `[${at}] ${level.toUpperCase()} ${event}${detail ? ' — ' + detail : ''}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  try {
    getDb()
      .prepare('INSERT INTO scheduler_log (at_utc, level, event, detail, reminder_id) VALUES (?, ?, ?, ?, ?)')
      .run(at, level, event, detail ?? null, reminderId ?? null)
  } catch (e) {
    console.error('failed to write scheduler_log', e)
  }
}

export function listLog(limit = 50): SchedulerLogEntry[] {
  return getDb()
    .prepare('SELECT * FROM scheduler_log ORDER BY id DESC LIMIT ?')
    .all(limit) as SchedulerLogEntry[]
}

export function clearLog(): void {
  getDb().prepare('DELETE FROM scheduler_log').run()
}
