import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { canonicalExistingPath, compareColdFacts, defaultWorkspaceIsolationErrors, degradedRpcBindingErrors, detailStepMatches, expectedDetailFields, freezeSessions, freezeTaskLedger, mountForbiddenErrors, mountSessionCwdErrors, observedExitErrors, parseConfigDumpEntries, pathWithinRoot, profileFromRunRoot, probeCoverageErrors, recoveredRpcBindingErrors, recoveredStateErrors, responseBindingErrors, rpcFailureBindingErrors, stalePreservationErrors, sourceField, workspaceControllerOverlayErrors } from '../scripts/lib/verify-web-paths.mjs'

const workspace = fileURLToPath(new URL('..', import.meta.url))
const buildRoot = join(workspace, 'test', 'build')

function matchingStep() {
  return {
    detailId: 'tsk-1',
    taskId: 'tsk-1',
    sourceText: 'source C: cnv-1',
    sourceId: 'cnv-1',
    logicalText: 'logical workspace: wsp-1',
    logical: 'wsp-1',
    nativeText: 'native workspace: nws-1',
    native: 'nws-1',
    directoryText: 'observed directory: E:\\Project\\Workspace-Organizer\\test\\build\\R\\ws-a',
    directory: 'E:\\Project\\Workspace-Organizer\\test\\build\\R\\ws-a',
    verifiedAtText: 'verifiedAt: 2026-10-23T05:17:08.078Z',
    verifiedAt: '2026-10-23T05:17:08.078Z',
    verificationText: 'verification: blocked',
    verification: 'blocked',
    sourceBlockedText: 'source blocked: source-archived',
    taskBlockedText: 'blocked: source/source-archived'
  }
}

const source = {
  conversationId: 'cnv-1',
  workspaceLogicalId: 'wsp-1',
  nativeWorkspaceId: 'nws-1',
  directory: 'E:\\Project\\Workspace-Organizer\\test\\build\\R\\ws-a',
  verifiedAt: '2026-10-23T05:17:08.078Z',
  verificationState: 'blocked',
  blockedReason: 'source-archived'
}
const task = { taskId: 'tsk-1', blockedReason: 'source/source-archived' }

test('expectedDetailFields mirrors client labels for values, unknown and blocked reasons', () => {
  assert.deepEqual(expectedDetailFields(source, task), {
    sourceId: 'cnv-1',
    logical: 'wsp-1',
    native: 'nws-1',
    directory: 'E:\\Project\\Workspace-Organizer\\test\\build\\R\\ws-a',
    verifiedAt: '2026-10-23T05:17:08.078Z',
    verification: 'blocked',
    sourceBlocked: 'source blocked: source-archived',
    taskBlocked: 'blocked: source/source-archived'
  })
  assert.deepEqual(expectedDetailFields(undefined, { taskId: 'tsk-2' }), {
    sourceId: 'unknown',
    logical: 'unknown',
    native: 'unknown',
    directory: 'unknown',
    verifiedAt: 'unknown',
    verification: 'unverified',
    sourceBlocked: 'unknown',
    taskBlocked: 'unknown'
  })
  assert.equal(sourceField(''), 'unknown')
  assert.equal(sourceField(0), '0')
})

test('detailStepMatches requires exact native/logical/verifiedAt/blocked values', () => {
  const step = matchingStep()
  assert.equal(detailStepMatches(step, source, task), true)
  // The previous `includes` assertions accepted all of these near-matches.
  const drift = [
    { native: 'nws-10', nativeText: 'native workspace: nws-10' },
    { logical: 'wsp-10', logicalText: 'logical workspace: wsp-10' },
    { verifiedAt: '2026-10-23T05:17:08.078Z0', verifiedAtText: 'verifiedAt: 2026-10-23T05:17:08.078Z0' },
    { sourceBlockedText: 'source blocked: source-archived-extra' },
    { taskBlockedText: 'blocked: source/source-archived-extra' },
    { verification: 'unverified', verificationText: 'verification: unverified' },
    { directory: 'E:\\Project\\Workspace-Organizer\\build\\R\\ws-a', directoryText: 'observed directory: E:\\Project\\Workspace-Organizer\\build\\R\\ws-a' }
  ]
  for (const change of drift) {
    const mutated = { ...step, ...change }
    assert.equal(detailStepMatches(mutated, source, task), false, JSON.stringify(change))
  }
})

test('detailStepMatches rejects missing fields instead of substituting unknown', () => {
  const step = matchingStep()
  for (const field of ['native', 'logical', 'verifiedAt', 'verification', 'sourceBlockedText', 'taskBlockedText']) {
    const missing = { ...step }
    delete missing[field]
    assert.equal(detailStepMatches(missing, source, task), false, field)
  }
})

test('canonicalExistingPath resolves a junction and keeps one canonical profile root', async () => {
  await mkdir(buildRoot, { recursive: true })
  const temp = await mkdtemp(join(buildRoot, 'verify-paths-'))
  try {
    const target = join(temp, 'real-run')
    const junction = join(temp, 'junction-run')
    await mkdir(join(target, 'ws-a'), { recursive: true })
    await symlink(target, junction, 'junction')
    const canonical = await canonicalExistingPath(junction)
    assert.equal(canonical, await realpath(target))
    assert.notEqual(canonical, junction)
    assert.equal(profileFromRunRoot(canonical, await canonicalExistingPath(buildRoot)), `c1web-${basename(temp).toLowerCase()}-real-run`)
    assert.equal(basename(canonical), 'real-run')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

function coldFixture() {
  return {
    ledger: {
      revision: 5,
      sources: [
        { conversationId: 'cnv-a', sessionId: 's1', workspaceLogicalId: 'wsp-1', nativeWorkspaceId: 'nws-1', directory: 'D:\\R\\ws-a', verifiedAt: '2026-10-23T00:00:00.000Z', verificationState: 'verified', hostVersion: '0.2.1' },
        { conversationId: 'cnv-b', sessionId: 's2', workspaceLogicalId: 'wsp-1', nativeWorkspaceId: 'nws-1', directory: 'D:\\R\\ws-a', verifiedAt: '2026-10-23T00:00:01.000Z', verificationState: 'blocked', blockedReason: 'source-archived', hostVersion: '0.2.1' }
      ],
      tasks: [
        { taskId: 't1', childSessionId: 'wo-t1', sourceConversationId: 'cnv-a', parent: { kind: 'conversation', conversationId: 'cnv-a' }, depth: 1, executionState: 'UNKNOWN' },
        { taskId: 't2', childSessionId: 'wo-t2', sourceConversationId: 'cnv-a', parent: { kind: 'task', taskId: 't1' }, depth: 2, executionState: 'UNKNOWN' },
        { taskId: 'u1', childSessionId: 'wo-u1', sourceConversationId: 'cnv-b', parent: { kind: 'conversation', conversationId: 'cnv-b' }, depth: 1, executionState: 'UNKNOWN', blockedReason: 'source/source-archived' }
      ]
    },
    tree: {
      revision: 4,
      nodes: [
        { id: 'root', kind: 'project', title: 'Root', parentId: null },
        { id: 'w', kind: 'workspace', title: 'W', parentId: 'root', directory: 'D:\\R\\ws-a', nativeWorkspaceId: 'nws-1' },
        { id: 'c1', kind: 'conversation', title: 'C1', parentId: 'w', sessionId: 's1', cwd: 'D:\\R\\ws-a' },
        { id: 'c2', kind: 'conversation', title: 'C2', parentId: 'w', sessionId: 's2', cwd: 'D:\\R\\ws-a' }
      ]
    },
    registry: { global: { workspaceIds: ['nws-1'], archivedSessionIds: ['s2'] }, tables: { workspaces: { 'nws-1': { path: 'D:\\R\\ws-a', title: 'A', sessionIds: ['s1', 's2'] } } } },
    sessions: {
      s1: { header: { id: 's1' }, inheritedEventCount: 2, events: [{ seq: 0 }, { seq: 1 }] },
      s2: { header: { id: 's2' }, inheritedEventCount: 1, events: [{ seq: 0 }] }
    }
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value))

test('compareColdFacts rejects revision, identity, source, tree and session drift', () => {
  const baseline = coldFixture()
  assert.deepEqual(compareColdFacts(baseline, clone(baseline)), [])
  assert.deepEqual(freezeTaskLedger(baseline.ledger), freezeTaskLedger(clone(baseline.ledger)))
  assert.deepEqual(freezeSessions(baseline.sessions), freezeSessions(clone(baseline.sessions)))

  const revision = clone(baseline)
  revision.ledger.revision = 6
  assert.ok(compareColdFacts(baseline, revision).includes('ledger-revision:5->6'))

  const parent = clone(baseline)
  parent.ledger.tasks[1].parent = { kind: 'conversation', conversationId: 'cnv-a' }
  assert.ok(compareColdFacts(baseline, parent).includes('task:wo-t2:parent'))

  const taskId = clone(baseline)
  taskId.ledger.tasks[1].taskId = 't9'
  assert.ok(compareColdFacts(baseline, taskId).includes('task:wo-t2:taskId'))

  const missing = clone(baseline)
  missing.ledger.tasks.pop()
  assert.ok(compareColdFacts(baseline, missing).includes('task-missing:wo-u1'))

  const resurrected = clone(baseline)
  resurrected.ledger.sources[1].verificationState = 'verified'
  resurrected.ledger.sources[1].blockedReason = null
  const sourceErrors = compareColdFacts(baseline, resurrected)
  assert.ok(sourceErrors.includes('source-resurrected:cnv-b'))
  assert.ok(sourceErrors.includes('source:cnv-b:verificationState'))

  const tree = clone(baseline)
  tree.tree.nodes = tree.tree.nodes.filter((node) => node.id !== 'c2')
  assert.ok(compareColdFacts(baseline, tree).includes('tree-missing:c2'))

  const session = clone(baseline)
  session.sessions.s1.events.push({ seq: 2 })
  assert.ok(compareColdFacts(baseline, session).includes('session-content:s1'))
})

test('probeCoverageErrors fails closed on missing probes and non-zero counters', () => {
  const probes = { agents: { present: true, methods: { resume: { typeof: 'function', wrapped: true } } } }
  const counts = { 'agents/resume': 0 }
  assert.deepEqual(probeCoverageErrors(probes, counts, ['agents/resume']), [])
  assert.deepEqual(probeCoverageErrors({}, counts, ['agents/resume']), ['probe-missing-service:agents'])
  assert.deepEqual(probeCoverageErrors(probes, {}, ['agents/resume']), ['count-missing:agents/resume'])
  assert.deepEqual(probeCoverageErrors({ agents: { present: true, methods: { resume: { typeof: 'function', wrapped: false } } } }, counts, ['agents/resume']), ['probe-unwrapped:agents/resume'])
  assert.deepEqual(probeCoverageErrors(probes, { 'agents/resume': 2 }, ['agents/resume']), ['count-nonzero:agents/resume=2'])
})

test('responseBindingErrors rejects warm page, wrong boot, stale response and missing result', () => {
  const record = { decision: 'accepted', pageId: 'page-cold', at: 200, result: { error: null } }
  const options = { pageId: 'page-cold', warmPageId: 'page-warm', bootId: 'boot-cold', coldBootId: 'boot-cold', startedAt: 100 }
  assert.deepEqual(responseBindingErrors(record, options), [])
  assert.ok(responseBindingErrors({ ...record, pageId: 'page-warm' }, options).includes('response-warm-page'))
  assert.ok(responseBindingErrors(record, { ...options, bootId: 'boot-old' }).includes('response-boot-mismatch'))
  assert.ok(responseBindingErrors({ ...record, at: 50 }, options).includes('response-before-cold-start'))
  assert.ok(responseBindingErrors({ ...record, decision: 'discarded' }, options).includes('response-not-accepted'))
  assert.ok(responseBindingErrors({ ...record, result: null }, options).includes('response-missing-result'))
  assert.ok(responseBindingErrors({ ...record, result: { error: 'boom' } }, options).includes('response-result-error'))
})

test('rpcFailureBindingErrors accepts only a same-page new accepted transport error', () => {
  const record = { id: 'rpc-2', method: 'taskLedger', input: {}, pageId: 'page-1', at: 200, generation: 2, decision: 'accepted', decisionExtra: { outcome: 'error' }, result: { error: 'Failed to fetch' } }
  const options = { pageId: 'page-1', previousIds: ['rpc-1'], minGeneration: 1, hostStoppedAt: 100 }
  assert.deepEqual(rpcFailureBindingErrors(record, options), [])
  assert.ok(rpcFailureBindingErrors({ ...record, pageId: 'page-2' }, options).includes('rpc-error-page-mismatch'))
  assert.ok(rpcFailureBindingErrors({ ...record, id: 'rpc-1' }, options).includes('rpc-error-old-request'))
  assert.ok(rpcFailureBindingErrors({ ...record, generation: 1 }, options).includes('rpc-error-generation'))
  assert.ok(rpcFailureBindingErrors({ ...record, at: 50 }, options).includes('rpc-error-before-host-stop'))
  assert.ok(rpcFailureBindingErrors({ ...record, decision: 'discarded' }, options).includes('rpc-error-discarded'))
  assert.ok(rpcFailureBindingErrors({ ...record, decision: 'accepted', decisionExtra: { outcome: 'success' } }, options).includes('rpc-error-decision-outcome'))
  assert.ok(rpcFailureBindingErrors({ ...record, result: { error: '' } }, options).includes('rpc-error-result-error'))
  assert.ok(rpcFailureBindingErrors({ ...record, result: { decoded: { revision: 5 } } }, options).includes('rpc-error-decoded'))
  assert.ok(rpcFailureBindingErrors({ ...record, method: 'reconcileTasks' }, options).includes('rpc-error-method'))
  assert.ok(rpcFailureBindingErrors({ ...record, input: { sourceId: 's' } }, options).includes('rpc-error-source-scoped'))
})

test('degradedRpcBindingErrors accepts only a same-page new accepted degraded transport error', () => {
  const record = { id: 'rpc-2', method: 'taskLedger', input: {}, pageId: 'page-1', at: 200, generation: 2, decision: 'accepted', decisionExtra: { outcome: 'error' }, result: { error: 'Failed to fetch' } }
  const options = { pageId: 'page-1', minGeneration: 1, degradedAt: 100, previousIds: ['rpc-1'] }
  assert.deepEqual(degradedRpcBindingErrors(record, options), [])
  assert.ok(degradedRpcBindingErrors(null, options).includes('degraded-rpc-response-missing'))
  assert.ok(degradedRpcBindingErrors({ ...record, pageId: 'page-2' }, options).includes('degraded-rpc-page-mismatch'))
  assert.ok(degradedRpcBindingErrors({ ...record, id: 'rpc-1' }, options).includes('degraded-rpc-old-request'))
  assert.ok(degradedRpcBindingErrors({ ...record, generation: 1 }, options).includes('degraded-rpc-generation'))
  assert.ok(degradedRpcBindingErrors({ ...record, at: 50 }, options).includes('degraded-rpc-before-degradation'))
  assert.ok(degradedRpcBindingErrors({ ...record, decision: 'discarded' }, options).includes('degraded-rpc-discarded'))
  assert.ok(degradedRpcBindingErrors({ ...record, decision: 'pending' }, options).includes('degraded-rpc-not-accepted'))
  assert.ok(degradedRpcBindingErrors({ ...record, decision: 'accepted', decisionExtra: { outcome: 'success' } }, options).includes('degraded-rpc-decision-outcome'))
  assert.ok(degradedRpcBindingErrors({ ...record, result: { error: '' } }, options).includes('degraded-rpc-result-error'))
  assert.ok(degradedRpcBindingErrors({ ...record, result: { decoded: { revision: 5 } } }, options).includes('degraded-rpc-decoded'))
  assert.ok(degradedRpcBindingErrors({ ...record, method: 'reconcileTasks' }, options).includes('degraded-rpc-method'))
  assert.ok(degradedRpcBindingErrors({ ...record, input: { sourceId: 's' } }, options).includes('degraded-rpc-source-scoped'))
})

test('recoveredRpcBindingErrors accepts only a same-page new accepted success retry response', () => {
  const expectedLedger = { revision: 5, tasks: [] }
  const record = { id: 'rpc-3', method: 'taskLedger', input: {}, pageId: 'page-1', at: 300, generation: 3, decision: 'accepted', decisionExtra: { outcome: 'success' }, result: { decoded: expectedLedger, error: null } }
  const options = { pageId: 'page-1', failedGeneration: 2, retryAt: 250, previousIds: ['rpc-1', 'rpc-2'], expectedLedger }
  assert.deepEqual(recoveredRpcBindingErrors(record, options), [])
  assert.ok(recoveredRpcBindingErrors(null, options).includes('recovered-rpc-response-missing'))
  assert.ok(recoveredRpcBindingErrors({ ...record, pageId: 'page-2' }, options).includes('recovered-rpc-page-mismatch'))
  assert.ok(recoveredRpcBindingErrors({ ...record, id: 'rpc-2' }, options).includes('recovered-rpc-old-request'))
  assert.ok(recoveredRpcBindingErrors({ ...record, generation: 2 }, options).includes('recovered-rpc-generation'))
  assert.ok(recoveredRpcBindingErrors({ ...record, at: 200 }, options).includes('recovered-rpc-before-retry'))
  assert.ok(recoveredRpcBindingErrors({ ...record, decision: 'discarded' }, options).includes('recovered-rpc-discarded'))
  assert.ok(recoveredRpcBindingErrors({ ...record, decision: 'pending' }, options).includes('recovered-rpc-not-accepted'))
  assert.ok(recoveredRpcBindingErrors({ ...record, decisionExtra: { outcome: 'error' } }, options).includes('recovered-rpc-decision-outcome'))
  assert.ok(recoveredRpcBindingErrors({ ...record, result: { ...record.result, error: 'boom' } }, options).includes('recovered-rpc-result-error'))
  assert.ok(recoveredRpcBindingErrors({ ...record, result: { error: null } }, options).includes('recovered-rpc-decoded-missing'))
  assert.ok(recoveredRpcBindingErrors({ ...record, result: { decoded: { revision: 6, tasks: [] }, error: null } }, options).includes('recovered-rpc-decoded-mismatch'))
  assert.ok(recoveredRpcBindingErrors({ ...record, method: 'reconcileTasks' }, options).includes('recovered-rpc-method'))
  assert.ok(recoveredRpcBindingErrors({ ...record, input: { sourceId: 's' } }, options).includes('recovered-rpc-source-scoped'))
})

test('recoveredStateErrors verifies restored ready status, cleared error/stale and preserved detail', () => {
  const beforeDetail = matchingStep()
  const afterDetail = clone(beforeDetail)
  const state = {
    status: 'Tasks ledger: ready (rev 5)',
    error: null,
    stale: null,
    rows: ['a', 'b', 'c', 'd'],
    detailId: 'tsk-1',
    sourceStale: 'last observed source facts only',
    sourceStaleAttr: 'false'
  }
  const expectedRows = ['a', 'b', 'c', 'd']
  assert.deepEqual(recoveredStateErrors({ state, beforeDetail, afterDetail, source, task, expectedRows, revision: 5 }), [])
  assert.ok(recoveredStateErrors(null).includes('recovered-state-missing'))
  assert.ok(recoveredStateErrors({ state: { ...state, status: 'Tasks ledger: error (rev 5)' }, beforeDetail, afterDetail, source, task, expectedRows, revision: 5 }).includes('recovered-status-not-ready'))
  assert.ok(recoveredStateErrors({ state: { ...state, status: 'Tasks ledger: ready (rev 6)' }, beforeDetail, afterDetail, source, task, expectedRows, revision: 5 }).includes('recovered-status-revision'))
  assert.ok(recoveredStateErrors({ state: { ...state, error: 'some error' }, beforeDetail, afterDetail, source, task, expectedRows, revision: 5 }).includes('recovered-error-persisted'))
  assert.ok(recoveredStateErrors({ state: { ...state, stale: 'stale text' }, beforeDetail, afterDetail, source, task, expectedRows, revision: 5 }).includes('recovered-stale-persisted'))
  assert.ok(recoveredStateErrors({ state: { ...state, sourceStaleAttr: 'true' }, beforeDetail, afterDetail, source, task, expectedRows, revision: 5 }).includes('recovered-source-stale-attr'))
  assert.ok(recoveredStateErrors({ state: { ...state, sourceStale: 'last observed source facts; stale' }, beforeDetail, afterDetail, source, task, expectedRows, revision: 5 }).includes('recovered-source-stale-text'))
  assert.ok(recoveredStateErrors({ state: { ...state, rows: ['a', 'b'] }, beforeDetail, afterDetail, source, task, expectedRows, revision: 5 }).includes('recovered-rows-count'))
  assert.ok(recoveredStateErrors({ state: { ...state, rows: ['a', 'b', 'c', 'e'] }, beforeDetail, afterDetail, source, task, expectedRows, revision: 5 }).includes('recovered-rows-mismatch'))
  assert.ok(recoveredStateErrors({ state: { ...state, detailId: 'other' }, beforeDetail, afterDetail, source, task, expectedRows, revision: 5 }).includes('recovered-selected-detail'))
  assert.ok(recoveredStateErrors({ state, beforeDetail, afterDetail: { ...afterDetail, native: 'other', nativeText: 'native workspace: other' }, source, task, expectedRows, revision: 5 }).includes('recovered-detail-changed:native'))
})

test('stalePreservationErrors rejects missing stale, field drift, reason mixing and revision advance', () => {
  const before = matchingStep()
  const after = clone(before)
  const state = {
    status: 'Tasks ledger: error (rev 5)',
    error: 'Failed to fetch',
    stale: 'Showing last observed ledger; request failed (stale)',
    rows: ['a', 'b', 'c', 'd'],
    detailId: 'tsk-1',
    sourceStale: 'last observed source facts; stale',
    sourceStaleAttr: 'true'
  }
  const record = { result: { error: 'Failed to fetch' } }
  assert.deepEqual(stalePreservationErrors({ before, after, source, task, state, record, revision: 5 }), [])
  assert.ok(stalePreservationErrors({ before, after, source, task, state: { ...state, stale: null }, record, revision: 5 }).includes('stale-marker-missing'))
  assert.ok(stalePreservationErrors({ before, after, source, task, state: { ...state, sourceStaleAttr: 'false' }, record, revision: 5 }).includes('stale-source-attr'))
  assert.ok(stalePreservationErrors({ before, after, source, task, state: { ...state, error: 'boom' }, record, revision: 5 }).includes('stale-error-mismatch'))
  assert.ok(stalePreservationErrors({ before, after, source, task, state: { ...state, status: 'Tasks ledger: ready (rev 5)' }, record, revision: 5 }).includes('stale-status'))
  assert.ok(stalePreservationErrors({ before, after, source, task, state: { ...state, status: 'Tasks ledger: error (rev 6)' }, record, revision: 5 }).includes('stale-status-revision'))
  assert.ok(stalePreservationErrors({ before, after, source, task, state: { ...state, rows: ['a'] }, record, revision: 5 }).includes('stale-rows'))
  assert.ok(stalePreservationErrors({ before, after, source, task, state: { ...state, detailId: 'other' }, record, revision: 5 }).includes('stale-selected-detail'))
  assert.ok(stalePreservationErrors({ before, after: { ...after, native: 'nws-9', nativeText: 'native workspace: nws-9' }, source, task, state, record, revision: 5 }).includes('stale-detail-changed:native'))
  assert.ok(stalePreservationErrors({ before, after: { ...after, taskBlockedText: 'source blocked: source-archived' }, source, task, state, record, revision: 5 }).some((error) => error.startsWith('stale-detail-changed:')))
})

test('observedExitErrors rejects missing, unobserved, timed-out and surviving exits', () => {
  const exits = [
    { label: 'rpc-error-host', observed: true, timedOut: false, aliveAfter: false },
    { label: 'rpc-error-browser', observed: true, timedOut: false, aliveAfter: false }
  ]
  assert.deepEqual(observedExitErrors(exits, { min: 2, requireLabels: ['rpc-error-host', 'rpc-error-browser'] }), [])
  assert.ok(observedExitErrors([], { min: 2, requireLabels: ['rpc-error-host'] }).includes('exit-count:0'))
  assert.ok(observedExitErrors([exits[1]], { min: 2, requireLabels: ['rpc-error-host'] }).includes('exit-missing:rpc-error-host'))
  assert.ok(observedExitErrors([{ ...exits[0], observed: false }, exits[1]], { min: 2 }).includes('exit-unobserved:rpc-error-host'))
  assert.ok(observedExitErrors([{ ...exits[0], timedOut: true }, exits[1]], { min: 2 }).includes('exit-timeout:rpc-error-host'))
  assert.ok(observedExitErrors([{ ...exits[0], aliveAfter: true }, exits[1]], { min: 2 }).includes('exit-residual:rpc-error-host'))
})

test('parseConfigDumpEntries and workspaceControllerOverlayErrors validate composed overlay and reject invalid shapes', () => {
  const dump = [
    '# == @deepseek-ai/dsh-base',
    '- id: timer',
    "  name: '@deepseek-ai/cordis-plugin-timer'",
    '# == @deepseek-ai/dsh-web-app, patched by loader-overlay.yml',
    '- id: workspace-controller',
    "  name: '@deepseek-ai/dsh-api-workspace-controller'",
    '  config:',
    '    documentsDirectory: E:/Project/Workspace-Organizer/test/R/documents',
    '    documentsLookupTimeoutMs: 10000',
    '- id: cordis-host-runner',
    "  name: '@deepseek-ai/dsh-cordis-host-runner'"
  ].join('\n')

  const parsed = parseConfigDumpEntries(dump)
  assert.equal(parsed.length, 3)
  assert.equal(parsed[1].id, 'workspace-controller')
  assert.equal(parsed[1].name, '@deepseek-ai/dsh-api-workspace-controller')
  assert.equal(parsed[1].config.documentsDirectory, 'E:/Project/Workspace-Organizer/test/R/documents')
  assert.equal(parsed[1].config.documentsLookupTimeoutMs, 10000)

  const expected = {
    documentsDirectory: 'E:/Project/Workspace-Organizer/test/R/documents',
    documentsLookupTimeoutMs: 10000
  }
  assert.deepEqual(workspaceControllerOverlayErrors(parsed, expected), [])

  // Missing entry
  assert.ok(workspaceControllerOverlayErrors([parsed[0]], expected).includes('overlay-missing:workspace-controller'))

  // Duplicate entry
  assert.ok(workspaceControllerOverlayErrors([parsed[1], parsed[1]], expected).some((e) => e.startsWith('overlay-duplicate:')))

  // Name mismatch
  assert.ok(workspaceControllerOverlayErrors([{ ...parsed[1], name: '@other/pkg' }], expected).some((e) => e.startsWith('overlay-name-mismatch:')))

  // Config missing
  assert.ok(workspaceControllerOverlayErrors([{ id: 'workspace-controller', name: '@deepseek-ai/dsh-api-workspace-controller' }], expected).includes('overlay-config-missing'))

  // Directory mismatch
  assert.ok(workspaceControllerOverlayErrors([{ ...parsed[1], config: { ...parsed[1].config, documentsDirectory: 'C:/other' } }], expected).some((e) => e.startsWith('overlay-documents-directory-mismatch:')))

  // Timeout mismatch
  assert.ok(workspaceControllerOverlayErrors([{ ...parsed[1], config: { ...parsed[1].config, documentsLookupTimeoutMs: 5000 } }], expected).some((e) => e.startsWith('overlay-timeout-mismatch:')))

  // Folded multi-line YAML scalar test (dsh dump wraps long strings with >-)
  const foldedDump = [
    '- id: workspace-controller',
    "  name: '@deepseek-ai/dsh-api-workspace-controller'",
    '  config:',
    '    documentsDirectory: >-',
    '      E:/Project/Workspace-Organizer/test/R/documents',
    '    documentsLookupTimeoutMs: 10000'
  ].join('\n')
  const foldedParsed = parseConfigDumpEntries(foldedDump)
  assert.equal(foldedParsed[0].config.documentsDirectory, 'E:/Project/Workspace-Organizer/test/R/documents')
  assert.equal(foldedParsed[0].config.documentsLookupTimeoutMs, 10000)
  assert.deepEqual(workspaceControllerOverlayErrors(foldedParsed, expected), [])
})

test('defaultWorkspaceIsolationErrors accepts valid isolated default workspace and rejects external paths, pre-existing records, and escapes', () => {
  const runRoot = 'E:\\Project\\Workspace-Organizer\\test\\R'
  const expectedDocumentsDir = 'E:\\Project\\Workspace-Organizer\\test\\R\\documents'
  const expectedDefaultPath = 'E:\\Project\\Workspace-Organizer\\test\\R\\documents\\deepseek-harness\\default-workspace'
  const prohibitedPaths = ['C:\\Users\\Shake\\Documents']

  const validActual = {
    before: { defaultWorkspaceId: null, workspaces: [] },
    result: {
      workspace: {
        workspaceId: 'ws-def-1',
        path: expectedDefaultPath,
        title: 'default-workspace',
        sessionIds: [],
        createdAt: '2026-10-24T08:00:00.000Z',
        updatedAt: '2026-10-24T08:00:00.000Z'
      }
    },
    after: {
      defaultWorkspaceId: 'ws-def-1',
      workspaces: [
        {
          id: 'ws-def-1',
          path: expectedDefaultPath,
          title: 'default-workspace',
          sessionIds: []
        }
      ]
    },
    resolvedPath: expectedDefaultPath,
    ancestorPaths: [expectedDocumentsDir, join(expectedDocumentsDir, 'deepseek-harness')]
  }

  const expected = { runRoot, expectedDocumentsDir, expectedDefaultPath, prohibitedPaths }

  assert.deepEqual(defaultWorkspaceIsolationErrors(validActual, expected), [])

  // Pre-existing default
  assert.ok(defaultWorkspaceIsolationErrors({ ...validActual, before: { defaultWorkspaceId: 'old-1', workspaces: [{ id: 'old-1' }] } }, expected).some((e) => e.startsWith('pre-existing-default-workspace-id:')))

  // Result missing
  assert.ok(defaultWorkspaceIsolationErrors({ ...validActual, result: null }, expected).includes('initialize-default-result-missing'))

  // Path mismatch
  assert.ok(defaultWorkspaceIsolationErrors({ ...validActual, result: { workspace: { ...validActual.result.workspace, path: 'E:\\Project\\other' } } }, expected).some((e) => e.startsWith('workspace-path-mismatch:')))

  // Path escapes run root
  assert.ok(defaultWorkspaceIsolationErrors({ ...validActual, result: { workspace: { ...validActual.result.workspace, path: 'C:\\Users\\Shake\\Documents\\deepseek-harness\\default-workspace' } } }, expected).some((e) => e.startsWith('workspace-path-escape-run-root:')))

  // Path matches prohibited
  assert.ok(defaultWorkspaceIsolationErrors({ ...validActual, result: { workspace: { ...validActual.result.workspace, path: 'C:\\Users\\Shake\\Documents\\default' } } }, { ...expected, expectedDefaultPath: 'C:\\Users\\Shake\\Documents\\default' }).some((e) => e.startsWith('workspace-path-prohibited-match:')))

  // Registry after missing record
  assert.ok(defaultWorkspaceIsolationErrors({ ...validActual, after: { defaultWorkspaceId: 'ws-def-1', workspaces: [] } }, expected).includes('registry-default-record-missing'))

  // Registry default ID mismatch
  assert.ok(defaultWorkspaceIsolationErrors({ ...validActual, after: { defaultWorkspaceId: 'ws-other', workspaces: validActual.after.workspaces } }, expected).some((e) => e.startsWith('registry-default-id-mismatch:')))

  // Resolved path escape
  assert.ok(defaultWorkspaceIsolationErrors({ ...validActual, resolvedPath: 'C:\\escaped\\path' }, expected).some((e) => e.startsWith('resolved-path-escape:')))

  // Ancestor path escape
  assert.ok(defaultWorkspaceIsolationErrors({ ...validActual, ancestorPaths: ['C:\\escaped\\ancestor'] }, expected).some((e) => e.startsWith('ancestor-path-escape:')))
})

test('mountForbiddenErrors and mountSessionCwdErrors validate mount baseline and session paths', () => {
  const forbidden = ['sessionController/follow', 'sessionController/create', 'sessions/create']
  const baseline = { 'sessionController/follow': 0, 'sessionController/create': 0, 'sessions/create': 0 }

  // Clean mount: no increment
  assert.deepEqual(mountForbiddenErrors(baseline, { ...baseline }, forbidden), [])

  // Forbidden increment
  const dirty = { ...baseline, 'sessionController/follow': 1 }
  assert.deepEqual(mountForbiddenErrors(baseline, dirty, forbidden), ['forbidden-increment:sessionController/follow=+1'])

  // Session CWD validation
  const runRoot = 'E:\\Project\\Workspace-Organizer\\test\\R'
  const expectedCwd = 'E:\\Project\\Workspace-Organizer\\test\\R\\documents\\deepseek-harness\\default-workspace'
  const prohibitedPaths = ['C:\\Users\\Shake\\Documents']

  // Clean session
  const cleanSessions = {
    'sess-1': { cwd: expectedCwd, header: { cwd: expectedCwd } }
  }
  assert.deepEqual(mountSessionCwdErrors(cleanSessions, expectedCwd, runRoot, prohibitedPaths), [])

  // Missing CWD
  assert.deepEqual(mountSessionCwdErrors({ 'sess-2': {} }, expectedCwd, runRoot, prohibitedPaths), ['session-cwd-missing:sess-2'])

  // CWD mismatch
  assert.ok(mountSessionCwdErrors({ 'sess-3': { cwd: 'E:\\Project\\Workspace-Organizer\\test\\R\\other' } }, expectedCwd, runRoot, prohibitedPaths).some((e) => e.startsWith('session-cwd-mismatch:')))

  // CWD escape
  assert.ok(mountSessionCwdErrors({ 'sess-4': { cwd: 'C:\\escaped\\sess' } }, expectedCwd, runRoot, prohibitedPaths).some((e) => e.startsWith('session-cwd-escape:')))

  // Prohibited path match
  assert.ok(mountSessionCwdErrors({ 'sess-5': { cwd: 'C:\\Users\\Shake\\Documents\\default' } }, 'C:\\Users\\Shake\\Documents\\default', 'C:\\', prohibitedPaths).some((e) => e.startsWith('session-cwd-prohibited:')))
})
