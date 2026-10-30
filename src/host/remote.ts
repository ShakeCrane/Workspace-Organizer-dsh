/**
 * Official Typert Remote namespace: `workspaceOrganizer`.
 *
 * The Host face uses `TypertRemoteService` + `Remote` markers. The Gateway's
 * documented source mode derives each endpoint from those markers, so no
 * generated artifact is required; the browser face mounts the matching
 * descriptors from `client/client.js`.
 *
 * Parameter lists stay plain identifiers: source mode reads them from the live
 * method, and a default, destructured, or typed parameter would invalidate the
 * endpoint instead of silently guessing its wire shape.
 */
import { Remote, RemoteError, TypertRemoteService, type RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { OrganizerError } from '../core/errors.js'
import type { TreeSnapshot } from '../core/model.js'
import type { OrganizerStatus, WorkspaceOrganizerService } from '../service.js'

/**
 * Translate the plugin's structured failure into the wire's stable code.
 *
 * `RemoteErrorCode` is a closed compile-time map of the core API's codes; the
 * wire itself carries any string, and the browser must keep the organizer's own
 * stable codes, so the cast is deliberate rather than a lossy mapping.
 */
function failure(error: unknown): never {
  if (error instanceof OrganizerError) {
    throw new RemoteError(error.code as RemoteErrorCode, error.message, { ...error.details })
  }
  throw error
}

/** Input for creating one logical Project. */
export interface CreateProjectRequest {
  readonly parentId: string
  readonly title: string
}

/** Input for renaming one logical node. */
export interface RenameNodeRequest {
  readonly id: string
  readonly title: string
}

/** Input for moving one logical node. */
export interface MoveNodeRequest {
  readonly id: string
  readonly parentId: string
}

/** Input for creating one ordinary conversation (currently refused). */
export interface CreateConversationRequest {
  readonly parentId: string
  readonly title: string
}

/** Register a terminal Workspace over an existing directory. */
export interface RegisterWorkspaceRequest {
  readonly parentId: string
  readonly title: string
  readonly directory: string
}

/** Bind an existing directory-bound Conversation. */
export interface BindDirectoryConversationRequest {
  readonly workspaceId: string
  readonly title: string
  readonly sessionId: string
}

/** Link one host-verified existing Session to a logical Project folder. */
export interface LinkExistingSessionRequest {
  readonly projectId: string
  readonly title: string
  readonly sessionId: string
}

/** Resolve one logical Conversation to its current native Session target. */
export interface ConversationTargetRequest {
  readonly conversationId: string
}

/** Reconcile the official catalog for one source Conversation. */
export interface ReconcileTasksRequest {
  readonly conversationId: string
}

/**
 * Fixed refusal for a caller that is not the local owner.
 *
 * The message and details are deliberately constant: a refusal must not reveal
 * whether a targeted node exists, its title, or a path.
 */
const ACCESS_DENIED = 'organizer/access-denied'

/** The invocation the Gateway exposes on the receiving method's context. */
interface GatewayInvocationLike {
  readonly peer?: {
    readonly principal?: { readonly kind?: unknown }
  }
}

/**
 * Require the real owner caller, read from the Gateway's invocation.
 *
 * The check never looks at request arguments: a browser-supplied role, an
 * `owner` field in the payload, or a forged peer object in the arguments cannot
 * grant access. The Gateway's own `remoteAccess` gate stays in place; this is a
 * second, namespace-local boundary that holds even when a test policy grants
 * the action.
 */
function requireOwner(context: Context): void {
  const invocation = (context as unknown as { invocation?: GatewayInvocationLike }).invocation
  const kind = invocation?.peer?.principal?.kind
  if (invocation === undefined || kind !== 'owner') {
    throw new RemoteError(ACCESS_DENIED as RemoteErrorCode, 'workspace organizer RPC is restricted to the local owner', {})
  }
}

/** Host service backing the generated `ctx.remote.workspaceOrganizer` namespace. */
export class WorkspaceOrganizerRemote extends TypertRemoteService {
  /**
   * The organizer service, kept as a TypeScript-private field rather than a
   * JS `#private` one: the Gateway invokes Remote methods on a Context-extended
   * receiver, and native private fields are not readable from that derivation.
   */
  private readonly service: WorkspaceOrganizerService

  constructor(ctx: Context, service: WorkspaceOrganizerService) {
    super(ctx, 'workspaceOrganizerRemote', { namespace: 'workspaceOrganizer' })
    this.service = service
  }

  /** Refuse any caller that is not the real local owner. */
  private assertOwner(): void {
    requireOwner(this.ctx)
  }

  /** Capability and dependency report; never contains user content. */
  @Remote('status')
  async status(): Promise<OrganizerStatus> {
    this.assertOwner()
    return this.service.status()
  }

  /** Current logical tree. */
  @Remote('snapshot')
  async snapshot(): Promise<TreeSnapshot> {
    this.assertOwner()
    return this.service.snapshot()
  }

  /** Depth-first rows for the browser tree. */
  @Remote('rows')
  async rows(): Promise<Awaited<ReturnType<WorkspaceOrganizerService['rows']>>> {
    this.assertOwner()
    try {
      return await this.service.rows()
    } catch (error) {
      failure(error)
    }
  }

  /** Create one nested Project. */
  @Remote('createProject')
  async createProject(request: CreateProjectRequest): Promise<TreeSnapshot> {
    this.assertOwner()
    try {
      return await this.service.createProject({ parentId: request.parentId, title: request.title })
    } catch (error) {
      failure(error)
    }
  }

  /** Rename one Project or Conversation. */
  @Remote('renameNode')
  async renameNode(request: RenameNodeRequest): Promise<TreeSnapshot> {
    this.assertOwner()
    try {
      return await this.service.rename({ id: request.id, title: request.title })
    } catch (error) {
      failure(error)
    }
  }

  /** Move one node under another Project; Sessions and directories are untouched. */
  @Remote('moveNode')
  async moveNode(request: MoveNodeRequest): Promise<TreeSnapshot> {
    this.assertOwner()
    try {
      return await this.service.move({ id: request.id, parentId: request.parentId })
    } catch (error) {
      failure(error)
    }
  }

  /** Create an ordinary conversation; refused while the host binds a directory. */
  @Remote('createConversation')
  async createConversation(request: CreateConversationRequest): Promise<TreeSnapshot> {
    this.assertOwner()
    try {
      return await this.service.createConversation({ parentId: request.parentId, title: request.title })
    } catch (error) {
      failure(error)
    }
  }

  /** Register a terminal Workspace over an existing directory (C1). */
  @Remote('registerWorkspace')
  async registerWorkspace(request: RegisterWorkspaceRequest): Promise<TreeSnapshot> {
    this.assertOwner()
    try {
      return await this.service.registerWorkspace({
        parentId: request.parentId,
        title: request.title,
        directory: request.directory
      })
    } catch (error) {
      failure(error)
    }
  }

  /** Bind an existing directory-bound Conversation to a Workspace (C1). */
  @Remote('bindDirectoryConversation')
  async bindDirectoryConversation(request: BindDirectoryConversationRequest): Promise<TreeSnapshot> {
    this.assertOwner()
    try {
      return await this.service.bindDirectoryConversation({
        workspaceId: request.workspaceId,
        title: request.title,
        sessionId: request.sessionId
      })
    } catch (error) {
      failure(error)
    }
  }

  /** Link an existing readable Session without changing its cwd or host record. */
  @Remote('linkExistingSession')
  async linkExistingSession(request: LinkExistingSessionRequest): Promise<TreeSnapshot> {
    this.assertOwner()
    try {
      return await this.service.linkExistingSession({
        projectId: request.projectId,
        title: request.title,
        sessionId: request.sessionId
      })
    } catch (error) {
      failure(error)
    }
  }

  /** Read-only current native target for opening an associated Conversation. */
  @Remote('conversationTarget')
  async conversationTarget(request: ConversationTargetRequest): Promise<{ conversationId: string; sessionId: string; treeRevision: number }> {
    this.assertOwner()
    try {
      return await this.service.conversationTarget({ conversationId: request.conversationId })
    } catch (error) {
      failure(error)
    }
  }

  /** Read-only catalog reconciliation for one source Conversation (C1). */
  @Remote('reconcileTasks')
  async reconcileTasks(request: ReconcileTasksRequest): Promise<unknown> {
    this.assertOwner()
    try {
      return await this.service.reconcileTasks({ conversationId: request.conversationId })
    } catch (error) {
      failure(error)
    }
  }

  /** Read-only task ledger snapshot (C1). */
  @Remote('taskLedger')
  async taskLedger(): Promise<unknown> {
    this.assertOwner()
    try {
      return await this.service.taskLedger()
    } catch (error) {
      failure(error)
    }
  }
}
