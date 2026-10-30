import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createHooksRuntime,
  createRemoteProxy,
  createZodTestDouble,
  findAll,
  findOne,
  mountClientApplication,
  requireOne,
  textOf
} from '../scripts/lib/c3a-synthetic-component-runtime.mjs'

const snapshotAandB = (revision = 41) => ({
  rootId: 'root',
  revision,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root' },
    { id: 'project', parentId: 'root', kind: 'project', title: 'Project' },
    { id: 'workspace', parentId: 'project', kind: 'workspace', title: 'Workspace' },
    { id: 'cnv_A', parentId: 'workspace', kind: 'conversation', title: 'Conversation A', sessionId: 'session-A' },
    { id: 'cnv_B', parentId: 'workspace', kind: 'conversation', title: 'Conversation B', sessionId: 'session-B' }
  ]
})

const snapshotWithoutA = {
  rootId: 'root',
  revision: 42,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root' },
    { id: 'project', parentId: 'root', kind: 'project', title: 'Project' },
    { id: 'workspace', parentId: 'project', kind: 'workspace', title: 'Workspace' },
    { id: 'cnv_B', parentId: 'workspace', kind: 'conversation', title: 'Conversation B', sessionId: 'session-B' }
  ]
}

const status = { conversationsCreatable: true, sessionSource: 'FP-135 synthetic Tasks Refresh tree validity' }
const ledger = {
  revision: 7,
  sources: [
    { conversationId: 'cnv_A', sessionId: 'session-A', tasksCount: 1 },
    { conversationId: 'cnv_B', sessionId: 'session-B', tasksCount: 0 }
  ],
  tasks: [
    {
      taskId: 'task-A1',
      sourceConversationId: 'cnv_A',
      childSessionId: 'task-session-A1',
      parent: { kind: 'conversation', conversationId: 'cnv_A' },
      depth: 0,
      executionState: 'completed',
      executionEligibility: 'eligible',
      label: 'Task A1'
    }
  ]
}

function mockEvent() {
  return { stopPropagation() {}, preventDefault() {} }
}

function deferred() {
  let resolve
  let reject
  let settled = false
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return {
    promise,
    get settled() { return settled },
    resolve(value) { settled = true; resolve(value) },
    reject(error) { settled = true; reject(error) }
  }
}

function makeTimerQueue() {
  let nextId = 0
  const pending = new Map()
  const events = []
  return {
    pending,
    events,
    setTimeout(callback, delay) {
      const id = ++nextId
      pending.set(id, callback)
      events.push({ action: 'schedule', id, delay })
      return id
    },
    clearTimeout(id) {
      const existed = pending.delete(id)
      events.push({ action: 'cancel', id, existed })
      return existed
    }
  }
}

async function setup({
  refreshSnapshotResult = { ok: true, value: snapshotWithoutA },
  refreshStatusResult = { ok: true, value: status },
  taskLedgerHandler,
  reconcileHandler
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  let setterCalls = 0
  let observedLiveSnapshot = null
  const originalUseState = runtime.React.useState
  runtime.React.useState = function (initialValue) {
    const [value, setState] = originalUseState.call(this, initialValue)
    if (value !== null && typeof value === 'object' && Array.isArray(value.nodes) && Number.isInteger(value.revision)) {
      observedLiveSnapshot = value
    }
    return [value, (...args) => {
      setterCalls += 1
      return setState(...args)
    }]
  }

  const timers = makeTimerQueue()
  const remote = createRemoteProxy({ snapshot: snapshotAandB(), status, ledgers: [ledger] })
  let snapshotCalls = 0
  let statusCalls = 0
  let taskLedgerCalls = 0
  let reconcileCalls = 0
  remote.allowed.snapshot = async (...args) => {
    remote.calls.push({ method: 'snapshot', args })
    snapshotCalls += 1
    return snapshotCalls === 1 ? { ok: true, value: snapshotAandB() } : refreshSnapshotResult
  }
  remote.allowed.status = async (...args) => {
    remote.calls.push({ method: 'status', args })
    statusCalls += 1
    return statusCalls === 1 ? { ok: true, value: status } : refreshStatusResult
  }
  remote.allowed.taskLedger = async (...args) => {
    remote.calls.push({ method: 'taskLedger', args })
    taskLedgerCalls += 1
    return typeof taskLedgerHandler === 'function'
      ? taskLedgerHandler({ call: taskLedgerCalls, args })
      : { ok: true, value: ledger }
  }
  remote.allowed.reconcileTasks = async (input) => {
    remote.calls.push({ method: 'reconcileTasks', input })
    reconcileCalls += 1
    return typeof reconcileHandler === 'function'
      ? reconcileHandler({ call: reconcileCalls, input })
      : { ok: true, value: { ledger } }
  }

  const mounted = await mountClientApplication({
    source,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()

  const env = {
    runtime,
    mounted,
    remote,
    timers,
    get setterCalls() { return setterCalls },
    get snapshotCalls() { return snapshotCalls },
    get taskLedgerCalls() { return taskLedgerCalls },
    get reconcileCalls() { return reconcileCalls },
    get observedLiveSnapshot() { return observedLiveSnapshot },
    cleaned: false,
    async cleanup() {
      if (env.cleaned) return
      if (runtime.isMounted()) runtime.unmount()
      await mounted.cleanup()
      env.cleaned = true
    }
  }
  return env
}

function captureTasksCallback(root, sourceId) {
  return requireOne(root, (node) => node.props?.['data-wo-tasks'] === sourceId, `rendered Tasks row ${sourceId}`).props.onClick
}

function capturePanelRefresh(root) {
  return requireOne(root, (node) => node.props?.['data-wo-task-refresh'] === 'true', 'rendered source panel Refresh')
}

function readUi(root) {
  const panel = findOne(root, (node) => node.props?.['data-wo-task-panel'] !== undefined)
  const refresh = findOne(root, (node) => node.props?.['data-wo-task-refresh'] === 'true')
  const revision = findOne(root, (node) => node.props?.['data-wo-task-revision'] !== undefined)
  return {
    taskPanelSource: panel?.props['data-wo-task-panel'] ?? null,
    taskRefreshExists: refresh !== null,
    taskRefreshDisabled: refresh?.props.disabled ?? null,
    taskLoading: findOne(root, (node) => node.props?.['data-wo-task-loading'] === 'true') !== null,
    taskError: textOf(findOne(root, (node) => node.props?.['data-wo-task-error'] === 'true')) || null,
    taskStale: findOne(root, (node) => node.props?.['data-wo-task-stale'] === 'true') !== null,
    taskRevision: revision ? textOf(revision) : null,
    taskRows: findAll(root, (node) => node.props?.['data-wo-task-row'] !== undefined).map((node) => node.props['data-wo-task-row']),
    treeStale: findOne(root, (node) => node.props?.['data-wo-snapshot-stale'] === 'true') !== null,
    treeConversationIds: findAll(root, (node) => node.props?.['data-wo-tasks'] !== undefined).map((node) => node.props['data-wo-tasks'])
  }
}

function record(env, phase, extra = {}) {
  const entry = {
    phase,
    ui: readUi(env.runtime.getRoot()),
    setterCalls: env.setterCalls,
    remoteCalls: [...env.remote.calls],
    illegalCalls: [...env.remote.illegal],
    timerEvents: [...env.timers.events],
    pendingTimerIds: [...env.timers.pending.keys()],
    runtime: { mounted: env.runtime.isMounted(), ...env.runtime.stats },
    ...extra
  }
  console.log(JSON.stringify({ fp135: entry }, null, 2))
  return entry
}

async function refreshTree(env) {
  const refresh = requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-refresh'] === 'true', 'rendered normal tree Refresh')
  refresh.props.onClick(mockEvent())
  await env.runtime.settle()
}

function assertAcceptedL2(env, label, expectedAOccurrences) {
  const root = env.runtime.getRoot()
  const l2 = {
    snapshotCalls: env.snapshotCalls,
    treeStale: findOne(root, (node) => node.props?.['data-wo-snapshot-stale'] === 'true') !== null,
    rowAOccurrences: findAll(root, (node) => node.props?.['data-wo-tasks'] === 'cnv_A').length,
    rowBOccurrences: findAll(root, (node) => node.props?.['data-wo-tasks'] === 'cnv_B').length,
    panelSource: readUi(root).taskPanelSource
  }
  console.log(JSON.stringify({ fp135L2: { label, l2 } }, null, 2))
  assert.equal(l2.snapshotCalls, 2, `${label}: actual normal tree Refresh must perform L2 snapshot read`)
  assert.equal(l2.treeStale, false, `${label}: L2 must be accepted as non-stale`)
  assert.equal(l2.rowAOccurrences, expectedAOccurrences, `${label}: L2 A conversation row count`)
  assert.equal(l2.rowBOccurrences, 1, `${label}: L2 must retain exactly one B conversation row`)
  assert.equal(l2.panelSource, 'cnv_A', `${label}: accepted L2 must leave the already-open A panel in place`)
  return l2
}

function expectNoCallbackEffects(t, env, before, after, label) {
  const diagnostic = {
    scenario: label,
    before: { ui: before.ui, setterCalls: before.setterCalls, remoteCalls: before.remoteCalls, timerEvents: before.timerEvents, pendingTimerIds: before.pendingTimerIds },
    after: { ui: after.ui, setterCalls: after.setterCalls, remoteCalls: after.remoteCalls, timerEvents: after.timerEvents, pendingTimerIds: after.pendingTimerIds },
    deltas: {
      setters: after.setterCalls - before.setterCalls,
      remoteCalls: after.remoteCalls.slice(before.remoteCalls.length),
      timerEvents: after.timerEvents.slice(before.timerEvents.length),
      pendingTimerIdsBefore: before.pendingTimerIds,
      pendingTimerIdsAfter: after.pendingTimerIds
    }
  }
  console.log(JSON.stringify({ fp135NoEffectAssertion: diagnostic }, null, 2))
  assert.equal(diagnostic.deltas.setters, 0, `${label}: old A Refresh must add zero state setter calls`)
  assert.deepEqual(diagnostic.deltas.remoteCalls, [], `${label}: old A Refresh must dispatch zero RPCs`)
  assert.deepEqual(diagnostic.deltas.timerEvents, [], `${label}: old A Refresh must add zero timer events`)
  assert.deepEqual(diagnostic.deltas.pendingTimerIdsAfter, diagnostic.deltas.pendingTimerIdsBefore, `${label}: pending timer set must not change`)
  assert.deepEqual(after.ui, before.ui, `${label}: old A Refresh must leave visible task/tree state unchanged`)
  assert.deepEqual(env.remote.illegal, [], `${label}: no non-whitelisted remote method may be called`)
  t.diagnostic = diagnostic
}

test('removed A panel Refresh is inert after accepted tree Refresh; same-source Close remains available', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())

  const rootL1 = env.runtime.getRoot()
  const savedARow = captureTasksCallback(rootL1, 'cnv_A')
  savedARow(mockEvent())
  await env.runtime.settle()
  const savedARefresh = capturePanelRefresh(env.runtime.getRoot()).props.onClick
  record(env, 'L1 accepted; opened A through actual rendered Tasks row and saved panel Refresh')
  assert.equal(readUi(env.runtime.getRoot()).taskPanelSource, 'cnv_A', 'L1 must open A from its rendered tree row')
  assert.equal(env.taskLedgerCalls, 1, 'opening A performs the expected initial read-only taskLedger call')

  await refreshTree(env)
  assertAcceptedL2(env, 'L2 removes A', 0)
  const currentRefresh = capturePanelRefresh(env.runtime.getRoot())
  assert.equal(currentRefresh.props.disabled, true, 'current A Refresh control must be disabled while A is absent from the latest tree')
  const before = record(env, 'accepted L2 before old A Refresh replay', { expectedAOccurrences: 0 })

  savedARefresh()
  await env.runtime.settle()
  const after = record(env, 'saved A Refresh replayed after accepted L2 removed A')
  expectNoCallbackEffects(t, env, before, after, 'removed A / accepted non-stale L2')
  assert.equal(env.reconcileCalls, 0, 'removed source must dispatch no reconcileTasks')
  assert.equal(env.taskLedgerCalls, 1, 'removed source must dispatch no extra taskLedger read')

  const beforeClose = record(env, 'removed A panel before same-source close control')
  savedARow(mockEvent())
  await env.runtime.settle()
  const afterClose = record(env, 'saved same-source Tasks row callback closed removed A panel')
  assert.equal(afterClose.ui.taskPanelSource, null, 'same-source Close remains available after tree removal')
  assert.equal(env.reconcileCalls, 0, 'same-source Close dispatches no reconcileTasks')
  assert.equal(env.taskLedgerCalls, 1, 'same-source Close dispatches no extra taskLedger read')
  assert.ok(afterClose.setterCalls > beforeClose.setterCalls, 'legal Close retains its expected state updates')
})

test('unique retained A keeps current and same-instance saved Refresh valid; loading blocks double dispatch', async (t) => {
  const reads = []
  const env = await setup({
    refreshSnapshotResult: { ok: true, value: snapshotAandB(42) },
    reconcileHandler: ({ call, input }) => {
      assert.equal(input.conversationId, 'cnv_A', `reconcile call ${call} must remain bound to A`)
      const read = deferred()
      reads.push(read)
      return read.promise
    }
  })
  t.after(() => env.cleanup())

  const savedARow = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  savedARow(mockEvent())
  await env.runtime.settle()
  const savedARefresh = capturePanelRefresh(env.runtime.getRoot()).props.onClick
  await refreshTree(env)
  assertAcceptedL2(env, 'unique A retained', 1)
  const currentARefresh = capturePanelRefresh(env.runtime.getRoot())
  assert.equal(currentARefresh.props.disabled, false, 'unique live A must keep current Refresh enabled')

  currentARefresh.props.onClick()
  await env.runtime.settle()
  const firstPending = record(env, 'current valid Refresh dispatched and is pending', {
    reconcileDispatches: env.reconcileCalls,
    controlledPromiseSettled: reads[0]?.settled ?? null
  })
  assert.equal(env.reconcileCalls, 1, 'current valid A Refresh dispatches exactly one reconcile')
  assert.equal(firstPending.ui.taskRefreshDisabled, true, 'Refresh is disabled while the controlled reconcile remains pending')
  assert.equal(reads.length, 1, 'exactly one controlled reconcile promise was created')
  assert.equal(reads[0].settled, false, 'the controlled reconcile promise is explicitly unresolved')

  savedARefresh()
  await env.runtime.settle()
  const afterDoubleFire = record(env, 'same-instance saved callback invoked while the current read is pending', {
    reconcileDispatches: env.reconcileCalls,
    controlledPromiseSettled: reads[0].settled
  })
  assert.equal(env.reconcileCalls, 1, 'loading guard must prevent the saved callback from double-dispatching')
  assert.equal(afterDoubleFire.ui.taskRefreshDisabled, true, 'Refresh remains disabled during the pending request')
  assert.equal(reads[0].settled, false, 'double-fire attempt must leave the controlled promise unresolved')

  reads[0].resolve({ ok: true, value: { ledger: { ...ledger, revision: 8 } } })
  await env.runtime.settle()
  const firstSettled = record(env, 'controlled current Refresh completed', { controlledPromiseSettled: reads[0].settled })
  assert.equal(reads[0].settled, true, 'the current reconcile settles only after explicit resolve')
  assert.equal(firstSettled.ui.taskRevision, 'rev 8', 'valid current reconcile result settles with its ledger')
  assert.equal(firstSettled.ui.taskLoading, false, 'valid current reconcile clears loading')

  savedARefresh()
  await env.runtime.settle()
  const savedPending = record(env, 'same-instance saved callback dispatched after current request settled', {
    reconcileDispatches: env.reconcileCalls,
    controlledPromiseSettled: reads[1]?.settled ?? null
  })
  assert.equal(env.reconcileCalls, 2, 'same-instance saved Refresh remains valid and dispatches exactly one additional reconcile')
  assert.equal(reads.length, 2, 'the second controlled reconcile is pending')
  assert.equal(savedPending.ui.taskRefreshDisabled, true, 'saved valid Refresh disables the current control while pending')
  assert.equal(reads[1].settled, false, 'the second controlled reconcile remains unresolved before explicit resolve')
  reads[1].resolve({ ok: true, value: { ledger: { ...ledger, revision: 9 } } })
  await env.runtime.settle()
  const savedSettled = record(env, 'controlled same-instance saved Refresh completed', { controlledPromiseSettled: reads[1].settled })
  assert.equal(reads[1].settled, true, 'the saved callback reconcile settles after explicit resolve')
  assert.equal(savedSettled.ui.taskRevision, 'rev 9', 'same-instance saved callback keeps normal result settlement')
  assert.equal(savedSettled.ui.taskPanelSource, 'cnv_A', 'successful valid Refresh leaves A panel open')
  assert.deepEqual(env.remote.illegal, [], 'only the mock reconcile method is used')
})

test('already-dispatched A reconcile keeps its original settlement after a later tree Refresh removes A', async (t) => {
  const read = deferred()
  const env = await setup({
    reconcileHandler: ({ input }) => {
      assert.equal(input.conversationId, 'cnv_A')
      return read.promise
    }
  })
  t.after(() => env.cleanup())

  const savedARow = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  savedARow(mockEvent())
  await env.runtime.settle()
  const currentRefresh = capturePanelRefresh(env.runtime.getRoot())
  currentRefresh.props.onClick()
  await env.runtime.settle()
  const dispatched = record(env, 'valid A reconcile dispatched before tree change', {
    reconcileDispatches: env.reconcileCalls,
    controlledPromiseSettled: read.settled
  })
  assert.equal(env.reconcileCalls, 1, 'the valid request must be dispatched before L2')
  assert.equal(dispatched.ui.taskRefreshDisabled, true, 'Refresh is disabled while its controlled reconcile is pending')
  assert.equal(read.settled, false, 'the controlled reconcile remains unresolved before L2')

  await refreshTree(env)
  assertAcceptedL2(env, 'later L2 removes A during dispatched reconcile', 0)
  const removedWhilePending = record(env, 'A removed while prior legitimate reconcile remains pending', {
    reconcileDispatches: env.reconcileCalls,
    controlledPromiseSettled: read.settled
  })
  assert.equal(removedWhilePending.ui.taskRefreshDisabled, true, 'new Refresh attempts remain disabled after A disappears')
  assert.equal(read.settled, false, 'tree Refresh must not cancel or settle the existing reconcile')
  assert.equal(capturePanelRefresh(env.runtime.getRoot()).props.disabled, true, 'new Refresh attempts are disabled after A disappears')
  assert.equal(env.reconcileCalls, 1, 'tree Refresh does not dispatch another reconcile')

  read.resolve({ ok: true, value: { ledger: { ...ledger, revision: 10 } } })
  await env.runtime.settle()
  const settled = record(env, 'previously dispatched reconcile settles under unchanged source token', { controlledPromiseSettled: read.settled })
  assert.equal(read.settled, true, 'the already-dispatched reconcile settles only after explicit resolve')
  assert.equal(settled.ui.taskRevision, 'rev 10', 'the already-dispatched valid request retains its pre-existing settlement semantics')
  assert.equal(settled.ui.taskLoading, false, 'the legitimate request may finish loading after tree removal')
  assert.equal(settled.ui.taskPanelSource, 'cnv_A', 'tree removal does not implicitly close the existing panel')
  assert.equal(env.reconcileCalls, 1, 'no duplicate reconcile is introduced during settlement')
})

test('stale cached tree disables and rejects a saved A Refresh without side effects', async (t) => {
  const env = await setup({ refreshSnapshotResult: { ok: false, error: { message: 'synthetic snapshot refresh failure' } } })
  t.after(() => env.cleanup())

  const savedARow = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  savedARow(mockEvent())
  await env.runtime.settle()
  const savedARefresh = capturePanelRefresh(env.runtime.getRoot()).props.onClick
  await refreshTree(env)
  assert.equal(readUi(env.runtime.getRoot()).treeStale, true, 'failed normal Refresh must retain and mark L1 stale')
  assert.equal(capturePanelRefresh(env.runtime.getRoot()).props.disabled, true, 'stale cached tree disables current A Refresh')
  const before = record(env, 'stale L1 before saved A Refresh replay')

  savedARefresh()
  await env.runtime.settle()
  const after = record(env, 'saved A Refresh replayed against stale L1')
  expectNoCallbackEffects(t, env, before, after, 'stale cached L1')
  assert.equal(env.reconcileCalls, 0, 'stale source identity must not dispatch reconcileTasks')
})

test('synthetic same-ID wrong-kind L2 disables and rejects saved A Refresh', async (t) => {
  const wrongKindL2 = {
    rootId: 'root', revision: 42,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root' },
      { id: 'project', parentId: 'root', kind: 'project', title: 'Project' },
      { id: 'workspace', parentId: 'project', kind: 'workspace', title: 'Workspace' },
      { id: 'cnv_A', parentId: 'project', kind: 'workspace', title: 'Synthetic same-ID wrong-kind node' },
      { id: 'cnv_B', parentId: 'workspace', kind: 'conversation', title: 'Conversation B', sessionId: 'session-B' }
    ]
  }
  const env = await setup({ refreshSnapshotResult: { ok: true, value: wrongKindL2 } })
  t.after(() => env.cleanup())

  const savedARow = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  savedARow(mockEvent())
  await env.runtime.settle()
  const savedARefresh = capturePanelRefresh(env.runtime.getRoot()).props.onClick
  await refreshTree(env)
  assertAcceptedL2(env, 'synthetic same-ID wrong-kind L2', 0)
  const before = record(env, 'synthetic wrong-kind ID present before callback replay')
  assert.equal(before.ui.taskRefreshDisabled, true, 'wrong-kind source disables current Refresh')

  savedARefresh()
  await env.runtime.settle()
  const after = record(env, 'saved A Refresh replayed after synthetic wrong-kind L2')
  expectNoCallbackEffects(t, env, before, after, 'synthetic same-ID wrong-kind')
  assert.equal(env.reconcileCalls, 0, 'wrong-kind target must not dispatch reconcileTasks')
})

test('synthetic duplicate same-ID L2 disables and rejects saved A Refresh', async (t) => {
  const duplicateL2 = snapshotAandB(42)
  duplicateL2.nodes.push({ id: 'cnv_A', parentId: 'workspace', kind: 'conversation', title: 'Synthetic duplicate A', sessionId: 'session-A2' })
  const env = await setup({ refreshSnapshotResult: { ok: true, value: duplicateL2 } })
  t.after(() => env.cleanup())

  const savedARow = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  savedARow(mockEvent())
  await env.runtime.settle()
  const savedARefresh = capturePanelRefresh(env.runtime.getRoot()).props.onClick
  await refreshTree(env)
  const duplicateCount = duplicateL2.nodes.filter((node) => node.id === 'cnv_A').length
  assert.equal(duplicateCount, 2, 'synthetic fixture explicitly contains duplicate A IDs')
  const l2 = assertAcceptedL2(env, 'synthetic duplicate same-ID L2', 1)
  const observedSnapshot = env.observedLiveSnapshot
  const observedDuplicateA = observedSnapshot?.nodes?.filter((node) => node.id === 'cnv_A') ?? []
  const liveSnapshotProbe = {
    l2NonStale: l2.treeStale === false,
    observedRevision: observedSnapshot?.revision ?? null,
    observedAOccurrences: observedDuplicateA.length,
    observedAKinds: observedDuplicateA.map((node) => node.kind),
    observedMatchesAcceptedL2: observedSnapshot === duplicateL2
  }
  const before = record(env, 'read-only hook-state probe observed accepted duplicate A snapshot before callback replay', { liveSnapshotProbe })
  assert.equal(liveSnapshotProbe.l2NonStale, true, 'duplicate oracle requires normal Refresh to accept non-stale L2')
  assert.equal(liveSnapshotProbe.observedRevision, 42, 'read-only probe must observe the component-held L2 revision')
  assert.equal(liveSnapshotProbe.observedMatchesAcceptedL2, true, 'component-held live snapshot must be the L2 returned by normal Refresh')
  assert.equal(liveSnapshotProbe.observedAOccurrences, 2, 'component-held non-stale live snapshot must contain both duplicate A entries')
  assert.deepEqual(liveSnapshotProbe.observedAKinds, ['conversation', 'conversation'], 'both observed duplicate A entries must be conversations')
  assert.equal(before.ui.taskRefreshDisabled, true, 'duplicate source disables current Refresh')

  savedARefresh()
  await env.runtime.settle()
  const after = record(env, 'saved A Refresh replayed after synthetic duplicate L2')
  expectNoCallbackEffects(t, env, before, after, 'synthetic duplicate same-ID')
  assert.equal(env.reconcileCalls, 0, 'ambiguous duplicate source must not dispatch reconcileTasks')
})

test('true runtime unmount and awaited plugin cleanup make a saved A Refresh inert', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())

  const savedARow = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  savedARow(mockEvent())
  await env.runtime.settle()
  const savedARefresh = capturePanelRefresh(env.runtime.getRoot()).props.onClick
  const cleanupsBefore = env.runtime.stats.effectCleanups
  env.runtime.unmount()
  const runtimeUnmounted = env.runtime.isMounted() === false && env.runtime.stats.unmounts === 1
  const effectCleanupRan = env.runtime.stats.effectCleanups > cleanupsBefore
  await env.mounted.cleanup()
  const pluginCleanupComplete = env.mounted.lifecycle.mountDisposed === 1
  env.cleaned = true

  const before = record(env, 'after real runtime.unmount, effect cleanup and awaited mounted.cleanup', {
    runtimeUnmounted,
    effectCleanupRan,
    pluginCleanupComplete
  })
  assert.equal(runtimeUnmounted, true, 'the synthetic React runtime must be genuinely unmounted before measurement')
  assert.equal(effectCleanupRan, true, 'component effect cleanup must run before measurement')
  assert.equal(pluginCleanupComplete, true, 'mounted plugin cleanup must be awaited before measurement')

  savedARefresh()
  await env.runtime.settle()
  const after = record(env, 'saved A Refresh replayed after both cleanup phases')
  expectNoCallbackEffects(t, env, before, after, 'true unmount plus awaited cleanup')
  assert.equal(env.reconcileCalls, 0, 'unmounted panel callback must dispatch no reconcileTasks')
})
