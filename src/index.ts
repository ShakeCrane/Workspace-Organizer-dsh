/**
 * Workspace-Organizer Cordis entrypoint (host half).
 *
 * The host half owns the logical organization tree (Root → Project → ordinary
 * Conversation) with stable ids, persists it as one versioned aggregate, maps a
 * Conversation to a real Session only when the host can honour the product
 * semantics, and exposes the tree to the browser through the official Typert
 * Remote namespace `workspaceOrganizer`.
 *
 * Conversation creation is deliberately fail-closed on DSH 0.2.1-rc.2: the
 * native Session Controller binds a directory when `cwd` is omitted, so the
 * plugin refuses before any Session exists instead of faking a no-directory
 * conversation.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { OrganizerError } from './core/errors.js'
import { JsonTreeRepository } from './core/repository.js'
import { OrganizerCore } from './core/service.js'
import { JsonTaskLedgerRepository, TaskLedgerService } from './core/taskService.js'
import { readHostServices, servicePresence } from './host/capabilities.js'
import { collectModuleIdentity } from './host/identity.js'
import { resolveDataDir } from './host/paths.js'
import { WorkspaceOrganizerRemote } from './host/remote.js'
import { runSelfTest, SELFTEST_ENV } from './host/selftest.js'
import { createHostSessionPort } from './host/sessions.js'
import { WorkspaceOrganizerService } from './service.js'

/** Cordis plugin name; also the `cordis.patch.yml` row id. */
export const name = 'workspace-organizer'

/** Service key this plugin provides on the host context. */
export const SERVICE_KEY = 'workspaceOrganizer'

/** Environment flag that writes a one-shot capability report for host verification. */
export const DIAGNOSTICS_ENV = 'DSH_WORKSPACE_ORGANIZER_DIAGNOSTICS'

/** Upper bound the diagnostic path waits for the Session dependency chain. */
export const SETTLE_TIMEOUT_MS = 30_000

/** Test seam: an explicit bounded settle window, never unbounded. */
export const SETTLE_MS_ENV = 'DSH_WORKSPACE_ORGANIZER_SETTLE_MS'

/** Resolve the settle window from the bounded override, or the default. */
function settleTimeout(): number {
  const raw = Number(process.env[SETTLE_MS_ENV] ?? '')
  return Number.isFinite(raw) && raw >= 0 && raw <= SETTLE_TIMEOUT_MS ? raw : SETTLE_TIMEOUT_MS
}

/** Optional plugin configuration from the Cordis row. */
export interface Config {
  /** Absolute parent directory for this plugin's data; defaults to the harness home. */
  readonly dataDir?: string
}

/**
 * The slice of the Cordis context this plugin uses.
 *
 * Declared structurally so a test can supply a context double without the whole
 * harness. The real value is always the live proxy: capabilities are read on
 * every call, never from a captured snapshot.
 */
export interface OrganizerContext {
  readonly provide?: (name: string, value: unknown) => unknown
  readonly effect?: (register: () => (() => unknown) | void) => unknown
  /** Cordis' safe service accessor; a direct property read of an undeclared service throws. */
  readonly get?: (name: string) => unknown
  readonly sessionController?: unknown
  readonly sessions?: unknown
  readonly storageDomain?: unknown
  readonly typert?: unknown
  readonly typertGateway?: unknown
  readonly connection?: unknown
  readonly fileUploads?: unknown
  readonly webServer?: unknown
  readonly reflect?: unknown
}

/**
 * Register the organizer service, its Remote namespace, and their drain hook.
 *
 * The service, the Remote service, and the client module registration are all
 * owned by the Cordis fiber: disabling the plugin removes the API and the
 * namespace, and the browser slot registration is withdrawn by its own effect,
 * so the native browsing region returns.
 */
export function apply(ctx: OrganizerContext, config: Config = {}): void {
  if (typeof ctx.provide !== 'function') {
    throw new OrganizerError('host/unavailable', 'Cordis context cannot provide the organizer service', { field: 'provide' })
  }
  const dataDir = resolveDataDir(config.dataDir)
  const repository = new JsonTreeRepository(join(dataDir, 'tree.json'))
  const core = new OrganizerCore({ repository })
  const taskRepository = new JsonTaskLedgerRepository(join(dataDir, 'tasks.json'))
  const tasks = new TaskLedgerService({ repository: taskRepository })
  // The live context, not a snapshot: late-loading services must be visible.
  const sessions = createHostSessionPort(ctx)
  const service = new WorkspaceOrganizerService({ core, sessions, host: ctx, dataDir, tasks })

  const withdraw = ctx.provide(SERVICE_KEY, service)
  const remote = new WorkspaceOrganizerRemote(ctx as unknown as Context, service)
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (typeof withdraw === 'function') withdraw()
    if (typeof (remote as { dispose?: () => unknown }).dispose === 'function') {
      await (remote as unknown as { dispose: () => Promise<void> }).dispose()
    }
    await service.close()
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => close())
  }

  if (process.env[DIAGNOSTICS_ENV] === '1') {
    void settleHostServices(ctx)
      .then((settled) => writeDiagnostics(dataDir, service, ctx, settled))
      .catch(() => undefined)
  }
  if (process.env[SELFTEST_ENV] === '1') {
    void settleHostServices(ctx)
      .then(() => runSelfTest(service, dataDir, ctx))
      .catch(() => undefined)
  }
}

/** What the bounded wait observed before the report was written. */
export interface SettleReport {
  readonly satisfied: boolean
  readonly waitedMs: number
  readonly missing: readonly string[]
  readonly presence: Readonly<Record<string, boolean>>
}

/**
 * Wait for the dependency that actually gates conversation creation.
 *
 * The wait ends when `sessionController` (and therefore its own `connection` /
 * `fileUploads` chain) is provided, or when the bound expires. It deliberately
 * does **not** stop early on `typert`: an early Typert registry says nothing
 * about whether the Session chain finished assembling.
 */
export async function settleHostServices(host: unknown, timeoutMs = settleTimeout()): Promise<SettleReport> {
  const startedAt = Date.now()
  let presence = servicePresence(host)
  while (Date.now() - startedAt < timeoutMs) {
    presence = servicePresence(host)
    if (presence.sessionController === true) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  const missing = Object.entries(presence).filter(([, present]) => present !== true).map(([name]) => name)
  return Object.freeze({
    satisfied: presence.sessionController === true,
    waitedMs: Date.now() - startedAt,
    missing: Object.freeze(missing),
    presence
  })
}

/** Compact view of what the host's client module graph actually advertises. */
interface ClientGraphReport {
  readonly available: boolean
  readonly mentionsPlugin: boolean
  readonly entryIds: readonly string[]
  readonly waitedMs: number
  readonly error?: string
}

/**
 * Read the host's composed client module graph.
 *
 * This is the authoritative "the browser will load my module" signal available
 * without a browser: the graph is what the Web host serves to the page. It is
 * polled briefly because the graph is composed during Web startup.
 */
async function waitForClientGraph(host: unknown, timeoutMs = 8_000): Promise<ClientGraphReport> {
  const startedAt = Date.now()
  const presenceDeadline = startedAt + 1_500
  let error: string | undefined
  while (Date.now() - startedAt < timeoutMs) {
    const service = readHostServices(host).clientModules
    if (service === undefined && Date.now() > presenceDeadline) break
    if (service !== undefined && typeof service.graph === 'function') {
      try {
        const value = service.graph.call(service) as { entries?: Array<{ id?: unknown }> }
        const json = JSON.stringify(value)
        const entryIds = Array.isArray(value?.entries)
          ? value.entries.map((entry) => (typeof entry?.id === 'string' ? entry.id : '(unnamed)'))
          : []
        return Object.freeze({
          available: true,
          mentionsPlugin: json.includes(name) || json.includes('workspace-organizer-dsh'),
          entryIds: Object.freeze(entryIds),
          waitedMs: Date.now() - startedAt
        })
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  return Object.freeze({
    available: false,
    mentionsPlugin: false,
    entryIds: Object.freeze([]),
    waitedMs: Date.now() - startedAt,
    ...(error === undefined ? {} : { error })
  })
}

/** Write the capability/status report once per boot when explicitly requested. */
async function writeDiagnostics(
  dataDir: string,
  service: WorkspaceOrganizerService,
  host: unknown,
  settled: SettleReport
): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const status = service.status()
  const reflect = readHostServices(host).reflect
  const getter = (host as { get?: (name: string) => unknown }).get
  const remoteService = typeof getter === 'function' ? getter.call(host, 'workspaceOrganizerRemote') !== undefined : false
  const clientGraph = await waitForClientGraph(host)
  const moduleIdentity = await collectModuleIdentity(host)
  await writeFile(join(dataDir, 'diagnostics.json'), `${JSON.stringify({
    plugin: name,
    remoteNamespace: 'workspaceOrganizer',
    remoteService,
    moduleIdentity,
    clientGraph,
    recordedAt: new Date().toISOString(),
    node: process.version,
    settle: {
      satisfied: settled.satisfied,
      waitedMs: settled.waitedMs,
      missing: settled.missing
    },
    presence: settled.presence,
    services: status.services,
    status,
    registeredServices: Object.keys(reflect?.props ?? {}).sort()
  }, null, 2)}\n`, 'utf8')
}
