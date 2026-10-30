/**
 * Conversation → real Session adapter, with an explicit no-directory gate.
 *
 * Two facts drive this module:
 *
 * 1. The Controller is resolved through the live Cordis context on every call,
 *    so a service that loads after this plugin is still visible.
 * 2. On DSH 0.2.1-rc.2 the Session Controller's `create` is not a no-directory
 *    API: omitting `cwd` falls back to the host process directory, creates that
 *    directory, and the resume/history paths reject a header without a cwd.
 *    A Project Conversation therefore must **not** be created through it until
 *    the host grows a real no-directory mode. `create()` refuses before any
 *    Session-creating call, which is the fail-closed boundary the Architect
 *    required — no implicit directory is ever bound or hidden.
 */
import { OrganizerError } from '../core/errors.js'
import { readHostServices, type HostServices } from './capabilities.js'

/** Options a future compliant no-directory creation may accept. */
export interface SessionCreateOptions {
  readonly agentPreset?: string
}

/** The proven result of creating a real conversation. */
export interface CreatedSession {
  readonly sessionId: string
}

/** Presence of the services that gate conversation creation, read live. */
export interface SessionDependencyReport {
  readonly sessionController: boolean
  readonly connection: boolean
  readonly fileUploads: boolean
  readonly sessions: boolean
}

/** The narrow port the organizer core needs from the host. */
export interface HostSessionPort {
  /** Whether a compliant no-directory conversation can be created right now. */
  available(): boolean
  reason(): string
  dependencies(): SessionDependencyReport
  create(options?: SessionCreateOptions): Promise<CreatedSession>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read a host service lazily, tolerating a context that appears later. */
function currentServices(host: unknown): HostServices {
  return readHostServices(host)
}

/** Live presence of the dependency chain the Controller waits on. */
export function readSessionDependencies(services: HostServices): SessionDependencyReport {
  return Object.freeze({
    sessionController: typeof services.sessionController?.create === 'function',
    connection: services.connection !== undefined,
    fileUploads: services.fileUploads !== undefined,
    sessions: typeof services.sessions?.create === 'function'
  })
}

/** Read `sessionId` from a Session Controller reply, proving a non-blank id. */
export function readCreatedSessionId(reply: unknown): string {
  if (!isRecord(reply)) {
    throw new OrganizerError('session/create-failed', 'Session Controller returned no result object')
  }
  const sessionId = reply.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new OrganizerError('session/create-failed', 'Session Controller returned no usable Session id', {
      field: 'sessionId'
    })
  }
  return sessionId.trim()
}

/**
 * Bind the host Session Controller lazily and keep the no-directory door shut.
 *
 * `available()` stays false while the host has no no-directory mode, so a status
 * report cannot accidentally advertise a capability the product contract needs
 * but the host does not provide.
 */
export function createHostSessionPort(host: unknown): HostSessionPort {
  const dependencies = (): SessionDependencyReport => readSessionDependencies(currentServices(host))
  const unavailableReason = (report: SessionDependencyReport): string => {
    if (!report.sessionController) return 'host Session Controller is not composed in this deployment'
    return 'host Session Controller has no no-directory mode: create() falls back to the process directory'
  }
  return Object.freeze({
    available: () => false,
    reason: () => unavailableReason(dependencies()),
    dependencies,
    create: async (): Promise<CreatedSession> => {
      const report = dependencies()
      if (!report.sessionController) {
        throw new OrganizerError('session/unavailable', 'host Session Controller is not composed in this deployment', {
          service: 'sessionController',
          dependencies: report
        })
      }
      throw new OrganizerError(
        'session/no-directory-unsupported',
        'refused to create a Project conversation: the host Session Controller would bind an implicit process directory',
        {
          dependencies: report,
          hostVersion: '0.2.1-rc.2',
          fallback: 'workspace.path ?? request.cwd ?? process.cwd()',
          createsDirectory: true,
          resumeRequiresCwd: true
        }
      )
    }
  })
}
