/**
 * Test-only C1 fixture plugin (never shipped). Loaded only through an isolated
 * profile patch with an explicit phase.
 *
 * setup:   create native Workspaces, synthetic ordinary sources and catalog
 *          facts, persist every session through the official
 *          `sessionPersistence.create(header)` write handle, then measure
 *          through the real Gateway.
 * measure: no creation, no appends; cold-read the persisted logs through the
 *          real SessionQuery/listDescendants and re-run the authorization
 *          matrix with an exact session-scoped test grant.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'c1-fixture'

const ENDPOINTS = [
  'status', 'snapshot', 'rows', 'createProject', 'renameNode', 'moveNode', 'createConversation',
  'registerWorkspace', 'bindDirectoryConversation', 'reconcileTasks', 'taskLedger'
]
const SERVICE_METHOD = {
  status: 'status', snapshot: 'snapshot', rows: 'rows', createProject: 'createProject',
  renameNode: 'rename', moveNode: 'move', createConversation: 'createConversation',
  registerWorkspace: 'registerWorkspace', bindDirectoryConversation: 'bindDirectoryConversation',
  reconcileTasks: 'reconcileTasks', taskLedger: 'taskLedger'
}
const FORGED_SESSION = 'c1-forged'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function peer(ctx, id, kind) {
  return { id, ctx, principal: { kind }, signal: new AbortController().signal }
}

async function invoke(gateway, p, method, args) {
  try {
    return { ok: true, value: await gateway.invoke({ namespace: 'workspaceOrganizer', method, args, peer: p, signal: new AbortController().signal }) }
  } catch (error) {
    return { ok: false, code: error?.code ?? 'error', message: error?.message ?? String(error), details: error?.details ?? null }
  }
}

function endpointArgs(method, target, secondary, workspaceId) {
  switch (method) {
    case 'createProject': return { request: { parentId: target, title: 'C1 refused project' } }
    case 'renameNode': return { request: { id: target, title: 'C1 refused rename' } }
    case 'moveNode': return { request: { id: target, parentId: secondary } }
    case 'createConversation': return { request: { parentId: target, title: 'C1 refused conversation' } }
    case 'registerWorkspace': return { request: { parentId: target, title: 'C1 refused workspace', directory: 'E:\\c1-refused' } }
    case 'bindDirectoryConversation': return { request: { workspaceId, title: 'C1 refused binding', sessionId: secondary } }
    case 'reconcileTasks': return { request: { conversationId: target } }
    default: return {}
  }
}

function instrument(service, methods) {
  const counters = {}
  const originals = {}
  const installed = {}
  for (const method of methods) {
    installed[method] = typeof service?.[method] === 'function'
    if (!installed[method]) continue
    counters[method] = 0
    originals[method] = service[method]
    service[method] = function instrumented(...args) {
      counters[method] = (counters[method] ?? 0) + 1
      // Preserve the original return (sync value or promise) and `this`.
      return originals[method].apply(this, args)
    }
  }
  return { counters, installed, restore() { for (const [method, original] of Object.entries(originals)) service[method] = original } }
}

async function waitFor(ctx) {
  const services = {}
  const keys = ['sessions', 'sessionPersistence', 'workspaceRegistry', 'subagents', 'sessionQuery', 'sessionController', 'agents', 'agent', 'typertGateway', 'remoteAccess', 'workspaceOrganizer']
  for (let attempt = 0; attempt < 80; attempt += 1) {
    for (const key of keys) if (services[key] === undefined) services[key] = ctx.get(key)
    if (services.sessions && services.sessionPersistence && services.workspaceRegistry && services.subagents && services.sessionQuery && services.typertGateway && services.workspaceOrganizer) return services
    await sleep(250)
  }
  return services
}

const CATALOG = {
  'c1-src-a': [{ childId: 'c1-a-t1', mode: 'continuable', label: 'T1' }],
  'c1-a-t1': [{ childId: 'c1-a-t2', mode: 'continuable', label: 'T2' }],
  'c1-a-t2': [{ childId: 'c1-a-t3', mode: 'one-shot', label: 'T3' }],
  'c1-src-b': [{ childId: 'c1-b-u1', mode: 'one-shot', label: 'U1' }]
}

export function apply(ctx, config) {
  void (async () => {
    const dataDir = config.dataDir
    const result = { phase: config.phase, steps: [], ok: false }
    const services = await waitFor(ctx)
    result.services = Object.fromEntries(Object.entries(services).map(([key, value]) => [key, value !== undefined]))
    const step = async (name, fn) => {
      try {
        const value = await fn()
        result.steps.push({ step: name, ok: true, value })
        return value
      } catch (error) {
        result.steps.push({ step: name, ok: false, error: String(error?.stack ?? error) })
        return undefined
      }
    }
    const gateway = services.typertGateway
    const owner = peer(ctx, 'c1-fixture-owner', 'owner')
    const dirA = config.dirA
    const dirB = config.dirB
    const sourceId = 'c1-src-a'
    const setupFile = join(dataDir, 'c1-setup.json')
    let setup = undefined
    try { setup = JSON.parse(await readFile(setupFile, 'utf8')) } catch {}

    if (config.phase === 'setup') {
      await mkdir(dataDir, { recursive: true })
      await mkdir(dirA, { recursive: true })
      await mkdir(dirB, { recursive: true })

      const native = await step('native-workspaces', async () => {
        const registry = services.workspaceRegistry
        const resolveOrCreate = async (dir, title) => {
          const existing = await registry.resolveByPath(dir)
          if (existing !== undefined) return { id: existing.id, path: existing.path }
          const created = await registry.create(dir, title)
          return { id: created.id, path: created.path }
        }
        return { a: await resolveOrCreate(dirA, 'C1 W A'), b: await resolveOrCreate(dirB, 'C1 W B') }
      })

      const sessions = services.sessions
      const SP = services.sessionPersistence
      const created = []
      const meta = {
        'c1-src-a': { cwd: dirA },
        'c1-src-b': { cwd: dirB },
        'c1-a-t1': { cwd: dirA, origin: 'subagent' },
        'c1-a-t2': { cwd: dirA, origin: 'subagent' },
        'c1-a-t3': { cwd: dirA, origin: 'subagent' },
        'c1-b-u1': { cwd: dirB, origin: 'subagent' },
        'c1-orphan': { cwd: dirA, origin: 'subagent' },
        'c1-fork': { cwd: dirA, parentSession: sourceId }
      }
      const live = {}
      await step('persist-official-handles', async () => {
        const records = []
        for (const [id, m] of Object.entries(meta)) {
          const detached = sessions.prepare(id, { meta: m })
          const events = []
          for (const fact of CATALOG[id] ?? []) {
            events.push(detached.append('subagent/catalog', {
              childId: fact.childId,
              childCreatedAt: Date.now(),
              version: 0,
              mode: fact.mode,
              ...(fact.label === undefined ? {} : { label: fact.label })
            }))
          }
          const expected = events.map((event) => event.seq)
          if (JSON.stringify(expected) !== JSON.stringify(events.map((_, index) => index))) {
            throw new Error(`seq continuity broken for ${id}: ${JSON.stringify(expected)}`)
          }
          const handle = await SP.create(detached.header)
          try {
            for (const event of events) await handle.append([event])
            await handle.flush()
          } finally {
            await handle.close()
          }
          const reader = await SP.open(id, 'read')
          const read = await reader.read()
          await reader.close()
          records.push({ id, expected: events.length, stored: read.events.length })
        }
        const root = join(config.dshHome, 'sessions')
        const rootExists = await stat(root).then(() => true, () => false)
        const files = rootExists ? await readdir(root, { recursive: true }) : []
        return { records, root, rootExists, files: files.slice(0, 40) }
      })

      await step('synthetic-live-sessions', async () => {
        for (const [id, m] of Object.entries(meta)) {
          const session = sessions.create(id, { meta: m })
          live[id] = session
          created.push(session)
        }
        for (const [id, facts] of Object.entries(CATALOG)) {
          for (const fact of facts) {
            live[id].append('subagent/catalog', {
              childId: fact.childId,
              childCreatedAt: Date.now(),
              version: 0,
              mode: fact.mode,
              ...(fact.label === undefined ? {} : { label: fact.label })
            })
          }
        }
        for (const session of created) await sessions.flush(session)
        return created.map((session) => session.id)
      })

      const catalog = await step('catalog-live', async () => services.subagents.listDescendants(sourceId))

      const execution = [
        ['subagents', ['start', 'startActivation', 'interrupt', 'message']],
        ['sessionController', ['create', 'resume', 'prompt']],
        ['sessions', ['create', 'prepare']]
      ]
      const exec = execution.map(([key, methods]) => ({ key, ...instrument(services[key] ?? {}, methods) }))
      const business = instrument(services.workspaceOrganizer, ENDPOINTS.map((method) => SERVICE_METHOD[method]))
      const countersBefore = exec.map((entry) => ({ key: entry.key, ...entry.counters }))

      const wsA = await step('register-workspace', async () => {
        const registered = await invoke(gateway, owner, 'registerWorkspace', { request: { parentId: 'root', title: 'C1 W A', directory: dirA } })
        if (!registered.ok) throw new Error(`registerWorkspace failed: ${registered.code}`)
        return registered.value.nodes.find((node) => node.kind === 'workspace' && node.directory === native.a.path)?.id
      })
      const bound = await step('bind-source', async () => {
        const boundTree = await invoke(gateway, owner, 'bindDirectoryConversation', { request: { workspaceId: wsA, title: 'C1 source A', sessionId: sourceId } })
        if (!boundTree.ok) throw new Error(`bind failed: ${boundTree.code}`)
        return boundTree.value.nodes.find((node) => node.sessionId === sourceId)?.id
      })
      const forkBind = await step('bind-fork', async () => {
        const forkTree = await invoke(gateway, owner, 'bindDirectoryConversation', { request: { workspaceId: wsA, title: 'C1 fork', sessionId: 'c1-fork' } })
        return { ok: forkTree.ok, code: forkTree.code ?? null }
      })
      const orphanBind = await step('bind-subagent-rejected', async () => {
        const orphanTree = await invoke(gateway, owner, 'bindDirectoryConversation', { request: { workspaceId: wsA, title: 'C1 orphan', sessionId: 'c1-orphan' } })
        return { ok: orphanTree.ok, code: orphanTree.code ?? null }
      })

      const EXPECTED = [
        { child: 'c1-a-t1', depth: 1, parent: { kind: 'conversation' } },
        { child: 'c1-a-t2', depth: 2, parent: { kind: 'task', taskOf: 'c1-a-t1' } },
        { child: 'c1-a-t3', depth: 3, parent: { kind: 'task', taskOf: 'c1-a-t2' } }
      ]
      const reconciled = await step('reconcile-live', async () => {
        const outcome = await invoke(gateway, owner, 'reconcileTasks', { request: { conversationId: bound } })
        if (!outcome.ok) throw new Error(`reconcile failed: ${outcome.code}`)
        return { ledger: outcome.value.ledger, conflicts: outcome.value.conflicts }
      })
      const ledgerRead = await step('ledger-via-gateway', async () => {
        const outcome = await invoke(gateway, owner, 'taskLedger', {})
        if (!outcome.ok) throw new Error(`taskLedger failed: ${outcome.code}`)
        return outcome.value
      })

      // Exact resource grant: the Gateway derives {kind:'session', id:<request.sessionId>}.
      const decisions = []
      let decideOriginal
      const remoteAccess = services.remoteAccess
      if (typeof remoteAccess?.decide === 'function') {
        decideOriginal = remoteAccess.decide
        remoteAccess.decide = (request) => {
          decisions.push({ action: request?.action ?? null, resources: request?.resources ?? null })
          return decideOriginal.call(remoteAccess, request)
        }
      }

      const matrix = async (p) => {
        const results = []
        for (const method of ENDPOINTS) {
          for (const target of [bound, 'c1-missing']) {
            const workspaceId = target === bound ? wsA : 'c1-missing'
            const outcome = await invoke(gateway, p, method, endpointArgs(method, target, FORGED_SESSION, workspaceId))
            results.push({
              method,
              target: target === bound ? 'existing' : 'missing',
              ok: outcome.ok,
              code: outcome.code ?? null,
              message: outcome.message ?? null,
              details: outcome.details ?? null
            })
          }
        }
        return results
      }
      const defaultPhase = await step('matrix-default', async () => matrix(peer(ctx, 'c1-agent-default', 'c1Default')))
      const ownerBusiness = { ...business.counters }
      let grantedPhase
      let disposePolicy
      await step('matrix-granted', async () => {
        disposePolicy = remoteAccess.registerPolicy('c1Granted', {
          bindings: () => [
            {
              role: { name: 'c1-allow-all', resource: 'global', actions: ENDPOINTS.map((method) => `workspaceOrganizer/${method}`) },
              resource: { kind: 'global' }
            },
            {
              role: { name: 'c1-bind-workspace', resource: 'workspace', actions: ['workspaceOrganizer/bindDirectoryConversation'] },
              resource: { kind: 'workspace', id: wsA }
            },
            {
              role: { name: 'c1-bind-workspace-missing', resource: 'workspace', actions: ['workspaceOrganizer/bindDirectoryConversation'] },
              resource: { kind: 'workspace', id: 'c1-missing' }
            },
            {
              role: { name: 'c1-bind-probe', resource: 'session', actions: ['workspaceOrganizer/bindDirectoryConversation'] },
              resource: { kind: 'session', id: FORGED_SESSION }
            }
          ]
        })
        grantedPhase = await matrix(peer(ctx, 'c1-agent-granted', 'c1Granted'))
        return grantedPhase
      })
      if (typeof disposePolicy === 'function') disposePolicy()
      const revokedPhase = await step('matrix-revoked', async () => matrix(peer(ctx, 'c1-agent-revoked', 'c1Granted')))
      if (decideOriginal !== undefined) remoteAccess.decide = decideOriginal

      const businessDuringMatrix = ENDPOINTS.reduce((sum, method) => {
        const key = SERVICE_METHOD[method]
        return sum + Math.max(0, (business.counters[key] ?? 0) - (ownerBusiness[key] ?? 0))
      }, 0)
      const execCalls = exec.reduce((sum, entry) => sum + Object.values(entry.counters).reduce((inner, value) => inner + value, 0), 0)
      const instrumentation = {
        business: { installed: true, calls: businessDuringMatrix },
        execution: exec.map((entry) => ({ service: entry.key, installed: entry.installed, calls: entry.counters, beforeSetup: countersBefore.find((c) => c.key === entry.key) ?? null }))
      }
      business.restore()
      for (const entry of exec) entry.restore()

      const tasks = reconciled?.ledger?.tasks ?? []
      const byChild = new Map(tasks.map((task) => [task.childSessionId, task]))
      const observed = EXPECTED.map((expected) => {
        const task = byChild.get(expected.child)
        return task === undefined
          ? { child: expected.child, present: false }
          : {
              child: expected.child,
              present: true,
              depth: task.depth,
              sourceConversationId: task.sourceConversationId,
              parent: task.parent,
              executionState: task.executionState,
              eligibility: task.executionEligibility
            }
      })
      const topologyOk = observed.every((entry, index) => entry.present === true &&
        entry.depth === EXPECTED[index].depth &&
        entry.executionState === 'UNKNOWN' &&
        entry.sourceConversationId === bound &&
        (EXPECTED[index].parent.kind === 'conversation'
          ? entry.parent.kind === 'conversation' && entry.parent.conversationId === bound
          : entry.parent.kind === 'task' && entry.parent.taskId === byChild.get(EXPECTED[index].parent.taskOf)?.taskId))

      const detailsEmpty = grantedPhase?.every((entry) => {
        const details = entry.details
        return details !== null && typeof details === 'object' && Object.keys(details).length === 0
      }) ?? false
      const grantedToPlugin = grantedPhase?.filter((entry) => entry.code === 'organizer/access-denied').length ?? 0
      const grantedPolicyDenied = grantedPhase?.filter((entry) => entry.code === 'remote-access/denied').length ?? 0
      const matrixOk = defaultPhase?.every((entry) => entry.code === 'remote-access/denied') === true &&
        revokedPhase?.every((entry) => entry.code === 'remote-access/denied') === true &&
        grantedToPlugin + grantedPolicyDenied === 22 &&
        grantedPolicyDenied === 0 &&
        detailsEmpty

      const ledgerText = await readFile(join(dataDir, 'tasks.json'), 'utf8').catch(() => '')
      const treeText = await readFile(join(dataDir, 'tree.json'), 'utf8').catch(() => '')
      const persisted = result.steps.find((entry) => entry.step === 'persist-official-handles')?.value
      const setupResult = {
        phase: 'setup',
        native,
        catalog: { rows: catalog?.length ?? 0, children: (catalog ?? []).filter((row) => row.kind === 'child').map((row) => row.id) },
        persisted,
        wsA,
        bound,
        forkBind,
        orphanBind,
        expected: EXPECTED,
        observed,
        topologyOk,
        ledger: { taskCount: tasks.length, ids: tasks.map((task) => task.taskId), source: reconciled?.ledger?.sources?.[0] ?? null },
        ledgerSha256: ledgerText.length > 0 ? sha256(ledgerText) : null,
        treeSha256: treeText.length > 0 ? sha256(treeText) : null,
        matrix: {
          decisions,
          default: { attempts: defaultPhase?.length ?? 0, denied: defaultPhase?.filter((entry) => entry.code === 'remote-access/denied').length ?? 0 },
          granted: {
            attempts: grantedPhase?.length ?? 0,
            pluginDenied: grantedToPlugin,
            policyDenied: grantedPolicyDenied,
            detailsEmpty,
            outliers: (grantedPhase ?? []).filter((entry) => entry.code !== 'organizer/access-denied')
          },
          revoked: { attempts: revokedPhase?.length ?? 0, denied: revokedPhase?.filter((entry) => entry.code === 'remote-access/denied').length ?? 0 }
        },
        instrumentation,
        ok: false
      }
      setupResult.ok = persisted?.records?.every((record) => record.stored === record.expected) === true &&
        catalog !== undefined &&
        setupResult.topologyOk &&
        ledgerRead?.tasks?.length === 3 &&
        forkBind?.ok === true &&
        orphanBind?.ok === false && orphanBind?.code === 'task/subagent-session' &&
        matrixOk &&
        businessDuringMatrix === 0 && execCalls === 0
      await writeFile(setupFile, JSON.stringify({
        taskIds: tasks.map((task) => task.taskId).sort(),
        taskMap: observed,
        expectedFull: tasks.map((task) => ({
          taskId: task.taskId,
          childSessionId: task.childSessionId,
          sourceConversationId: task.sourceConversationId,
          parent: task.parent,
          depth: task.depth,
          mode: task.mode,
          label: task.label ?? null,
          executionState: task.executionState,
          executionEligibility: task.executionEligibility
        })),
        source: bound,
        wsA,
        ledgerSha256: setupResult.ledgerSha256,
        treeSha256: setupResult.treeSha256,
        persistedRoot: persisted?.root ?? null
      }, null, 2), 'utf8')
      result.setup = setupResult
      result.ok = setupResult.ok === true
    } else if (config.phase === 'measure2') {
      // Contract measurement: probe the real services, install the complete
      // zero table, and split cold windows and matrix windows with per-window
      // deltas, live-registry checks and raw tree/tasks hashes.
      const METHOD_TABLE = {
        agents: ['create', 'resume', 'register', 'enter', 'announce', 'get', 'list', 'roots'],
        agentLoop: ['createAgent', 'resume'],
        sessionController: ['create', 'prompt', 'resolveAgent', 'fork', 'selectModel'],
        sessions: ['create', 'prepare', 'enter', 'announce'],
        subagents: ['startActivation', 'sendMessage', 'interrupt', 'drainChildren', 'drainDescendants'],
        llm: ['stream', 'prepareCall']
      }
      const probedServices = {}
      const probes = ['agents', 'agentLoop', 'sessionController', 'sessions', 'subagents', 'llm'].map((name) => {
        let service
        let threw = null
        try {
          service = ctx.get(name)
        } catch (error) {
          threw = String(error?.message ?? error)
        }
        if (threw !== null) {
          return { name, probeAttempted: true, getThrew: true, error: threw, servicePresent: false, status: 'UNKNOWN', methods: {}, wrapped: {} }
        }
        if (service === undefined) {
          return { name, probeAttempted: true, returnedUndefined: true, servicePresent: false, status: 'UNKNOWN', methods: {}, wrapped: {} }
        }
        probedServices[name] = service
        const methods = {}
        for (const method of METHOD_TABLE[name] ?? []) methods[method] = typeof service[method]
        return { name, probeAttempted: true, returnedUndefined: false, servicePresent: true, status: 'PRESENT', methods, wrapped: {} }
      })
      const exec = Object.entries(METHOD_TABLE).map(([key, methods]) => ({ key, ...instrument(probedServices[key] ?? {}, methods) }))
      for (const probe of probes) {
        const entry = exec.find((candidate) => candidate.key === probe.name)
        probe.wrapped = entry === undefined ? {} : entry.installed
      }
      const business = instrument(services.workspaceOrganizer, ENDPOINTS.map((method) => SERVICE_METHOD[method]))
      const READ_ONLY = new Set(['agents.get', 'agents.list', 'agents.roots'])
      const OBSERVATION = new Set(['sessions.prepare'])
      const zeroRequired = (service, method) => !READ_ONLY.has(`${service}.${method}`) && !OBSERVATION.has(`${service}.${method}`)
      const snap = () => ({
        business: { ...business.counters },
        execution: Object.fromEntries(exec.map((entry) => [entry.key, { ...entry.counters }]))
      })
      const diff = (before, after) => {
        const out = { business: 0, execution: {} }
        for (const method of Object.keys(business.counters)) {
          out.business += Math.max(0, (after.business[method] ?? 0) - (before.business[method] ?? 0))
        }
        for (const entry of exec) {
          const calls = {}
          for (const [method, present] of Object.entries(entry.installed)) {
            if (present !== true) continue
            calls[method] = Math.max(0, (after.execution[entry.key]?.[method] ?? 0) - (before.execution[entry.key]?.[method] ?? 0))
          }
          out.execution[entry.key] = calls
        }
        return out
      }
      const badIn = (delta) => Object.entries(delta.execution).flatMap(([service, calls]) =>
        Object.entries(calls).filter(([method, value]) => value > 0 && zeroRequired(service, method)).map(([method, value]) => ({ service, method, calls: value })))
      const liveCheck = () => {
        const agents = services.agents
        if (agents === undefined) return { probed: false, status: 'UNKNOWN' }
        try {
          return {
            probed: true,
            list: typeof agents.list === 'function' ? agents.list().length : null,
            roots: typeof agents.roots === 'function' ? agents.roots().length : null,
            get: typeof agents.get === 'function' ? agents.get('c1-src-a') ?? null : null
          }
        } catch (error) {
          return { probed: true, error: String(error?.message ?? error) }
        }
      }
      const hashFile = async (name) => {
        const text = await readFile(join(dataDir, name), 'utf8').catch(() => '')
        return text.length === 0 ? null : sha256(text)
      }
      const notifications = { installed: false, created: 0, disposed: 0 }
      if (typeof ctx.on === 'function') {
        try {
          ctx.on('agent/created', () => { notifications.created += 1 })
          ctx.on('agent/disposed', () => { notifications.disposed += 1 })
          notifications.installed = true
        } catch {
          notifications.installed = false
        }
      }
      const runWindow = async (name, fn, options = {}) => {
        const before = snap()
        const hashesBefore = options.hash === true
          ? { tree: await hashFile('tree.json'), tasks: await hashFile('tasks.json') }
          : null
        const value = await fn()
        const after = snap()
        const hashesAfter = options.hash === true
          ? { tree: await hashFile('tree.json'), tasks: await hashFile('tasks.json') }
          : null
        const delta = diff(before, after)
        return {
          name,
          value,
          delta,
          hashes: options.hash === true
            ? { before: hashesBefore, after: hashesAfter, stable: JSON.stringify(hashesBefore) === JSON.stringify(hashesAfter) }
            : null,
          live: liveCheck(),
          bad: badIn(delta)
        }
      }
      try {
        await step('wait-registry', async () => {
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const workspace = await services.workspaceRegistry.resolveByPath(dirA).catch(() => undefined)
            if (workspace !== undefined) return { id: workspace.id, path: workspace.path }
            await sleep(250)
          }
          throw new Error('native workspace did not become readable after restart')
        })
        const windows = []
        const readSource = await runWindow('cold.readSource', () => services.sessionQuery.readSession('c1-src-a'))
        windows.push(readSource)
        const reconcileWindow = await runWindow('cold.reconcile', () => invoke(gateway, owner, 'reconcileTasks', { request: { conversationId: setup?.source } }))
        windows.push(reconcileWindow)
        const ledgerWindow = await runWindow('cold.readLedger', () => invoke(gateway, owner, 'taskLedger', {}))
        windows.push(ledgerWindow)
        const reconciled = reconcileWindow.value?.ok === true
          ? { tasks: reconcileWindow.value.value.ledger.tasks, conflicts: reconcileWindow.value.value.conflicts }
          : null
        const actual = reconciled?.tasks ?? []
        const expectedFull = setup?.expectedFull ?? []
        const table = expectedFull.map((expected) => {
          const found = actual.find((task) => task.taskId === expected.taskId)
          return {
            expected,
            found: found ?? null,
            matches: found !== undefined &&
              found.childSessionId === expected.childSessionId &&
              found.sourceConversationId === expected.sourceConversationId &&
              JSON.stringify(found.parent) === JSON.stringify(expected.parent) &&
              found.depth === expected.depth &&
              found.mode === expected.mode &&
              (found.label ?? null) === (expected.label ?? null) &&
              found.executionState === 'UNKNOWN' &&
              found.executionEligibility === 'eligible'
          }
        })
        const coldTableOk = expectedFull.length > 0 && actual.length === expectedFull.length &&
          table.every((entry) => entry.matches === true) && (reconciled?.conflicts ?? []).length === 0
        const prepareByWindow = windows.map((entry) => ({ window: entry.name, calls: entry.delta.execution.sessions?.prepare ?? 0 }))
        const prepareTotal = prepareByWindow.reduce((sum, entry) => sum + entry.calls, 0)
        const coldBad = windows.flatMap((entry) => entry.bad)
        const coldLiveEmpty = windows.every((entry) => entry.live.probed === true && entry.live.list === 0 && entry.live.roots === 0 && entry.live.get === null)
        let phases = {}
        let stopped = coldBad.length > 0
        if (!stopped) {
          const matrix = async (p) => {
            const results = []
            for (const method of ENDPOINTS) {
              for (const target of [setup?.source, 'c1-missing']) {
                const workspaceId = target === setup?.source ? setup.wsA : 'c1-missing'
                const outcome = await invoke(gateway, p, method, endpointArgs(method, target, FORGED_SESSION, workspaceId))
                results.push({
                  method,
                  target: target === setup?.source ? 'existing' : 'missing',
                  ok: outcome.ok,
                  code: outcome.code ?? null,
                  message: outcome.message ?? null,
                  details: outcome.details ?? null
                })
              }
            }
            return results
          }
          const decisions = []
          let decideOriginal
          const remoteAccess = services.remoteAccess
          if (typeof remoteAccess?.decide === 'function') {
            decideOriginal = remoteAccess.decide
            remoteAccess.decide = (request) => {
              decisions.push({ action: request?.action ?? null, resources: request?.resources ?? null })
              return decideOriginal.call(remoteAccess, request)
            }
          }
          const phase = async (name, p) => {
            const outcome = await runWindow(name, () => matrix(p), { hash: true })
            return {
              name,
              attempts: outcome.value.length,
              codes: outcome.value.reduce((acc, entry) => { acc[entry.code] = (acc[entry.code] ?? 0) + 1; return acc }, {}),
              detailsEmpty: outcome.value.every((entry) => entry.details !== null && typeof entry.details === 'object' && Object.keys(entry.details).length === 0),
              hashes: outcome.hashes,
              counters: outcome.delta,
              live: outcome.live,
              bad: outcome.bad,
              results: outcome.value
            }
          }
          phases.default = await step('matrix-default', () => phase('default', peer(ctx, 'c1-agent-default', 'c1Default')))
          let granted
          let disposePolicy
          const grantedOutcome = await step('matrix-granted', async () => {
            disposePolicy = remoteAccess.registerPolicy('c1Granted', {
              bindings: () => [
                { role: { name: 'c1-allow-all', resource: 'global', actions: ENDPOINTS.map((method) => `workspaceOrganizer/${method}`) }, resource: { kind: 'global' } },
                { role: { name: 'c1-bind-workspace', resource: 'workspace', actions: ['workspaceOrganizer/bindDirectoryConversation'] }, resource: { kind: 'workspace', id: setup.wsA } },
                { role: { name: 'c1-bind-workspace-missing', resource: 'workspace', actions: ['workspaceOrganizer/bindDirectoryConversation'] }, resource: { kind: 'workspace', id: 'c1-missing' } },
                { role: { name: 'c1-bind-probe', resource: 'session', actions: ['workspaceOrganizer/bindDirectoryConversation'] }, resource: { kind: 'session', id: FORGED_SESSION } }
              ]
            })
            granted = await phase('granted', peer(ctx, 'c1-agent-granted', 'c1Granted'))
            return granted
          })
          if (typeof disposePolicy === 'function') disposePolicy()
          phases.granted = grantedOutcome
          phases.revoked = await step('matrix-revoked', () => phase('revoked', peer(ctx, 'c1-agent-revoked', 'c1Granted')))
          if (decideOriginal !== undefined) remoteAccess.decide = decideOriginal
          phases.decisions = decisions
          stopped = Object.values(phases).some((entry) => entry?.bad?.length > 0)
        }
        const phaseOk = (entry, allowed, requireEmptyDetails) => entry !== undefined &&
          entry.attempts === 22 &&
          Object.entries(entry.codes).length === 1 &&
          entry.codes[allowed] === 22 &&
          (requireEmptyDetails === false || entry.detailsEmpty === true) &&
          entry.hashes?.stable === true &&
          entry.counters.business === 0 &&
          entry.bad.length === 0 &&
          entry.live.list === 0 && entry.live.roots === 0 && entry.live.get === null
        const zeroTableComplete = exec.every((entry) => Object.entries(entry.installed).every(([method, present]) =>
          present !== true || typeof entry.counters[method] === 'number'))
        const EXPECTED_PREPARE = Object.freeze({ 'cold.readSource': 0, 'cold.reconcile': 4, 'cold.readLedger': 0 })
        const prepareMap = Object.fromEntries(prepareByWindow.map((entry) => [entry.window, entry.calls]))
        const evaluatePrepare = (map, total) => Object.keys(map).length === Object.keys(EXPECTED_PREPARE).length &&
          Object.entries(EXPECTED_PREPARE).every(([window, calls]) => Object.hasOwn(map, window) && map[window] === calls) &&
          total === 4
        const evaluateProbes = (list) => list.length === 6 && list.every((probe) => {
          const required = METHOD_TABLE[probe.name] ?? []
          return probe.probeAttempted === true &&
            probe.servicePresent === true &&
            probe.status === 'PRESENT' &&
            required.every((method) => probe.methods?.[method] === 'function' && probe.wrapped?.[method] === true)
        })
        const prepareAttributed = evaluatePrepare(prepareMap, prepareTotal)
        const requiredMethodsOk = evaluateProbes(probes)
        const gateNegativeChecks = {
          wrongPrepareTotal: evaluatePrepare(prepareMap, 3) === false,
          wrongPrepareWindow: evaluatePrepare({ ...prepareMap, 'cold.readSource': 1, 'cold.reconcile': 3 }, 4) === false,
          missingService: evaluateProbes(probes.map((probe) => probe.name === 'llm' ? { ...probe, servicePresent: false, status: 'UNKNOWN' } : probe)) === false,
          missingMethod: evaluateProbes(probes.map((probe) => probe.name === 'agents' ? { ...probe, wrapped: { ...probe.wrapped, create: false } } : probe)) === false
        }
        const gateSelfCheckOk = Object.values(gateNegativeChecks).every((value) => value === true)
        const notificationsOk = notifications.installed === true && notifications.created === 0 && notifications.disposed === 0
        const phasePrepareZero = ['default', 'granted', 'revoked'].every((name) =>
          phases[name]?.counters?.execution?.sessions?.prepare === 0)
        const phaseGetNull = ['default', 'granted', 'revoked'].every((name) => phases[name]?.live?.get === null)
        result.cold = {
          windows: windows.map((entry) => ({
            name: entry.name,
            delta: entry.delta,
            live: entry.live,
            bad: entry.bad
          })),
          table,
          coldTableOk,
          prepareByWindow,
          prepareMap,
          expectedPrepare: EXPECTED_PREPARE,
          prepareTotal,
          prepareAttributed,
          coldLiveEmpty,
          coldBad,
          phases
        }
        result.probes = probes
        result.instrumentation = {
          methodTable: METHOD_TABLE,
          installed: exec.map((entry) => ({ service: entry.key, methods: entry.installed })),
          notifications
        }
        result.gates = { prepareAttributed, requiredMethodsOk, notificationsOk, phasePrepareZero, phaseGetNull, zeroTableComplete, coldTableOk, coldLiveEmpty, gateSelfCheckOk, gateNegativeChecks }
        result.ok = !stopped && coldTableOk && coldLiveEmpty && coldBad.length === 0 &&
          prepareAttributed && requiredMethodsOk && gateSelfCheckOk && notificationsOk && phasePrepareZero && phaseGetNull &&
          phaseOk(phases.default, 'remote-access/denied', false) &&
          phaseOk(phases.granted, 'organizer/access-denied', true) &&
          phaseOk(phases.revoked, 'remote-access/denied', false) &&
          zeroTableComplete
      } finally {
        business.restore()
        for (const entry of exec) entry.restore()
      }
    } else {
      // Measurement: install every available execution counter BEFORE the cold
      // owner query and any matrix call; wrappers preserve sync/async returns.
      const execution = [
        ['subagents', ['start', 'startActivation', 'sendMessage', 'interrupt', 'drainChildren', 'drainDescendants']],
        ['sessionController', ['create', 'prompt', 'resume']],
        ['sessions', ['create', 'prepare']],
        ['agents', ['create', 'resume', 'start']],
        ['agent', ['create', 'resume']]
      ]
      const exec = execution.map(([key, methods]) => ({ key, ...instrument(services[key] ?? {}, methods) }))
      const business = instrument(services.workspaceOrganizer, ENDPOINTS.map((method) => SERVICE_METHOD[method]))
      const counterSnapshot = () => ({
        business: { ...business.counters },
        execution: Object.fromEntries(exec.map((entry) => [entry.key, { ...entry.counters }]))
      })
      const installed = exec.map((entry) => ({ service: entry.key, methods: entry.installed }))
      const probes = ['agents', 'agent'].map((key) => {
        const service = services[key]
        return service === undefined
          ? { service: key, probed: false, status: 'UNKNOWN', availableMethods: [] }
          : { service: key, probed: true, status: 'probed', availableMethods: Object.keys(service).filter((method) => typeof service[method] === 'function') }
      })
      const baseline = counterSnapshot()
      const expectedFull = setup?.expectedFull ?? []
      const hashFile = async (name) => {
        const text = await readFile(join(dataDir, name), 'utf8').catch(() => '')
        return text.length === 0 ? null : sha256(text)
      }
      const delta = (beforeSnapshot, snapshot) => {
        const out = { business: 0, execution: {} }
        for (const method of Object.keys(business.counters)) {
          out.business += Math.max(0, (business.counters[method] ?? 0) - (beforeSnapshot.business[method] ?? 0))
        }
        for (const entry of exec) {
          const before = beforeSnapshot.execution[entry.key] ?? {}
          const now = snapshot.execution[entry.key] ?? {}
          const calls = {}
          for (const [method, present] of Object.entries(entry.installed)) {
            if (present !== true) continue
            calls[method] = Math.max(0, (now[method] ?? 0) - (before[method] ?? 0))
          }
          out.execution[entry.key] = calls
        }
        return out
      }
      try {
        await step('wait-registry', async () => {
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const workspace = await services.workspaceRegistry.resolveByPath(dirA).catch(() => undefined)
            if (workspace !== undefined) return { id: workspace.id, path: workspace.path }
            await sleep(250)
          }
          throw new Error('native workspace did not become readable after restart')
        })
        const ledger = await step('cold-ledger', async () => {
          const outcome = await invoke(gateway, owner, 'taskLedger', {})
          if (!outcome.ok) throw new Error(`taskLedger failed: ${outcome.code}`)
          return outcome.value
        })
        const readBack = await step('cold-session-read', async () => {
          const snapshot = await services.sessionQuery.readSession('c1-src-a')
          return { header: snapshot.session, events: snapshot.events.length }
        })
        const reconciled = await step('cold-reconcile', async () => {
          const outcome = await invoke(gateway, owner, 'reconcileTasks', { request: { conversationId: setup?.source } })
          return outcome.ok
            ? { tasks: outcome.value.ledger.tasks, conflicts: outcome.value.conflicts, revision: outcome.value.ledger.revision }
            : { code: outcome.code, message: outcome.message, details: outcome.details }
        })
        const actual = reconciled?.tasks ?? []
        const table = expectedFull.map((expected) => {
          const found = actual.find((task) => task.taskId === expected.taskId)
          return {
            expected,
            found: found ?? null,
            matches: found !== undefined &&
              found.childSessionId === expected.childSessionId &&
              found.sourceConversationId === expected.sourceConversationId &&
              JSON.stringify(found.parent) === JSON.stringify(expected.parent) &&
              found.depth === expected.depth &&
              found.mode === expected.mode &&
              (found.label ?? null) === (expected.label ?? null) &&
              found.executionState === 'UNKNOWN' &&
              found.executionEligibility === 'eligible'
          }
        })
        const coldTableOk = expectedFull.length > 0 &&
          actual.length === expectedFull.length &&
          table.every((entry) => entry.matches === true) &&
          (reconciled?.conflicts ?? []).length === 0
        const ids = actual.map((task) => task.taskId).sort()
        const expectedIds = (setup?.taskIds ?? []).slice().sort()

        // Owner reconcile advances the ledger revision; the matrix baseline is
        // taken AFTER it. Every non-owner phase must leave both raw hashes equal.
        const coldDelta = delta(baseline, counterSnapshot())
        const matrixBaseline = {
          tree: await hashFile('tree.json'),
          tasks: await hashFile('tasks.json')
        }
        const matrix = async (p) => {
          const results = []
          for (const method of ENDPOINTS) {
            for (const target of [setup?.source, 'c1-missing']) {
              const workspaceId = target === setup?.source ? setup.wsA : 'c1-missing'
              const outcome = await invoke(gateway, p, method, endpointArgs(method, target, FORGED_SESSION, workspaceId))
              results.push({
                method,
                target: target === setup?.source ? 'existing' : 'missing',
                ok: outcome.ok,
                code: outcome.code ?? null,
                message: outcome.message ?? null,
                details: outcome.details ?? null
              })
            }
          }
          return results
        }
        const decisions = []
        let decideOriginal
        const remoteAccess = services.remoteAccess
        if (typeof remoteAccess?.decide === 'function') {
          decideOriginal = remoteAccess.decide
          remoteAccess.decide = (request) => {
            decisions.push({ action: request?.action ?? null, resources: request?.resources ?? null })
            return decideOriginal.call(remoteAccess, request)
          }
        }
        const phase = async (name, p) => {
          const before = { tree: await hashFile('tree.json'), tasks: await hashFile('tasks.json') }
          const countersBefore = counterSnapshot()
          const results = await matrix(p)
          const after = { tree: await hashFile('tree.json'), tasks: await hashFile('tasks.json') }
          const counters = delta(countersBefore, counterSnapshot())
          return {
            name,
            attempts: results.length,
            codes: results.reduce((acc, entry) => { acc[entry.code] = (acc[entry.code] ?? 0) + 1; return acc }, {}),
            detailsEmpty: results.every((entry) => entry.details !== null && typeof entry.details === 'object' && Object.keys(entry.details).length === 0),
            hashes: { before, after, stable: JSON.stringify(before) === JSON.stringify(after) },
            counters,
            results
          }
        }
        const defaultPhase = await step('matrix-default', async () => phase('default', peer(ctx, 'c1-agent-default', 'c1Default')))
        let grantedPhase
        let disposePolicy
        await step('matrix-granted', async () => {
          disposePolicy = remoteAccess.registerPolicy('c1Granted', {
            bindings: () => [
              {
                role: { name: 'c1-allow-all', resource: 'global', actions: ENDPOINTS.map((method) => `workspaceOrganizer/${method}`) },
                resource: { kind: 'global' }
              },
              {
                role: { name: 'c1-bind-workspace', resource: 'workspace', actions: ['workspaceOrganizer/bindDirectoryConversation'] },
                resource: { kind: 'workspace', id: setup.wsA }
              },
              {
                role: { name: 'c1-bind-workspace-missing', resource: 'workspace', actions: ['workspaceOrganizer/bindDirectoryConversation'] },
                resource: { kind: 'workspace', id: 'c1-missing' }
              },
              {
                role: { name: 'c1-bind-probe', resource: 'session', actions: ['workspaceOrganizer/bindDirectoryConversation'] },
                resource: { kind: 'session', id: FORGED_SESSION }
              }
            ]
          })
          grantedPhase = await phase('granted', peer(ctx, 'c1-agent-granted', 'c1Granted'))
          return grantedPhase
        })
        if (typeof disposePolicy === 'function') disposePolicy()
        const revokedPhase = await step('matrix-revoked', async () => phase('revoked', peer(ctx, 'c1-agent-revoked', 'c1Granted')))
        if (decideOriginal !== undefined) remoteAccess.decide = decideOriginal

        const zeroTableOk = (entry) => exec.every((svc) =>
          Object.entries(svc.installed).every(([method, present]) =>
            present !== true || entry.counters.execution[svc.key]?.[method] === 0))
        const phaseOk = (entry, allowed, requireEmptyDetails) => entry !== undefined &&
          entry.attempts === 22 &&
          Object.entries(entry.codes).length === 1 &&
          entry.codes[allowed] === 22 &&
          (requireEmptyDetails === false || entry.detailsEmpty === true) &&
          entry.hashes.stable === true &&
          entry.counters.business === 0 &&
          zeroTableOk(entry)
        const coldUnattributed = Object.entries(coldDelta.execution).flatMap(([service, calls]) =>
          Object.entries(calls).filter(([, value]) => value > 0).map(([method, value]) => ({ service, method, calls: value })))
        result.cold = {
          readBack,
          ids,
          expectedIds,
          sameIds: JSON.stringify(ids) === JSON.stringify(expectedIds),
          table,
          coldTableOk,
          conflicts: reconciled?.conflicts ?? [],
          revision: reconciled?.revision ?? null,
          ledgerRevision: ledger?.revision ?? null,
          coldDelta,
          coldUnattributed,
          matrixBaseline,
          phases: { default: defaultPhase, granted: grantedPhase, revoked: revokedPhase },
          decisions
        }
        result.ok = coldTableOk && readBack?.events === 1 && readBack?.header?.cwd === dirA &&
          phaseOk(defaultPhase, 'remote-access/denied', false) &&
          phaseOk(grantedPhase, 'organizer/access-denied', true) &&
          phaseOk(revokedPhase, 'remote-access/denied', false) &&
          installed.some((entry) => Object.values(entry.methods).some(Boolean))
        result.instrumentation = { installed, probes, baseline, coldDelta }
      } finally {
        business.restore()
        for (const entry of exec) entry.restore()
      }
    }

    await writeFile(join(dataDir, `c1-result-${config.phase}.json`), JSON.stringify(result, null, 2), 'utf8')
  })().catch(async (error) => {
    await writeFile(join(config?.dataDir ?? '.', `c1-result-${config?.phase ?? 'unknown'}.json`), JSON.stringify({ fatal: String(error?.stack ?? error) }, null, 2), 'utf8').catch(() => undefined)
  })
}
