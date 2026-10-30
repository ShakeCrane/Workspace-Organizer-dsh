import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authoritativePersistenceErrors,
  errorRecord,
  errorShapeErrors,
  fixtureManifestErrors,
  fourTaskLedgerErrors,
  ledgerFacts,
  ledgerStabilityErrors,
  overlaySourceErrors,
  pathWithinRoot,
  projectionCheckpointErrors,
  sourceReadinessErrors,
  summarizeReadSession,
  webLedgerExecutionErrors,
  webPanelPreservationErrors,
  webRefreshBindingErrors
} from '../scripts/lib/c3a-live-session-b-fixture.mjs'

const ledger = {
  revision: 5,
  sources: [
    { conversationId: 'cnv-s', sessionId: 'real-b-source', workspaceLogicalId: 'wsp', directory: 'D:\\R\\ws-b', nativeWorkspaceId: 'nws', verifiedAt: '2026-10-24T00:00:00.000Z', verificationState: 'verified' }
  ],
  tasks: [
    { taskId: 'tsk-b', childSessionId: 'real-b-child', sourceConversationId: 'cnv-s', parent: { kind: 'conversation', conversationId: 'cnv-s' }, depth: 1, executionState: 'UNKNOWN' }
  ]
}

test('live B error shapes accept only the expected raw failures', () => {
  assert.deepEqual(errorShapeErrors('read-session', { code: 'SESSION_QUERY_SESSION_NOT_FOUND', message: 'session "real-b-source" not found' }), [])
  assert.ok(errorShapeErrors('read-session', { code: 'OTHER', message: 'x' }).includes('read-session-code'))
  assert.ok(errorShapeErrors('read-session', null).includes('read-session-missing'))

  assert.deepEqual(errorShapeErrors('list-descendants', { code: 'SESSION_QUERY_SESSION_NOT_FOUND', message: 'session not found' }), [])
  assert.ok(errorShapeErrors('list-descendants', { code: '', message: 'x' }).includes('list-descendants-code'))

  const reconcile = { code: 'task/unavailable', message: 'subagent catalog read failed', details: { service: 'subagents.listDescendants', cause: 'session not found' } }
  assert.deepEqual(errorShapeErrors('reconcile', reconcile), [])
  assert.ok(errorShapeErrors('reconcile', { ...reconcile, code: 'task/conflict' }).includes('reconcile-code'))
  assert.ok(errorShapeErrors('reconcile', { ...reconcile, message: 'other' }).includes('reconcile-message'))
  assert.ok(errorShapeErrors('reconcile', { ...reconcile, details: { service: 'other', cause: 'x' } }).includes('reconcile-service'))
  assert.ok(errorShapeErrors('reconcile', { ...reconcile, details: { service: 'subagents.listDescendants', cause: '' } }).includes('reconcile-cause'))
})

test('errorRecord preserves code/details/cause without serializing object graphs', () => {
  const cause = new Error('session not found')
  const error = Object.assign(new Error('subagent catalog read failed'), {
    name: 'OrganizerError',
    code: 'task/unavailable',
    details: { service: 'subagents.listDescendants', cause: cause.message }
  })
  const record = errorRecord(error)
  assert.equal(record.name, 'OrganizerError')
  assert.equal(record.code, 'task/unavailable')
  assert.equal(record.details.service, 'subagents.listDescendants')
  assert.equal(record.details.cause, 'session not found')
  assert.equal(record.cause, null)
})

test('ledgerFacts and ledgerStabilityErrors detect revision and identity drift', () => {
  const before = ledgerFacts(ledger)
  assert.equal(before.revision, 5)
  assert.equal(before.sources[0].sessionId, 'real-b-source')
  assert.equal(before.tasks[0].childSessionId, 'real-b-child')
  assert.deepEqual(ledgerStabilityErrors(ledger, JSON.parse(JSON.stringify(ledger))), [])
  const revision = JSON.parse(JSON.stringify(ledger)); revision.revision = 6
  assert.ok(ledgerStabilityErrors(ledger, revision).includes('ledger-changed'))
  const task = JSON.parse(JSON.stringify(ledger)); task.tasks[0].depth = 2
  assert.ok(ledgerStabilityErrors(ledger, task).includes('ledger-changed'))
  const source = JSON.parse(JSON.stringify(ledger)); source.sources[0].verificationState = 'blocked'
  assert.ok(ledgerStabilityErrors(ledger, source).includes('ledger-changed'))
})

test('fourTaskLedgerErrors validates 4-task tree structure and rejects invalid shapes', () => {
  const valid4Tasks = {
    revision: 10,
    sources: [
      { conversationId: 'c-a', sessionId: 'real-a-source' },
      { conversationId: 'c-b', sessionId: 'real-b-source' }
    ],
    tasks: [
      { taskId: 't1', childSessionId: 'real-a-t1', depth: 1, parent: { kind: 'conversation', conversationId: 'c-a' } },
      { taskId: 't2', childSessionId: 'real-a-t2', depth: 2, parent: { kind: 'task', taskId: 't1' } },
      { taskId: 't3', childSessionId: 'real-a-t3', depth: 2, parent: { kind: 'task', taskId: 't1' } },
      { taskId: 'u1', childSessionId: 'real-b-child', depth: 1, parent: { kind: 'conversation', conversationId: 'c-b' } }
    ]
  }
  assert.deepEqual(fourTaskLedgerErrors(valid4Tasks), [])
  assert.ok(fourTaskLedgerErrors(null).includes('four-tasks-ledger-missing'))
  assert.ok(fourTaskLedgerErrors({ ...valid4Tasks, sources: [valid4Tasks.sources[0]] }).includes('four-tasks-sources-count'))
  assert.ok(fourTaskLedgerErrors({ ...valid4Tasks, tasks: valid4Tasks.tasks.slice(0, 3) }).includes('four-tasks-count:3'))
  assert.ok(fourTaskLedgerErrors({ ...valid4Tasks, tasks: [{ ...valid4Tasks.tasks[0], depth: 2 }, ...valid4Tasks.tasks.slice(1)] }).includes('four-tasks-t1-depth'))
  assert.ok(fourTaskLedgerErrors({ ...valid4Tasks, tasks: [valid4Tasks.tasks[0], { ...valid4Tasks.tasks[1], depth: 1 }, valid4Tasks.tasks[2], valid4Tasks.tasks[3]] }).includes('four-tasks-t2-parent'))
  assert.ok(fourTaskLedgerErrors({ ...valid4Tasks, tasks: [valid4Tasks.tasks[0], valid4Tasks.tasks[1], { ...valid4Tasks.tasks[2], parent: { kind: 'task', taskId: 'other' } }, valid4Tasks.tasks[3]] }).includes('four-tasks-t3-parent'))
  assert.ok(fourTaskLedgerErrors({ ...valid4Tasks, tasks: [valid4Tasks.tasks[0], valid4Tasks.tasks[1], valid4Tasks.tasks[2], { ...valid4Tasks.tasks[3], depth: 2 }] }).includes('four-tasks-u1-depth'))
})

test('authoritativePersistenceErrors rejects stat/list copies and interface failures', () => {
  const clean = { statSource: { ok: true, value: null }, statChild: { ok: true, value: null }, list: { ok: true, ids: [] }, sourceId: 'real-b-source', childId: 'real-b-child' }
  assert.deepEqual(authoritativePersistenceErrors(clean), [])
  assert.ok(authoritativePersistenceErrors({ ...clean, statSource: { ok: true, value: { id: 'real-b-source' } } }).includes('stat-source-copy'))
  assert.ok(authoritativePersistenceErrors({ ...clean, statChild: { ok: true, value: { id: 'real-b-child' } } }).includes('stat-child-copy'))
  assert.ok(authoritativePersistenceErrors({ ...clean, list: { ok: true, ids: ['real-b-child'] } }).includes('list-copy'))
  assert.ok(authoritativePersistenceErrors({ ...clean, statSource: { ok: false, error: { code: 'EPERM' } } }).includes('stat-source-unavailable'))
  assert.ok(authoritativePersistenceErrors({ ...clean, list: { ok: false, error: { code: 'EPERM' } } }).includes('list-unavailable'))
})

test('projectionCheckpointErrors accepts valid cache checkpoints and rejects read/shape/path failures', () => {
  const valid = { root: 'D:\\run\\real-b-R\\projection', files: [{ name: 'real-b-source.json', insideRoot: true, sha256: 'abc', version: 7 }], readError: null }
  assert.deepEqual(projectionCheckpointErrors(valid), [])
  assert.ok(projectionCheckpointErrors({ ...valid, readError: { code: 'EACCES' } }).includes('projection-read'))
  assert.ok(projectionCheckpointErrors({ ...valid, files: [{ name: 'escape.json', insideRoot: false }] }).some((error) => error.startsWith('projection-path-escape:')))
  assert.ok(projectionCheckpointErrors({ ...valid, files: [{ name: 'bad.json', insideRoot: true, error: { code: 'EACCES' } }] }).some((error) => error.startsWith('projection-file-read:')))
  assert.ok(projectionCheckpointErrors({ ...valid, files: [{ name: 'unknown.json', insideRoot: true, shapeError: 'unknown-checkpoint-shape' }] }).some((error) => error.startsWith('projection-shape:')))
})

test('pathWithinRoot accepts the root itself and rejects sibling/outside paths', () => {
  assert.equal(pathWithinRoot('D:\\run\\real-b-R\\ws-b', 'D:\\run\\real-b-R'), true)
  assert.equal(pathWithinRoot('D:\\run\\real-b-R', 'D:\\run\\real-b-R'), true)
  assert.equal(pathWithinRoot('D:\\run\\real-b-R2\\ws-b', 'D:\\run\\real-b-R'), false)
  assert.equal(pathWithinRoot('D:\\run\\other', 'D:\\run\\real-b-R'), false)
})

test('summarizeReadSession exposes header and event count only', () => {
  const summary = summarizeReadSession({ session: { id: 'real-b-source', cwd: 'D:\\run\\real-b-R\\ws-b', origin: undefined, parentSession: undefined, delegationDepth: undefined }, events: [{}, {}] })
  assert.deepEqual(summary, { hasSession: true, id: 'real-b-source', cwd: 'D:\\run\\real-b-R\\ws-b', origin: null, parentSession: null, delegationDepth: null, eventCount: 2 })
})

test('overlaySourceErrors rejects original live, pinned drift, duplicate source and graph duplication', () => {
  const original = { id: 'include:workspace-organizer', name: 'workspace-organizer-dsh', effectiveDisabled: true }
  const pinned = { id: 'include:wo-test-pinned-organizer', name: 'file:///R/profile/node_modules/workspace-organizer-dsh/dist/index.js', effectiveDisabled: false }
  const graph = { entries: [{ id: 'workspace-organizer-dsh' }], batches: [{ entries: ['workspace-organizer-dsh'] }] }
  assert.deepEqual(overlaySourceErrors({ loaderEntries: [original, pinned], pinnedName: pinned.name, graph }), [])
  assert.ok(overlaySourceErrors({ loaderEntries: [{ ...original, effectiveDisabled: false }, pinned], pinnedName: pinned.name, graph }).includes('overlay-original-row'))
  assert.ok(overlaySourceErrors({ loaderEntries: [original, { ...pinned, name: 'wrong' }], pinnedName: pinned.name, graph }).includes('overlay-pinned-row'))
  assert.ok(overlaySourceErrors({ loaderEntries: [original, pinned, { ...pinned, id: 'extra', name: pinned.name }], pinnedName: pinned.name, graph }).includes('overlay-live-count'))
  assert.ok(overlaySourceErrors({ loaderEntries: [original, pinned], pinnedName: pinned.name, graph: { entries: [], batches: [] } }).includes('overlay-graph-entry'))
})

test('sourceReadinessErrors rejects artifact/combo mismatch, missing request and uninstrumented execution', () => {
  const baseline = { path: 'E:\\run\\client\\client.js' }
  const artifact = { path: baseline.path, sha256: 'a'.repeat(64), sizeMatchesBaseline: true, mtimeMatchesBaseline: true, ctimeMatchesBaseline: true, instrumented: true }
  const graph = { entries: [{ id: 'workspace-organizer-dsh' }], batches: [{ entries: ['workspace-organizer-dsh'] }] }
  const combo = { containsArtifact: true, instrumented: true, sha256: 'b'.repeat(64), executionRequestId: 'r1', refetchRequestIds: [] }
  const requests = [{ requestId: 'r1', status: 200, bodySha256: 'b'.repeat(64) }]
  assert.deepEqual(sourceReadinessErrors({ baseline, artifact, graph, combo, requests, executionRequestId: 'r1' }), [])
  assert.ok(sourceReadinessErrors({ baseline, artifact: { ...artifact, instrumented: false }, graph, combo, requests, executionRequestId: 'r1' }).includes('readiness-artifact-instrumentation'))
  assert.ok(sourceReadinessErrors({ baseline, artifact: { ...artifact, path: 'other' }, graph, combo, requests, executionRequestId: 'r1' }).includes('readiness-artifact-path'))
  assert.ok(sourceReadinessErrors({ baseline, artifact, graph, combo: { ...combo, containsArtifact: false }, requests, executionRequestId: 'r1' }).includes('readiness-combo-artifact'))
  assert.ok(sourceReadinessErrors({ baseline, artifact, graph, combo: { ...combo, instrumented: false }, requests, executionRequestId: 'r1' }).includes('readiness-combo-instrumentation'))
  assert.ok(sourceReadinessErrors({ baseline, artifact, graph, combo, requests: [], executionRequestId: 'r1' }).includes('readiness-no-execution-request'))
  assert.ok(sourceReadinessErrors({ baseline, artifact, graph, combo, requests, executionRequestId: 'r2' }).includes('readiness-execution-request'))
  assert.ok(sourceReadinessErrors({ baseline, artifact, graph, combo, requests: [{ ...requests[0], bodySha256: 'c'.repeat(64) }], executionRequestId: 'r1' }).includes('readiness-execution-body'))
  assert.ok(sourceReadinessErrors({ baseline, artifact, graph: { entries: [], batches: [] }, combo, requests, executionRequestId: 'r1' }).includes('readiness-graph-entry'))
})
test('webRefreshBindingErrors rejects wrong page/source/generation, discarded and missing raw error', () => {
  const record = { id: 'rpc-2', method: 'reconcileTasks', input: { conversationId: 'cnv-s' }, pageId: 'p', generation: 2, at: 200, decision: 'accepted', decisionExtra: { outcome: 'error' }, result: { error: 'subagent catalog read failed' } }
  const options = { pageId: 'p', sourceId: 'cnv-s', baselineGeneration: 1, refreshAt: 100, previousIds: ['rpc-1'] }
  assert.deepEqual(webRefreshBindingErrors(record, options), [])
  assert.ok(webRefreshBindingErrors({ ...record, pageId: 'other' }, options).includes('web-refresh-page'))
  assert.ok(webRefreshBindingErrors({ ...record, input: { conversationId: 'other' } }, options).includes('web-refresh-source'))
  assert.ok(webRefreshBindingErrors({ ...record, generation: 1 }, options).includes('web-refresh-generation'))
  assert.ok(webRefreshBindingErrors({ ...record, id: 'rpc-1' }, options).includes('web-refresh-old-request'))
  assert.ok(webRefreshBindingErrors({ ...record, decision: 'discarded' }, options).includes('web-refresh-discarded'))
  assert.ok(webRefreshBindingErrors({ ...record, decisionExtra: { outcome: 'success' } }, options).includes('web-refresh-outcome'))
  assert.ok(webRefreshBindingErrors({ ...record, result: { error: '' } }, options).includes('web-refresh-raw-error'))
  assert.ok(webRefreshBindingErrors(null, options).includes('web-refresh-missing'))
})

test('webPanelPreservationErrors rejects stale-less error, source/row/revision drift and fake execution words', () => {
  const before = {
    source: 'cnv-s',
    revision: 'rev 1',
    error: null,
    stale: null,
    empty: false,
    unreconciled: false,
    rows: [{ taskId: 'tsk-b', childSessionId: 'real-b-child', parent: '', depth: 1, state: 'UNKNOWN', text: 'U1 · tsk-b · UNKNOWN' }]
  }
  const after = { ...before, error: 'task/unavailable: subagent catalog read failed', stale: 'Showing stale observation' }
  assert.deepEqual(webPanelPreservationErrors({ before, after, revision: 1 }), [])
  assert.ok(webPanelPreservationErrors({ before, after: { ...after, stale: null }, revision: 1 }).includes('web-panel-stale'))
  assert.ok(webPanelPreservationErrors({ before, after: { ...after, source: 'other' }, revision: 1 }).includes('web-panel-source'))
  assert.ok(webPanelPreservationErrors({ before, after: { ...after, rows: [{ ...after.rows[0], taskId: 'other' }] }, revision: 1 }).includes('web-panel-rows'))
  assert.ok(webPanelPreservationErrors({ before, after: { ...after, revision: 'rev 2' }, revision: 1 }).includes('web-panel-revision'))
  assert.ok(webPanelPreservationErrors({ before, after: { ...after, error: '' }, revision: 1 }).includes('web-panel-error'))
  assert.ok(webPanelPreservationErrors({ before, after: { ...after, rows: [{ ...after.rows[0], text: 'running' }] }, revision: 1 }).includes('web-panel-execution-word'))
})

test('webLedgerExecutionErrors rejects tree/task/revision/fact drift and forbidden execution', () => {
  const clean = { treeBefore: 't', treeAfter: 't', tasksBefore: 'x', tasksAfter: 'x', revisionBefore: 1, revisionAfter: 1, factsBefore: ledgerFacts(ledger), factsAfter: ledgerFacts(ledger), forbidden: [] }
  assert.deepEqual(webLedgerExecutionErrors(clean), [])
  assert.ok(webLedgerExecutionErrors({ ...clean, treeAfter: 'u' }).includes('web-ledger-tree'))
  assert.ok(webLedgerExecutionErrors({ ...clean, tasksAfter: 'y' }).includes('web-ledger-tasks'))
  assert.ok(webLedgerExecutionErrors({ ...clean, revisionAfter: 2 }).includes('web-ledger-revision'))
  assert.ok(webLedgerExecutionErrors({ ...clean, factsAfter: { revision: 9 } }).includes('web-ledger-facts'))
  assert.ok(webLedgerExecutionErrors({ ...clean, forbidden: ['sessionController/follow'] }).some((error) => error.startsWith('web-execution:')))
})

test('fixtureManifestErrors accepts valid isolated fixture and rejects missing manifest, unbounded climb, pseudo-unique, unexpected client, missing module/private and copy drift', () => {
  const validFixture = {
    id: 'wo-live-session-b',
    path: 'D:\\R\\fixtures\\live-session-b\\index.mjs',
    nearestManifestPath: 'D:\\R\\fixtures\\live-session-b\\package.json',
    manifest: {
      name: 'wo-live-session-b-fixture',
      version: '0.0.0',
      private: true,
      type: 'module'
    },
    sourceSha256: 'a'.repeat(64),
    copySha256: 'a'.repeat(64)
  }
  const projectManifestPath = 'E:\\Project\\Workspace-Organizer\\package.json'

  assert.deepEqual(fixtureManifestErrors(validFixture, { projectManifestPath }), [])
  assert.deepEqual(fixtureManifestErrors(null), ['fixture-missing'])
  assert.ok(fixtureManifestErrors({ ...validFixture, nearestManifestPath: null, manifest: null }).includes('fixture-missing-manifest'))
  assert.ok(fixtureManifestErrors({ ...validFixture, nearestManifestPath: projectManifestPath }, { projectManifestPath }).includes('fixture-unbounded-manifest'))

  // pseudo-unique: fixture id does not contain workspace-organizer, but manifest.name is workspace-organizer-dsh
  const pseudoUnique = { ...validFixture, id: 'wo-helper', manifest: { ...validFixture.manifest, name: 'workspace-organizer-dsh' } }
  assert.ok(fixtureManifestErrors(pseudoUnique, { projectPackageName: 'workspace-organizer-dsh' }).includes('fixture-pseudo-unique'))

  // unexpected client declaration
  assert.ok(fixtureManifestErrors({ ...validFixture, manifest: { ...validFixture.manifest, client: { platform: 'web' } } }).includes('fixture-unexpected-client'))
  assert.ok(fixtureManifestErrors({ ...validFixture, manifest: { ...validFixture.manifest, dsh: { client: {} } } }).includes('fixture-unexpected-client'))
  assert.ok(fixtureManifestErrors({ ...validFixture, manifest: { ...validFixture.manifest, exports: { './client': './client.js' } } }).includes('fixture-unexpected-client'))

  // package flags
  assert.ok(fixtureManifestErrors({ ...validFixture, manifest: { ...validFixture.manifest, type: 'commonjs' } }).includes('fixture-not-module'))
  assert.ok(fixtureManifestErrors({ ...validFixture, manifest: { ...validFixture.manifest, private: false } }).includes('fixture-not-private'))

  // copy drift
  assert.ok(fixtureManifestErrors({ ...validFixture, copySha256: 'b'.repeat(64) }).includes('fixture-copy-drift'))
})

test('overlaySourceErrors detects pseudo-unique entries and fixture errors', () => {
  const original = { id: 'include:workspace-organizer', name: 'workspace-organizer-dsh', effectiveDisabled: true }
  const pinned = { id: 'include:wo-test-pinned-organizer', name: 'file:///R/profile/node_modules/workspace-organizer-dsh/dist/index.js', effectiveDisabled: false }
  const graph = { entries: [{ id: 'workspace-organizer-dsh' }], batches: [{ entries: ['workspace-organizer-dsh'] }] }
  const validFixture = {
    id: 'wo-live-session-b',
    path: 'D:\\R\\fixtures\\live-session-b\\index.mjs',
    nearestManifestPath: 'D:\\R\\fixtures\\live-session-b\\package.json',
    manifest: { name: 'wo-live-session-b-fixture', type: 'module', private: true }
  }

  assert.deepEqual(overlaySourceErrors({ loaderEntries: [original, pinned], pinnedName: pinned.name, graph, fixtures: [validFixture] }), [])

  // pseudo-unique fixture
  const pseudoFixture = { ...validFixture, id: 'wo-helper', manifest: { ...validFixture.manifest, name: 'workspace-organizer-dsh' } }
  assert.ok(overlaySourceErrors({ loaderEntries: [original, pinned], pinnedName: pinned.name, graph, fixtures: [pseudoFixture] }).includes('overlay-pseudo-unique'))

  // unexpected client in fixture
  const clientFixture = { ...validFixture, manifest: { ...validFixture.manifest, client: {} } }
  assert.ok(overlaySourceErrors({ loaderEntries: [original, pinned], pinnedName: pinned.name, graph, fixtures: [clientFixture] }).includes('overlay-fixture-client'))

  // unbounded fixture
  const unboundedFixture = { ...validFixture, nearestManifestPath: 'E:\\Project\\Workspace-Organizer\\package.json' }
  assert.ok(overlaySourceErrors({ loaderEntries: [original, pinned], pinnedName: pinned.name, graph, fixtures: [unboundedFixture] }, { projectManifestPath: 'E:\\Project\\Workspace-Organizer\\package.json' }).includes('overlay-fixture-unbounded'))

  // copy drift fixture
  const driftFixture = { ...validFixture, sourceSha256: 'a'.repeat(64), copySha256: 'b'.repeat(64) }
  assert.ok(overlaySourceErrors({ loaderEntries: [original, pinned], pinnedName: pinned.name, graph, fixtures: [driftFixture] }).includes('overlay-fixture-drift'))
})

test('sourceReadinessErrors rejects missing collector, wrong collector page and collector errors', () => {
  const baseline = { path: 'E:\\run\\client\\client.js' }
  const artifact = { path: baseline.path, sha256: 'a'.repeat(64), sizeMatchesBaseline: true, mtimeMatchesBaseline: true, ctimeMatchesBaseline: true, instrumented: true }
  const graph = { entries: [{ id: 'workspace-organizer-dsh' }], batches: [{ entries: ['workspace-organizer-dsh'] }] }
  const combo = { containsArtifact: true, instrumented: true, sha256: 'b'.repeat(64), executionRequestId: 'r1', refetchRequestIds: [] }
  const requests = [{ requestId: 'r1', status: 200, bodySha256: 'b'.repeat(64) }]
  const collector = { pageId: 'p1', errors: [] }

  assert.deepEqual(sourceReadinessErrors({ baseline, artifact, graph, combo, requests, executionRequestId: 'r1', collector, pageId: 'p1' }), [])
  assert.ok(sourceReadinessErrors({ baseline, artifact, graph, combo, requests, executionRequestId: 'r1', collector: null, pageId: 'p1' }).includes('readiness-collector-missing'))
  assert.ok(sourceReadinessErrors({ baseline, artifact, graph, combo, requests, executionRequestId: 'r1', collector, pageId: 'other-page' }).includes('readiness-collector-page'))
  assert.ok(sourceReadinessErrors({ baseline, artifact, graph, combo, requests, executionRequestId: 'r1', collector: { pageId: 'p1', errors: ['snapshot-error'] }, pageId: 'p1' }).includes('readiness-collector-errors'))
})
