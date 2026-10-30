/**
 * Task ledger: stable product task identity reconciled from the host's
 * parent-owned subagent catalog.
 *
 * C1 scope: read-only observation. A task is created only from an official
 * catalog edge reachable from an explicitly registered source Conversation.
 * `executionState` is always UNKNOWN — no start/resume/message/stop/archive
 * entry exists in this module, and no Agent is loaded or resumed.
 *
 * Identity rules:
 * - `taskId` is product-owned and stable: the same `childSessionId` keeps its
 *   task id across repeated scans and restarts;
 * - a root task's parent is `{conversation, Cid}`; a descendant's parent is
 *   `{task, Tid}` — never a second source;
 * - one `childSessionId` maps to exactly one task; a child claimed by two
 *   parents is a conflict, not a guess.
 */
import { randomUUID } from 'node:crypto'
import { OrganizerError } from './errors.js'

/** Current persisted ledger shape; other values are refused. */
export const TASK_LEDGER_SCHEMA_VERSION = 1 as const

/** The single source a task tree descends from. */
export type TaskParent =
  | { readonly kind: 'conversation'; readonly conversationId: string }
  | { readonly kind: 'task'; readonly taskId: string }

/** One observed task, with no execution claim beyond UNKNOWN. */
export interface TaskRecord {
  readonly taskId: string
  readonly childSessionId: string
  readonly sourceConversationId: string
  readonly parent: TaskParent
  readonly depth: number
  readonly mode: string
  readonly label?: string
  readonly observedAt: string
  readonly executionState: 'UNKNOWN'
  readonly executionEligibility: 'eligible' | 'blocked'
  readonly blockedReason?: string
}

/** One registered source Conversation and its workspace resource facts. */
export interface SourceRecord {
  readonly conversationId: string
  readonly sessionId: string
  readonly workspaceLogicalId?: string
  readonly directory?: string
  readonly nativeWorkspaceId?: string
  /** Last successful verification instant; absent when the source was never verified. */
  readonly verifiedAt?: string
  readonly verificationState?: 'verified' | 'blocked'
  readonly blockedReason?: string
  readonly hostVersion: string
}

/** One structured observation problem; the affected branch is isolated. */
export interface TaskDiagnostic {
  readonly code: string
  readonly message: string
  readonly childSessionId?: string
  readonly parentId?: string
  readonly depth?: number
  readonly details: Readonly<Record<string, unknown>>
}

/** The authoritative ledger aggregate. */
export interface TaskLedger {
  readonly schemaVersion: typeof TASK_LEDGER_SCHEMA_VERSION
  readonly revision: number
  readonly updatedAt: string
  readonly sources: readonly SourceRecord[]
  readonly tasks: readonly TaskRecord[]
  readonly diagnostics: readonly TaskDiagnostic[]
}

/** One row of the official subagent catalog, reduced to what C1 needs. */
export type CatalogRow =
  | {
    readonly kind: 'child'
    readonly id: string
    readonly parentId: string
    readonly depth: number
    readonly mode: string
    readonly label?: string
  }
  | {
    readonly kind: 'diagnostic'
    readonly id: string
    readonly parentId: string
    readonly depth: number
    readonly reason: string
  }

/** A read-only header observation for one child Session. */
export interface HeaderObservation {
  readonly cwd?: string
  readonly parentSessionId?: string
  /** Session origin; `subagent` marks a child Agent session. */
  readonly origin?: string
}

/** Everything one reconciliation pass may read. */
export interface ReconcileInput {
  readonly previous: TaskLedger | undefined
  readonly source: SourceRecord
  readonly catalog: readonly CatalogRow[]
  readonly headers: Readonly<Record<string, HeaderObservation>>
  readonly now: string
  /** Set when the source/workspace currentness check failed; no new edges are adopted. */
  readonly sourceBlockedReason?: string
  readonly newTaskId?: (childSessionId: string) => string
}

/** Result of one pass; diagnostics never delete previously known tasks. */
export interface ReconcileResult {
  readonly ledger: TaskLedger
  readonly conflicts: readonly TaskDiagnostic[]
}

function fail(code: ConstructorParameters<typeof OrganizerError>[0], message: string, details?: Record<string, unknown>): never {
  throw new OrganizerError(code, message, details)
}

/** Empty ledger with no sources or tasks. */
export function emptyTaskLedger(now: string): TaskLedger {
  return Object.freeze({
    schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now,
    sources: Object.freeze([]),
    tasks: Object.freeze([]),
    diagnostics: Object.freeze([])
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a decoded ledger and every cross-reference.
 *
 * Fail-closed: a duplicate task id, a duplicate child mapping, a dangling task
 * parent, a parent cycle, an unknown execution state, or a task without a
 * source is an error, never a silent repair.
 */
export function validateTaskLedger(value: unknown): TaskLedger {
  if (!isRecord(value)) fail('task/invalid-ledger', 'task ledger must be an object')
  if (value.schemaVersion !== TASK_LEDGER_SCHEMA_VERSION) {
    fail('task/invalid-schema-version', `unsupported task ledger schema ${String(value.schemaVersion)}`, {
      expected: TASK_LEDGER_SCHEMA_VERSION,
      found: value.schemaVersion
    })
  }
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 0) {
    fail('task/invalid-ledger', 'task ledger revision must be a non-negative integer')
  }
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) {
    fail('task/invalid-ledger', 'task ledger updatedAt must be an ISO-8601 instant')
  }
  if (!Array.isArray(value.sources) || !Array.isArray(value.tasks) || !Array.isArray(value.diagnostics)) {
    fail('task/invalid-ledger', 'task ledger must carry sources, tasks and diagnostics arrays')
  }

  const sources: SourceRecord[] = []
  const sourceIds = new Set<string>()
  for (const raw of value.sources) {
    if (!isRecord(raw)) fail('task/invalid-ledger', 'every source must be an object')
    const conversationId = String(raw.conversationId ?? '')
    if (conversationId.length === 0 || sourceIds.has(conversationId)) {
      fail('task/invalid-ledger', 'source conversation ids must be unique and non-empty', { conversationId })
    }
    sourceIds.add(conversationId)
    sources.push(Object.freeze({
      conversationId,
      sessionId: String(raw.sessionId ?? ''),
      ...(typeof raw.workspaceLogicalId === 'string' ? { workspaceLogicalId: raw.workspaceLogicalId } : {}),
      ...(typeof raw.directory === 'string' ? { directory: raw.directory } : {}),
      ...(typeof raw.nativeWorkspaceId === 'string' ? { nativeWorkspaceId: raw.nativeWorkspaceId } : {}),
      ...(typeof raw.verifiedAt === 'string'
        ? (Number.isNaN(Date.parse(raw.verifiedAt))
            ? fail('task/invalid-ledger', 'source verifiedAt must be an ISO-8601 instant', { conversationId })
            : { verifiedAt: raw.verifiedAt })
        : {}),
      ...(raw.verificationState === 'verified' || raw.verificationState === 'blocked'
        ? { verificationState: raw.verificationState }
        : {}),
      ...(typeof raw.blockedReason === 'string' ? { blockedReason: raw.blockedReason } : {}),
      hostVersion: String(raw.hostVersion ?? '')
    }))
  }

  const tasks: TaskRecord[] = []
  const taskIds = new Set<string>()
  const childIds = new Set<string>()
  for (const raw of value.tasks) {
    if (!isRecord(raw)) fail('task/invalid-ledger', 'every task must be an object')
    const taskId = String(raw.taskId ?? '')
    const childSessionId = String(raw.childSessionId ?? '')
    if (taskId.length === 0 || taskIds.has(taskId)) fail('task/invalid-ledger', 'task ids must be unique', { taskId })
    if (childSessionId.length === 0 || childIds.has(childSessionId)) {
      fail('task/invalid-ledger', 'one child Session may map to only one task', { childSessionId })
    }
    if (raw.executionState !== 'UNKNOWN') {
      fail('task/invalid-ledger', 'task executionState must remain UNKNOWN in this read-only stage', { taskId })
    }
    const parent = raw.parent
    if (!isRecord(parent) || (parent.kind !== 'conversation' && parent.kind !== 'task')) {
      fail('task/invalid-ledger', 'task parent must be a conversation or task reference', { taskId })
    }
    if (parent.kind === 'conversation' && !sourceIds.has(String(parent.conversationId ?? ''))) {
      fail('task/invalid-ledger', 'task parent conversation is not a registered source', { taskId })
    }
    if (raw.executionEligibility !== 'eligible' && raw.executionEligibility !== 'blocked') {
      fail('task/invalid-ledger', 'task executionEligibility must be eligible or blocked', { taskId })
    }
    if (typeof raw.depth !== 'number' || !Number.isInteger(raw.depth) || raw.depth < 1) {
      fail('task/invalid-ledger', 'task depth must be a positive integer', { taskId })
    }
    if (typeof raw.mode !== 'string' || raw.mode.length === 0) {
      fail('task/invalid-ledger', 'task mode must be a non-empty string', { taskId })
    }
    if (typeof raw.observedAt !== 'string' || Number.isNaN(Date.parse(raw.observedAt))) {
      fail('task/invalid-ledger', 'task observedAt must be an ISO-8601 instant', { taskId })
    }
    taskIds.add(taskId)
    childIds.add(childSessionId)
    tasks.push(Object.freeze({
      taskId,
      childSessionId,
      sourceConversationId: String(raw.sourceConversationId ?? ''),
      parent: parent.kind === 'conversation'
        ? Object.freeze({ kind: 'conversation' as const, conversationId: String(parent.conversationId) })
        : Object.freeze({ kind: 'task' as const, taskId: String(parent.taskId) }),
      depth: raw.depth,
      mode: raw.mode,
      ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
      observedAt: String(raw.observedAt ?? ''),
      executionState: 'UNKNOWN',
      executionEligibility: raw.executionEligibility,
      ...(typeof raw.blockedReason === 'string' ? { blockedReason: raw.blockedReason } : {})
    }))
  }

  const byId = new Map(tasks.map((task) => [task.taskId, task]))
  for (const task of tasks) {
    if (!sourceIds.has(task.sourceConversationId)) {
      fail('task/invalid-ledger', 'task names an unregistered source', { taskId: task.taskId })
    }
    let cursor: TaskRecord | undefined = task
    const seen = new Set<string>()
    while (cursor !== undefined) {
      if (seen.has(cursor.taskId)) fail('task/invalid-ledger', 'task parent chain contains a cycle', { at: cursor.taskId })
      seen.add(cursor.taskId)
      if (cursor.parent.kind === 'conversation') {
        if (cursor.parent.conversationId !== cursor.sourceConversationId) {
          fail('task/invalid-ledger', 'task root parent must equal its source conversation', {
            taskId: cursor.taskId,
            sourceConversationId: cursor.sourceConversationId,
            parentConversationId: cursor.parent.conversationId
          })
        }
        break
      }
      const parent = byId.get(cursor.parent.taskId)
      if (parent === undefined) {
        fail('task/invalid-ledger', 'task names a missing parent task', { taskId: cursor.taskId, parentId: cursor.parent.taskId })
      }
      if (parent.sourceConversationId !== task.sourceConversationId) {
        fail('task/invalid-ledger', 'task parent belongs to a different source', { taskId: task.taskId })
      }
      cursor = parent
    }
    // Depth must stay consistent with the stored parent chain: a root task is
    // depth 1 and every child is exactly one deeper than its parent task.
    const expectedDepth = task.parent.kind === 'conversation'
      ? 1
      : (byId.get(task.parent.taskId) as TaskRecord).depth + 1
    if (task.depth !== expectedDepth) {
      fail('task/invalid-ledger', 'task depth does not match its parent chain', {
        taskId: task.taskId,
        depth: task.depth,
        expectedDepth,
        parent: task.parent
      })
    }
  }

  const diagnostics: TaskDiagnostic[] = []
  for (const raw of value.diagnostics) {
    if (!isRecord(raw)) fail('task/invalid-ledger', 'every diagnostic must be an object')
    diagnostics.push(Object.freeze({
      code: String(raw.code ?? ''),
      message: String(raw.message ?? ''),
      ...(typeof raw.childSessionId === 'string' ? { childSessionId: raw.childSessionId } : {}),
      ...(typeof raw.parentId === 'string' ? { parentId: raw.parentId } : {}),
      ...(typeof raw.depth === 'number' ? { depth: raw.depth } : {}),
      details: isRecord(raw.details) ? Object.freeze({ ...raw.details }) : Object.freeze({})
    }))
  }

  return Object.freeze({
    schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
    revision: value.revision,
    updatedAt: value.updatedAt,
    sources: Object.freeze(sources),
    tasks: Object.freeze(tasks),
    diagnostics: Object.freeze(diagnostics)
  })
}

/** Deep-freeze a reconciled ledger through the same validation gate. */
function seal(ledger: TaskLedger): TaskLedger {
  return validateTaskLedger(JSON.parse(JSON.stringify(ledger)))
}

/**
 * Reconcile the official catalog into the ledger.
 *
 * Only catalog edges create tasks. Headers are read for cwd verification and
 * never grant write permission. Branches with conflicts, unknown modes,
 * missing parents, depth mismatches or unreadable headers are blocked with a
 * diagnostic; previously known tasks are carried forward as blocked instead of
 * being interpreted as deleted.
 */
export function reconcileTasks(input: ReconcileInput): ReconcileResult {
  // The pure function shares the same valid-ledger precondition as the JSON and
  // in-memory repositories. A corrupt previous is rejected before traversal or
  // any ID allocation; it is never repaired into a successful ledger.
  const previous = input.previous === undefined ? undefined : validateTaskLedger(input.previous)
  const newTaskId = input.newTaskId ?? ((childSessionId: string) => `tsk_${randomUUID()}`)
  const previousAll = previous?.tasks ?? []
  const previousScoped = previousAll.filter((task) => task.sourceConversationId === input.source.conversationId)
  const foreignTasks = previousAll.filter((task) => task.sourceConversationId !== input.source.conversationId)
  const foreignByChild = new Map(foreignTasks.map((task) => [task.childSessionId, task]))
  const previousByChild = new Map(previousScoped.map((task) => [task.childSessionId, task]))
  const diagnostics: TaskDiagnostic[] = []
  const diagnostic = (code: string, message: string, extra: Partial<TaskDiagnostic> = {}): void => {
    diagnostics.push(Object.freeze({
      code,
      message,
      ...(extra.childSessionId === undefined ? {} : { childSessionId: extra.childSessionId }),
      ...(extra.parentId === undefined ? {} : { parentId: extra.parentId }),
      ...(extra.depth === undefined ? {} : { depth: extra.depth }),
      details: Object.freeze({ ...(extra.details ?? {}) })
    }))
  }

  const source = input.source

  // A source whose currentness could not be proven keeps its identity but never
  // becomes eligible, and no new catalog edge is adopted (no revival).
  if (input.sourceBlockedReason !== undefined && input.sourceBlockedReason.length > 0) {
    const reason = input.sourceBlockedReason
    diagnostic(`source/${reason}`, `source verification failed: ${reason}`, {
      details: { conversationId: source.conversationId, sessionId: source.sessionId }
    })
    const blocked = previousScoped.map((task) => Object.freeze({
      ...task,
      executionState: 'UNKNOWN' as const,
      executionEligibility: 'blocked' as const,
      blockedReason: `source/${reason}`,
      observedAt: input.now
    }))
    const sources = [
      ...(previous?.sources ?? []).filter((entry) => entry.conversationId !== source.conversationId),
      source
    ].sort((a, b) => a.conversationId.localeCompare(b.conversationId))
    const ledger = seal({
      schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: input.now,
      sources,
      tasks: [...foreignTasks, ...blocked].sort((a, b) => a.depth - b.depth || a.childSessionId.localeCompare(b.childSessionId)),
      diagnostics
    })
    return Object.freeze({ ledger, conflicts: Object.freeze([...diagnostics]) })
  }

  const rows = input.catalog
  const childRows = rows.filter((row): row is Extract<CatalogRow, { kind: 'child' }> => row.kind === 'child')
  const byChild = new Map<string, Extract<CatalogRow, { kind: 'child' }>>()
  const conflicted = new Set<string>()
  for (const row of childRows) {
    const existing = byChild.get(row.id)
    if (existing !== undefined && existing.parentId !== row.parentId) {
      conflicted.add(row.id)
      byChild.delete(row.id)
      diagnostic('catalog/dual-parent', `child "${row.id}" is claimed by two parents`, {
        childSessionId: row.id,
        details: { parents: [existing.parentId, row.parentId].sort() }
      })
      continue
    }
    if (existing === undefined) byChild.set(row.id, row)
  }
  for (const row of rows) {
    if (row.kind === 'diagnostic') {
      diagnostic(`catalog/${row.reason}`, `catalog reported ${row.reason} for a branch`, {
        childSessionId: row.id,
        parentId: row.parentId,
        depth: row.depth
      })
    }
  }

  const ordered = [...byChild.values()].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
  const tasksByChild = new Map<string, TaskRecord>()
  const byTaskId = new Map<string, TaskRecord>()
  // Stored tasks are resolvable as effective parents even when this pass has
  // not observed them yet; observed records overwrite these entries later.
  for (const task of previousScoped) byTaskId.set(task.taskId, task)
  const blockedByAncestor = (task: TaskRecord | undefined): string | undefined => {
    let cursor = task
    while (cursor !== undefined) {
      if (cursor.executionEligibility === 'blocked') return cursor.blockedReason ?? 'ancestor-blocked'
      if (cursor.parent.kind === 'conversation') return undefined
      cursor = byTaskId.get(cursor.parent.taskId)
    }
    return undefined
  }
  const taskIdForParent = (parentId: string): string | undefined => {
    if (parentId === source.sessionId) return undefined
    return tasksByChild.get(parentId)?.taskId
  }

  const KNOWN_MODES = new Set(['one-shot', 'continuable'])
  const diagnosticChildren = new Map<string, string>()
  for (const row of rows) {
    if (row.kind === 'diagnostic') diagnosticChildren.set(row.id, row.reason)
  }

  for (const row of ordered) {
    if (foreignByChild.has(row.id)) {
      // A known child never silently changes source.
      diagnostic('task/cross-source', `child "${row.id}" already belongs to another source`, {
        childSessionId: row.id,
        parentId: row.parentId,
        depth: row.depth,
        details: { ownerSource: foreignByChild.get(row.id)?.sourceConversationId ?? null }
      })
      continue
    }
    const previousTask = previousByChild.get(row.id)
    const baseId = previousTask?.taskId ?? newTaskId(row.id)
    const header = input.headers[row.id]
    let blockedReason: string | undefined
    if (conflicted.has(row.id)) blockedReason = 'catalog/dual-parent'
    else if (diagnosticChildren.has(row.id)) {
      blockedReason = `catalog/${diagnosticChildren.get(row.id) as string}`
    } else if (!KNOWN_MODES.has(row.mode)) {
      blockedReason = 'catalog/unsupported-mode'
      diagnostic('catalog/unsupported-mode', `child "${row.id}" has an unsupported catalog mode "${row.mode}"`, {
        childSessionId: row.id,
        parentId: row.parentId,
        depth: row.depth,
        details: { mode: row.mode }
      })
    }

    // Cycle / missing-parent / depth checks along the catalog chain.
    let cursorId = row.parentId
    const chain = new Set<string>([row.id])
    let expectedDepth = 1
    while (cursorId !== source.sessionId) {
      if (chain.has(cursorId)) {
        blockedReason = 'catalog/cycle'
        diagnostic('catalog/cycle', `catalog parent chain cycles at "${cursorId}"`, {
          childSessionId: row.id,
          parentId: row.parentId
        })
        break
      }
      chain.add(cursorId)
      const parentRow = byChild.get(cursorId)
      if (parentRow === undefined) {
        blockedReason = 'catalog/missing-parent'
        diagnostic('catalog/missing-parent', `parent "${cursorId}" is not in the reachable catalog`, {
          childSessionId: row.id,
          parentId: cursorId
        })
        break
      }
      expectedDepth += 1
      cursorId = parentRow.parentId
    }
    if (blockedReason === 'catalog/cycle') {
      // A cyclic branch cannot be represented as a consistent parent chain.
      continue
    }
    if (blockedReason === undefined && row.depth !== expectedDepth) {
      blockedReason = 'catalog/depth-mismatch'
      diagnostic('catalog/depth-mismatch', `child "${row.id}" depth ${String(row.depth)} does not match its chain`, {
        childSessionId: row.id,
        parentId: row.parentId,
        depth: row.depth,
        details: { expectedDepth }
      })
    }
    if (blockedReason === undefined && source.directory !== undefined) {
      if (header === undefined) {
        blockedReason = 'header/unavailable'
      } else if (header.cwd === undefined || header.cwd !== source.directory) {
        blockedReason = 'cwd/unverified'
      }
    }

    const parentTaskId = row.parentId === source.sessionId ? undefined : taskIdForParent(row.parentId)
    if (row.parentId !== source.sessionId && parentTaskId === undefined) {
      // The branch is isolated: no task is invented without a proven parent.
      diagnostic('catalog/parent-isolated', `parent "${row.parentId}" is isolated or missing`, {
        childSessionId: row.id,
        parentId: row.parentId,
        depth: row.depth
      })
      continue
    }
    const parent: TaskParent = parentTaskId === undefined
      ? { kind: 'conversation', conversationId: source.conversationId }
      : { kind: 'task', taskId: parentTaskId }
    // A stored relation is never re-bound by a later catalog observation. The
    // effective depth is derived from the EFFECTIVE parent's ledger depth, so a
    // rebind anywhere in the ancestor chain keeps descendants consistent.
    let effectiveParent = parent
    if (previousTask !== undefined && JSON.stringify(previousTask.parent) !== JSON.stringify(parent)) {
      effectiveParent = previousTask.parent
      blockedReason = blockedReason ?? 'task/rebind-detected'
      diagnostic('task/rebind-detected', `catalog parent for "${row.id}" differs from the stored relation`, {
        childSessionId: row.id,
        parentId: row.parentId,
        depth: row.depth,
        details: { stored: previousTask.parent, storedDepth: previousTask.depth, observed: parent, observedDepth: row.depth }
      })
    }
    const effectiveParentTask = effectiveParent.kind === 'task' ? byTaskId.get(effectiveParent.taskId) : undefined
    const effectiveDepth = effectiveParent.kind === 'conversation'
      ? 1
      : (effectiveParentTask === undefined ? undefined : effectiveParentTask.depth + 1)
    if (effectiveDepth === undefined) {
      // The branch cannot be represented without inventing a parent relation.
      diagnostic('task/parent-unresolved', `effective parent "${(effectiveParent as { taskId: string }).taskId}" is not resolvable`, {
        childSessionId: row.id,
        parentId: row.parentId,
        depth: row.depth,
        details: { effectiveParent }
      })
      continue
    }
    const ancestorBlocked = blockedByAncestor(
      effectiveParent.kind === 'task' ? byTaskId.get(effectiveParent.taskId) : undefined
    )
    const finalReason = blockedReason ?? (ancestorBlocked === undefined ? undefined : 'ancestor-blocked')
    const task: TaskRecord = Object.freeze({
      taskId: baseId,
      childSessionId: row.id,
      sourceConversationId: source.conversationId,
      parent: Object.freeze(effectiveParent),
      depth: effectiveDepth,
      mode: row.mode,
      ...(row.label === undefined ? {} : { label: row.label }),
      observedAt: input.now,
      executionState: 'UNKNOWN',
      executionEligibility: finalReason === undefined ? 'eligible' : 'blocked',
      ...(finalReason === undefined ? {} : { blockedReason: finalReason })
    })
    tasksByChild.set(row.id, task)
    byTaskId.set(task.taskId, task)
  }

  // Previously known tasks of THIS source that disappeared from the reachable
  // catalog are kept and blocked; omission is never interpreted as deletion.
  // Tasks of other sources are never touched by this pass.
  for (const previousTask of previousScoped) {
    if (tasksByChild.has(previousTask.childSessionId)) continue
    tasksByChild.set(previousTask.childSessionId, Object.freeze({
      ...previousTask,
      executionState: 'UNKNOWN',
      executionEligibility: 'blocked',
      blockedReason: previousTask.blockedReason ?? 'catalog/not-observed',
      observedAt: input.now
    }))
    diagnostic('catalog/not-observed', `previously known task "${previousTask.taskId}" was not observed`, {
      childSessionId: previousTask.childSessionId,
      details: { taskId: previousTask.taskId }
    })
  }

  const sources = [
    ...(previous?.sources ?? []).filter((entry) => entry.conversationId !== source.conversationId),
    source
  ].sort((a, b) => a.conversationId.localeCompare(b.conversationId))
  const tasks = [...foreignTasks, ...tasksByChild.values()]
    .sort((a, b) => a.depth - b.depth || a.childSessionId.localeCompare(b.childSessionId))

  const ledger = seal({
    schemaVersion: TASK_LEDGER_SCHEMA_VERSION,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: input.now,
    sources,
    tasks,
    diagnostics
  })
  return Object.freeze({ ledger, conflicts: Object.freeze(diagnostics.filter((entry) => entry.code !== 'catalog/not-observed')) })
}
