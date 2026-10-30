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

const status = { conversationsCreatable: true, sessionSource: 'FP-136 synthetic source View tree validity' }
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
  const view = findOne(root, (node) => node.props?.['data-wo-task-view'] !== undefined)
  const center = findOne(root, (node) => node.props?.['data-wo-task-center-panel'] === 'true')
  const centerStatus = findOne(root, (node) => node.props?.['data-wo-task-center-status'] !== undefined)
  const centerDetail = findOne(root, (node) => node.props?.['data-wo-task-center-detail'] !== undefined)
  return {
    taskPanelSource: panel?.props['data-wo-task-panel'] ?? null,
    taskRefreshExists: refresh !== null,
    taskRefreshDisabled: refresh?.props.disabled ?? null,
    taskLoading: findOne(root, (node) => node.props?.['data-wo-task-loading'] === 'true') !== null,
    taskError: textOf(findOne(root, (node) => node.props?.['data-wo-task-error'] === 'true')) || null,
    taskStale: findOne(root, (node) => node.props?.['data-wo-task-stale'] === 'true') !== null,
    taskRevision: revision ? textOf(revision) : null,
    taskRows: findAll(root, (node) => node.props?.['data-wo-task-row'] !== undefined).map((node) => node.props['data-wo-task-row']),
    taskViewExists: view !== null,
    taskViewDisabled: view?.props.disabled ?? null,
    taskCenterOpen: center !== null,
    taskCenterStatus: centerStatus?.props['data-wo-task-center-status'] ?? null,
    taskCenterDetail: centerDetail?.props['data-wo-task-center-detail'] ?? null,
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
  console.log(JSON.stringify({ fp136: entry }, null, 2))
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
  console.log(JSON.stringify({ fp136L2: { label, l2 } }, null, 2))
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
  console.log(JSON.stringify({ fp136NoEffectAssertion: diagnostic }, null, 2))
  assert.equal(diagnostic.deltas.setters, 0, `${label}: old A Refresh must add zero state setter calls`)
  assert.deepEqual(diagnostic.deltas.remoteCalls, [], `${label}: old A Refresh must dispatch zero RPCs`)
  assert.deepEqual(diagnostic.deltas.timerEvents, [], `${label}: old A Refresh must add zero timer events`)
  assert.deepEqual(diagnostic.deltas.pendingTimerIdsAfter, diagnostic.deltas.pendingTimerIdsBefore, `${label}: pending timer set must not change`)
  assert.deepEqual(after.ui, before.ui, `${label}: old A Refresh must leave visible task/tree state unchanged`)
  assert.deepEqual(env.remote.illegal, [], `${label}: no non-whitelisted remote method may be called`)
  t.diagnostic = diagnostic
}

function captureTaskView(root, taskId = 'task-A1') {
  return requireOne(root, (node) => node.props?.['data-wo-task-view'] === taskId, 'rendered Task View button ' + taskId)
}

async function openAWithTask(env) {
  const savedTasksA = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  savedTasksA(mockEvent())
  await env.runtime.settle()
  const savedViewA = captureTaskView(env.runtime.getRoot()).props.onClick
  return { savedTasksA, savedViewA }
}

test('removed A after accepted tree Refresh disables View and rejects saved/current callbacks; same-source Close remains available', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())

  const { savedTasksA, savedViewA } = await openAWithTask(env)
  await refreshTree(env)
  assertAcceptedL2(env, 'L2 removes A', 0)
  const currentViewAfterL2 = captureTaskView(env.runtime.getRoot())
  assert.equal(currentViewAfterL2.props.disabled, true, 'View control is disabled when the source conversation left the accepted live tree')
  const beforeSaved = record(env, 'accepted non-stale L2 removed A before saved View callback')
  savedViewA(mockEvent())
  await env.runtime.settle()
  const afterSaved = record(env, 'saved A View callback replayed after accepted L2 removed A')
  expectNoCallbackEffects(t, env, beforeSaved, afterSaved, 'removed A saved View')
  assert.equal(afterSaved.ui.taskCenterOpen, false, 'saved View cannot open Task Center for removed source A')
  assert.equal(afterSaved.ui.taskViewDisabled, true, 'current View remains disabled after saved callback replay')

  const currentView = captureTaskView(env.runtime.getRoot())
  assert.equal(currentView.props.disabled, true)
  const beforeCurrent = record(env, 'before direct invocation of disabled current A View')
  currentView.props.onClick(mockEvent())
  await env.runtime.settle()
  const afterCurrent = record(env, 'disabled current A View callback replayed after accepted L2')
  expectNoCallbackEffects(t, env, beforeCurrent, afterCurrent, 'removed A current View')
  assert.equal(afterCurrent.ui.taskCenterOpen, false)

  const callsBeforeClose = env.taskLedgerCalls
  const beforeClose = record(env, 'before same-source Close after A was removed from tree')
  savedTasksA(mockEvent())
  await env.runtime.settle()
  const afterClose = record(env, 'same-source Close after A was removed from tree')
  assert.equal(afterClose.ui.taskPanelSource, null, 'existing same-source Close remains usable')
  assert.equal(env.taskLedgerCalls, callsBeforeClose, 'same-source Close dispatches no Task Center or source ledger read')
  assert.ok(afterClose.setterCalls > beforeClose.setterCalls, 'legal same-source Close retains its existing state updates')
})

test('unique retained A keeps current and saved same-instance View callbacks valid', async (t) => {
  const env = await setup({ refreshSnapshotResult: { ok: true, value: snapshotAandB(42) } })
  t.after(() => env.cleanup())

  const { savedViewA } = await openAWithTask(env)
  await refreshTree(env)
  assertAcceptedL2(env, 'L2 uniquely retains A', 1)
  const currentView = captureTaskView(env.runtime.getRoot())
  assert.equal(currentView.props.disabled, false, 'View remains enabled for a unique live conversation source')

  const beforeCurrent = env.taskLedgerCalls
  currentView.props.onClick(mockEvent())
  await env.runtime.settle()
  const currentResult = record(env, 'current valid View after L2 retained A')
  assert.equal(env.taskLedgerCalls, beforeCurrent + 1, 'current valid View dispatches exactly one read-only ledger request')
  assert.equal(currentResult.ui.taskCenterOpen, true, 'current valid View opens Task Center')
  assert.equal(currentResult.ui.taskCenterStatus, 'ready', 'current valid View reaches ready state')
  assert.equal(currentResult.ui.taskCenterDetail, 'task-A1', 'current valid View selects the exact task')

  requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-close'] === 'true', 'Task Center Close').props.onClick(mockEvent())
  await env.runtime.settle()
  const beforeSaved = env.taskLedgerCalls
  savedViewA(mockEvent())
  await env.runtime.settle()
  const savedResult = record(env, 'saved same-instance View after L2 retained A')
  assert.equal(env.taskLedgerCalls, beforeSaved + 1, 'saved same-instance valid View dispatches exactly one request')
  assert.equal(savedResult.ui.taskCenterOpen, true)
  assert.equal(savedResult.ui.taskCenterStatus, 'ready')
  assert.equal(savedResult.ui.taskCenterDetail, 'task-A1')
  assert.deepEqual(env.remote.illegal, [], 'valid source View uses only whitelisted read methods')
})

test('already-dispatched valid View read settles after later tree Refresh removes A', async (t) => {
  const viewRead = deferred()
  const env = await setup({
    taskLedgerHandler: ({ call }) => call === 1 ? { ok: true, value: ledger } : viewRead.promise
  })
  t.after(() => env.cleanup())

  const { savedViewA } = await openAWithTask(env)
  savedViewA(mockEvent())
  await env.runtime.settle()
  const dispatched = record(env, 'valid View read dispatched and pending before tree Refresh')
  assert.equal(env.taskLedgerCalls, 2, 'initial source read plus one valid View read were dispatched')
  assert.equal(viewRead.settled, false, 'controlled Task Center read remains unresolved')
  assert.equal(dispatched.ui.taskCenterOpen, true)
  assert.equal(dispatched.ui.taskCenterStatus, 'loading')

  await refreshTree(env)
  assertAcceptedL2(env, 'L2 removes A while valid View read is pending', 0)
  const afterTree = record(env, 'accepted L2 removed A while already-dispatched View read remains pending')
  assert.equal(viewRead.settled, false, 'tree change does not cancel an already-dispatched valid View read')
  assert.equal(afterTree.ui.taskCenterOpen, true)
  assert.equal(afterTree.ui.taskCenterStatus, 'loading')
  assert.equal(env.taskLedgerCalls, 2, 'tree Refresh does not issue another Task Center ledger read')

  viewRead.resolve({ ok: true, value: ledger })
  await env.runtime.settle()
  const settled = record(env, 'previously dispatched valid View read settles after source removal')
  assert.equal(viewRead.settled, true)
  assert.equal(settled.ui.taskCenterOpen, true, 'legitimate in-flight navigation retains its existing settlement semantics')
  assert.equal(settled.ui.taskCenterStatus, 'ready')
  assert.equal(settled.ui.taskCenterDetail, 'task-A1')
  assert.equal(env.taskLedgerCalls, 2)
})

test('stale tree disables and rejects saved A View without side effects', async (t) => {
  const env = await setup({ refreshSnapshotResult: { ok: false, error: { message: 'synthetic tree refresh failure' } } })
  t.after(() => env.cleanup())

  const { savedViewA } = await openAWithTask(env)
  await refreshTree(env)
  const before = record(env, 'stale tree observed before saved View replay')
  assert.equal(before.ui.treeStale, true, 'failed normal Refresh produces stale cached tree state')
  assert.equal(before.ui.taskPanelSource, 'cnv_A')
  assert.equal(before.ui.taskViewDisabled, true, 'View control is disabled while source tree is stale')
  savedViewA(mockEvent())
  await env.runtime.settle()
  const after = record(env, 'saved A View replayed while tree is stale')
  expectNoCallbackEffects(t, env, before, after, 'stale tree')
})

test('accepted same-ID wrong-kind L2 disables and rejects saved A View', async (t) => {
  const wrongKind = snapshotAandB(42)
  const sourceA = wrongKind.nodes.find((node) => node.id === 'cnv_A')
  sourceA.kind = 'project'
  delete sourceA.sessionId
  const env = await setup({ refreshSnapshotResult: { ok: true, value: wrongKind } })
  t.after(() => env.cleanup())

  const { savedViewA } = await openAWithTask(env)
  await refreshTree(env)
  assertAcceptedL2(env, 'same-ID wrong-kind L2', 0)
  const before = record(env, 'wrong-kind L2 before saved View replay')
  assert.equal(before.ui.taskViewDisabled, true, 'same ID with non-conversation kind disables View')
  savedViewA(mockEvent())
  await env.runtime.settle()
  const after = record(env, 'saved A View replayed after same-ID wrong-kind L2')
  expectNoCallbackEffects(t, env, before, after, 'wrong-kind live source')
})

test('accepted duplicate A snapshot is observed in component live state and rejects saved View', async (t) => {
  const duplicateL2 = snapshotAandB(42)
  duplicateL2.nodes.push({ id: 'cnv_A', parentId: 'workspace', kind: 'conversation', title: 'Duplicate A', sessionId: 'session-A-duplicate' })
  const env = await setup({ refreshSnapshotResult: { ok: true, value: duplicateL2 } })
  t.after(() => env.cleanup())

  const { savedViewA } = await openAWithTask(env)
  await refreshTree(env)
  assertAcceptedL2(env, 'duplicate same-ID L2', 1)
  const observed = env.observedLiveSnapshot
  const aEntries = observed?.nodes?.filter((node) => node.id === 'cnv_A') ?? []
  const duplicateProbe = {
    componentSnapshotPresent: observed !== null,
    nonStale: !readUi(env.runtime.getRoot()).treeStale,
    revision: observed?.revision ?? null,
    sameAcceptedSnapshotIdentity: observed === duplicateL2,
    aOccurrences: aEntries.length,
    aKinds: aEntries.map((node) => node.kind)
  }
  console.log(JSON.stringify({ fp136DuplicateLiveSnapshotProbe: duplicateProbe }, null, 2))
  assert.equal(duplicateProbe.componentSnapshotPresent, true, 'duplicate oracle requires a component-held live snapshot observation')
  assert.equal(duplicateProbe.nonStale, true, 'duplicate oracle requires normal Refresh to accept non-stale L2')
  assert.equal(duplicateProbe.revision, 42, 'component-held snapshot must be the accepted L2 revision')
  assert.equal(duplicateProbe.sameAcceptedSnapshotIdentity, true, 'component-held snapshot must be the exact L2 returned by normal Refresh')
  assert.equal(duplicateProbe.aOccurrences, 2, 'component-held non-stale L2 must contain both duplicate A entries')
  assert.deepEqual(duplicateProbe.aKinds, ['conversation', 'conversation'], 'both duplicate A entries must be conversations')

  const before = record(env, 'verified duplicate live snapshot before saved View replay')
  assert.equal(before.ui.taskViewDisabled, true, 'ambiguous source disables the rendered View control')
  savedViewA(mockEvent())
  await env.runtime.settle()
  const after = record(env, 'saved A View replayed after verified duplicate live snapshot')
  expectNoCallbackEffects(t, env, before, after, 'duplicate live source')
})

test('true runtime unmount and awaited apply cleanup make a saved A View inert', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())

  const { savedViewA } = await openAWithTask(env)
  const effectCleanupsBeforeUnmount = env.runtime.stats.effectCleanups
  env.runtime.unmount()
  const runtimeUnmounted = !env.runtime.isMounted()
  const effectCleanupRan = env.runtime.stats.effectCleanups > effectCleanupsBeforeUnmount
  assert.equal(runtimeUnmounted, true, 'synthetic hooks runtime must be truly unmounted before measuring old callback')
  assert.equal(effectCleanupRan, true, 'runtime effect cleanup must run during unmount')
  await env.mounted.cleanup()
  env.cleaned = true

  const before = record(env, 'after actual runtime.unmount and awaited mounted.cleanup; before saved View')
  const callsBefore = [...env.remote.calls]
  const timersBefore = [...env.timers.events]
  const pendingBefore = [...env.timers.pending.keys()]
  savedViewA(mockEvent())
  await env.runtime.settle()
  const after = record(env, 'saved A View callback replayed after both cleanup phases')
  const diagnostic = {
    scenario: 'true component unmount plus awaited plugin cleanup',
    runtimeUnmounted,
    effectCleanupRan,
    cleanupComplete: env.cleaned,
    settersBefore: before.setterCalls,
    settersAfter: after.setterCalls,
    remoteCallsUnchanged: JSON.stringify(callsBefore) === JSON.stringify(env.remote.calls),
    timerEventsUnchanged: JSON.stringify(timersBefore) === JSON.stringify(env.timers.events),
    pendingTimersBefore: pendingBefore,
    pendingTimersAfter: [...env.timers.pending.keys()]
  }
  console.log(JSON.stringify({ fp136UnmountDiagnostic: diagnostic }, null, 2))
  assert.equal(after.setterCalls, before.setterCalls, 'unmounted saved View adds zero state setter calls')
  assert.deepEqual(env.remote.calls, callsBefore, 'unmounted saved View adds zero RPC calls')
  assert.deepEqual(env.timers.events, timersBefore, 'unmounted saved View adds zero timer events')
  assert.deepEqual([...env.timers.pending.keys()], pendingBefore, 'unmounted saved View does not change pending timers')
  assert.equal(env.runtime.isMounted(), false)
})