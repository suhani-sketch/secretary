/** What the day detail panel is focused on (spec 6b). The date is always shown; a selected thing is expanded on top. */
export type Selection =
  | { kind: 'date' }
  | { kind: 'item'; id: string }
  | { kind: 'event'; id: string; occurrenceStartUtc: string }
  | { kind: 'reminder'; id: string }
  | { kind: 'happening'; id: string }
