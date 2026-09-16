// The recurrence engine lives in src/core (platform-independent, no Electron, no SQLite). This shim keeps existing
// imports working; new code should import from '../core/recurrence' directly.
export * from '../core/recurrence'
