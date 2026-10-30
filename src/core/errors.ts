/**
 * Structured failures for the Workspace-Organizer host core.
 *
 * Every failure carries a stable `code` so a caller (host RPC, tests, logs) can
 * branch on identity instead of message text. Codes are intentionally
 * fail-closed: an unknown document shape never degrades into a repaired tree.
 */
export type OrganizerErrorCode =
  | 'tree/invalid-document'
  | 'tree/invalid-schema-version'
  | 'tree/migration-unsupported'
  | 'tree/corrupt'
  | 'tree/duplicate-id'
  | 'tree/duplicate-directory'
  | 'tree/unknown-node'
  | 'tree/unknown-parent'
  | 'tree/root-invariant'
  | 'tree/invalid-parent-kind'
  | 'tree/cycle'
  | 'tree/duplicate-session'
  | 'tree/invalid-session'
  | 'tree/invalid-title'
  | 'tree/conflict'
  | 'tree/too-large'
  | 'session/unavailable'
  | 'session/create-failed'
  | 'session/no-directory-unsupported'
  | 'task/invalid-ledger'
  | 'task/invalid-schema-version'
  | 'task/conflict'
  | 'task/unavailable'
  | 'task/source-not-bound'
  | 'task/subagent-session'
  | 'host/unavailable'

/** One structured, serializable organizer failure. */
export class OrganizerError extends Error {
  readonly code: OrganizerErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: OrganizerErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'OrganizerError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }

  /** Serialize for diagnostics without leaking object graphs. */
  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details }
  }
}

/** Narrow an unknown thrown value to the structured failure it proves. */
export function organizerErrorOf(value: unknown): OrganizerError | undefined {
  return value instanceof OrganizerError ? value : undefined
}
