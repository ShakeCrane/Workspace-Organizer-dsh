/**
 * Test-only Cordis fixture for the real B narrow verification.
 *
 * It creates a live-only source S and child T through the public
 * `sessions.prepare` / `enter` / `announce` primitives. S and T are never passed
 * to `sessionPersistence.create`; S and T get separate detach disposers before
 * announcement. A later control command disposes only S's exact disposer.
 *
 * The fixture is loaded by the isolated Host via a cordis.patch.yml entry. It
 * never opens a browser and never calls a provider/model API.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

export const name = 'wo-live-session-b'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'subagents', 'workspaceOrganizer', 'workspaceRegistry', 'clientModules', 'loader']

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

export function errorRecord(error) {
  return {
    name: error?.name ?? null,
    message: String(error?.message ?? error),
    code: typeof error?.code === 'string' ? error.code : null,
    details: error?.details ?? null,
    cause: error?.cause === undefined ? null : String(error.cause),
    stack: String(error?.stack ?? '')
  }
}

export function errorCodeOf(record) {
  return typeof record?.code === 'string' ? record.code : null
}

export function summarizeReadSession(snapshot) {
  const session = snapshot?.session ?? null
  return {
    hasSession: session !== null && typeof session === 'object',
    id: session?.id ?? null,
    cwd: session?.cwd ?? null,
    origin: session?.origin ?? null,
    parentSession: session?.parentSession ?? null,
    delegationDepth: session?.delegationDepth ?? null,
    eventCount: Array.isArray(snapshot?.events) ? snapshot.events.length : null
  }
}

export function ledgerFacts(ledger) {
  if (ledger === null || typeof ledger !== 'object' || !Array.isArray(ledger.tasks) || !Array.isArray(ledger.sources)) return null
  return {
    revision: ledger.revision ?? null,
    tasks: ledger.tasks.map((task) => ({
      taskId: task.taskId ?? null,
      childSessionId: task.childSessionId ?? null,
      sourceConversationId: task.sourceConversationId ?? null,
      parent: task.parent ?? null,
      depth: task.depth ?? null,
      executionState: task.executionState ?? null,
      blockedReason: task.blockedReason ?? null
    })).sort((a, b) => String(a.childSessionId).localeCompare(String(b.childSessionId))),
    sources: ledger.sources.map((source) => ({
      conversationId: source.conversationId ?? null,
      sessionId: source.sessionId ?? null,
      workspaceLogicalId: source.workspaceLogicalId ?? null,
      directory: source.directory ?? null,
      nativeWorkspaceId: source.nativeWorkspaceId ?? null,
      verifiedAt: source.verifiedAt ?? null,
      verificationState: source.verificationState ?? null,
      blockedReason: source.blockedReason ?? null
    })).sort((a, b) => String(a.conversationId).localeCompare(String(b.conversationId)))
  }
}

export function ledgerStabilityErrors(before, after) {
  const left = ledgerFacts(before)
  const right = ledgerFacts(after)
  if (left === null || right === null) return ['ledger-missing']
  return JSON.stringify(left) === JSON.stringify(right) ? [] : ['ledger-changed']
}

export function errorShapeErrors(kind, record) {
  if (record === null || record === undefined) return [`${kind}-missing`]
  const errors = []
  if (kind === 'read-session') {
    if (record.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') errors.push('read-session-code')
    if (typeof record.message !== 'string' || record.message.length === 0) errors.push('read-session-message')
  } else if (kind === 'list-descendants') {
    if (typeof record.code !== 'string' || record.code.length === 0) errors.push('list-descendants-code')
    if (typeof record.message !== 'string' || record.message.length === 0) errors.push('list-descendants-message')
  } else if (kind === 'reconcile') {
    if (record.code !== 'task/unavailable') errors.push('reconcile-code')
    if (!String(record.message ?? '').includes('subagent catalog read failed')) errors.push('reconcile-message')
    if (record.details?.service !== 'subagents.listDescendants') errors.push('reconcile-service')
    if (typeof record.details?.cause !== 'string' || record.details.cause.length === 0) errors.push('reconcile-cause')
  } else {
    errors.push('unknown-error-kind')
  }
  return errors
}

export function authoritativePersistenceErrors({ statSource, statChild, list, sourceId, childId }) {
  const errors = []
  if (statSource?.ok !== true) errors.push('stat-source-unavailable')
  else if (statSource.value !== null) errors.push('stat-source-copy')
  if (statChild?.ok !== true) errors.push('stat-child-unavailable')
  else if (statChild.value !== null) errors.push('stat-child-copy')
  if (list?.ok !== true) errors.push('list-unavailable')
  else if (Array.isArray(list.ids) && (list.ids.includes(sourceId) || list.ids.includes(childId))) errors.push('list-copy')
  return errors
}

export function fourTaskLedgerErrors(ledger, { sourceAId = 'real-a-source', sourceBId = 'real-b-source', taskT1Id = 'real-a-t1', taskT2Id = 'real-a-t2', taskT3Id = 'real-a-t3', taskU1Id = 'real-b-child' } = {}) {
  if (ledger === null || typeof ledger !== 'object') return ['four-tasks-ledger-missing']
  const errors = []
  if (!Array.isArray(ledger.sources) || ledger.sources.length < 2) errors.push('four-tasks-sources-count')
  if (!Array.isArray(ledger.tasks) || ledger.tasks.length !== 4) errors.push('four-tasks-count:' + String(ledger.tasks?.length ?? 0))
  const byChild = Object.fromEntries((ledger.tasks ?? []).map((t) => [t.childSessionId, t]))
  const t1 = byChild[taskT1Id]
  const t2 = byChild[taskT2Id]
  const t3 = byChild[taskT3Id]
  const u1 = byChild[taskU1Id]
  if (!t1) errors.push('four-tasks-missing-t1')
  if (!t2) errors.push('four-tasks-missing-t2')
  if (!t3) errors.push('four-tasks-missing-t3')
  if (!u1) errors.push('four-tasks-missing-u1')
  if (t1 && t1.depth !== 1) errors.push('four-tasks-t1-depth')
  if (t2 && (t2.depth !== 2 || t2.parent?.kind !== 'task' || t2.parent?.taskId !== t1?.taskId)) errors.push('four-tasks-t2-parent')
  if (t3 && (t3.depth !== 2 || t3.parent?.kind !== 'task' || t3.parent?.taskId !== t1?.taskId)) errors.push('four-tasks-t3-parent')
  if (u1 && u1.depth !== 1) errors.push('four-tasks-u1-depth')
  return errors
}

export function projectionCheckpointErrors({ files, readError }) {
  const errors = []
  if (readError !== null && readError !== undefined) errors.push('projection-read')
  for (const file of files ?? []) {
    if (file.insideRoot !== true) errors.push('projection-path-escape:' + String(file.name))
    if (file.error !== undefined) errors.push('projection-file-read:' + String(file.name))
    if (file.shapeError !== undefined) errors.push('projection-shape:' + String(file.name))
  }
  return errors
}

export function pathWithinRoot(path, root) {
  const normalizedPath = resolve(path).toLowerCase()
  const normalizedRoot = resolve(root).toLowerCase()
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + sep)
}

export function webRefreshBindingErrors(record, { pageId, sourceId, baselineGeneration, refreshAt, previousIds = [] } = {}) {
  if (record === null || typeof record !== 'object') return ['web-refresh-missing']
  const errors = []
  if (record.method !== 'reconcileTasks') errors.push('web-refresh-method')
  if (record.input?.conversationId !== sourceId) errors.push('web-refresh-source')
  if (record.pageId !== pageId) errors.push('web-refresh-page')
  if (previousIds.includes(record.id)) errors.push('web-refresh-old-request')
  if (!(Number(record.generation) > Number(baselineGeneration))) errors.push('web-refresh-generation')
  if (!(Number(record.at) >= Number(refreshAt))) errors.push('web-refresh-before-click')
  if (record.decision === 'discarded') errors.push('web-refresh-discarded')
  else if (record.decision !== 'accepted') errors.push('web-refresh-not-accepted')
  if (record.decisionExtra?.outcome !== 'error') errors.push('web-refresh-outcome')
  if (typeof record.result?.error !== 'string' || record.result.error.length === 0) errors.push('web-refresh-raw-error')
  return errors
}

export function webPanelPreservationErrors({ before, after, revision } = {}) {
  if (before === null || before === undefined || after === null || after === undefined) return ['web-panel-missing']
  const errors = []
  if (after.source !== before.source) errors.push('web-panel-source')
  if (typeof after.error !== 'string' || !after.error.includes('task/unavailable') || !after.error.includes('subagent catalog read failed')) errors.push('web-panel-error')
  if (typeof after.stale !== 'string' || !after.stale.toLowerCase().includes('stale')) errors.push('web-panel-stale')
  if (after.empty === true || after.unreconciled === true) errors.push('web-panel-empty')
  if (after.revision !== `rev ${String(revision)}`) errors.push('web-panel-revision')
  if (JSON.stringify(after.rows) !== JSON.stringify(before.rows)) errors.push('web-panel-rows')
  if (!Array.isArray(after.rows) || after.rows.length !== 1 || after.rows[0]?.state !== 'UNKNOWN') errors.push('web-panel-task-state')
  if ((after.rows ?? []).some((row) => /running|paused/iu.test(String(row.text)))) errors.push('web-panel-execution-word')
  return errors
}

export function webLedgerExecutionErrors({ treeBefore, treeAfter, tasksBefore, tasksAfter, revisionBefore, revisionAfter, factsBefore, factsAfter, forbidden } = {}) {
  const errors = []
  if (treeAfter !== treeBefore) errors.push('web-ledger-tree')
  if (tasksAfter !== tasksBefore) errors.push('web-ledger-tasks')
  if (revisionAfter !== revisionBefore) errors.push('web-ledger-revision')
  if (JSON.stringify(factsAfter) !== JSON.stringify(factsBefore)) errors.push('web-ledger-facts')
  if (Array.isArray(forbidden) && forbidden.length > 0) errors.push('web-execution:' + forbidden.join(','))
  return errors
}

export async function nearestManifest(filePath) {
  let dir = dirname(resolve(filePath))
  while (true) {
    const candidate = resolve(dir, 'package.json')
    try {
      const content = await readFile(candidate, 'utf8')
      const json = JSON.parse(content)
      return { path: candidate, dir, manifest: json }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function fixtureManifestErrors(fixture, { projectPackageName = 'workspace-organizer-dsh', projectManifestPath = null } = {}) {
  if (fixture === null || typeof fixture !== 'object') return ['fixture-missing']
  const errors = []
  if (typeof fixture.path !== 'string' || fixture.path.length === 0) errors.push('fixture-path')
  const manifestPath = fixture.nearestManifestPath ?? fixture.manifestPath
  const manifest = fixture.manifest
  if (typeof manifestPath !== 'string' || manifestPath.length === 0 || manifest === null || typeof manifest !== 'object') {
    errors.push('fixture-missing-manifest')
    return errors
  }
  if (projectManifestPath && resolve(manifestPath).toLowerCase() === resolve(projectManifestPath).toLowerCase()) {
    errors.push('fixture-unbounded-manifest')
  }
  const fixtureName = String(fixture.name ?? fixture.id ?? fixture.path)
  if (!fixtureName.toLowerCase().includes(projectPackageName.toLowerCase()) && manifest.name === projectPackageName) {
    errors.push('fixture-pseudo-unique')
  }
  if (manifest.client !== undefined || manifest.dsh?.client !== undefined || manifest.exports?.['./client'] !== undefined) {
    errors.push('fixture-unexpected-client')
  }
  if (manifest.type !== 'module') errors.push('fixture-not-module')
  if (manifest.private !== true) errors.push('fixture-not-private')
  if (fixture.sourceSha256 !== undefined && fixture.copySha256 !== undefined) {
    if (fixture.sourceSha256 !== fixture.copySha256) {
      errors.push('fixture-copy-drift')
    }
  }
  return errors
}

export function overlaySourceErrors({
  loaderEntries,
  originalId = 'workspace-organizer',
  originalName = 'workspace-organizer-dsh',
  pinnedId = 'wo-test-pinned-organizer',
  pinnedName,
  graph,
  packageId = 'workspace-organizer-dsh',
  fixtures = [],
  projectManifestPath = null
} = {}, options = {}) {
  const effectiveProjectPath = projectManifestPath ?? options.projectManifestPath ?? null
  const errors = []
  if (!Array.isArray(loaderEntries)) return ['overlay-loader-enumeration']
  const original = loaderEntries.filter((entry) => entry.id === originalId || String(entry.id).endsWith(':' + originalId))
  const pinned = loaderEntries.filter((entry) => entry.id === pinnedId || String(entry.id).endsWith(':' + pinnedId))
  const organizerRows = loaderEntries.filter((entry) => entry.name === originalName || entry.name === pinnedName)
  if (original.length !== 1 || original[0].name !== originalName || original[0].effectiveDisabled !== true) errors.push('overlay-original-row')
  if (pinned.length !== 1 || pinned[0].name !== pinnedName || pinned[0].effectiveDisabled !== false) errors.push('overlay-pinned-row')
  if (organizerRows.filter((entry) => entry.effectiveDisabled === false).length !== 1) errors.push('overlay-live-count')
  if (loaderEntries.filter((entry) => !organizerRows.includes(entry) && (entry.name === originalName || String(entry.name ?? '').includes('workspace-organizer'))).length > 0) errors.push('overlay-extra-source')
  if ((graph?.entries ?? []).filter((entry) => entry.id === packageId).length !== 1) errors.push('overlay-graph-entry')
  if ((graph?.batches ?? []).filter((batch) => Array.isArray(batch.entries) && batch.entries.includes(packageId)).length !== 1) errors.push('overlay-graph-batch')
  for (const fixture of fixtures) {
    const fixtureErrors = fixtureManifestErrors(fixture, { projectPackageName: packageId, projectManifestPath: effectiveProjectPath })
    if (fixtureErrors.includes('fixture-pseudo-unique')) errors.push('overlay-pseudo-unique')
    if (fixtureErrors.includes('fixture-unexpected-client')) errors.push('overlay-fixture-client')
    if (fixtureErrors.includes('fixture-unbounded-manifest')) errors.push('overlay-fixture-unbounded')
    if (fixtureErrors.includes('fixture-copy-drift')) errors.push('overlay-fixture-drift')
  }
  return errors
}

export function sourceReadinessErrors({
  baseline,
  artifact,
  graph,
  packageId = 'workspace-organizer-dsh',
  combo,
  requests,
  executionRequestId,
  collector,
  pageId
} = {}) {
  const errors = []
  if (typeof baseline?.path !== 'string' || baseline.path.length === 0) errors.push('readiness-baseline-path')
  if (typeof artifact?.sha256 !== 'string' || artifact.sha256.length !== 64) errors.push('readiness-artifact-hash')
  if (artifact?.path !== baseline?.path) errors.push('readiness-artifact-path')
  if (artifact?.sizeMatchesBaseline !== true || artifact?.mtimeMatchesBaseline !== true || artifact?.ctimeMatchesBaseline !== true) errors.push('readiness-artifact-stat')
  if (artifact?.instrumented !== true) errors.push('readiness-artifact-instrumentation')
  const entry = (graph?.entries ?? []).find((row) => row.id === packageId)
  if (entry === undefined) errors.push('readiness-graph-entry')
  const batch = (graph?.batches ?? []).find((row) => Array.isArray(row.entries) && row.entries.includes(packageId))
  if (batch === undefined) errors.push('readiness-graph-batch')
  if (combo?.containsArtifact !== true) errors.push('readiness-combo-artifact')
  if (combo?.instrumented !== true) errors.push('readiness-combo-instrumentation')
  if (!Array.isArray(requests) || requests.length === 0) errors.push('readiness-no-execution-request')
  const execution = (requests ?? []).find((request) => request.requestId === executionRequestId)
  if (execution === undefined) errors.push('readiness-execution-request')
  else if (execution.status !== 200 || execution.bodySha256 !== combo?.sha256) errors.push('readiness-execution-body')
  if (combo?.executionRequestId !== executionRequestId) errors.push('readiness-execution-binding')
  if (!Array.isArray(combo?.refetchRequestIds)) errors.push('readiness-refetch-list')
  if (collector !== undefined) {
    if (collector === null || typeof collector !== 'object') errors.push('readiness-collector-missing')
    else {
      if (typeof pageId === 'string' && pageId.length > 0 && collector.pageId !== pageId) errors.push('readiness-collector-page')
      if (Array.isArray(collector.errors) && collector.errors.length > 0) errors.push('readiness-collector-errors')
    }
  }
  return errors
}

export async function apply(ctx, config) {
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const query = ctx.get('sessionQuery')
  const subagents = ctx.get('subagents')
  const organizer = ctx.get('workspaceOrganizer')
  const registry = ctx.get('workspaceRegistry')
  const clientModules = ctx.get('clientModules')
  const loader = ctx.get('loader')
  const bootId = `${process.pid}-${Date.now()}`
  const services = {
    sessions: sessions !== undefined,
    sessionPersistence: persistence !== undefined,
    sessionQuery: query !== undefined,
    subagents: subagents !== undefined,
    workspaceOrganizer: organizer !== undefined,
    workspaceRegistry: registry !== undefined,
    clientModules: clientModules !== undefined,
    loader: loader !== undefined
  }
  const sourceId = config.sourceId
  const childId = config.childId
  let phase = 'ready'
  let detachSource = null
  let detachChild = null
  let prepared = null
  let detached = null
  let probed = null
  let sourceSession = null
  let childSession = null
  let lastRequest = null
  let busy = false
  let lastLive = null

  const writeState = async (extra = {}) => {
    const state = {
      evidenceKind: 'real-b-host-live-only',
      syntheticCatalog: true,
      bootId,
      pid: process.pid,
      phase,
      services,
      directory: config.directory,
      runRoot: config.runRoot,
      sourceId,
      childId,
      at: new Date().toISOString(),
      ...extra
    }
    await writeFile(config.stateFile, JSON.stringify(state, null, 2), 'utf8')
    return state
  }
  const mark = async (stage, extra = {}) => {
    await writeFile(config.checkpointFile, JSON.stringify({ at: new Date().toISOString(), stage, ...extra }) + '\n', { encoding: 'utf8', flag: 'a' })
  }
  const readSession = async (id) => {
    try {
      const snapshot = await query.readSession(id)
      return { ok: true, summary: summarizeReadSession(snapshot) }
    } catch (error) {
      return { ok: false, error: errorRecord(error) }
    }
  }
  const readCatalog = async (id) => {
    try {
      const rows = await subagents.listDescendants(id)
      return { ok: true, rows: Array.isArray(rows) ? rows : null }
    } catch (error) {
      return { ok: false, error: errorRecord(error) }
    }
  }
  const readStat = async (id) => {
    try {
      const value = await persistence.stat(id)
      return { ok: true, value: value === undefined ? null : { id: value.header?.id ?? null, revision: value.revision ?? null } }
    } catch (error) {
      return { ok: false, error: errorRecord(error) }
    }
  }
  const readList = async () => {
    try {
      const list = await persistence.list()
      return { ok: true, ids: list.map((entry) => entry?.header?.id ?? entry?.id ?? null).filter((id) => typeof id === 'string') }
    } catch (error) {
      return { ok: false, error: errorRecord(error) }
    }
  }
  const projectionCheckpointState = async () => {
    let names = []
    let readError = null
    try {
      const info = await stat(config.projectionDir)
      if (!info.isDirectory()) readError = { name: 'Error', message: 'projection path is not a directory', code: null, details: null, cause: null, stack: '' }
      else names = (await readdir(config.projectionDir)).filter((entry) => entry.endsWith('.json')).sort()
    } catch (error) {
      if (error?.code !== 'ENOENT') readError = errorRecord(error)
    }
    const files = []
    for (const name of names) {
      const path = resolve(config.projectionDir, name)
      const insideRoot = pathWithinRoot(path, config.projectionDir)
      if (!insideRoot) { files.push({ name, path, insideRoot }); continue }
      try {
        const content = await readFile(path)
        const info = await stat(path)
        const text = content.toString('utf8')
        let parsed = null
        let shapeError = null
        try { parsed = JSON.parse(text) } catch (error) { shapeError = 'invalid-json:' + String(error?.message ?? error) }
        if (shapeError === null) {
          const identity = parsed?.record?.identity
          const rows = parsed?.record?.rows
          if (parsed?.version !== 7 || identity === null || typeof identity !== 'object' || rows === null || typeof rows !== 'object') shapeError = 'unknown-checkpoint-shape'
        }
        const identity = parsed?.record?.identity
        const rows = parsed?.record?.rows
        const file = {
          name,
          path,
          insideRoot,
          sizeBytes: content.length,
          sha256: sha256(content),
          mtimeMs: info.mtimeMs,
          version: parsed?.version ?? null,
          identity: identity === null || typeof identity !== 'object' ? null : {
            formatVersion: identity.formatVersion ?? null,
            createdAt: identity.createdAt ?? null,
            cwd: identity.cwd ?? null,
            isSeeded: identity.isSeeded ?? null,
            inheritedEventCount: identity.inheritedEventCount ?? null
          },
          rowKeys: rows === null || typeof rows !== 'object' ? null : Object.keys(rows).sort(),
          relatedToSource: name.includes(sourceId),
          relatedToChild: name.includes(childId),
          raw: text
        }
        if (shapeError !== null) file.shapeError = shapeError
        files.push(file)
      } catch (error) {
        files.push({ name, path, insideRoot, error: errorRecord(error) })
      }
    }
    return { root: config.projectionDir, files, readError, errors: projectionCheckpointErrors({ files, readError }) }
  }
  const persistenceState = async () => {
    const statSource = await readStat(sourceId)
    const statChild = await readStat(childId)
    const list = await readList()
    const authoritative = {
      statSource,
      statChild,
      list,
      physicalScan: 'UNKNOWN',
      note: 'sessionPersistence.stat/list are authoritative; no guessed physical log root was scanned',
      errors: authoritativePersistenceErrors({ statSource, statChild, list, sourceId, childId })
    }
    const projection = await projectionCheckpointState()
    return { authoritative, projection }
  }
  const fileHashes = async () => {
    const tree = await readFile(config.treeFile, 'utf8').catch(() => '')
    const tasks = await readFile(config.tasksFile, 'utf8').catch(() => '')
    return { tree: sha256(tree), tasks: sha256(tasks) }
  }

  const prepare = async () => {
    if (sessions.get(sourceId) !== undefined || sessions.get(childId) !== undefined) throw new Error('live session id already exists')
    if ((await persistence.stat(sourceId)) !== undefined || (await persistence.stat(childId)) !== undefined) throw new Error('persistence copy already exists before prepare')

    let workspaceA = null
    let conversationA = null
    let projectA = null
    let nativeA = null

    if (config.fourTasks === true) {
      if (typeof config.dirA !== 'string') throw new Error('dirA is required for fourTasks setup')
      const dirA = config.dirA
      const sourceAId = config.sourceAId ?? 'real-a-source'
      const taskT1Id = config.taskT1Id ?? 'real-a-t1'
      const taskT2Id = config.taskT2Id ?? 'real-a-t2'
      const taskT3Id = config.taskT3Id ?? 'real-a-t3'

      nativeA = await registry.create(dirA, config.workspaceTitleA ?? 'Workspace A')
      if (nativeA === undefined || nativeA.id === undefined || nativeA.path !== dirA) throw new Error('native workspace A create failed')

      const beforeA = await organizer.snapshot()
      const projectASnapshot = await organizer.createProject({ parentId: beforeA.rootId, title: config.projectTitleA ?? 'Project A' })
      projectA = projectASnapshot.nodes.find((node) => node.kind === 'project' && node.title === (config.projectTitleA ?? 'Project A') && node.parentId === beforeA.rootId)
      if (projectA === undefined) throw new Error('organizer project A was not created')

      const workspaceASnapshot = await organizer.registerWorkspace({ parentId: projectA.id, title: config.workspaceTitleA ?? 'Workspace A', directory: dirA })
      workspaceA = workspaceASnapshot.nodes.find((node) => node.kind === 'workspace' && node.title === (config.workspaceTitleA ?? 'Workspace A') && node.parentId === projectA.id)
      if (workspaceA === undefined || workspaceA.nativeWorkspaceId !== nativeA.id || workspaceA.directory !== dirA) throw new Error('organizer workspace A identity mismatch')

      const addPersisted = async (id, cwd, catalog = [], meta = {}) => {
        const detached = sessions.prepare(id, { meta: { cwd, ...meta } })
        const handle = await persistence.create(detached.header)
        try {
          const events = []
          for (const child of catalog) {
            events.push(detached.append('subagent/catalog', { childId: child, childCreatedAt: Date.now(), version: 0, mode: 'one-shot' }))
          }
          if (events.length > 0) await handle.append(events)
          await handle.flush()
        } finally {
          await handle.close()
        }
      }

      await addPersisted(sourceAId, dirA, [taskT1Id])
      await addPersisted(taskT1Id, dirA, [taskT2Id, taskT3Id], { parentSession: sourceAId, origin: 'subagent', delegationDepth: 1 })
      await addPersisted(taskT2Id, dirA, [], { parentSession: taskT1Id, origin: 'subagent', delegationDepth: 2 })
      await addPersisted(taskT3Id, dirA, [], { parentSession: taskT1Id, origin: 'subagent', delegationDepth: 2 })

      const bindASnapshot = await organizer.bindDirectoryConversation({ workspaceId: workspaceA.id, title: config.conversationTitleA ?? 'Conversation A', sessionId: sourceAId })
      conversationA = bindASnapshot.nodes.find((node) => node.kind === 'conversation' && node.sessionId === sourceAId && node.parentId === workspaceA.id)
      if (conversationA === undefined) throw new Error('organizer conversation A was not bound')
      await organizer.reconcileTasks({ conversationId: conversationA.id })
    }

    const native = await registry.create(config.directory, config.workspaceTitle)
    if (native === undefined || native.id === undefined || native.path !== config.directory) throw new Error('native workspace create failed')
    const before = await organizer.snapshot()
    const projectSnapshot = await organizer.createProject({ parentId: before.rootId, title: config.projectTitle })
    const project = projectSnapshot.nodes.find((node) => node.kind === 'project' && node.title === config.projectTitle && node.parentId === before.rootId)
    if (project === undefined) throw new Error('organizer project was not created')
    const workspaceSnapshot = await organizer.registerWorkspace({ parentId: project.id, title: config.workspaceTitle, directory: config.directory })
    const workspace = workspaceSnapshot.nodes.find((node) => node.kind === 'workspace' && node.title === config.workspaceTitle && node.parentId === project.id)
    if (workspace === undefined || workspace.nativeWorkspaceId !== native.id || workspace.directory !== config.directory) throw new Error('organizer workspace identity mismatch')

    sourceSession = sessions.prepare(sourceId, { meta: { cwd: config.directory } })
    sourceSession.append('user/message', {
      id: `msg-${sourceId}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'synthetic live-only source' }]
    }, { surfaceOp: 'append' })
    sourceSession.append('subagent/catalog', {
      childId,
      childCreatedAt: Date.now(),
      version: 0,
      mode: 'one-shot'
    })
    childSession = sessions.prepare(childId, {
      meta: {
        cwd: config.directory,
        parentSession: sourceId,
        origin: 'subagent',
        delegationDepth: 1
      }
    })
    childSession.append('user/message', {
      id: `msg-${childId}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'synthetic live-only child' }]
    }, { surfaceOp: 'append' })

    // Register the EXACT disposers before any announcement, and keep S/T separate.
    detachSource = sessions.enter(sourceSession)
    detachChild = sessions.enter(childSession)
    sessions.announce(childSession)
    sessions.announce(sourceSession)
    await sleep(100)

    const live = await persistenceState()
    lastLive = live
    const getSource = sessions.get(sourceId) !== undefined
    const getChild = sessions.get(childId) !== undefined
    if (!getSource || !getChild) throw new Error('live sessions are not both present after announce')
    if (live.authoritative.errors.length > 0) throw new Error('authoritative persistence premise failed: ' + live.authoritative.errors.join(','))
    if (live.projection.errors.length > 0) throw new Error('projection checkpoint classification failed: ' + live.projection.errors.join(','))
    const sourceRead = await readSession(sourceId)
    const childRead = await readSession(childId)
    if (!sourceRead.ok || !childRead.ok) throw new Error('live readSession failed')
    const catalog = await readCatalog(sourceId)
    if (!catalog.ok || !Array.isArray(catalog.rows) || !catalog.rows.some((row) => row?.id === childId)) throw new Error('live catalog did not expose child T')

    const bindSnapshot = await organizer.bindDirectoryConversation({ workspaceId: workspace.id, title: config.conversationTitle, sessionId: sourceId })
    const conversation = bindSnapshot.nodes.find((node) => node.kind === 'conversation' && node.sessionId === sourceId && node.parentId === workspace.id)
    if (conversation === undefined) throw new Error('organizer conversation was not bound')
    const reconciled = await organizer.reconcileTasks({ conversationId: conversation.id })
    const ledger = await organizer.taskLedger()
    const ledgerFactsValue = ledgerFacts(ledger)
    const sourceRecord = ledger?.sources?.find((entry) => entry.sessionId === sourceId)
    const taskRecord = ledger?.tasks?.find((entry) => entry.childSessionId === childId)
    if (sourceRecord === undefined || taskRecord === undefined) throw new Error('prepared ledger missing S/T identity')
    if (taskRecord.sourceConversationId !== conversation.id) throw new Error('prepared task source mismatch')
    if (!Number.isInteger(ledger.revision)) throw new Error('prepared ledger revision invalid')
    if (config.fourTasks === true) {
      const fourTaskErrors = fourTaskLedgerErrors(ledger, {
        sourceAId: config.sourceAId ?? 'real-a-source',
        sourceBId: sourceId,
        taskT1Id: config.taskT1Id ?? 'real-a-t1',
        taskT2Id: config.taskT2Id ?? 'real-a-t2',
        taskT3Id: config.taskT3Id ?? 'real-a-t3',
        taskU1Id: childId
      })
      if (fourTaskErrors.length > 0) throw new Error('prepared four tasks shape failed: ' + fourTaskErrors.join(','))
    }
    const hashes = await fileHashes()

    prepared = {
      projectId: project.id,
      workspaceId: workspace.id,
      nativeWorkspaceId: native.id,
      conversationId: conversation.id,
      projectA: projectA === null ? null : { id: projectA.id },
      workspaceA: workspaceA === null ? null : { id: workspaceA.id },
      nativeWorkspaceA: nativeA === null ? null : { id: nativeA.id },
      conversationA: conversationA === null ? null : { id: conversationA.id },
      fourTasks: config.fourTasks === true,
      ledger,
      ledgerFacts: ledgerFactsValue,
      sourceRecord,
      taskRecord,
      live,
      getSource,
      getChild,
      sourceRead,
      childRead,
      catalog,
      hashes,
      conflicts: reconciled.conflicts,
      detachRegistered: { source: typeof detachSource === 'function', child: typeof detachChild === 'function' }
    }
    phase = 'prepared'
    await writeState({ prepared })
    await mark('prepared', { sourceId, childId, conversationId: conversation.id, revision: ledger.revision })
  }

  const detach = async () => {
    if (phase !== 'prepared' || prepared === null) throw new Error('detach requires prepared phase')
    if (typeof detachSource !== 'function') throw new Error('source detach disposer is not registered')
    detachSource()
    detachSource = null
    await sleep(100)
    const live = await persistenceState()
    lastLive = live
    const getSource = sessions.get(sourceId) !== undefined
    const getChild = sessions.get(childId) !== undefined
    if (getSource) throw new Error('source S remained live after exact disposer')
    if (!getChild) throw new Error('child T was unexpectedly detached')
    if (live.authoritative.errors.length > 0) throw new Error('detach authoritative persistence premise failed: ' + live.authoritative.errors.join(','))
    if (live.projection.errors.length > 0) throw new Error('detach projection checkpoint classification failed: ' + live.projection.errors.join(','))
    const childRead = await readSession(childId)
    if (!childRead.ok) throw new Error('child T readSession failed after source detach')
    detached = { live, getSource, getChild, childRead, detachedAt: new Date().toISOString() }
    phase = 'detached'
    await writeState({ prepared, detached })
    await mark('detached', { getSource, getChild, statSource: live.authoritative.statSource, statChild: live.authoritative.statChild })
  }

  const probe = async () => {
    if (phase !== 'detached' || detached === null) throw new Error('probe requires detached phase')
    const sourceRead = await readSession(sourceId)
    const catalog = await readCatalog(sourceId)
    let reconcileError = null
    let reconcileCalls = 0
    try {
      reconcileCalls += 1
      await organizer.reconcileTasks({ conversationId: prepared.conversationId })
    } catch (error) {
      reconcileError = errorRecord(error)
    }
    const ledger = await organizer.taskLedger()
    const live = await persistenceState()
    lastLive = live
    if (live.authoritative.errors.length > 0) throw new Error('probe authoritative persistence premise failed: ' + live.authoritative.errors.join(','))
    if (live.projection.errors.length > 0) throw new Error('probe projection checkpoint classification failed: ' + live.projection.errors.join(','))
    const hashes = await fileHashes()
    const stability = ledgerStabilityErrors(prepared.ledger, ledger)
    probed = {
      sourceRead,
      catalog,
      reconcileError,
      reconcileCalls,
      ledger,
      ledgerFacts: ledgerFacts(ledger),
      stability,
      live,
      hashes,
      sourceDetachRemaining: detachSource !== null,
      childDetachRegistered: typeof detachChild === 'function'
    }
    phase = 'probed'
    await writeState({ prepared, detached, probed })
    await mark('probed', { reconcileCalls, reconcileCode: reconcileError?.code ?? null, stability })
  }

  const status = async (requestId) => {
    const live = await persistenceState()
    lastLive = live
    const getSource = sessions.get(sourceId) !== undefined
    const getChild = sessions.get(childId) !== undefined
    const ledger = await organizer.taskLedger()
    const result = {
      requestId: requestId ?? null,
      at: new Date().toISOString(),
      phase,
      getSource,
      getChild,
      live,
      ledger,
      ledgerFacts: ledgerFacts(ledger)
    }
    await writeFile(config.statusFile, JSON.stringify(result, null, 2), 'utf8')
    await mark('status', { getSource, getChild, revision: ledger?.revision ?? null, authoritativeErrors: live.authoritative.errors, projectionErrors: live.projection.errors })
  }

  const readiness = async (requestId) => {
    if (clientModules === undefined || typeof clientModules.artifactBaseline !== 'function' || typeof clientModules.graph !== 'function') throw new Error('public clientModules artifactBaseline/graph is unavailable')
    const packageId = typeof config.packageId === 'string' && config.packageId.length > 0 ? config.packageId : 'workspace-organizer-dsh'
    let baseline = clientModules.artifactBaseline(packageId)
    if (baseline === undefined) throw new Error('artifactBaseline returned undefined for ' + packageId)
    if (typeof baseline.path !== 'string' || baseline.path.length === 0) throw new Error('artifactBaseline.path is missing')
    const expectedArtifactPath = typeof config.expectedArtifactPath === 'string' ? config.expectedArtifactPath : null
    let settledBaseline = baseline
    for (let attempt = 0; expectedArtifactPath !== null && settledBaseline?.path !== expectedArtifactPath && attempt < 100; attempt += 1) {
      await sleep(100)
      settledBaseline = clientModules.artifactBaseline(packageId)
    }
    if (settledBaseline !== undefined) baseline = settledBaseline
    const graph = clientModules.graph()
    if (graph === null || typeof graph !== 'object' || !Array.isArray(graph.entries) || !Array.isArray(graph.batches)) throw new Error('clientModules.graph shape is invalid')
    const loaderEntries = loader === undefined || typeof loader.entries !== 'function' ? null : [...loader.entries()].map((entry) => ({ id: entry.id, name: entry.options?.name ?? null, disabled: entry.options?.disabled ?? null, effectiveDisabled: entry.disabled === true, fiber: entry.fiber !== undefined }))
    const bytes = await readFile(baseline.path)
    const info = await stat(baseline.path)
    await writeFile(config.artifactOutFile, bytes)
    const result = {
      requestId: requestId ?? null,
      at: new Date().toISOString(),
      packageId,
      baseline,
      artifact: {
        path: baseline.path,
        sha256: sha256(bytes),
        sizeBytes: bytes.length,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        sizeMatchesBaseline: bytes.length === baseline.size,
        mtimeMatchesBaseline: info.mtimeMs === baseline.mtimeMs,
        ctimeMatchesBaseline: info.ctimeMs === baseline.ctimeMs,
        instrumented: bytes.toString('utf8').includes('__WO_C3A_SAFE__')
      },
      graph,
      loaderEntries
    }
    await writeFile(config.readinessFile, JSON.stringify(result, null, 2), 'utf8')
    await mark('readiness', { packageId, path: baseline.path, sha256: result.artifact.sha256, instrumented: result.artifact.instrumented })
  }

  const handle = async (command) => {
    if (command === null || typeof command !== 'object' || typeof command.action !== 'string') return
    if (command.requestId !== undefined && command.requestId === lastRequest) return
    lastRequest = command.requestId ?? null
    busy = true
    try {
      await writeFile(config.controlFile, '{}', 'utf8').catch(() => {})
      if (command.action === 'prepare') await prepare()
      else if (command.action === 'detach') await detach()
      else if (command.action === 'probe') await probe()
      else if (command.action === 'status') await status(command.requestId)
      else if (command.action === 'readiness') await readiness(command.requestId)
      else throw new Error('unknown live B control action: ' + command.action)
    } catch (error) {
      phase = 'error'
      await writeState({ prepared, detached, probed, lastLive, error: errorRecord(error) })
      await mark('error', { action: command.action, error: errorRecord(error) })
    } finally {
      busy = false
    }
  }

  await writeState()
  await mark('ready', { services })
  const timer = setInterval(async () => {
    if (busy) return
    let command = null
    try { command = JSON.parse(await readFile(config.controlFile, 'utf8')) } catch { return }
    await handle(command)
  }, 100)
  ctx.effect(() => () => {
    clearInterval(timer)
    void mark('cleanup', { sourceDetachRemaining: detachSource !== null, childDetachRegistered: typeof detachChild === 'function' })
  })
}
