/**
 * Boot-time self-check, run only when `DSH_WORKSPACE_ORGANIZER_SELFTEST=1`.
 *
 * It exercises the installed candidate inside the real host composition:
 *
 * - owner matrix over the Gateway: reads, two Project creations, one rename,
 *   one move, and the unchanged no-directory conversation refusal;
 * - non-owner matrix over the same Gateway for all seven endpoints, with two
 *   targets each (an existing node and a nonexistent one): default deny by the
 *   official Gateway, an explicit test grant that the plugin still refuses, and
 *   the revoked-grant denial again;
 * - oracles: business-entry counters, Session-creation counter, and the
 *   persisted tree's byte hash / revision / complete node set around every
 *   refusal phase.
 *
 * The report is written under the plugin's own data directory; nothing runs in
 * a normal deployment. The temporary grant exists only inside this self-test
 * and is withdrawn in a `finally`.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OrganizerError } from '../core/errors.js'
import { ROOT_ID } from '../core/model.js'
import { readHostServices } from './capabilities.js'
import { taskHostAvailability } from './tasks.js'
import { collectModuleIdentity } from './identity.js'
import type { WorkspaceOrganizerService } from '../service.js'

/** Environment flag that enables the self-check. */
export const SELFTEST_ENV = 'DSH_WORKSPACE_ORGANIZER_SELFTEST'

/** Endpoints the Remote namespace exports, in report order. */
const ENDPOINTS = ['status', 'snapshot', 'rows', 'createProject', 'renameNode', 'moveNode', 'createConversation'] as const
type Endpoint = typeof ENDPOINTS[number]

/** Endpoint → service method (the Remote names two of them differently). */
const SERVICE_METHOD: Record<Endpoint, string> = {
  status: 'status',
  snapshot: 'snapshot',
  rows: 'rows',
  createProject: 'createProject',
  renameNode: 'rename',
  moveNode: 'move',
  createConversation: 'createConversation'
}

/** The gateway surface the self-check exercises; the peer shape is Cordis-owned. */
interface GatewayLike {
  readonly invoke?: (request: unknown) => Promise<unknown>
}

interface SelfTestStep {
  readonly step: string
  readonly ok: boolean
  readonly detail?: string
  readonly [key: string]: unknown
}

/** One logical node as persisted; only the fields the oracle compares. */
interface StoredNode {
  readonly id: string
  readonly kind: string
  readonly parentId: string | null
  readonly title: string
}

interface TreeState {
  readonly sha256: string
  readonly revision: number
  readonly nodes: readonly StoredNode[]
}

/**
 * Build a synthetic Peer for an in-process dispatch. Production Peers are
 * created by the Host's connection layer; a wire client cannot choose its
 * principal, so this is test-only.
 */
function syntheticPeer(host: unknown, id: string, kind: string): Record<string, unknown> {
  return {
    id,
    ctx: host,
    principal: { kind },
    signal: new AbortController().signal,
    interactions: 'none',
    dispose: async () => undefined
  }
}

function ownerPeer(host: unknown): Record<string, unknown> {
  return syntheticPeer(host, 'workspace-organizer-selftest', 'owner')
}

/** Read the persisted tree strictly: absence or corruption is an error, never "unchanged". */
async function readTree(dataDir: string): Promise<TreeState> {
  const raw = await readFile(join(dataDir, 'tree.json'), 'utf8')
  const document = JSON.parse(raw) as { schemaVersion?: unknown; revision?: unknown; nodes?: unknown }
  if ((document.schemaVersion !== 1 && document.schemaVersion !== 2) || typeof document.revision !== 'number' || !Array.isArray(document.nodes)) {
    throw new Error('persisted tree is not a readable schema document')
  }
  return Object.freeze({
    sha256: createHash('sha256').update(raw).digest('hex'),
    revision: document.revision,
    nodes: Object.freeze((document.nodes as StoredNode[]).map((node) => Object.freeze({
      id: node.id,
      kind: node.kind,
      parentId: node.parentId,
      title: node.title
    })))
  })
}

/** Deep equality of two persisted trees, including every node field we track. */
function sameTree(a: TreeState, b: TreeState): boolean {
  return a.sha256 === b.sha256 &&
    a.revision === b.revision &&
    JSON.stringify(a.nodes) === JSON.stringify(b.nodes)
}

interface CallResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly code?: string
  readonly message?: string
  readonly details?: unknown
}

async function call(
  gateway: GatewayLike,
  peer: Record<string, unknown>,
  method: Endpoint,
  args: Record<string, unknown> = {}
): Promise<CallResult> {
  if (typeof gateway.invoke !== 'function') return { ok: false, code: 'gateway/unavailable' }
  try {
    const value = await gateway.invoke({
      namespace: 'workspaceOrganizer',
      method,
      args,
      peer,
      signal: new AbortController().signal
    })
    return { ok: true, value }
  } catch (error) {
    const structured = error as { code?: string; message?: string; details?: unknown }
    return {
      ok: false,
      code: typeof structured.code === 'string' ? structured.code : 'unknown',
      message: typeof structured.message === 'string' ? structured.message : String(error),
      details: structured.details
    }
  }
}

/** Count business entries so a refusal can prove it never reached the service. */
function instrumentService(service: WorkspaceOrganizerService): { counters: Record<Endpoint, number>; restore: () => void } {
  const counters = Object.fromEntries(ENDPOINTS.map((endpoint) => [endpoint, 0])) as Record<Endpoint, number>
  const target = service as unknown as Record<string, (...args: unknown[]) => unknown>
  const originals: Record<string, (...args: unknown[]) => unknown> = {}
  for (const endpoint of ENDPOINTS) {
    const method = SERVICE_METHOD[endpoint]
    const original = target[method]
    if (typeof original !== 'function') continue
    originals[method] = original
    target[method] = (...args: unknown[]) => {
      counters[endpoint] += 1
      return original.apply(service, args)
    }
  }
  return {
    counters,
    restore() {
      for (const [method, original] of Object.entries(originals)) target[method] = original
    }
  }
}

/** Count Session Controller creations; the port must never reach it here. */
function instrumentSession(host: unknown): { calls: () => number; instrumented: boolean; restore: () => void } {
  const controller = readHostServices(host).sessionController as
    | { create?: (request: Record<string, unknown>) => Promise<unknown> }
    | undefined
  const original = controller?.create
  let calls = 0
  if (controller !== undefined && typeof original === 'function') {
    controller.create = async (request: Record<string, unknown>) => {
      calls += 1
      return original.call(controller, request)
    }
    return {
      calls: () => calls,
      instrumented: true,
      restore() {
        if (controller !== undefined && original !== undefined) controller.create = original
      }
    }
  }
  // No composed controller: a zero counter proves nothing, so the assertion is
  // reported as NOT RUN instead of a vacuous pass.
  return { calls: () => 0, instrumented: false, restore() {} }
}

/** Arguments for one endpoint against an existing or a nonexistent target. */
function endpointArgs(method: Endpoint, target: string, secondary: string, forged: boolean): Record<string, unknown> {
  const extra = forged ? { principal: { kind: 'owner' }, peer: { principal: { kind: 'owner' } }, owner: true } : {}
  switch (method) {
    case 'createProject':
      return { request: { parentId: target, title: 'Refused project', ...extra } }
    case 'renameNode':
      return { request: { id: target, title: 'Refused rename', ...extra } }
    case 'moveNode':
      return { request: { id: target, parentId: secondary, ...extra } }
    case 'createConversation':
      return { request: { parentId: target, title: 'Refused conversation', ...extra } }
    default:
      return {}
  }
}

/** Run one phase over all endpoints and both targets; returns the observed codes. */
async function runMatrix(
  gateway: GatewayLike,
  peer: Record<string, unknown>,
  targets: { existing: string; secondary: string; missing: string },
  options: { forged?: boolean } = {}
): Promise<{ attempts: number; codes: string[]; allDetailsEmpty: boolean; allMessagesFixed: boolean; entered: boolean }> {
  const codes: string[] = []
  let allDetailsEmpty = true
  let allMessagesFixed = true
  let entered = false
  for (const method of ENDPOINTS) {
    for (const target of [targets.existing, targets.missing]) {
      const secondary = target === targets.existing ? targets.secondary : targets.missing
      const result = await call(gateway, peer, method, endpointArgs(method, target, secondary, options.forged === true))
      if (result.ok) entered = true
      codes.push(result.code ?? 'none')
      if (result.code === 'organizer/access-denied') {
        if (typeof result.details !== 'object' || result.details === null || Object.keys(result.details).length !== 0) {
          allDetailsEmpty = false
        }
        if (result.message !== 'workspace organizer RPC is restricted to the local owner') allMessagesFixed = false
      }
    }
  }
  return { attempts: codes.length, codes, allDetailsEmpty, allMessagesFixed, entered }
}

/** Run the check and write one report; never throws into the host boot path. */
export async function runSelfTest(service: WorkspaceOrganizerService, dataDir: string, host: unknown): Promise<void> {
  const startedAt = new Date().toISOString()
  const steps: SelfTestStep[] = []
  let status: unknown
  try {
    status = service.status()
    const before = await service.snapshot()
    steps.push({
      step: 'snapshot',
      ok: true,
      detail: 'read without creating storage',
      revision: before.revision,
      nodes: before.nodes.length,
      conversations: before.nodes.filter((node) => node.kind === 'conversation').length
    })

    const gateway = readHostServices(host).typertGateway as GatewayLike | undefined
    if (typeof gateway?.invoke !== 'function') {
      steps.push({ step: 'ownerMatrix', ok: false, detail: 'typertGateway.invoke is unavailable' })
    } else {
      const owner = ownerPeer(host)

      // Owner matrix over the Gateway: reads plus real mutations.
      const ownerReads = [await call(gateway, owner, 'status'), await call(gateway, owner, 'snapshot'), await call(gateway, owner, 'rows')]
      const readsOk = ownerReads.every((result) => result.ok === true)
      const createdA = await call(gateway, owner, 'createProject', { request: { parentId: ROOT_ID, title: 'Owner project A' } })
      const createdB = await call(gateway, owner, 'createProject', { request: { parentId: ROOT_ID, title: 'Owner project B' } })
      const nodeOf = (result: CallResult, title: string): { id: string } | undefined => {
        const snapshot = result.value as { nodes?: Array<{ id: string; title: string }> } | undefined
        return snapshot?.nodes?.find((node) => node.title === title)
      }
      const a = nodeOf(createdA, 'Owner project A')
      const b = nodeOf(createdB, 'Owner project B')
      const renamed = a !== undefined && b !== undefined
        ? await call(gateway, owner, 'renameNode', { request: { id: b.id, title: 'Owner project B renamed' } })
        : { ok: false, code: 'matrix/seed-missing' } as CallResult
      const moved = a !== undefined && b !== undefined
        ? await call(gateway, owner, 'moveNode', { request: { id: b.id, parentId: a.id } })
        : { ok: false, code: 'matrix/seed-missing' } as CallResult
      const afterMatrix = await service.snapshot()
      const matrixTree = await readTree(dataDir)
      const mutationRevisions = afterMatrix.revision - before.revision
      const mutationNodes = afterMatrix.nodes.length - before.nodes.length
      const matrixOk = readsOk && createdA.ok && createdB.ok && renamed.ok && moved.ok &&
        a !== undefined && b !== undefined &&
        mutationRevisions === 4 && mutationNodes === 2 &&
        matrixTree.revision === afterMatrix.revision
      steps.push({
        step: 'ownerMatrix',
        ok: matrixOk,
        reads: ownerReads.map((result) => result.ok),
        created: [createdA.ok, createdB.ok],
        renamed: renamed.ok,
        moved: moved.ok,
        projectId: a?.id,
        siblingId: b?.id,
        mutations: { revisions: mutationRevisions, nodes: mutationNodes },
        revision: afterMatrix.revision,
        nodes: afterMatrix.nodes.length
      })

      // No-directory conversation refusal must survive the owner path.
      if (a === undefined) {
        steps.push({ step: 'createConversationRefused', ok: false, detail: 'owner seed project missing' })
      } else {
        const revisionBefore = (await service.snapshot()).revision
        const refused = await call(gateway, owner, 'createConversation', { request: { parentId: a.id, title: 'Self-test conversation' } })
        const revisionAfter = (await service.snapshot()).revision
        steps.push({
          step: 'createConversationRefused',
          ok: refused.ok === false && refused.code === 'session/no-directory-unsupported' && revisionAfter === revisionBefore,
          refusedCode: refused.code,
          revisionBefore,
          revisionAfter,
          conversationsCreatable: (status as { conversationsCreatable?: boolean }).conversationsCreatable
        })
      }

      const entries = instrumentService(service)
      const session = instrumentSession(host)
      const sessionZero = (): boolean => (session.instrumented ? session.calls() === 0 : true)
      const sessionFields = (): Record<string, unknown> => ({
        sessionCalls: session.instrumented ? session.calls() : null,
        sessionAssertion: session.instrumented ? 'ASSERTED_ZERO' : 'NOT RUN'
      })
      try {
        const targets = {
          existing: a?.id ?? ROOT_ID,
          secondary: b?.id ?? ROOT_ID,
          missing: 'selftest-missing-node'
        }
        const baseline = await readTree(dataDir)
        for (const endpoint of ENDPOINTS) entries.counters[endpoint] = 0

        // Phase 1: non-owner with no policy → official Gateway denies.
        const defaultPhase = await runMatrix(gateway, syntheticPeer(host, 'wo-selftest-agent', 'selftestAgentDefault'), targets)
        const afterDefault = await readTree(dataDir)
        const defaultCounters = ENDPOINTS.reduce((sum, endpoint) => sum + entries.counters[endpoint], 0)
        steps.push({
          step: 'nonOwnerDefaultDenied',
          ok: defaultPhase.entered === false &&
            defaultPhase.codes.every((code) => code === 'remote-access/denied') &&
            defaultCounters === 0 &&
            sessionZero() &&
            sameTree(baseline, afterDefault),
          attempts: defaultPhase.attempts,
          denied: defaultPhase.codes.filter((code) => code === 'remote-access/denied').length,
          businessEntries: defaultCounters,
          ...sessionFields(),
          treeStable: sameTree(baseline, afterDefault)
        })

        // Phase 2: explicit test grant → Gateway allows, the plugin refuses.
        const remoteAccess = readHostServices(host).remoteAccess
        let policyRegistered = false
        let disposePolicy: (() => void) | undefined
        let grantedPhase: Awaited<ReturnType<typeof runMatrix>> = { attempts: 0, codes: [], allDetailsEmpty: true, allMessagesFixed: true, entered: false }
        try {
          if (typeof remoteAccess?.registerPolicy === 'function') {
            disposePolicy = remoteAccess.registerPolicy('selftestAgentGranted', {
              bindings: () => [{
                role: { name: 'selftest-allow-organizer', resource: 'global', actions: ENDPOINTS.map((method) => `workspaceOrganizer/${method}`) },
                resource: { kind: 'global' }
              }]
            })
            policyRegistered = true
            grantedPhase = await runMatrix(
              gateway,
              syntheticPeer(host, 'wo-selftest-granted', 'selftestAgentGranted'),
              targets,
              { forged: true }
            )
          }
        } finally {
          if (typeof disposePolicy === 'function') disposePolicy()
        }
        const afterGranted = await readTree(dataDir)
        const grantedCounters = ENDPOINTS.reduce((sum, endpoint) => sum + entries.counters[endpoint], 0)
        steps.push({
          step: 'nonOwnerGrantedStillDenied',
          ok: policyRegistered &&
            grantedPhase.entered === false &&
            grantedPhase.codes.every((code) => code === 'organizer/access-denied') &&
            grantedPhase.allDetailsEmpty &&
            grantedPhase.allMessagesFixed &&
            grantedCounters === 0 &&
            sessionZero() &&
            sameTree(baseline, afterGranted),
          attempts: grantedPhase.attempts,
          denied: grantedPhase.codes.filter((code) => code === 'organizer/access-denied').length,
          policyRegistered,
          forgedPayloads: true,
          detailsEmpty: grantedPhase.allDetailsEmpty,
          messageFixed: grantedPhase.allMessagesFixed,
          businessEntries: grantedCounters,
          ...sessionFields(),
          treeStable: sameTree(baseline, afterGranted)
        })

        // Phase 3: grant revoked → the Gateway denies again.
        const revokedPhase = await runMatrix(gateway, syntheticPeer(host, 'wo-selftest-revoked', 'selftestAgentGranted'), targets)
        const afterRevoked = await readTree(dataDir)
        const revokedCounters = ENDPOINTS.reduce((sum, endpoint) => sum + entries.counters[endpoint], 0)
        steps.push({
          step: 'nonOwnerGrantRevokedDenied',
          ok: revokedPhase.entered === false &&
            revokedPhase.codes.every((code) => code === 'remote-access/denied') &&
            revokedCounters === 0 &&
            sessionZero() &&
            sameTree(baseline, afterRevoked),
          attempts: revokedPhase.attempts,
          denied: revokedPhase.codes.filter((code) => code === 'remote-access/denied').length,
          businessEntries: revokedCounters,
          ...sessionFields(),
          treeStable: sameTree(baseline, afterRevoked)
        })

        const finalTree = await readTree(dataDir)
        const expectedRevision = before.revision + mutationRevisions
        const expectedNodes = before.nodes.length + mutationNodes
        steps.push({
          step: 'finalState',
          ok: finalTree.revision === expectedRevision && finalTree.nodes.length === expectedNodes,
          revision: finalTree.revision,
          nodes: finalTree.nodes.length,
          expectedRevision,
          expectedNodes,
          treeSha256: finalTree.sha256
        })
      } finally {
        entries.restore()
        session.restore()
      }
    }

    // C1 read-only service availability; a missing service is reported, not
    // emulated. The synthetic catalog fixture itself is NOT RUN in this probe.
    const c1 = taskHostAvailability(readHostServices(host))
    steps.push({
      step: 'c1HostAvailability',
      ok: true,
      available: c1.available,
      missing: c1.missing,
      note: 'synthetic catalog fixture NOT RUN'
    })

    // Peer resolution: a normal import must reach the host-shared Cordis and
    // Typert protocol. The host Context must be branded by that same Cordis and
    // its prototype must be that class's prototype, which a copy installed under
    // the plugin could not satisfy.
    const identity = await collectModuleIdentity(host)
    steps.push({
      step: 'moduleIdentity',
      ok: identity.cordis.contextBrand === true &&
        identity.cordis.instanceOfContext === true &&
        identity.protocol.sameServiceClass === true,
      pluginModule: identity.pluginModule,
      cordisResolved: identity.cordis.resolved,
      cordisPrototypeMatch: identity.cordis.prototypeMatch,
      cordisContextBrand: identity.cordis.contextBrand,
      cordisInstanceOf: identity.cordis.instanceOfContext,
      protocolResolved: identity.protocol.resolved,
      protocolSameServiceClass: identity.protocol.sameServiceClass
    })
  } catch (error) {
    steps.push({
      step: 'failure',
      ok: false,
      code: error instanceof OrganizerError ? error.code : 'host/unavailable',
      detail: error instanceof Error ? error.message : String(error)
    })
  }

  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, `selftest-${startedAt.replace(/[:.]/gu, '-')}.json`), `${JSON.stringify({
    plugin: 'workspace-organizer',
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    status,
    steps
  }, null, 2)}\n`, 'utf8')
}
