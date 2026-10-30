/**
 * Logical organization tree: stable identities, invariants, and the persisted
 * aggregate document.
 *
 * Identity rules (Core v1.0): Root, Project, and ordinary Conversation each own
 * a stable logical id that never derives from a directory path or from a host
 * Session id. A Conversation *maps* exactly one real DSH Session; the Session id
 * is a foreign reference, never the Conversation's identity, and a Project
 * never owns one.
 *
 * This module is pure: no host service, no filesystem, no clock. Callers supply
 * timestamps and ids so every invariant is testable without a host.
 */
import { isAbsolute } from 'node:path'
import { OrganizerError } from './errors.js'

/**
 * Current persisted document shape.
 *
 * Version 2 adds the terminal Workspace node; version 1 documents are read
 * through {@link migrateDocument} and are not rewritten on read.
 */
export const TREE_SCHEMA_VERSION = 2 as const

/** Oldest schema this build can read and migrate. */
export const OLDEST_READABLE_SCHEMA_VERSION = 1

/** The single root every logical node descends from. */
export const ROOT_ID = 'root'

/** Longest accepted user-visible title, in characters. */
export const MAX_TITLE_LENGTH = 200

export type NodeKind = 'project' | 'workspace' | 'conversation'

/** One logical node of the organization tree. */
export interface TreeNode {
  readonly id: string
  readonly kind: NodeKind
  /** Parent logical id; `null` only for the root node. */
  readonly parentId: string | null
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  /** Conversations only: the real DSH Session this conversation maps. */
  readonly sessionId?: string
  /** Conversations only: canonical directory of a directory-bound conversation. */
  readonly cwd?: string
  /** Workspaces only: the single canonical directory this terminal node binds. */
  readonly directory?: string
  /** Workspaces only: the native DSH Workspace id used for reconciliation (data, not identity). */
  readonly nativeWorkspaceId?: string
}

/** The authoritative aggregate: one record, one revision, whole-tree atomically. */
export interface TreeDocument {
  readonly schemaVersion: typeof TREE_SCHEMA_VERSION
  readonly revision: number
  readonly rootId: string
  readonly nodes: readonly TreeNode[]
}

/** Host- and browser-facing view of the tree; no storage details leak out. */
export interface TreeSnapshot {
  readonly revision: number
  readonly rootId: string
  readonly nodes: readonly TreeNode[]
}

/** A node together with its direct children, in stable row order. */
export interface TreeRow {
  readonly node: TreeNode
  readonly children: readonly TreeRow[]
}

function fail(code: ConstructorParameters<typeof OrganizerError>[0], message: string, details?: Record<string, unknown>): never {
  throw new OrganizerError(code, message, details)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string, code: ConstructorParameters<typeof OrganizerError>[0]): string {
  if (typeof value !== 'string' || value.length === 0) fail(code, `tree field "${field}" must be a non-empty string`, { field })
  return value
}

function requireTimestamp(value: unknown, field: string): string {
  const text = requireString(value, field, 'tree/invalid-document')
  if (Number.isNaN(Date.parse(text))) fail('tree/invalid-document', `tree field "${field}" is not an ISO-8601 instant`, { field })
  return text
}

/** Normalize a user-visible title or reject it. Never trims identity-bearing text silently. */
export function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') fail('tree/invalid-title', 'title must be a string', { field: 'title' })
  const title = value.trim()
  if (title.length === 0) fail('tree/invalid-title', 'title must not be blank', { field: 'title' })
  if (title.length > MAX_TITLE_LENGTH) {
    fail('tree/invalid-title', `title must be at most ${String(MAX_TITLE_LENGTH)} characters`, {
      field: 'title',
      length: title.length
    })
  }
  return title
}

/** A Session reference on a Conversation: non-blank and distinct from the logical id. */
export function normalizeSessionId(value: unknown, conversationId: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('tree/invalid-session', 'a conversation requires the real Session id it maps', { field: 'sessionId' })
  }
  const sessionId = value.trim()
  if (sessionId === conversationId) {
    fail('tree/invalid-session', 'a conversation id must not be its Session id', { field: 'sessionId' })
  }
  return sessionId
}

/** Build the initial document: one root project, nothing else. */
export function createEmptyTree(now: string): TreeDocument {
  const root: TreeNode = Object.freeze({
    id: ROOT_ID,
    kind: 'project',
    parentId: null,
    title: 'Root',
    createdAt: now,
    updatedAt: now
  })
  return Object.freeze({
    schemaVersion: TREE_SCHEMA_VERSION,
    revision: 0,
    rootId: ROOT_ID,
    nodes: Object.freeze([root])
  })
}

/** Read-only projection used by the host service and its future Remote namespace. */
export function toSnapshot(document: TreeDocument): TreeSnapshot {
  return Object.freeze({
    revision: document.revision,
    rootId: document.rootId,
    nodes: Object.freeze(document.nodes.map((node) => Object.freeze({ ...node })))
  })
}

/** Find one node, or `undefined` when the id names nothing in this tree. */
export function findNode(document: TreeDocument, id: string): TreeNode | undefined {
  return document.nodes.find((node) => node.id === id)
}

/** Direct children of a node in document order. */
export function childrenOf(document: TreeDocument, parentId: string): readonly TreeNode[] {
  return document.nodes.filter((node) => node.parentId === parentId)
}

/** Root → node ancestry, excluding the node itself. */
export function ancestorsOf(document: TreeDocument, id: string): readonly TreeNode[] {
  const chain: TreeNode[] = []
  let current = findNode(document, id)
  const seen = new Set<string>()
  while (current !== undefined && current.parentId !== null) {
    if (seen.has(current.id)) fail('tree/cycle', 'organization tree contains a parent cycle', { at: current.id })
    seen.add(current.id)
    const parent = findNode(document, current.parentId)
    if (parent === undefined) break
    chain.push(parent)
    current = parent
  }
  return chain
}

/** Depth-first rows for rendering: root first, children after their parent. */
export function toRows(document: TreeDocument): readonly TreeRow[] {
  const build = (node: TreeNode): TreeRow => Object.freeze({
    node: Object.freeze({ ...node }),
    children: Object.freeze(childrenOf(document, node.id).map(build))
  })
  const root = findNode(document, document.rootId)
  return root === undefined ? Object.freeze([]) : Object.freeze([build(root)])
}

/**
 * Read a stored document, upgrading an older readable schema in memory.
 *
 * Version 1 could store a directory-bound conversation under a project. That
 * shape has no unambiguous workspace, so such a record is refused instead of
 * being silently stripped or re-parented. Other version 1 documents only gain
 * the schema version; the file is rewritten only by the next mutation.
 */
export function migrateDocument(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (value.schemaVersion === OLDEST_READABLE_SCHEMA_VERSION) {
    const nodes = Array.isArray(value.nodes) ? value.nodes : []
    for (const node of nodes) {
      if (isRecord(node) && node.kind === 'conversation' && typeof node.cwd === 'string') {
        fail('tree/migration-unsupported', 'version 1 document has a directory-bound project conversation; a workspace cannot be inferred', {
          id: node.id,
          cwd: node.cwd
        })
      }
    }
    return { ...value, schemaVersion: TREE_SCHEMA_VERSION }
  }
  return value
}

/**
 * Validate one decoded document and prove every structural invariant.
 *
 * Fail-closed by design: a document from a newer schema, a duplicate id, a
 * dangling parent, a cycle, or a Conversation doubling as a Project is an error,
 * never a silent repair that could re-parent user data.
 */
export function validateDocument(input: unknown): TreeDocument {
  const value = migrateDocument(input)
  if (!isRecord(value)) fail('tree/invalid-document', 'tree document must be an object')
  if (value.schemaVersion !== TREE_SCHEMA_VERSION) {
    fail('tree/invalid-schema-version', `unsupported tree schema version ${String(value.schemaVersion)}`, {
      expected: TREE_SCHEMA_VERSION,
      found: value.schemaVersion
    })
  }
  const revision = value.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    fail('tree/invalid-document', 'tree revision must be a non-negative integer', { field: 'revision' })
  }
  const rootId = requireString(value.rootId, 'rootId', 'tree/invalid-document')
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    fail('tree/invalid-document', 'tree document must carry at least the root node', { field: 'nodes' })
  }

  const nodes: TreeNode[] = []
  const byId = new Map<string, TreeNode>()
  const sessionIds = new Set<string>()
  const workspaceDirectories = new Set<string>()
  const nativeWorkspaceIds = new Set<string>()
  for (const raw of value.nodes) {
    if (!isRecord(raw)) fail('tree/invalid-document', 'every tree node must be an object')
    const id = requireString(raw.id, 'id', 'tree/invalid-document')
    if (byId.has(id)) fail('tree/duplicate-id', `tree node id "${id}" appears twice`, { id })
    const kind = raw.kind
    if (kind !== 'project' && kind !== 'workspace' && kind !== 'conversation') {
      fail('tree/invalid-document', `tree node "${id}" has an unknown kind`, { id, kind: raw.kind })
    }
    const parentId = raw.parentId === null || raw.parentId === undefined
      ? null
      : requireString(raw.parentId, 'parentId', 'tree/invalid-document')
    let node: TreeNode = {
      id,
      kind,
      parentId,
      title: normalizeTitle(raw.title),
      createdAt: requireTimestamp(raw.createdAt, 'createdAt'),
      updatedAt: requireTimestamp(raw.updatedAt, 'updatedAt')
    }
    if (kind === 'workspace') {
      const directory = requireString(raw.directory, 'directory', 'tree/invalid-document')
      if (!isAbsolute(directory)) fail('tree/invalid-document', `workspace "${id}" directory must be absolute`, { id })
      const nativeWorkspaceId = requireString(raw.nativeWorkspaceId, 'nativeWorkspaceId', 'tree/invalid-document')
      if (raw.sessionId !== undefined || raw.cwd !== undefined) {
        fail('tree/invalid-parent-kind', `workspace "${id}" must not own a Session or cwd`, { id })
      }
      if (workspaceDirectories.has(directory)) {
        fail('tree/duplicate-id', `directory "${directory}" is bound by two workspaces`, { id, directory })
      }
      if (nativeWorkspaceIds.has(nativeWorkspaceId)) {
        fail('tree/duplicate-id', `native workspace "${nativeWorkspaceId}" is bound twice`, { id, nativeWorkspaceId })
      }
      workspaceDirectories.add(directory)
      nativeWorkspaceIds.add(nativeWorkspaceId)
      node = { ...node, directory, nativeWorkspaceId }
    } else if (raw.directory !== undefined || raw.nativeWorkspaceId !== undefined) {
      fail('tree/invalid-parent-kind', `node "${id}" must not own a workspace binding`, { id })
    }
    if (raw.sessionId !== undefined) {
      if (kind !== 'conversation') {
        fail('tree/invalid-parent-kind', `node "${id}" must not own a Session`, { id })
      }
      node = { ...node, sessionId: normalizeSessionId(raw.sessionId, id) }
      const sessionId = node.sessionId as string
      if (sessionIds.has(sessionId)) {
        fail('tree/duplicate-session', `Session "${sessionId}" is mapped by two conversations`, { sessionId, id })
      }
      sessionIds.add(sessionId)
    } else if (kind === 'conversation') {
      fail('tree/invalid-session', `conversation "${id}" requires a Session mapping`, { id })
    }
    if (raw.cwd !== undefined) {
      if (kind !== 'conversation') fail('tree/invalid-parent-kind', `node "${id}" must not own a cwd`, { id })
      node = { ...node, cwd: requireString(raw.cwd, 'cwd', 'tree/invalid-document') }
    }
    const frozen = Object.freeze(node)
    byId.set(id, frozen)
    nodes.push(frozen)
  }

  if (!byId.has(rootId)) fail('tree/root-invariant', 'declared root id names no node', { rootId })
  const roots = nodes.filter((node) => node.parentId === null)
  if (roots.length !== 1) fail('tree/root-invariant', 'tree must have exactly one root node', { roots: roots.length })
  const root = roots[0] as TreeNode
  if (root.id !== rootId) fail('tree/root-invariant', 'root node id differs from the declared root', { rootId, nodeId: root.id })
  if (root.kind !== 'project') fail('tree/root-invariant', 'root node must be a project', { rootId })

  for (const node of nodes) {
    if (node.parentId === null) continue
    const parent = byId.get(node.parentId)
    if (parent === undefined) fail('tree/unknown-parent', `node "${node.id}" names a missing parent`, { id: node.id, parentId: node.parentId })
    if (parent.kind === 'conversation') {
      fail('tree/invalid-parent-kind', `node "${node.id}" is a child of a conversation`, { id: node.id, parentId: parent.id })
    }
    // CORE-004: a Workspace is terminal; a Project may only nest under a Project.
    if (node.kind === 'project' && parent.kind !== 'project') {
      fail('tree/invalid-parent-kind', `project "${node.id}" must be a child of a project`, { id: node.id, parentId: parent.id })
    }
    if (node.kind === 'workspace' && parent.kind !== 'project') {
      fail('tree/invalid-parent-kind', `workspace "${node.id}" must be a child of a project`, { id: node.id, parentId: parent.id })
    }
    if (node.kind === 'conversation') {
      if (parent.kind === 'workspace') {
        if (node.cwd === undefined) {
          fail('tree/invalid-parent-kind', `conversation "${node.id}" under a workspace requires its cwd`, { id: node.id })
        }
        if (node.cwd !== parent.directory) {
          fail('tree/invalid-parent-kind', `conversation "${node.id}" cwd must equal its workspace directory`, {
            id: node.id,
            cwd: node.cwd,
            directory: parent.directory
          })
        }
      } else if (node.cwd !== undefined) {
        fail('tree/invalid-parent-kind', `conversation "${node.id}" under a project must not own a cwd`, { id: node.id })
      }
    }
  }

  for (const node of nodes) {
    const seen = new Set<string>()
    let cursor: TreeNode | undefined = node
    while (cursor !== undefined && cursor.parentId !== null) {
      if (seen.has(cursor.id)) fail('tree/cycle', 'organization tree contains a parent cycle', { at: cursor.id })
      seen.add(cursor.id)
      cursor = byId.get(cursor.parentId)
    }
  }

  return Object.freeze({
    schemaVersion: TREE_SCHEMA_VERSION,
    revision,
    rootId,
    nodes: Object.freeze(nodes)
  })
}
