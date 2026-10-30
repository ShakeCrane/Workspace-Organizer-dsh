/**
 * The serialized logical-tree use cases.
 *
 * One in-process queue means concurrent host calls (a UI double-click, two
 * reconnects) cannot interleave a read-modify-write; the repository's revision
 * gate then covers a second process. A rejected write surfaces as
 * `tree/conflict` instead of silently overwriting another writer's tree.
 */
import { randomUUID } from 'node:crypto'
import { OrganizerError } from './errors.js'
import {
  createEmptyTree,
  toRows,
  toSnapshot,
  type TreeDocument,
  type TreeSnapshot
} from './model.js'
import {
  bindDirectoryConversation,
  createConversation,
  createProject,
  moveNode,
  registerWorkspace,
  renameNode,
  type CreateConversationInput,
  type CreateProjectInput
} from './ops.js'
import type { TreeRepository } from './repository.js'

/** Identity and clock seams, injectable so results are deterministic in tests. */
export interface OrganizerCoreOptions {
  readonly repository: TreeRepository
  readonly newId?: (kind: 'project' | 'workspace' | 'conversation') => string
  readonly now?: () => string
}

/** One logical Project request, without storage or id details. */
export interface NewProject {
  readonly parentId: string
  readonly title: string
}

/** One Conversation request whose Session already exists on the host. */
export interface NewConversation {
  readonly parentId: string
  readonly title: string
  readonly sessionId: string
  readonly cwd?: string
}

/** Stable logical ids never derive from a path or a Session id. */
export function defaultLogicalId(kind: 'project' | 'workspace' | 'conversation'): string {
  const prefix = kind === 'project' ? 'prj' : kind === 'workspace' ? 'wsp' : 'cnv'
  return `${prefix}_${randomUUID()}`
}

/** The host-facing core: read, mutate, drain. */
export class OrganizerCore {
  readonly #repository: TreeRepository
  readonly #newId: (kind: 'project' | 'workspace' | 'conversation') => string
  readonly #now: () => string
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: OrganizerCoreOptions) {
    this.#repository = options.repository
    this.#newId = options.newId ?? defaultLogicalId
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  /** Storage location for diagnostics; never contains user content. */
  get location(): string {
    return this.#repository.location
  }

  /** Current tree without creating storage as a side effect of reading. */
  snapshot(): Promise<TreeSnapshot> {
    return this.#enqueue(async () => toSnapshot(await this.#load()))
  }

  /** Nested projects plus their conversations, ready for a later renderer. */
  rows(): Promise<{ revision: number; rows: ReturnType<typeof toRows> }> {
    return this.#enqueue(async () => {
      const document = await this.#load()
      return { revision: document.revision, rows: toRows(document) }
    })
  }

  createProject(input: NewProject): Promise<TreeSnapshot> {
    return this.#mutate((document) => createProject(document, {
      parentId: input.parentId,
      title: input.title,
      id: this.#newId('project'),
      now: this.#now()
    } satisfies CreateProjectInput))
  }

  /** Map an existing host Session to a new logical Conversation under a Project. */
  attachConversation(input: NewConversation): Promise<TreeSnapshot> {
    return this.#mutate((document) => createConversation(document, {
      parentId: input.parentId,
      title: input.title,
      sessionId: input.sessionId,
      id: this.#newId('conversation'),
      now: this.#now(),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd })
    } satisfies CreateConversationInput))
  }

  rename(input: { id: string; title: string }): Promise<TreeSnapshot> {
    return this.#mutate((document) => renameNode(document, { id: input.id, title: input.title, now: this.#now() }))
  }

  /** Register one terminal Workspace over an existing canonical directory. */
  registerWorkspace(input: {
    parentId: string
    title: string
    directory: string
    nativeWorkspaceId: string
  }): Promise<TreeSnapshot> {
    return this.#mutate((document) => registerWorkspace(document, {
      parentId: input.parentId,
      title: input.title,
      directory: input.directory,
      nativeWorkspaceId: input.nativeWorkspaceId,
      id: this.#newId('workspace'),
      now: this.#now()
    }))
  }

  /** Bind one existing directory-bound Conversation to a Workspace. */
  bindDirectoryConversation(input: {
    workspaceId: string
    title: string
    sessionId: string
  }): Promise<TreeSnapshot> {
    return this.#mutate((document) => bindDirectoryConversation(document, {
      workspaceId: input.workspaceId,
      title: input.title,
      sessionId: input.sessionId,
      id: this.#newId('conversation'),
      now: this.#now()
    }))
  }

  move(input: { id: string; parentId: string }): Promise<TreeSnapshot> {
    return this.#mutate((document) => moveNode(document, { id: input.id, parentId: input.parentId, now: this.#now() }))
  }

  /** Wait for every queued mutation; called by the Cordis effect disposer. */
  async drain(): Promise<void> {
    await this.#tail
  }

  async #load(): Promise<TreeDocument> {
    const stored = await this.#repository.load()
    return stored ?? createEmptyTree(this.#now())
  }

  #mutate(apply: (document: TreeDocument) => TreeDocument): Promise<TreeSnapshot> {
    return this.#enqueue(async () => {
      const document = await this.#load()
      const next = apply(document)
      if (next !== document) await this.#repository.save(next, document.revision)
      return toSnapshot(next)
    })
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work)
    this.#tail = run.then(
      () => undefined,
      () => undefined
    )
    return run.catch((error: unknown) => {
      throw error instanceof OrganizerError ? error : new OrganizerError('host/unavailable', 'organizer operation failed', {
        cause: error instanceof Error ? error.message : String(error)
      })
    })
  }
}
