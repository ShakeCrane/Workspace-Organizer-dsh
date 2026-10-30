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

const status = { conversationsCreatable: true, sessionSource: 'FP-134 synthetic source Tasks tree entry lifecycle' }
const ledger = {
  revision: 7,
  sources: [
    { conversationId: 'cnv_A', sessionId: 'session-A', tasksCount: 0 },
    { conversationId: 'cnv_B', sessionId: 'session-B', tasksCount: 0 }
  ],
  tasks: []
}

function mockEvent() {
  return { stopPropagation() {}, preventDefault() {} }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
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
  taskLedgerHandler
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  let setterCalls = 0
  const originalUseState = runtime.React.useState
  runtime.React.useState = function (initialValue) {
    const [value, setState] = originalUseState.call(this, initialValue)
    return [value, (...args) => {
      setterCalls += 1
      return setState(...args)
    }]
  }

  const timers = makeTimerQueue()
  const remote = createRemoteProxy({ snapshot: snapshotAandB(), status, ledgers: [] })
  let snapshotCalls = 0
  let statusCalls = 0
  let taskLedgerCalls = 0
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
    timeline: [],
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

function readUi(root) {
  const panel = findOne(root, (node) => node.props?.['data-wo-task-panel'] !== undefined)
  const revision = findOne(root, (node) => node.props?.['data-wo-task-revision'] !== undefined)
  return {
    taskPanelSource: panel?.props['data-wo-task-panel'] ?? null,
    taskLoading: findOne(root, (node) => node.props?.['data-wo-task-loading'] === 'true') !== null,
    taskError: textOf(findOne(root, (node) => node.props?.['data-wo-task-error'] === 'true')) || null,
    taskRevision: revision ? textOf(revision) : null,
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
  env.timeline.push(entry)
  console.log(JSON.stringify({ fp134: entry }, null, 2))
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
    rowAOccurrences: findAll(root, (node) => node.props?.['data-wo-node-id'] === 'cnv_A').length,
    rowB: findOne(root, (node) => node.props?.['data-wo-node-id'] === 'cnv_B') !== null
  }
  record(env, `${label}: Refresh result`, { l2 })
  assert.equal(l2.snapshotCalls, 2, `${label}: normal rendered Refresh must perform the second snapshot read`)
  assert.equal(l2.treeStale, false, `${label}: Refresh must accept a non-stale L2 before replaying the saved row callback`)
  assert.equal(l2.rowAOccurrences, expectedAOccurrences, `${label}: L2 row A count must match the scenario fixture`)
  assert.equal(l2.rowB, true, `${label}: L2 must retain the B conversation row`)
}

function expectNoCallbackEffects(t, env, before, after, label) {
  const diagnostic = {
    scenario: label,
    before: { ui: before.ui, setterCalls: before.setterCalls, remoteCalls: before.remoteCalls, timerEvents: before.timerEvents },
    after: { ui: after.ui, setterCalls: after.setterCalls, remoteCalls: after.remoteCalls, timerEvents: after.timerEvents },
    deltas: {
      setters: after.setterCalls - before.setterCalls,
      remoteCalls: after.remoteCalls.slice(before.remoteCalls.length),
      timerEvents: after.timerEvents.slice(before.timerEvents.length)
    }
  }
  console.log(JSON.stringify({ fp134CallbackAssertion: diagnostic }, null, 2))
  assert.equal(diagnostic.deltas.setters, 0, `${label}: old A callback must add zero state setter calls`)
  assert.deepEqual(diagnostic.deltas.remoteCalls, [], `${label}: old A callback must dispatch zero RPCs`)
  assert.deepEqual(diagnostic.deltas.timerEvents, [], `${label}: old A callback must add zero timer events`)
  assert.deepEqual(after.ui, before.ui, `${label}: old A callback must leave the visible state unchanged`)
}

test('removed A row callback is inert after accepted Refresh while current B taskLedger read is pending', async (t) => {
  const bRead = deferred()
  let bResolved = false
  const env = await setup({
    taskLedgerHandler: ({ call }) => {
      assert.equal(call, 1, 'only the current B row should dispatch while the saved A callback is under test')
      return bRead.promise
    }
  })
  t.after(() => env.cleanup())

  let root = env.runtime.getRoot()
  const savedA = captureTasksCallback(root, 'cnv_A')
  record(env, 'L1 accepted; captured real rendered Tasks row A callback', { revision: 41 })
  await refreshTree(env)
  assertAcceptedL2(env, 'removed A', 0)

  root = env.runtime.getRoot()
  captureTasksCallback(root, 'cnv_B')(mockEvent())
  await env.runtime.settle()
  const beforeOldA = record(env, 'B taskLedger pending before replaying old A', { bResolved })
  assert.equal(beforeOldA.ui.taskPanelSource, 'cnv_B', 'B must be the currently open panel before old A is replayed')
  assert.equal(beforeOldA.ui.taskLoading, true, 'B taskLedger must remain visibly pending before old A is replayed')
  assert.equal(bResolved, false, 'controlled B taskLedger promise must still be unresolved')

  savedA(mockEvent())
  await env.runtime.settle()
  const afterOldA = record(env, 'old A callback replayed while B is pending', { bResolved })
  expectNoCallbackEffects(t, env, beforeOldA, afterOldA, 'removed A / B pending')
  assert.equal(afterOldA.ui.taskPanelSource, 'cnv_B', 'old A must not replace pending B')
  assert.equal(afterOldA.ui.taskLoading, true, 'old A must not settle or cancel the pending B read')
  assert.equal(bResolved, false, 'old A replay must not resolve B taskLedger')

  bResolved = true
  bRead.resolve({ ok: true, value: ledger })
  await env.runtime.settle()
  const bCompleted = record(env, 'B controlled taskLedger completed')
  assert.equal(bCompleted.ui.taskPanelSource, 'cnv_B', 'B panel must remain selected after its valid read completes')
  assert.equal(bCompleted.ui.taskLoading, false, 'B loading indicator must clear after the controlled response')
  assert.equal(bCompleted.ui.taskRevision, 'rev 7', 'B must display the accepted ledger revision')
  assert.deepEqual(env.remote.illegal, [], 'no non-whitelisted RPC may be reached by this source-entry path')
})

test('saved A row remains a positive control when accepted L2 retains exactly one Conversation A', async (t) => {
  const env = await setup({ refreshSnapshotResult: { ok: true, value: snapshotAandB(42) } })
  t.after(() => env.cleanup())

  const savedA = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  record(env, 'positive control L1; captured A')
  await refreshTree(env)
  assertAcceptedL2(env, 'retained A positive control', 1)

  const rpcBefore = env.taskLedgerCalls
  savedA(mockEvent())
  await env.runtime.settle()
  const result = record(env, 'saved A callback replayed with unique A still in latest snapshot', { taskLedgerBefore: rpcBefore })
  assert.equal(result.ui.taskPanelSource, 'cnv_A', 'retained A must remain a legal source entry')
  assert.equal(env.taskLedgerCalls, rpcBefore + 1, 'legal retained A entry must dispatch one read-only taskLedger call')
  assert.deepEqual(env.remote.illegal, [], 'positive control must not dispatch an unapproved RPC')
})

test('saved A row is rejected when normal Refresh fails and only a stale cached snapshot remains', async (t) => {
  const env = await setup({ refreshSnapshotResult: { ok: false, error: { message: 'synthetic snapshot refresh failure' } } })
  t.after(() => env.cleanup())

  const savedA = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  await refreshTree(env)
  const afterFailedRefresh = record(env, 'normal Refresh failed; old snapshot is marked stale')
  assert.equal(afterFailedRefresh.ui.treeStale, true, 'failed Refresh must visibly mark cached L1 stale')
  const before = afterFailedRefresh
  savedA(mockEvent())
  await env.runtime.settle()
  const after = record(env, 'saved A callback replayed against stale cached L1')
  expectNoCallbackEffects(t, env, before, after, 'stale cached snapshot')
  assert.deepEqual(env.remote.illegal, [], 'stale rejection must not reach non-whitelisted RPCs')
})

test('synthetic same-ID wrong-kind L2 rejects the old Conversation A row callback', async (t) => {
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

  const savedA = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  await refreshTree(env)
  assertAcceptedL2(env, 'synthetic wrong-kind', 1)
  const before = record(env, 'synthetic same-ID wrong-kind target is present')
  savedA(mockEvent())
  await env.runtime.settle()
  const after = record(env, 'old Conversation A callback replayed after same-ID kind changed')
  expectNoCallbackEffects(t, env, before, after, 'synthetic same-ID wrong-kind')
})

test('synthetic duplicate same-ID L2 rejects the old Conversation A row callback', async (t) => {
  const duplicateL2 = snapshotAandB(42)
  duplicateL2.nodes.push({ id: 'cnv_A', parentId: 'workspace', kind: 'conversation', title: 'Synthetic duplicate A', sessionId: 'session-A2' })
  const env = await setup({ refreshSnapshotResult: { ok: true, value: duplicateL2 } })
  t.after(() => env.cleanup())

  const savedA = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  await refreshTree(env)
  const duplicateCount = duplicateL2.nodes.filter((node) => node.id === 'cnv_A').length
  assert.equal(duplicateCount, 2, 'fixture must explicitly contain two same-ID Conversation nodes')
  const root = env.runtime.getRoot()
  const accepted = findOne(root, (node) => node.props?.['data-wo-snapshot-stale'] === 'true') === null
  record(env, 'synthetic duplicate same-ID L2 accepted by normal Refresh', { duplicateCount, accepted })
  assert.equal(accepted, true, 'the duplicate negative oracle must exercise an accepted non-stale L2')

  const before = record(env, 'synthetic duplicate target is present')
  savedA(mockEvent())
  await env.runtime.settle()
  const after = record(env, 'old A callback replayed after duplicate same-ID L2')
  expectNoCallbackEffects(t, env, before, after, 'synthetic duplicate same-ID')
})

test('same-source Tasks callback still closes an already open panel after Refresh removes its source', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())

  const savedA = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  savedA(mockEvent())
  await env.runtime.settle()
  const opened = record(env, 'A opened before Refresh removal')
  assert.equal(opened.ui.taskPanelSource, 'cnv_A', 'positive setup must open the legal current A panel')
  const taskLedgerBeforeRefresh = env.taskLedgerCalls

  await refreshTree(env)
  assertAcceptedL2(env, 'same-source close after removal', 0)
  const beforeClose = record(env, 'A panel remains open after accepted removal; same-source callback may close')
  assert.equal(beforeClose.ui.taskPanelSource, 'cnv_A', 'accepted tree removal must not silently change existing panel state')
  savedA(mockEvent())
  await env.runtime.settle()
  const afterClose = record(env, 'same-source old callback used as legal Close after removal')
  assert.equal(afterClose.ui.taskPanelSource, null, 'same-source close must remain available even after source removal')
  assert.equal(env.taskLedgerCalls, taskLedgerBeforeRefresh, 'closing must not dispatch another taskLedger read')
  assert.ok(afterClose.setterCalls > beforeClose.setterCalls, 'legal close must still perform its expected state updates')
})

test('same-source Tasks callback still closes an already open panel when Refresh marks the cached tree stale', async (t) => {
  const env = await setup({ refreshSnapshotResult: { ok: false, error: { message: 'synthetic stale tree for close control' } } })
  t.after(() => env.cleanup())

  const savedA = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  savedA(mockEvent())
  await env.runtime.settle()
  const opened = record(env, 'A opened before stale Refresh')
  assert.equal(opened.ui.taskPanelSource, 'cnv_A', 'positive setup must open the legal current A panel')
  const taskLedgerBeforeRefresh = env.taskLedgerCalls

  await refreshTree(env)
  const stale = record(env, 'Refresh failed while A panel remains open')
  assert.equal(stale.ui.treeStale, true, 'failed Refresh must mark the cached tree stale')
  assert.equal(stale.ui.taskPanelSource, 'cnv_A', 'failed tree Refresh must retain the existing A panel')
  savedA(mockEvent())
  await env.runtime.settle()
  const afterClose = record(env, 'same-source old callback used as legal Close with stale snapshot')
  assert.equal(afterClose.ui.taskPanelSource, null, 'same-source close must precede and survive the stale-snapshot entry guard')
  assert.equal(env.taskLedgerCalls, taskLedgerBeforeRefresh, 'closing stale A must not dispatch another taskLedger read')
  assert.ok(afterClose.setterCalls > stale.setterCalls, 'legal stale-source close must still perform its expected state updates')
})

test('true runtime unmount and effect cleanup make a saved Tasks row callback inert', async (t) => {
  const env = await setup()
  t.after(() => env.cleanup())

  const savedA = captureTasksCallback(env.runtime.getRoot(), 'cnv_A')
  const effectCleanupsBefore = env.runtime.stats.effectCleanups
  env.runtime.unmount()
  const runtimeUnmounted = env.runtime.isMounted() === false && env.runtime.stats.unmounts === 1
  const effectCleanupRan = env.runtime.stats.effectCleanups > effectCleanupsBefore
  await env.cleanup()
  const cleanupComplete = env.mounted.lifecycle.mountDisposed === 1
  const before = record(env, 'after runtime.unmount plus awaited mounted cleanup', { runtimeUnmounted, effectCleanupRan, cleanupComplete })
  assert.equal(runtimeUnmounted, true, 'the component runtime must be actually unmounted before measuring the old callback')
  assert.equal(effectCleanupRan, true, 'runtime effect cleanup must have executed before measuring the old callback')
  assert.equal(cleanupComplete, true, 'the apply cleanup promise must be awaited before measuring the old callback')

  savedA(mockEvent())
  await env.runtime.settle()
  const after = record(env, 'saved A callback replayed after both unmount cleanups')
  expectNoCallbackEffects(t, env, before, after, 'true runtime unmount')
  assert.equal(env.runtime.stats.renders, before.runtime.renders, 'unmounted stale callback must not render')
})
