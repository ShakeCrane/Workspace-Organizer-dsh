/**
 * Path and detail-field helpers for verify-web-organizer.mjs (test-only).
 *
 * DSH compares `session.cwd` with `workspace.directory` literally. When the
 * run root is reached through an NTFS junction (for example the repository's
 * `build` -> `test/build` link), the registry stores the canonical target while
 * a raw bootstrap path would still carry the junction spelling. Canonicalizing
 * the run root and every workspace directory up front keeps both sides equal
 * without touching product source.
 */
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'

/** Resolve an existing path to its canonical form (realpath). */
export async function canonicalExistingPath(path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('canonical path requires a non-empty string')
  return await realpath(path)
}

/** Stable DSH profile name derived from the canonical run root. */
export function profileFromRunRoot(runRoot, buildRoot) {
  if (typeof runRoot !== 'string' || runRoot.length === 0) throw new Error('run root required')
  const relativeRoot = typeof buildRoot === 'string' && buildRoot.length > 0 ? relative(buildRoot, runRoot) : ''
  const stem = relativeRoot.length === 0 ? basename(runRoot) : relativeRoot
  return `c1web-${stem.replace(/[^a-z0-9-]/giu, '-').toLowerCase()}`
}

/** Mirror the client's `sourceField` rendering for a nullable field. */
export function sourceField(value) {
  return value === undefined || value === null || value === '' ? 'unknown' : String(value)
}

/**
 * Expected task-detail DOM fields for one ledger task.
 *
 * Mirrors client/client.js: `sourceField` for values, `sourceState` for the
 * verification state, and the literal `blocked:` / `source blocked:` labels
 * that are rendered only when blockedReason is defined.
 */
export function expectedDetailFields(source, task) {
  if (task === undefined || task === null) throw new Error('task required')
  const verification = source === undefined || source === null ? 'unverified' : sourceField(source.verificationState)
  return {
    sourceId: source === undefined || source === null ? 'unknown' : sourceField(source.conversationId),
    logical: sourceField(source?.workspaceLogicalId),
    native: sourceField(source?.nativeWorkspaceId),
    directory: sourceField(source?.directory),
    verifiedAt: sourceField(source?.verifiedAt),
    verification,
    sourceBlocked: source?.blockedReason === undefined ? 'unknown' : `source blocked: ${String(source.blockedReason)}`,
    taskBlocked: task.blockedReason === undefined ? 'unknown' : `blocked: ${String(task.blockedReason)}`
  }
}

/** Exact DOM text/attribute comparison for one detail step against ledger facts. */
export function detailStepMatches(step, source, task) {
  const expected = expectedDetailFields(source, task)
  return step.detailId === task.taskId &&
    step.sourceId === expected.sourceId && step.sourceText === `source C: ${expected.sourceId}` &&
    step.logical === expected.logical && step.logicalText === `logical workspace: ${expected.logical}` &&
    step.native === expected.native && step.nativeText === `native workspace: ${expected.native}` &&
    step.directory === expected.directory && step.directoryText === `observed directory: ${expected.directory}` &&
    step.verifiedAt === expected.verifiedAt && step.verifiedAtText === `verifiedAt: ${expected.verifiedAt}` &&
    step.verification === expected.verification && step.verificationText === `verification: ${expected.verification}` &&
    step.sourceBlockedText === expected.sourceBlocked &&
    step.taskBlockedText === expected.taskBlocked
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const TASK_FIELDS = ['taskId', 'childSessionId', 'sourceConversationId', 'parent', 'depth', 'executionState', 'blockedReason']
const SOURCE_FIELDS = ['conversationId', 'sessionId', 'workspaceLogicalId', 'nativeWorkspaceId', 'directory', 'verifiedAt', 'verificationState', 'blockedReason', 'hostVersion']
const TREE_FIELDS = ['id', 'kind', 'title', 'parentId', 'directory', 'nativeWorkspaceId', 'sessionId', 'cwd']
const pick = (row, fields) => Object.fromEntries(fields.map((field) => [field, row?.[field] ?? null]))

/** Freeze the durable ledger identity/resource facts used by the cold oracle. */
export function freezeTaskLedger(ledger) {
  if (ledger === null || typeof ledger !== 'object' || !Array.isArray(ledger.tasks) || !Array.isArray(ledger.sources)) {
    throw new Error('freezeTaskLedger requires tasks and sources')
  }
  return {
    revision: ledger.revision ?? null,
    tasks: ledger.tasks.map((task) => pick(task, TASK_FIELDS)).sort((a, b) => String(a.childSessionId).localeCompare(String(b.childSessionId))),
    sources: ledger.sources.map((source) => pick(source, SOURCE_FIELDS)).sort((a, b) => String(a.conversationId).localeCompare(String(b.conversationId)))
  }
}

/** Freeze tree node identity and parent/directory associations. */
export function freezeTreeState(state) {
  if (state === null || typeof state !== 'object' || !Array.isArray(state.nodes)) throw new Error('freezeTreeState requires nodes')
  return {
    revision: state.revision ?? null,
    nodes: state.nodes.map((node) => pick(node, TREE_FIELDS)).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  }
}

/** Freeze registry associations without volatile timestamps. */
export function freezeRegistry(registry) {
  const workspaces = registry?.tables?.workspaces ?? {}
  return {
    workspaceIds: (registry?.global?.workspaceIds ?? []).slice().sort(),
    archivedSessionIds: (registry?.global?.archivedSessionIds ?? []).slice().sort(),
    workspaces: Object.keys(workspaces).sort().map((id) => ({
      id,
      path: workspaces[id]?.path ?? null,
      title: workspaces[id]?.title ?? null,
      sessionIds: (workspaces[id]?.sessionIds ?? []).slice().sort()
    }))
  }
}

/** Content digest for a formal Session read (header, inherited count, events). */
export function freezeSessions(sessions) {
  if (sessions === null || typeof sessions !== 'object') throw new Error('freezeSessions requires sessions')
  return Object.fromEntries(Object.keys(sessions).sort().map((id) => {
    const session = sessions[id] ?? {}
    const events = Array.isArray(session.events) ? session.events : []
    return [id, {
      headerSha256: sha256(JSON.stringify(session.header ?? null)),
      inheritedEventCount: session.inheritedEventCount ?? null,
      eventCount: events.length,
      digest: sha256(JSON.stringify({ header: session.header ?? null, inheritedEventCount: session.inheritedEventCount ?? null, events }))
    }]
  }))
}

function fieldDiff(prefix, expected, actual, fields) {
  const errors = []
  for (const field of fields) {
    if (JSON.stringify(expected[field] ?? null) !== JSON.stringify(actual[field] ?? null)) errors.push(`${prefix}:${field}`)
  }
  return errors
}

/**
 * Compare the frozen pre-restart facts with the cold-boot facts.
 * Any lost/duplicated/recreated identity, revision drift, tree drift or
 * resurrected archived Source is a hard failure.
 */
export function compareColdFacts(baseline, cold) {
  const errors = []
  const b = freezeTaskLedger(baseline?.ledger)
  const c = freezeTaskLedger(cold?.ledger)
  if (b.revision !== c.revision) errors.push(`ledger-revision:${String(b.revision)}->${String(c.revision)}`)
  if (b.tasks.length !== c.tasks.length) errors.push(`task-count:${String(b.tasks.length)}->${String(c.tasks.length)}`)
  const coldTasks = new Map(c.tasks.map((task) => [task.childSessionId, task]))
  for (const task of b.tasks) {
    const actual = coldTasks.get(task.childSessionId)
    if (actual === undefined) errors.push(`task-missing:${task.childSessionId}`)
    else errors.push(...fieldDiff(`task:${task.childSessionId}`, task, actual, TASK_FIELDS))
  }
  for (const task of c.tasks) if (!b.tasks.some((entry) => entry.childSessionId === task.childSessionId)) errors.push(`task-extra:${task.childSessionId}`)

  const coldSources = new Map(c.sources.map((source) => [source.conversationId, source]))
  for (const source of b.sources) {
    const actual = coldSources.get(source.conversationId)
    if (actual === undefined) {
      errors.push(`source-missing:${source.conversationId}`)
      continue
    }
    errors.push(...fieldDiff(`source:${source.conversationId}`, source, actual, SOURCE_FIELDS))
    if (source.verificationState === 'blocked' && actual.verificationState !== 'blocked') errors.push(`source-resurrected:${source.conversationId}`)
  }
  for (const source of c.sources) if (!b.sources.some((entry) => entry.conversationId === source.conversationId)) errors.push(`source-extra:${source.conversationId}`)

  const bTree = freezeTreeState(baseline?.tree)
  const cTree = freezeTreeState(cold?.tree)
  if (bTree.revision !== cTree.revision) errors.push(`tree-revision:${String(bTree.revision)}->${String(cTree.revision)}`)
  if (bTree.nodes.length !== cTree.nodes.length) errors.push(`tree-count:${String(bTree.nodes.length)}->${String(cTree.nodes.length)}`)
  const coldNodes = new Map(cTree.nodes.map((node) => [node.id, node]))
  for (const node of bTree.nodes) {
    const actual = coldNodes.get(node.id)
    if (actual === undefined) errors.push(`tree-missing:${node.id}`)
    else errors.push(...fieldDiff(`tree:${node.id}`, node, actual, TREE_FIELDS))
  }
  for (const node of cTree.nodes) if (!bTree.nodes.some((entry) => entry.id === node.id)) errors.push(`tree-extra:${node.id}`)

  const bRegistry = freezeRegistry(baseline?.registry)
  const cRegistry = freezeRegistry(cold?.registry)
  if (JSON.stringify(bRegistry) !== JSON.stringify(cRegistry)) errors.push('registry-mismatch')

  const bSessions = freezeSessions(baseline?.sessions)
  const cSessions = freezeSessions(cold?.sessions)
  for (const id of Object.keys(bSessions)) {
    if (cSessions[id] === undefined) errors.push(`session-missing:${id}`)
    else if (JSON.stringify(bSessions[id]) !== JSON.stringify(cSessions[id])) errors.push(`session-content:${id}`)
  }
  for (const id of Object.keys(cSessions)) if (bSessions[id] === undefined) errors.push(`session-extra:${id}`)
  return errors
}

/**
 * Bind an observed taskLedger response to the cold page/boot and reject warm
 * or stale responses. The UI response must be accepted, have a result, and be
 * observed after the cold host started on the new page.
 */
export function responseBindingErrors(record, { pageId, warmPageId = null, bootId, coldBootId, startedAt } = {}) {
  if (record === null || typeof record !== 'object') return ['response-missing']
  const errors = []
  if (record.decision !== 'accepted') errors.push('response-not-accepted')
  if (record.pageId !== pageId) errors.push('response-page-mismatch')
  if (warmPageId !== null && record.pageId === warmPageId) errors.push('response-warm-page')
  if (bootId !== coldBootId) errors.push('response-boot-mismatch')
  if (!(Number(record.at) >= Number(startedAt))) errors.push('response-before-cold-start')
  if (record.result === null || record.result === undefined) errors.push('response-missing-result')
  else if (record.result.error !== null && record.result.error !== undefined) errors.push('response-result-error')
  return errors
}

/**
 * Bind the observed failed All Tasks Reload request to the page, the current
 * generation and the real Host-stop boundary. Old requests, discarded
 * decisions and success results are not a real transport failure.
 */
export function rpcFailureBindingErrors(record, { pageId, previousIds = [], minGeneration = 0, hostStoppedAt = 0 } = {}) {
  if (record === null || typeof record !== 'object') return ['rpc-error-response-missing']
  const errors = []
  if (record.method !== 'taskLedger') errors.push('rpc-error-method')
  if (record.input?.sourceId !== undefined) errors.push('rpc-error-source-scoped')
  if (record.pageId !== pageId) errors.push('rpc-error-page-mismatch')
  if (previousIds.includes(record.id)) errors.push('rpc-error-old-request')
  if (!(Number(record.generation) > Number(minGeneration))) errors.push('rpc-error-generation')
  if (!(Number(record.at) >= Number(hostStoppedAt))) errors.push('rpc-error-before-host-stop')
  if (record.decision === 'discarded') errors.push('rpc-error-discarded')
  else if (record.decision !== 'accepted') errors.push('rpc-error-not-accepted')
  if (record.decisionExtra?.outcome !== 'error') errors.push('rpc-error-decision-outcome')
  if (typeof record.result?.error !== 'string' || record.result.error.length === 0) errors.push('rpc-error-result-error')
  if (record.result?.decoded !== undefined && record.result?.decoded !== null) errors.push('rpc-error-decoded')
  return errors
}

/**
 * Bind the observed failed All Tasks Reload request to the page, the current
 * generation and the test-only CDP connection degradation boundary.
 */
export function degradedRpcBindingErrors(record, { pageId, previousIds = [], minGeneration = 0, degradedAt = 0 } = {}) {
  if (record === null || typeof record !== 'object') return ['degraded-rpc-response-missing']
  const errors = []
  if (record.method !== 'taskLedger') errors.push('degraded-rpc-method')
  if (record.input?.sourceId !== undefined) errors.push('degraded-rpc-source-scoped')
  if (record.pageId !== pageId) errors.push('degraded-rpc-page-mismatch')
  if (previousIds.includes(record.id)) errors.push('degraded-rpc-old-request')
  if (!(Number(record.generation) > Number(minGeneration))) errors.push('degraded-rpc-generation')
  if (!(Number(record.at) >= Number(degradedAt))) errors.push('degraded-rpc-before-degradation')
  if (record.decision === 'discarded') errors.push('degraded-rpc-discarded')
  else if (record.decision !== 'accepted') errors.push('degraded-rpc-not-accepted')
  if (record.decisionExtra?.outcome !== 'error') errors.push('degraded-rpc-decision-outcome')
  if (typeof record.result?.error !== 'string' || record.result.error.length === 0) errors.push('degraded-rpc-result-error')
  if (record.result?.decoded !== undefined && record.result?.decoded !== null) errors.push('degraded-rpc-decoded')
  return errors
}

/**
 * Bind the observed successful All Tasks Reload retry request to the page,
 * the current generation (strictly greater than the failed request generation),
 * and the user retry timestamp after connection recovery.
 */
export function recoveredRpcBindingErrors(record, { pageId, previousIds = [], failedGeneration = 0, retryAt = 0, expectedLedger = null } = {}) {
  if (record === null || typeof record !== 'object') return ['recovered-rpc-response-missing']
  const errors = []
  if (record.method !== 'taskLedger') errors.push('recovered-rpc-method')
  if (record.input?.sourceId !== undefined) errors.push('recovered-rpc-source-scoped')
  if (record.pageId !== pageId) errors.push('recovered-rpc-page-mismatch')
  if (previousIds.includes(record.id)) errors.push('recovered-rpc-old-request')
  if (!(Number(record.generation) > Number(failedGeneration))) errors.push('recovered-rpc-generation')
  if (!(Number(record.at) >= Number(retryAt))) errors.push('recovered-rpc-before-retry')
  if (record.decision === 'discarded') errors.push('recovered-rpc-discarded')
  else if (record.decision !== 'accepted') errors.push('recovered-rpc-not-accepted')
  if (record.decisionExtra?.outcome !== 'success') errors.push('recovered-rpc-decision-outcome')
  if (record.result?.error !== null && record.result?.error !== undefined) errors.push('recovered-rpc-result-error')
  if (record.result?.decoded === null || typeof record.result?.decoded !== 'object') errors.push('recovered-rpc-decoded-missing')
  else if (expectedLedger !== null && JSON.stringify(record.result.decoded) !== JSON.stringify(expectedLedger)) {
    errors.push('recovered-rpc-decoded-mismatch')
  }
  return errors
}

const DETAIL_COMPARE_FIELDS = [
  'detailId', 'taskId', 'sourceText', 'sourceId', 'logicalText', 'logical', 'nativeText', 'native',
  'directoryText', 'directory', 'verifiedAtText', 'verifiedAt', 'verificationText', 'verification',
  'sourceBlockedText', 'taskBlockedText'
]

/**
 * The failed Reload must keep the old detail and ledger exactly, add explicit
 * stale markers, and correlate the DOM error with the same raw client error.
 */
export function stalePreservationErrors({ before, after, source, task, state, record, revision } = {}) {
  if (before === null || before === undefined || after === null || after === undefined) return ['stale-detail-missing']
  const errors = []
  for (const field of DETAIL_COMPARE_FIELDS) if (before[field] !== after[field]) errors.push('stale-detail-changed:' + field)
  if (detailStepMatches(before, source, task) !== true) errors.push('stale-before-fields')
  if (detailStepMatches(after, source, task) !== true) errors.push('stale-after-fields')
  if (state?.detailId !== task?.taskId) errors.push('stale-selected-detail')
  if (String(state?.status ?? '').includes('error') !== true) errors.push('stale-status')
  if (revision !== undefined && String(state?.status ?? '').includes('(rev ' + String(revision) + ')') !== true) errors.push('stale-status-revision')
  if (typeof state?.error !== 'string' || state.error.length === 0) errors.push('stale-error-missing')
  if (typeof state?.error === 'string' && typeof record?.result?.error === 'string' && record.result.error.length > 0 && state.error.includes(record.result.error) !== true) errors.push('stale-error-mismatch')
  if (typeof state?.stale !== 'string' || state.stale.toLowerCase().includes('stale') !== true) errors.push('stale-marker-missing')
  if (state?.sourceStaleAttr !== 'true') errors.push('stale-source-attr')
  if (typeof state?.sourceStale !== 'string' || state.sourceStale.toLowerCase().includes('stale') !== true) errors.push('stale-source-text')
  if (!Array.isArray(state?.rows) || state.rows.length !== 4) errors.push('stale-rows')
  return errors
}

/**
 * The recovered All Tasks DOM state must return to ready, remove error and stale markers,
 * set sourceStaleAttr to "false", preserve the 4 task rows, and keep the selected U1 detail intact.
 */
export function recoveredStateErrors(options = {}) {
  if (options === null || typeof options !== 'object') return ['recovered-state-missing']
  const { state, beforeDetail, afterDetail, source, task, expectedRows = [], revision } = options
  if (state === null || typeof state !== 'object') return ['recovered-state-missing']
  const errors = []
  if (String(state.status ?? '').includes('ready') !== true) errors.push('recovered-status-not-ready')
  if (revision !== undefined && String(state.status ?? '').includes('(rev ' + String(revision) + ')') !== true) {
    errors.push('recovered-status-revision')
  }
  if (state.error !== null && state.error !== '') errors.push('recovered-error-persisted')
  if (state.stale !== null && state.stale !== '') errors.push('recovered-stale-persisted')
  if (state.sourceStaleAttr !== 'false') errors.push('recovered-source-stale-attr')
  if (typeof state.sourceStale !== 'string' || state.sourceStale.includes('stale')) errors.push('recovered-source-stale-text')
  if (!Array.isArray(state.rows) || state.rows.length !== expectedRows.length) errors.push('recovered-rows-count')
  else if (JSON.stringify(state.rows) !== JSON.stringify(expectedRows)) errors.push('recovered-rows-mismatch')
  if (state.detailId !== task?.taskId) errors.push('recovered-selected-detail')
  if (beforeDetail && afterDetail) {
    for (const field of DETAIL_COMPARE_FIELDS) {
      if (beforeDetail[field] !== afterDetail[field]) errors.push('recovered-detail-changed:' + field)
    }
    if (detailStepMatches(afterDetail, source, task) !== true) errors.push('recovered-detail-fields')
  }
  return errors
}

/**
 * Layered exit evidence: every required process must have an observed exit,
 * no timeout, and no surviving PID. Missing labels are a failure.
 */
export function observedExitErrors(records, { min = 2, requireLabels = [] } = {}) {
  const errors = []
  if (!Array.isArray(records) || records.length < min) errors.push('exit-count:' + String(records?.length ?? 0))
  for (const record of records ?? []) {
    if (record.observed !== true) errors.push('exit-unobserved:' + String(record.label))
    if (record.timedOut === true) errors.push('exit-timeout:' + String(record.label))
    if (record.aliveAfter !== false) errors.push('exit-residual:' + String(record.label))
  }
  for (const label of requireLabels) if (!(records ?? []).some((record) => record.label === label)) errors.push('exit-missing:' + label)
  return errors
}

/**
 * Every forbidden entry must be a confirmed wrapped probe with an explicit
 * counter; missing instrumentation is never treated as zero.
 */
export function probeCoverageErrors(probes, counts, forbidden) {
  const errors = []
  for (const key of forbidden) {
    const [service, method] = key.split('/')
    const probe = probes?.[service]
    if (probe === undefined || probe.present !== true) {
      errors.push(`probe-missing-service:${service}`)
      continue
    }
    const record = probe.methods?.[method]
    if (record === undefined || record.typeof !== 'function') {
      errors.push(`probe-missing-method:${key}`)
      continue
    }
    if (record.wrapped !== true) {
      errors.push(`probe-unwrapped:${key}`)
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(counts ?? {}, key)) {
      errors.push(`count-missing:${key}`)
      continue
    }
    if (counts[key] !== 0) errors.push(`count-nonzero:${key}=${String(counts[key])}`)
  }
  return errors
}

/**
 * Check whether a candidate path is inside or identical to a root directory.
 */
export function pathWithinRoot(path, root) {
  if (typeof path !== 'string' || typeof root !== 'string') return false
  const normalizedPath = resolve(path).toLowerCase()
  const normalizedRoot = resolve(root).toLowerCase()
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + sep)
}

/**
 * Parse top-level YAML entries from `dsh --dump-config` output text without
 * depending on an external YAML parser that might choke on custom tags (!!js).
 */
export function parseConfigDumpEntries(dumpText) {
  if (typeof dumpText !== 'string') return []
  const lines = dumpText.split(/\r?\n/u)
  const entries = []
  let current = null
  let inConfig = false
  let currentScalarProp = null
  let currentScalarLines = []

  const flushScalar = () => {
    if (current && inConfig && currentScalarProp !== null) {
      current.config[currentScalarProp] = currentScalarLines.join(' ').trim()
      currentScalarProp = null
      currentScalarLines = []
    }
  }

  for (const line of lines) {
    if (line.startsWith('#')) continue
    const entryMatch = line.match(/^- id:\s*(\S+)/u)
    if (entryMatch) {
      flushScalar()
      current = { id: entryMatch[1] }
      entries.push(current)
      inConfig = false
      continue
    }
    if (!current) continue
    if (line.startsWith('  name:')) {
      flushScalar()
      current.name = line.replace(/^\s*name:\s*['"]?([^'"]+)['"]?\s*$/u, '$1').trim()
      inConfig = false
      continue
    }
    if (line.startsWith('  config:')) {
      flushScalar()
      current.config = {}
      inConfig = true
      continue
    }
    if (inConfig) {
      if (currentScalarProp !== null) {
        if (/^\s{6,}\S/u.test(line)) {
          currentScalarLines.push(line.trim())
          continue
        } else {
          flushScalar()
        }
      }
      if (/^\s{4}[a-zA-Z0-9_-]+:/u.test(line)) {
        const propMatch = line.match(/^\s{4}([a-zA-Z0-9_-]+):\s*(.*)$/u)
        if (propMatch) {
          let val = propMatch[2].replace(/^['"]|['"]$/g, '').trim()
          if (['>-', '|-', '>', '|'].includes(val) || val === '') {
            currentScalarProp = propMatch[1]
            currentScalarLines = []
          } else {
            if (/^-?\d+$/u.test(val)) val = Number(val)
            current.config[propMatch[1]] = val
          }
        }
      } else if (!line.startsWith(' ') && line.length > 0) {
        flushScalar()
        inConfig = false
      }
    }
  }
  flushScalar()
  return entries
}

/**
 * Verify that the composed config tree contains exactly one workspace-controller entry
 * with the expected package name, documentsDirectory override, and timeout.
 */
export function workspaceControllerOverlayErrors(entries, expected = {}) {
  if (!Array.isArray(entries)) return ['overlay-entries-invalid']
  const errors = []
  const matches = entries.filter((entry) => entry?.id === 'workspace-controller')
  if (matches.length === 0) return ['overlay-missing:workspace-controller']
  if (matches.length > 1) return ['overlay-duplicate:workspace-controller=' + matches.length]

  const entry = matches[0]
  const expectedName = expected.expectedName ?? '@deepseek-ai/dsh-api-workspace-controller'
  if (entry.name !== expectedName) errors.push(`overlay-name-mismatch:${String(entry.name)}!=${expectedName}`)

  if (!entry.config || typeof entry.config !== 'object') {
    errors.push('overlay-config-missing')
    return errors
  }

  if (expected.documentsDirectory !== undefined) {
    const actualDir = resolve(String(entry.config.documentsDirectory ?? '')).toLowerCase()
    const expDir = resolve(String(expected.documentsDirectory)).toLowerCase()
    if (actualDir !== expDir) {
      errors.push(`overlay-documents-directory-mismatch:${entry.config.documentsDirectory}!=${expected.documentsDirectory}`)
    }
  }

  const expectedTimeout = expected.documentsLookupTimeoutMs ?? 10000
  if (entry.config.documentsLookupTimeoutMs !== expectedTimeout) {
    errors.push(`overlay-timeout-mismatch:${String(entry.config.documentsLookupTimeoutMs)}!=${expectedTimeout}`)
  }

  return errors
}

/**
 * Verify that initializeDefault produced a default workspace located strictly within
 * the run-root documents directory, correctly registered without pre-existing records,
 * and that no ancestor escapes the run-root.
 */
export function defaultWorkspaceIsolationErrors(actual = {}, expected = {}) {
  const errors = []
  const { before, result, after, resolvedPath, ancestorPaths = [] } = actual
  const runRoot = expected.runRoot ?? expected.canonicalR
  const expectedDocumentsDir = expected.expectedDocumentsDir ?? expected.documentsDirectory
  const expectedDefaultPath = expected.expectedDefaultPath
  const prohibitedPaths = expected.prohibitedPaths ?? []

  if (!runRoot || !expectedDefaultPath) return ['isolation-expected-params-missing']

  // Pre-condition: registry had no default workspace before initialization
  if (before?.defaultWorkspaceId !== null && before?.defaultWorkspaceId !== undefined) {
    errors.push('pre-existing-default-workspace-id:' + String(before.defaultWorkspaceId))
  }
  if (Array.isArray(before?.workspaces) && before.workspaces.some((w) => w?.id === before?.defaultWorkspaceId)) {
    errors.push('pre-existing-default-workspace-record')
  }

  // Result verification
  if (!result || typeof result !== 'object' || !result.workspace) {
    errors.push('initialize-default-result-missing')
    return errors
  }

  const ws = result.workspace
  if (!ws.workspaceId) errors.push('workspace-id-missing')
  if (typeof ws.path !== 'string' || ws.path.length === 0) {
    errors.push('workspace-path-missing')
  } else {
    const wsNormalized = resolve(ws.path).toLowerCase()
    const expectedNormalized = resolve(expectedDefaultPath).toLowerCase()
    if (wsNormalized !== expectedNormalized) {
      errors.push(`workspace-path-mismatch:${ws.path}!=${expectedDefaultPath}`)
    }
    if (!pathWithinRoot(ws.path, runRoot)) {
      errors.push(`workspace-path-escape-run-root:${ws.path}`)
    }
    if (expectedDocumentsDir && !pathWithinRoot(ws.path, expectedDocumentsDir)) {
      errors.push(`workspace-path-escape-documents:${ws.path}`)
    }
    for (const prohibited of prohibitedPaths) {
      if (typeof prohibited === 'string' && prohibited.length > 0) {
        const prohibitedNormalized = resolve(prohibited).toLowerCase()
        if (wsNormalized === prohibitedNormalized || wsNormalized.startsWith(prohibitedNormalized + sep)) {
          errors.push(`workspace-path-prohibited-match:${prohibited}`)
        }
      }
    }
  }

  // Registry post-state verification
  if (after?.defaultWorkspaceId !== ws.workspaceId) {
    errors.push(`registry-default-id-mismatch:${String(after?.defaultWorkspaceId)}!=${String(ws.workspaceId)}`)
  }
  const matchingRecord = (after?.workspaces ?? []).find(
    (w) => (w?.id === ws.workspaceId || w?.workspaceId === ws.workspaceId)
  )
  if (!matchingRecord) {
    errors.push('registry-default-record-missing')
  } else {
    const recordPath = matchingRecord.path ?? matchingRecord.record?.path ?? ''
    if (resolve(recordPath).toLowerCase() !== resolve(expectedDefaultPath).toLowerCase()) {
      errors.push(`registry-record-path-mismatch:${recordPath}!=${expectedDefaultPath}`)
    }
  }

  // Physical path & ancestors escape check
  if (resolvedPath) {
    if (!pathWithinRoot(resolvedPath, runRoot)) {
      errors.push(`resolved-path-escape:${resolvedPath}`)
    }
  }
  for (const ancestor of ancestorPaths) {
    if (!pathWithinRoot(ancestor, runRoot)) {
      errors.push(`ancestor-path-escape:${ancestor}`)
    }
  }

  return errors
}

/**
 * Detect forbidden entry point call increments across a measurement window.
 */
export function mountForbiddenErrors(baselineCounts = {}, currentCounts = {}, forbiddenList = []) {
  const errors = []
  for (const method of forbiddenList) {
    const base = Number(baselineCounts[method] ?? 0)
    const curr = Number(currentCounts[method] ?? 0)
    if (curr > base) {
      errors.push(`forbidden-increment:${method}=+${curr - base}`)
    }
  }
  return errors
}

/**
 * Verify that any native sessions created during mount have their cwd bound to the expected
 * default workspace path within runRoot, and do not escape or match prohibited directories.
 */
export function mountSessionCwdErrors(sessions = {}, expectedCwd, runRoot, prohibitedPaths = []) {
  const errors = []
  if (!expectedCwd || !runRoot) return ['session-cwd-params-missing']

  const expectedNormalized = resolve(expectedCwd).toLowerCase()
  for (const [id, session] of Object.entries(sessions)) {
    if (!session || typeof session !== 'object') continue
    const cwd = session.cwd ?? session.header?.cwd
    if (!cwd || typeof cwd !== 'string') {
      errors.push(`session-cwd-missing:${id}`)
      continue
    }
    const cwdNormalized = resolve(cwd).toLowerCase()
    if (cwdNormalized !== expectedNormalized) {
      errors.push(`session-cwd-mismatch:${id}=${cwd}!=${expectedCwd}`)
    }
    if (!pathWithinRoot(cwd, runRoot)) {
      errors.push(`session-cwd-escape:${id}=${cwd}`)
    }
    for (const prohibited of prohibitedPaths) {
      if (typeof prohibited === 'string' && prohibited.length > 0) {
        const prohibitedNormalized = resolve(prohibited).toLowerCase()
        if (cwdNormalized === prohibitedNormalized || cwdNormalized.startsWith(prohibitedNormalized + sep)) {
          errors.push(`session-cwd-prohibited:${id}=${prohibited}`)
        }
      }
    }
  }
  return errors
}
