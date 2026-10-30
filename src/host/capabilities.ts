/**
 * Capability detection against the live Cordis context.
 *
 * Every read goes through `ctx.get()` on each call: a Cordis context is a strict
 * proxy, and services load asynchronously, so a snapshot captured at activation
 * would freeze the boot-time gaps. Nothing is emulated here; missing services
 * are reported with the reason and the dependency they belong to.
 */
/** The host services this plugin can use when the deployment composes them. */
export interface HostServices {
  readonly sessionController?: {
    readonly create?: (request: Record<string, unknown>) => Promise<unknown>
  }
  readonly sessions?: {
    readonly create?: (id?: string) => unknown
  }
  readonly connection?: unknown
  readonly fileUploads?: unknown
  readonly storageDomain?: {
    readonly open?: (spec: unknown) => Promise<unknown>
  }
  readonly typert?: {
    readonly register?: (contribution: unknown) => unknown
    readonly local?: unknown
  }
  readonly typertGateway?: unknown
  readonly remoteAccess?: {
    readonly registerPolicy?: (kind: string, policy: unknown) => () => void
  }
  readonly subagents?: {
    readonly listDescendants?: (rootSessionId: string, signal?: AbortSignal) => Promise<unknown>
  }
  readonly sessionQuery?: {
    readonly readSession?: (sessionId: string) => Promise<unknown>
  }
  readonly workspaceRegistry?: {
    readonly resolveByPath?: (path: string) => Promise<unknown>
  }
  readonly clientModules?: {
    readonly graph?: () => unknown
  }
  readonly webServer?: {
    readonly register?: (route: unknown) => unknown
  }
  readonly reflect?: {
    readonly props?: Record<string, unknown>
  }
}

/** One capability fact: present or absent, with the observation behind it. */
export interface CapabilityFact {
  readonly name: string
  readonly available: boolean
  readonly detail: string
}

/** Services this plugin watches for the conversation dependency chain. */
export const WATCHED_SERVICES = Object.freeze([
  'sessionController',
  'connection',
  'fileUploads',
  'sessions',
  'storageDomain',
  'typert',
  'typertGateway',
  'remoteAccess',
  'subagents',
  'sessionQuery',
  'workspaceRegistry',
  'clientModules'
] as const)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readService(host: unknown, key: string): Record<string, unknown> | undefined {
  if (!isObject(host)) return undefined
  const getter = host.get
  const value = typeof getter === 'function' ? (getter as (name: string) => unknown).call(host, key) : host[key]
  return isObject(value) ? value : undefined
}

/** Extract the service objects this plugin understands from a live context. */
export function readHostServices(host: unknown): HostServices {
  const services: Record<string, unknown> = {}
  for (const key of WATCHED_SERVICES) {
    const service = readService(host, key)
    if (service !== undefined) services[key] = service
  }
  return services as HostServices
}

/** Presence of each watched service, resolved at the moment of the call. */
export function servicePresence(host: unknown): Readonly<Record<string, boolean>> {
  const presence: Record<string, boolean> = {}
  for (const key of WATCHED_SERVICES) presence[key] = readService(host, key) !== undefined
  return Object.freeze(presence)
}

/**
 * Report the host surface needed by the logical tree, honestly.
 *
 * `sessionController.create` is present but not usable for a Project
 * Conversation: on this host it always binds a directory. A bare
 * `sessions.create` is reported and deliberately unused.
 */
export function describeCapabilities(services: HostServices): readonly CapabilityFact[] {
  const sessionController = services.sessionController
  const sessions = services.sessions
  const storageDomain = services.storageDomain
  const typert = services.typert
  const gateway = services.typertGateway
  return Object.freeze([
    Object.freeze({
      name: 'sessionController.create',
      available: typeof sessionController?.create === 'function',
      detail: typeof sessionController?.create === 'function'
        ? 'present, but its create() falls back to the process directory: unusable for a no-directory Project conversation'
        : 'absent: conversations cannot be created on this deployment'
    }),
    Object.freeze({
      name: 'conversation.noDirectoryMode',
      available: false,
      detail: 'unsupported on 0.2.1-rc.2: native create/resume/history require a directory'
    }),
    Object.freeze({
      name: 'sessions.create',
      available: typeof sessions?.create === 'function',
      detail: typeof sessions?.create === 'function'
        ? 'present but not used: a bare Session is not proven usable by the Web conversation surface'
        : 'absent'
    }),
    Object.freeze({
      name: 'storageDomain.open',
      available: typeof storageDomain?.open === 'function',
      detail: typeof storageDomain?.open === 'function'
        ? 'present: official domain storage is available for a later repository adapter'
        : 'absent: the tree uses its own versioned JSON aggregate'
    }),
    Object.freeze({
      name: 'typert.register',
      available: typeof typert?.register === 'function',
      detail: typeof typert?.register === 'function'
        ? 'present: Remote namespaces can be contributed through the official registry'
        : 'absent: no host Remote namespace can be contributed on this deployment'
    }),
    Object.freeze({
      name: 'typertGateway',
      available: gateway !== undefined,
      detail: gateway !== undefined
        ? 'present: the host Remote gateway is composed'
        : 'absent: no host Remote gateway is composed'
    })
  ])
}
