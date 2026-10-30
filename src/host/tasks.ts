/**
 * Read-only host adapters for the C1 task ledger.
 *
 * Only observation APIs are used: the parent-owned subagent catalog (which does
 * not load or resume Agents), cold Session headers for cwd verification, and the
 * native Workspace registry for directory reconciliation. No start/resume/
 * message/stop/archive call exists here.
 */
import { OrganizerError } from '../core/errors.js'
import type { CatalogRow, HeaderObservation } from '../core/tasks.js'
import type { HostServices } from './capabilities.js'

/** Exact DSH version this adapter was verified against. */
export const TASK_HOST_VERSION = '0.2.1-rc.2'

/** Whether the host composes the read-only services C1 needs. */
export interface TaskHostAvailability {
  readonly available: boolean
  readonly missing: readonly string[]
}

/** Check the three read-only services and report exactly what is missing. */
export function taskHostAvailability(services: HostServices): TaskHostAvailability {
  const missing: string[] = []
  if (typeof services.subagents?.listDescendants !== 'function') missing.push('subagents.listDescendants')
  if (typeof services.sessionQuery?.readSession !== 'function') missing.push('sessionQuery.readSession')
  if (typeof services.workspaceRegistry?.resolveByPath !== 'function') missing.push('workspaceRegistry.resolveByPath')
  return Object.freeze({ available: missing.length === 0, missing: Object.freeze(missing) })
}

function unavailable(service: string): never {
  throw new OrganizerError('task/unavailable', `${service} is unavailable in this host composition`, { service })
}

/**
 * Read the official catalog descendants of one root Session.
 *
 * Catalog diagnostics are preserved as rows so reconciliation can isolate the
 * affected branch instead of dropping it.
 */
export async function observeCatalog(services: HostServices, rootSessionId: string): Promise<readonly CatalogRow[]> {
  const runtime = services.subagents
  if (typeof runtime?.listDescendants !== 'function') unavailable('subagents.listDescendants')
  let entries: readonly Record<string, unknown>[]
  try {
    const result = await runtime.listDescendants(rootSessionId)
    if (!Array.isArray(result)) {
      throw new OrganizerError('task/unavailable', 'subagent catalog returned an unexpected shape', {
        service: 'subagents.listDescendants'
      })
    }
    entries = result as readonly Record<string, unknown>[]
  } catch (error) {
    throw new OrganizerError('task/unavailable', 'subagent catalog read failed', {
      service: 'subagents.listDescendants',
      cause: error instanceof Error ? error.message : String(error)
    })
  }
  const rows: CatalogRow[] = []
  for (const entry of entries) {
    const id = typeof entry.id === 'string' ? entry.id : ''
    const parentId = typeof entry.parentId === 'string' ? entry.parentId : ''
    const depth = typeof entry.depth === 'number' ? entry.depth : Number.NaN
    if (id.length === 0 || parentId.length === 0 || !Number.isInteger(depth) || depth < 1) {
      rows.push(Object.freeze({ kind: 'diagnostic', id: id.length === 0 ? '(unknown)' : id, parentId, depth, reason: 'corrupt' }))
      continue
    }
    if (entry.kind === 'child') {
      const mode = typeof entry.mode === 'string' ? entry.mode : 'unknown'
      rows.push(Object.freeze({
        kind: 'child',
        id,
        parentId,
        depth,
        mode,
        ...(typeof entry.label === 'string' ? { label: entry.label } : {})
      }))
    } else {
      const reason = entry.reason === 'corrupt' || entry.reason === 'unsupported' || entry.reason === 'unavailable'
        ? entry.reason
        : 'unavailable'
      rows.push(Object.freeze({ kind: 'diagnostic', id, parentId, depth, reason }))
    }
  }
  return Object.freeze(rows)
}

/**
 * Read cold Session headers for cwd verification.
 *
 * A missing or unreadable header is omitted, which reconciliation turns into a
 * blocked branch rather than an eligible task.
 */
export async function observeHeaders(
  services: HostServices,
  sessionIds: readonly string[]
): Promise<Readonly<Record<string, HeaderObservation>>> {
  const query = services.sessionQuery
  if (typeof query?.readSession !== 'function') unavailable('sessionQuery.readSession')
  const headers: Record<string, HeaderObservation> = {}
  for (const sessionId of sessionIds) {
    try {
      const snapshot = await query.readSession(sessionId) as { session?: Record<string, unknown> } | undefined
      const header = snapshot?.session
      if (header === undefined) continue
      headers[sessionId] = Object.freeze({
        ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
        ...(typeof header.parentSession === 'string' ? { parentSessionId: header.parentSession } : {}),
        ...(typeof header.origin === 'string' ? { origin: header.origin } : {})
      })
    } catch {
      // Absent header: the task may still be listed, but it is blocked below.
    }
  }
  return Object.freeze(headers)
}

/** Resolve one canonical directory to its native Workspace record. */
export async function resolveNativeWorkspace(
  services: HostServices,
  directory: string
): Promise<{ workspaceId: string; path: string; archivedSessionIds: readonly string[]; archivedKnown: boolean } | undefined> {
  const registry = services.workspaceRegistry
  if (typeof registry?.resolveByPath !== 'function') unavailable('workspaceRegistry.resolveByPath')
  let workspace: Record<string, unknown> | undefined
  try {
    workspace = await registry.resolveByPath(directory) as Record<string, unknown> | undefined
  } catch (error) {
    throw new OrganizerError('task/unavailable', 'native Workspace lookup failed', {
      service: 'workspaceRegistry.resolveByPath',
      cause: error instanceof Error ? error.message : String(error)
    })
  }
  if (workspace === undefined) return undefined
  const workspaceId = typeof workspace.id === 'string' ? workspace.id : ''
  const path = typeof workspace.path === 'string' ? workspace.path : ''
  if (workspaceId.length === 0 || path.length === 0) return undefined
  const archivedValue = (registry as { archivedSessionIds?: unknown }).archivedSessionIds
  const archivedKnown = Array.isArray(archivedValue)
  const archivedSessionIds = archivedKnown
    ? Object.freeze(archivedValue.filter((value): value is string => typeof value === 'string'))
    : Object.freeze([])
  return Object.freeze({ workspaceId, path, archivedSessionIds, archivedKnown })
}
