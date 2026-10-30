/**
 * Pure tree operations. Each builder returns a new, fully validated document
 * with the revision advanced by one; nothing here mutates its input, touches a
 * Session, or writes storage.
 *
 * Deliberately absent: permanent delete. Stage B cannot prove a physical
 * removal through the host persistence API, so no operation pretends to erase
 * anything. Logical archive/restore belongs to a later stage with its own
 * traceable semantics.
 */
import { isAbsolute } from 'node:path'
import { OrganizerError } from './errors.js'
import {
  createEmptyTree,
  findNode,
  normalizeSessionId,
  normalizeTitle,
  ROOT_ID,
  TREE_SCHEMA_VERSION,
  validateDocument,
  type TreeDocument,
  type TreeNode
} from './model.js'

/** Why a node cannot change: a stable code plus the offending ids. */
function reject(code: ConstructorParameters<typeof OrganizerError>[0], message: string, details: Record<string, unknown> = {}): never {
  throw new OrganizerError(code, message, details)
}

function nextRevision(document: TreeDocument): number {
  return document.revision + 1
}

function requireNode(document: TreeDocument, id: string): TreeNode {
  const node = findNode(document, id)
  if (node === undefined) reject('tree/unknown-node', `no logical node "${id}" exists`, { id })
  return node
}

function requireProject(document: TreeDocument, id: string): TreeNode {
  const node = requireNode(document, id)
  if (node.kind !== 'project') {
    reject('tree/invalid-parent-kind', `node "${id}" is not a project`, { id, kind: node.kind })
  }
  return node
}

function isDescendant(document: TreeDocument, ancestorId: string, candidateId: string): boolean {
  let cursor: TreeNode | undefined = findNode(document, candidateId)
  const seen = new Set<string>()
  while (cursor !== undefined && cursor.parentId !== null) {
    if (cursor.parentId === ancestorId) return true
    if (seen.has(cursor.id)) reject('tree/cycle', 'organization tree contains a parent cycle', { at: cursor.id })
    seen.add(cursor.id)
    cursor = findNode(document, cursor.parentId)
  }
  return false
}

function withNodes(document: TreeDocument, nodes: readonly TreeNode[]): TreeDocument {
  return validateDocument({
    schemaVersion: TREE_SCHEMA_VERSION,
    revision: nextRevision(document),
    rootId: document.rootId,
    nodes
  })
}

/** Input facts a caller must supply for a new Project. */
export interface CreateProjectInput {
  readonly parentId: string
  readonly title: string
  readonly id: string
  readonly now: string
}

/** Add one nested Project under an existing Project (or the Root). */
export function createProject(document: TreeDocument, input: CreateProjectInput): TreeDocument {
  requireProject(document, input.parentId)
  if (findNode(document, input.id) !== undefined) {
    reject('tree/duplicate-id', `logical id "${input.id}" already exists`, { id: input.id })
  }
  const project: TreeNode = Object.freeze({
    id: input.id,
    kind: 'project',
    parentId: input.parentId,
    title: normalizeTitle(input.title),
    createdAt: input.now,
    updatedAt: input.now
  })
  return withNodes(document, [...document.nodes, project])
}

/** Input facts a caller must supply for a Conversation mapping. */
export interface CreateConversationInput {
  readonly parentId: string
  readonly title: string
  /** The real DSH Session already present on the host, before persistence. */
  readonly sessionId: string
  readonly id: string
  readonly now: string
  readonly cwd?: string
}

/**
 * Add one ordinary Conversation under a Project and map it to its real Session.
 *
 * The Session must already exist: the caller proves its id through a host read
 * or creation path before calling this pure operation, so a mapping never
 * invents a Session.
 */
export function createConversation(document: TreeDocument, input: CreateConversationInput): TreeDocument {
  requireProject(document, input.parentId)
  if (input.cwd !== undefined) {
    reject('tree/invalid-parent-kind', 'a project conversation has no directory; bind a workspace conversation instead', {
      cwd: input.cwd
    })
  }
  if (findNode(document, input.id) !== undefined) {
    reject('tree/duplicate-id', `logical id "${input.id}" already exists`, { id: input.id })
  }
  const sessionId = normalizeSessionId(input.sessionId, input.id)
  if (document.nodes.some((node) => node.sessionId === sessionId)) {
    reject('tree/duplicate-session', `Session "${sessionId}" is already mapped`, { sessionId })
  }
  const conversation: TreeNode = Object.freeze({
    id: input.id,
    kind: 'conversation',
    parentId: input.parentId,
    title: normalizeTitle(input.title),
    createdAt: input.now,
    updatedAt: input.now,
    sessionId,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd })
  })
  return withNodes(document, [...document.nodes, conversation])
}

/** Rename one node in place; identity, parent, and Session mapping are untouched. */
export function renameNode(document: TreeDocument, input: { id: string; title: string; now: string }): TreeDocument {
  const node = requireNode(document, input.id)
  const title = normalizeTitle(input.title)
  if (node.title === title) return document
  return withNodes(document, document.nodes.map((candidate) => candidate.id === node.id
    ? Object.freeze({ ...candidate, title, updatedAt: input.now })
    : candidate))
}

/**
 * Move one node under another Project.
 *
 * Only the logical parent changes. The mapped Session, its directory, and any
 * host-side Session record are untouched: moving the tree never moves files or
 * changes a working directory.
 */
export function moveNode(document: TreeDocument, input: { id: string; parentId: string; now: string }): TreeDocument {
  const node = requireNode(document, input.id)
  if (node.id === ROOT_ID) reject('tree/root-invariant', 'the root node cannot be moved', { id: node.id })
  requireProject(document, input.parentId)
  if (input.parentId === node.parentId) return document
  if (input.parentId === node.id || isDescendant(document, node.id, input.parentId)) {
    reject('tree/cycle', 'a project cannot be moved into itself or its own descendant', {
      id: node.id,
      parentId: input.parentId
    })
  }
  return withNodes(document, document.nodes.map((candidate) => candidate.id === node.id
    ? Object.freeze({ ...candidate, parentId: input.parentId, updatedAt: input.now })
    : candidate))
}

/** Return an empty tree when no document exists yet. */
export function emptyDocument(now: string): TreeDocument {
  return createEmptyTree(now)
}

/** Input for registering one terminal Workspace over an existing directory. */
export interface RegisterWorkspaceInput {
  readonly parentId: string
  readonly title: string
  /** Canonical absolute directory; a path is data, never identity. */
  readonly directory: string
  /** Native DSH Workspace id used for reconciliation (data, not product identity). */
  readonly nativeWorkspaceId: string
  readonly id: string
  readonly now: string
}

/**
 * Register one terminal Workspace under an existing Project.
 *
 * The node binds exactly one canonical directory and one native Workspace id.
 * It is a restricted single-directory subset of the frozen multi-directory
 * spec; nothing here claims the full directory model.
 */
export function registerWorkspace(document: TreeDocument, input: RegisterWorkspaceInput): TreeDocument {
  requireProject(document, input.parentId)
  if (findNode(document, input.id) !== undefined) {
    reject('tree/duplicate-id', `logical id "${input.id}" already exists`, { id: input.id })
  }
  if (!isAbsolute(input.directory)) {
    reject('tree/invalid-document', 'workspace directory must be absolute', { directory: input.directory })
  }
  if (document.nodes.some((node) => node.kind === 'workspace' && node.directory === input.directory)) {
    reject('tree/duplicate-directory', `directory "${input.directory}" is already bound`, { directory: input.directory })
  }
  if (document.nodes.some((node) => node.kind === 'workspace' && node.nativeWorkspaceId === input.nativeWorkspaceId)) {
    reject('tree/duplicate-id', `native workspace "${input.nativeWorkspaceId}" is already bound`, {
      nativeWorkspaceId: input.nativeWorkspaceId
    })
  }
  const workspace: TreeNode = Object.freeze({
    id: input.id,
    kind: 'workspace',
    parentId: input.parentId,
    title: normalizeTitle(input.title),
    createdAt: input.now,
    updatedAt: input.now,
    directory: input.directory,
    nativeWorkspaceId: input.nativeWorkspaceId
  })
  return withNodes(document, [...document.nodes, workspace])
}

/** Input for binding an existing directory-bound ordinary Conversation. */
export interface BindDirectoryConversationInput {
  readonly workspaceId: string
  readonly title: string
  /** Existing Session id, proven by the host before this call. */
  readonly sessionId: string
  readonly id: string
  readonly now: string
}

/**
 * Bind an existing ordinary Conversation to a Workspace.
 *
 * The conversation inherits the workspace's canonical directory as its `cwd`.
 * The caller must have proven the Session exists with that cwd; this function
 * never infers write permission from the path.
 */
export function bindDirectoryConversation(document: TreeDocument, input: BindDirectoryConversationInput): TreeDocument {
  const workspace = requireNode(document, input.workspaceId)
  if (workspace.kind !== 'workspace') {
    reject('tree/invalid-parent-kind', `node "${input.workspaceId}" is not a workspace`, { id: input.workspaceId })
  }
  if (findNode(document, input.id) !== undefined) {
    reject('tree/duplicate-id', `logical id "${input.id}" already exists`, { id: input.id })
  }
  const sessionId = normalizeSessionId(input.sessionId, input.id)
  if (document.nodes.some((node) => node.sessionId === sessionId)) {
    reject('tree/duplicate-session', `Session "${sessionId}" is already mapped`, { sessionId })
  }
  const conversation: TreeNode = Object.freeze({
    id: input.id,
    kind: 'conversation',
    parentId: workspace.id,
    title: normalizeTitle(input.title),
    createdAt: input.now,
    updatedAt: input.now,
    sessionId,
    cwd: workspace.directory as string
  })
  return withNodes(document, [...document.nodes, conversation])
}
