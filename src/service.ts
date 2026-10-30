/**
 * The plugin's host-facing service surface.
 *
 * Creating a new Project Conversation is allowed only after the host proves it
 * can create one without a directory. On DSH 0.2.1-rc.2 no such mode exists,
 * so `createConversation` refuses. Lite can still bookmark an existing Session
 * after a read-only host lookup proves that Session is visible.
 *
 * Host capabilities are read live from the Cordis context on every call, so a
 * service that finishes loading later is visible to both status and commands.
 */
import type { TreeSnapshot } from './core/model.js'
import type { OrganizerCore } from './core/service.js'
import {
  describeCapabilities,
  readHostServices,
  servicePresence,
  type CapabilityFact
} from './host/capabilities.js'
import type { HostSessionPort, SessionDependencyReport } from './host/sessions.js'
import { OrganizerError } from './core/errors.js'
import type { TaskLedgerService } from './core/taskService.js'
import type { SourceRecord, TaskLedger } from './core/tasks.js'
import {
  observeCatalog,
  observeHeaders,
  resolveNativeWorkspace,
  taskHostAvailability,
  TASK_HOST_VERSION
} from './host/tasks.js'

/** Construction facts the service reports for diagnostics. */
export interface WorkspaceOrganizerOptions {
  readonly core: OrganizerCore
  readonly sessions: HostSessionPort
  /** The live Cordis context; every capability read goes through it. */
  readonly host: unknown
  readonly dataDir: string
  readonly tasks: TaskLedgerService
}

/** Explicit statement about the blocked capability, never a boolean alone. */
export interface ConversationCreationStatus {
  readonly supported: boolean
  readonly reason: string
  readonly dependencies: SessionDependencyReport
}

/** One status document; no user content, safe to log. */
export interface OrganizerStatus {
  readonly dataDir: string
  readonly treeLocation: string
  readonly capabilities: readonly CapabilityFact[]
  readonly conversationsCreatable: boolean
  readonly sessionSource: string
  readonly conversationCreation: ConversationCreationStatus
  readonly services: Readonly<Record<string, boolean>>
}

/** The API registered on the Cordis context as `workspaceOrganizer`. */
export class WorkspaceOrganizerService {
  readonly #core: OrganizerCore
  readonly #sessions: HostSessionPort
  readonly #host: unknown
  readonly #dataDir: string
  readonly #tasks: TaskLedgerService

  constructor(options: WorkspaceOrganizerOptions) {
    this.#core = options.core
    this.#sessions = options.sessions
    this.#host = options.host
    this.#dataDir = options.dataDir
    this.#tasks = options.tasks
  }

  /** Capability/status report for the Remote namespace and for logs. */
  status(): OrganizerStatus {
    return Object.freeze({
      dataDir: this.#dataDir,
      treeLocation: this.#core.location,
      capabilities: describeCapabilities(readHostServices(this.#host)),
      conversationsCreatable: this.#sessions.available(),
      sessionSource: this.#sessions.reason(),
      conversationCreation: Object.freeze({
        supported: this.#sessions.available(),
        reason: this.#sessions.reason(),
        dependencies: this.#sessions.dependencies()
      }),
      services: servicePresence(this.#host)
    })
  }

  snapshot(): Promise<TreeSnapshot> {
    return this.#core.snapshot()
  }

  rows(): Promise<Awaited<ReturnType<OrganizerCore['rows']>>> {
    return this.#core.rows()
  }

  createProject(input: { parentId: string; title: string }): Promise<TreeSnapshot> {
    return this.#core.createProject({ parentId: input.parentId, title: input.title })
  }

  /**
   * Create a real ordinary conversation and persist its logical mapping.
   *
   * Fails closed on this host version: the port refuses before any
   * Session-creating call, so nothing is persisted and no directory is bound.
   */
  async createConversation(input: { parentId: string; title: string }): Promise<TreeSnapshot> {
    const created = await this.#sessions.create()
    return this.#core.attachConversation({
      parentId: input.parentId,
      title: input.title,
      sessionId: created.sessionId
    })
  }

  rename(input: { id: string; title: string }): Promise<TreeSnapshot> {
    return this.#core.rename({ id: input.id, title: input.title })
  }

  move(input: { id: string; parentId: string }): Promise<TreeSnapshot> {
    return this.#core.move({ id: input.id, parentId: input.parentId })
  }

  /**
   * Register a terminal Workspace over an existing directory.
   *
   * The native Workspace must already exist: C1 binds an existing resource and
   * never creates a native directory registration on the user's behalf.
   */
  async registerWorkspace(input: { parentId: string; title: string; directory: string }): Promise<TreeSnapshot> {
    const services = readHostServices(this.#host)
    const availability = taskHostAvailability(services)
    if (!availability.available) {
      throw new OrganizerError('task/unavailable', 'workspace registration needs the read-only host services', {
        missing: [...availability.missing]
      })
    }
    const native = await resolveNativeWorkspace(services, input.directory)
    if (native === undefined) {
      throw new OrganizerError('task/source-not-bound', 'no native Workspace is registered for this directory', {
        directory: input.directory
      })
    }
    return this.#core.registerWorkspace({
      parentId: input.parentId,
      title: input.title,
      directory: native.path,
      nativeWorkspaceId: native.workspaceId
    })
  }

  /**
   * Resolve a logical Conversation id to the currently valid native Session
   * target. Read-only: it performs the same currentness checks as binding and
   * returns no tree mutation.
   */
  async conversationTarget(input: { conversationId: string }): Promise<{ conversationId: string; sessionId: string; treeRevision: number }> {
    const services = readHostServices(this.#host)
    const snapshot = await this.#core.snapshot()
    const conversation = snapshot.nodes.find((node) => node.id === input.conversationId && node.kind === 'conversation')
    if (conversation === undefined || conversation.sessionId === undefined) {
      throw new OrganizerError('task/source-not-bound', 'conversation does not exist', { conversationId: input.conversationId })
    }
    const parent = snapshot.nodes.find((node) => node.id === conversation.parentId)
    if (parent === undefined || (parent.kind !== 'workspace' && parent.kind !== 'project')) {
      throw new OrganizerError('task/source-not-bound', 'conversation has no valid Project or Workspace parent', { conversationId: input.conversationId })
    }
    const headers = await observeHeaders(services, [conversation.sessionId])
    const header = headers[conversation.sessionId]
    if (header === undefined) {
      throw new OrganizerError('task/unavailable', 'session header could not be read', { sessionId: conversation.sessionId })
    }
    if (header.origin === 'subagent') {
      throw new OrganizerError('task/subagent-session', 'a subagent Session cannot be opened as an ordinary conversation', { sessionId: conversation.sessionId })
    }

    if (parent.kind === 'project') {
      return Object.freeze({ conversationId: conversation.id, sessionId: conversation.sessionId, treeRevision: snapshot.revision })
    }

    const workspace = parent
    if (workspace.directory === undefined) {
      throw new OrganizerError('task/source-not-bound', 'conversation Workspace has no directory', { conversationId: input.conversationId })
    }
    if (header.cwd !== workspace.directory || conversation.cwd !== workspace.directory) {
      throw new OrganizerError('task/source-not-bound', 'session cwd does not match the workspace directory', { sessionId: conversation.sessionId })
    }
    const current = await resolveNativeWorkspace(services, workspace.directory)
    if (current === undefined || current.workspaceId !== workspace.nativeWorkspaceId || current.path !== workspace.directory) {
      throw new OrganizerError('task/source-not-bound', 'native Workspace identity is no longer current', { directory: workspace.directory })
    }
    if (current.archivedKnown !== true) {
      throw new OrganizerError('task/unavailable', 'native Workspace archived state could not be confirmed', { directory: workspace.directory })
    }
    if (current.archivedSessionIds.includes(conversation.sessionId)) {
      throw new OrganizerError('task/source-not-bound', 'conversation Session is archived', { sessionId: conversation.sessionId })
    }
    return Object.freeze({ conversationId: conversation.id, sessionId: conversation.sessionId, treeRevision: snapshot.revision })
  }
  /**
   * Bind an existing directory-bound Conversation to a Workspace.
   *
   * The Session header is read cold and its cwd must equal the Workspace
   * directory. A subagent-derived Session is refused; the path never grants
   * write permission.
   */
  async bindDirectoryConversation(input: { workspaceId: string; title: string; sessionId: string }): Promise<TreeSnapshot> {
    const services = readHostServices(this.#host)
    const snapshot = await this.#core.snapshot()
    const workspace = snapshot.nodes.find((node) => node.id === input.workspaceId && node.kind === 'workspace')
    if (workspace === undefined || workspace.directory === undefined) {
      throw new OrganizerError('tree/unknown-node', 'workspace does not exist', { id: input.workspaceId })
    }
    const headers = await observeHeaders(services, [input.sessionId])
    const header = headers[input.sessionId]
    if (header === undefined) {
      throw new OrganizerError('task/unavailable', 'session header could not be read', { sessionId: input.sessionId })
    }
    if (header.origin === 'subagent') {
      throw new OrganizerError('task/subagent-session', 'a subagent Session cannot become an ordinary conversation', {
        sessionId: input.sessionId
      })
    }
    if (header.cwd !== workspace.directory) {
      throw new OrganizerError('task/source-not-bound', 'session cwd does not match the workspace directory', {
        sessionId: input.sessionId,
        expected: workspace.directory,
        found: header.cwd ?? null
      })
    }
    const current = await resolveNativeWorkspace(services, workspace.directory)
    if (current === undefined || current.workspaceId !== workspace.nativeWorkspaceId || current.path !== workspace.directory) {
      throw new OrganizerError('task/source-not-bound', 'native Workspace identity is no longer current', {
        directory: workspace.directory,
        expectedNativeWorkspaceId: workspace.nativeWorkspaceId,
        foundNativeWorkspaceId: current?.workspaceId ?? null
      })
    }
    if (current.archivedKnown !== true) {
      throw new OrganizerError('task/unavailable', 'native Workspace archived state could not be confirmed', {
        directory: workspace.directory
      })
    }
    if (current.archivedSessionIds.includes(input.sessionId)) {
      throw new OrganizerError('task/source-not-bound', 'an archived Session cannot become an ordinary conversation', {
        sessionId: input.sessionId,
        reason: 'archived'
      })
    }
    return this.#core.bindDirectoryConversation({
      workspaceId: workspace.id,
      title: input.title,
      sessionId: input.sessionId
    })
  }

  /**
   * Add a bookmark to an existing readable Session under a logical Project.
   *
   * DSH 0.2.1-rc.2 has no session-list surface available to this plugin, so the
   * caller supplies an id and the host's cold readSession lookup must prove it
   * exists and is visible before the logical mapping is persisted. This never
   * creates a Session and deliberately does not bind its cwd to the Project.
   */
  async linkExistingSession(input: { projectId: string; title: string; sessionId: string }): Promise<TreeSnapshot> {
    const sessionId = input.sessionId.trim()
    if (sessionId.length === 0) {
      throw new OrganizerError('tree/invalid-session', 'Session ID must not be empty', { field: 'sessionId' })
    }

    const snapshot = await this.#core.snapshot()
    const project = snapshot.nodes.find((node) => node.id === input.projectId && node.kind === 'project')
    if (project === undefined || project.parentId === null) {
      throw new OrganizerError('tree/invalid-parent-kind', 'an existing Session must be linked under a Project folder, not Root', {
        projectId: input.projectId
      })
    }

    const services = readHostServices(this.#host)
    const headers = await observeHeaders(services, [sessionId])
    const header = headers[sessionId]
    if (header === undefined) {
      throw new OrganizerError('task/unavailable', 'host could not verify that this Session exists and is readable', {
        service: 'sessionQuery.readSession',
        sessionId
      })
    }
    if (header.origin === 'subagent') {
      throw new OrganizerError('task/subagent-session', 'a subagent Session cannot be linked as an ordinary conversation', {
        sessionId
      })
    }

    return this.#core.attachConversation({
      parentId: project.id,
      title: input.title,
      sessionId
    })
  }

  /**
   * Reconcile the official subagent catalog into the task ledger (read-only).
   *
   * Only a directory-bound Conversation is a valid C1 source. Catalog reads do
   * not load or resume Agents; headers are read cold for cwd verification.
   */
  async reconcileTasks(input: { conversationId: string }): Promise<{ ledger: TaskLedger; conflicts: readonly unknown[] }> {
    const services = readHostServices(this.#host)
    const availability = taskHostAvailability(services)
    const snapshot = await this.#core.snapshot()
    const conversation = snapshot.nodes.find((node) => node.id === input.conversationId && node.kind === 'conversation')
    if (conversation === undefined || conversation.sessionId === undefined) {
      throw new OrganizerError('task/source-not-bound', 'conversation does not exist', { conversationId: input.conversationId })
    }
    const workspace = snapshot.nodes.find((node) => node.id === conversation.parentId && node.kind === 'workspace')
    if (workspace === undefined || workspace.directory === undefined) {
      throw new OrganizerError('task/source-not-bound', 'only a directory-bound Conversation is a C1 source', {
        conversationId: input.conversationId
      })
    }
    if (conversation.cwd !== workspace.directory) {
      throw new OrganizerError('task/source-not-bound', 'conversation cwd does not match its workspace directory', {
        conversationId: input.conversationId
      })
    }
    if (!availability.available) {
      throw new OrganizerError('task/unavailable', 'task reconciliation services are unavailable', {
        missing: [...availability.missing]
      })
    }

    // Re-verify the source and its resources at the observation boundary. A
    // failed check keeps the identity but blocks the source and adopts no new
    // catalog edge (no revival, no refreshed verifiedAt).
    const sourceHeaders = await observeHeaders(services, [conversation.sessionId])
    const sourceHeader = sourceHeaders[conversation.sessionId]
    const native = await resolveNativeWorkspace(services, workspace.directory)
    let sourceBlockedReason: string | undefined
    if (sourceHeader === undefined) sourceBlockedReason = 'header-unavailable'
    else if (sourceHeader.origin === 'subagent') sourceBlockedReason = 'subagent-origin'
    else if (sourceHeader.cwd !== workspace.directory) sourceBlockedReason = 'cwd-changed'
    else if (native === undefined) sourceBlockedReason = 'workspace-missing'
    else if (workspace.nativeWorkspaceId !== undefined && native.workspaceId !== workspace.nativeWorkspaceId) sourceBlockedReason = 'workspace-changed'
    else if (native.path !== workspace.directory) sourceBlockedReason = 'workspace-path-changed'
    else if (native.archivedKnown !== true) sourceBlockedReason = 'source-archived-unknown'
    else if (native.archivedSessionIds.includes(conversation.sessionId)) sourceBlockedReason = 'source-archived'

    const previousLedger = await this.#tasks.snapshot()
    const previousSource = previousLedger.sources.find((entry) => entry.conversationId === conversation.id)
    const catalog = await observeCatalog(services, conversation.sessionId)
    const childIds = catalog.filter((row) => row.kind === 'child').map((row) => row.id)
    const headers = await observeHeaders(services, childIds)
    const source: SourceRecord = Object.freeze({
      conversationId: conversation.id,
      sessionId: conversation.sessionId,
      workspaceLogicalId: workspace.id,
      directory: workspace.directory,
      ...(workspace.nativeWorkspaceId === undefined ? {} : { nativeWorkspaceId: workspace.nativeWorkspaceId }),
      ...(sourceBlockedReason === undefined
        ? { verifiedAt: new Date().toISOString(), verificationState: 'verified' as const }
        : {
            ...(previousSource?.verifiedAt === undefined ? {} : { verifiedAt: previousSource.verifiedAt }),
            verificationState: 'blocked' as const,
            blockedReason: sourceBlockedReason
          }),
      hostVersion: TASK_HOST_VERSION
    })
    const result = await this.#tasks.reconcile({
      source,
      catalog,
      headers,
      ...(sourceBlockedReason === undefined ? {} : { sourceBlockedReason })
    })
    return { ledger: result.ledger, conflicts: result.conflicts }
  }

  /** Read-only ledger snapshot; never observes or resumes anything. */
  taskLedger(): Promise<TaskLedger> {
    return this.#tasks.snapshot()
  }

  /** Read-only availability report for the C1 host services. */
  taskHostStatus(): ReturnType<typeof taskHostAvailability> & { readonly ledgerLocation: string } {
    return Object.freeze({
      ...taskHostAvailability(readHostServices(this.#host)),
      ledgerLocation: this.#tasks.location
    })
  }

  /** Drain queued mutations; the Cordis effect disposer awaits this. */
  async close(): Promise<void> {
    await this.#core.drain()
    await this.#tasks.drain()
  }
}
