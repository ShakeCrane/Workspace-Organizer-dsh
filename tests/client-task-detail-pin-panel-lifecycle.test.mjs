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

const taskT = {
  taskId: 'task-T',
  label: 'Task T',
  childSessionId: 'child-T',
  sourceConversationId: 'conversation-S',
  parent: { kind: 'conversation', conversationId: 'conversation-S' },
  depth: 1,
  mode: 'one-shot',
  executionState: 'UNKNOWN',
  executionEligibility: 'eligible',
  observedAt: '2026-10-30T00:00:00.000Z'
}
const taskU = {
  ...taskT,
  taskId: 'task-U',
  label: 'Task U',
  childSessionId: 'child-U',
  parent: { kind: 'task', taskId: 'task-T' },
  depth: 2
}

const snapshot = {
  rootId: 'root',
  revision: 1,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root' },
    { id: 'project', parentId: 'root', kind: 'project', title: 'Project' },
    { id: 'workspace', parentId: 'project', kind: 'workspace', title: 'Workspace', directory: 'D:\\synthetic\\fp133' },
    { id: 'conversation-S', parentId: 'workspace', kind: 'conversation', title: 'Source S', sessionId: 'session-S' }
  ]
}

function makeLedger(revision = 1) {
  return {
    revision,
    sources: [{
      conversationId: 'conversation-S',
      sessionId: 'session-S',
      workspaceLogicalId: 'workspace',
      nativeWorkspaceId: 'native-workspace',
      directory: 'D:\\synthetic\\fp133',
      tasksCount: 2
    }],
    tasks: [taskT, taskU].map((task) => ({ ...task, parent: { ...task.parent } }))
  }
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

async function setup({ ledger = makeLedger() } = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const mapRefs = []
  const seenMapRefs = new WeakSet()
  const originalUseRef = runtime.React.useRef
  runtime.React.useRef = function (initialValue) {
    const ref = originalUseRef.call(this, initialValue)
    if (!seenMapRefs.has(ref) && Object.prototype.toString.call(ref.current) === '[object Map]') {
      seenMapRefs.add(ref)
      mapRefs.push({ ref, initialMap: ref.current })
    }
    return ref
  }
  const snapshotMapRefs = () => mapRefs.map(({ ref, initialMap }, index) => ({
    index,
    currentIsInitialMap: ref.current === initialMap,
    currentEntries: Object.prototype.toString.call(ref.current) === '[object Map]' ? Array.from(ref.current.entries()) : null,
    initialEntries: Array.from(initialMap.entries())
  }))
  let setterCalls = 0
  const originalUseState = runtime.React.useState
  runtime.React.useState = function (initialValue) {
    const [value, setState] = originalUseState.call(this, initialValue)
    return [value, (...args) => {
      setterCalls += 1
      return setState(...args)
    }]
  }

  const remote = createRemoteProxy({
    snapshot,
    status: { conversationsCreatable: true, sessionSource: 'FP-133 synthetic panel lifecycle test' },
    ledgers: []
  })
  const taskLedgerQueue = []
  let taskLedgerCalls = 0
  remote.allowed.taskLedger = async (...args) => {
    remote.calls.push({ method: 'taskLedger', args })
    taskLedgerCalls += 1
    return taskLedgerQueue.length === 0 ? { ok: true, value: ledger } : taskLedgerQueue.shift()
  }

  const timers = makeTimerQueue()
  const selectors = []
  const scrolls = []
  const mounted = await mountClientApplication({
    source,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote,
    document: {
      querySelector(selector) {
        selectors.push(selector)
        return { scrollIntoView(options) { scrolls.push({ selector, options }) } }
      }
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()

  const timeline = []
  return {
    ledger,
    runtime,
    mounted,
    remote,
    timers,
    selectors,
    scrolls,
    taskLedgerQueue,
    timeline,
    snapshotMapRefs,
    get setterCalls() { return setterCalls },
    get taskLedgerCalls() { return taskLedgerCalls }
  }
}

function readMembers(root) {
  return findAll(root, (node) => node.props?.['data-wo-quick-access-task'] !== undefined).map((node) => ({
    taskId: node.props['data-wo-quick-access-task'],
    sourceConversationId: node.props['data-wo-quick-access-task-source'] ?? null
  }))
}

function record(env, phase, root = env.runtime.getRoot()) {
  const status = findOne(root, (node) => node.props?.['data-wo-task-center-status'] !== undefined)
  const detail = findOne(root, (node) => node.props?.['data-wo-task-center-detail'] !== undefined)
  const feedback = findOne(root, (node) => node.props?.['data-wo-task-center-locate-feedback'] === 'true')
  const entry = {
    at: new Date().toISOString(),
    phase,
    panelOpen: findOne(root, (node) => node.props?.['data-wo-task-center-panel'] === 'true') !== null,
    status: status === null ? null : {
      value: status.props['data-wo-task-center-status'],
      text: textOf(status)
    },
    detail: detail === null ? null : {
      taskId: detail.props['data-wo-task-center-detail'],
      text: textOf(detail)
    },
    feedback: feedback === null ? null : {
      state: feedback.props['data-wo-task-center-locate-state'],
      text: textOf(feedback)
    },
    quickAccessMembers: readMembers(root),
    setterCalls: env.setterCalls,
    taskLedgerCalls: env.taskLedgerCalls,
    remoteCalls: [...env.remote.calls],
    illegalRemoteCalls: [...env.remote.illegal],
    timerEvents: [...env.timers.events],
    pendingTimerIds: [...env.timers.pending.keys()],
    selectors: [...env.selectors],
    scrolls: [...env.scrolls]
  }
  env.timeline.push(entry)
  return entry
}

function recordUnmountProbe(env, phase) {
  const entry = {
    at: new Date().toISOString(),
    phase,
    runtimeMounted: env.runtime.isMounted(),
    runtimePending: env.runtime.pending(),
    runtimeStats: { ...env.runtime.stats },
    mountedLifecycle: { ...env.mounted.lifecycle },
    setterCalls: env.setterCalls,
    taskLedgerCalls: env.taskLedgerCalls,
    remoteCalls: [...env.remote.calls],
    illegalRemoteCalls: [...env.remote.illegal],
    timerEvents: [...env.timers.events],
    pendingTimerIds: [...env.timers.pending.keys()],
    stateReferenceMaps: env.snapshotMapRefs()
  }
  env.timeline.push(entry)
  return entry
}

async function openAndSelect(env, taskId) {
  let root = env.runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-task-center'] === 'true', 'rendered All Tasks').props.onClick(mockEvent())
  await env.runtime.settle()
  root = env.runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-task-center-row'] === taskId, `rendered ${taskId} Task Center row`).props.onClick(mockEvent())
  await env.runtime.settle()
  record(env, `selected-${taskId}`)
  return env.runtime.getRoot()
}

async function selectTask(env, taskId) {
  requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === taskId, `rendered ${taskId} Task Center row`).props.onClick(mockEvent())
  await env.runtime.settle()
  record(env, `reselected-${taskId}`)
  return env.runtime.getRoot()
}

async function closeTaskCenter(env) {
  requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-close'] === 'true', 'rendered Task Center Close').props.onClick()
  await env.runtime.settle()
  record(env, 'Task-Center-closed')
}

function captureDetailAction(root, action, taskId) {
  const attribute = action === 'pin' ? 'data-wo-task-pin' : 'data-wo-task-unpin'
  const button = requireOne(root, (node) => node.props?.[attribute] === taskId, `rendered detail ${action} for ${taskId}`)
  return button.props.onClick
}

function expectNoActionEffects(t, env, before, after, label) {
  const evidence = JSON.stringify({ label, before, after, timeline: env.timeline }, null, 2)
  t.diagnostic(evidence)
  assert.equal(after.panelOpen, before.panelOpen, `${label}: panel visibility is unchanged; evidence=${evidence}`)
  assert.deepEqual(after.status, before.status, `${label}: status fields are unchanged; evidence=${evidence}`)
  assert.deepEqual(after.detail, before.detail, `${label}: selected detail fields are unchanged; evidence=${evidence}`)
  assert.deepEqual(after.feedback, before.feedback, `${label}: nullable feedback is unchanged; evidence=${evidence}`)
  assert.deepEqual(after.quickAccessMembers, before.quickAccessMembers, `${label}: membership is unchanged; evidence=${evidence}`)
  assert.equal(after.setterCalls, before.setterCalls, `${label}: zero state setter calls; evidence=${evidence}`)
  assert.deepEqual(after.remoteCalls, before.remoteCalls, `${label}: zero new RPCs; evidence=${evidence}`)
  assert.deepEqual(after.illegalRemoteCalls, before.illegalRemoteCalls, `${label}: no illegal RPCs; evidence=${evidence}`)
  assert.deepEqual(after.timerEvents, before.timerEvents, `${label}: zero new timer events; evidence=${evidence}`)
  assert.deepEqual(after.pendingTimerIds, before.pendingTimerIds, `${label}: pending timers unchanged; evidence=${evidence}`)
  assert.deepEqual(after.selectors, before.selectors, `${label}: zero new selector queries; evidence=${evidence}`)
  assert.deepEqual(after.scrolls, before.scrolls, `${label}: zero new scrolls; evidence=${evidence}`)
}

test('old rendered Pin from panel A is inert after close and reopen B; current B Pin remains valid', async (t) => {
  const env = await setup()
  t.after(() => env.mounted.cleanup())
  let root = await openAndSelect(env, taskT.taskId)
  const oldPin = captureDetailAction(root, 'pin', taskT.taskId)
  await closeTaskCenter(env)
  root = await openAndSelect(env, taskT.taskId)
  const before = record(env, 'panel-B-before-old-A-pin', root)
  const beforeEvidence = JSON.stringify({ before, timeline: env.timeline }, null, 2)
  t.diagnostic(`Prewritten oracle: replaying saved rendered panel-A Pin must not add the same T member to panel B.\n${beforeEvidence}`)
  assert.equal(before.panelOpen, true, `panel B is open; evidence=${beforeEvidence}`)
  assert.equal(before.detail?.taskId, taskT.taskId, `panel B selects the same task identity; evidence=${beforeEvidence}`)
  assert.deepEqual(before.quickAccessMembers, [], `T is not pinned before old callback; evidence=${beforeEvidence}`)
  oldPin()
  await env.runtime.settle()
  const afterOld = record(env, 'panel-B-after-old-A-pin')
  expectNoActionEffects(t, env, before, afterOld, 'saved panel-A Pin after B reopen')

  root = env.runtime.getRoot()
  captureDetailAction(root, 'pin', taskT.taskId)()
  await env.runtime.settle()
  const afterCurrent = record(env, 'panel-B-after-current-pin')
  const positiveEvidence = JSON.stringify({ before, afterOld, afterCurrent, timeline: env.timeline }, null, 2)
  t.diagnostic(positiveEvidence)
  assert.deepEqual(afterCurrent.quickAccessMembers, [{ taskId: taskT.taskId, sourceConversationId: taskT.sourceConversationId }], `current B Pin still adds T; evidence=${positiveEvidence}`)
  assert.equal(afterCurrent.setterCalls, afterOld.setterCalls + 1, `current B Pin performs its state update; evidence=${positiveEvidence}`)
  assert.deepEqual(afterCurrent.remoteCalls, afterOld.remoteCalls, `Pin remains local and adds no RPC; evidence=${positiveEvidence}`)
})

test('old rendered Unpin from panel A is inert after close and reopen B; current B Unpin remains valid', async (t) => {
  const env = await setup()
  t.after(() => env.mounted.cleanup())
  let root = await openAndSelect(env, taskT.taskId)
  captureDetailAction(root, 'pin', taskT.taskId)()
  await env.runtime.settle()
  root = env.runtime.getRoot()
  const oldUnpin = captureDetailAction(root, 'unpin', taskT.taskId)
  await closeTaskCenter(env)
  root = await openAndSelect(env, taskT.taskId)
  const before = record(env, 'panel-B-before-old-A-unpin', root)
  const beforeEvidence = JSON.stringify({ before, timeline: env.timeline }, null, 2)
  t.diagnostic(`Prewritten oracle: replaying saved rendered panel-A Unpin must preserve the same live T membership in panel B.\n${beforeEvidence}`)
  assert.deepEqual(before.quickAccessMembers, [{ taskId: taskT.taskId, sourceConversationId: taskT.sourceConversationId }], `the same T member remains live; evidence=${beforeEvidence}`)
  assert.equal(before.detail?.taskId, taskT.taskId, `panel B selects T; evidence=${beforeEvidence}`)
  oldUnpin()
  await env.runtime.settle()
  const afterOld = record(env, 'panel-B-after-old-A-unpin')
  expectNoActionEffects(t, env, before, afterOld, 'saved panel-A Unpin after B reopen')

  root = env.runtime.getRoot()
  captureDetailAction(root, 'unpin', taskT.taskId)()
  await env.runtime.settle()
  const afterCurrent = record(env, 'panel-B-after-current-unpin')
  const positiveEvidence = JSON.stringify({ before, afterOld, afterCurrent, timeline: env.timeline }, null, 2)
  t.diagnostic(positiveEvidence)
  assert.deepEqual(afterCurrent.quickAccessMembers, [], `current B Unpin removes T; evidence=${positiveEvidence}`)
  assert.equal(afterCurrent.setterCalls, afterOld.setterCalls + 1, `current B Unpin performs its state update; evidence=${positiveEvidence}`)
  assert.deepEqual(afterCurrent.remoteCalls, afterOld.remoteCalls, `Unpin remains local and adds no RPC; evidence=${positiveEvidence}`)
})

test('old T detail Unpin cannot remove T after selecting U in the same panel', async (t) => {
  const env = await setup()
  t.after(() => env.mounted.cleanup())
  let root = await openAndSelect(env, taskT.taskId)
  captureDetailAction(root, 'pin', taskT.taskId)()
  await env.runtime.settle()
  root = env.runtime.getRoot()
  const oldTUnpin = captureDetailAction(root, 'unpin', taskT.taskId)
  requireOne(root, (node) => node.props?.['data-wo-task-center-row'] === taskU.taskId, 'rendered Task U row').props.onClick(mockEvent())
  await env.runtime.settle()
  const before = record(env, 'same-panel-U-selected-before-old-T-unpin')
  const beforeEvidence = JSON.stringify({ before, timeline: env.timeline }, null, 2)
  t.diagnostic(beforeEvidence)
  assert.equal(before.detail?.taskId, taskU.taskId, `U is the live detail; evidence=${beforeEvidence}`)
  assert.deepEqual(before.quickAccessMembers, [{ taskId: taskT.taskId, sourceConversationId: taskT.sourceConversationId }], `T is still pinned while U is selected; evidence=${beforeEvidence}`)
  oldTUnpin()
  await env.runtime.settle()
  const after = record(env, 'same-panel-after-old-T-unpin')
  expectNoActionEffects(t, env, before, after, 'saved T Unpin while U is selected')

  root = await selectTask(env, taskT.taskId)
  captureDetailAction(root, 'unpin', taskT.taskId)()
  await env.runtime.settle()
  const afterCurrent = record(env, 'same-panel-current-T-unpin')
  const positiveEvidence = JSON.stringify({ before, after, afterCurrent, timeline: env.timeline }, null, 2)
  t.diagnostic(positiveEvidence)
  assert.deepEqual(afterCurrent.quickAccessMembers, [], `current T Unpin remains valid after reselection; evidence=${positiveEvidence}`)
})

test('non-Reload replacement invalidates an old Pin without disturbing the current detail action', async (t) => {
  const env = await setup()
  t.after(() => env.mounted.cleanup())
  let root = await openAndSelect(env, taskT.taskId)
  const oldPin = captureDetailAction(root, 'pin', taskT.taskId)
  requireOne(root, (node) => node.props?.['data-wo-task-center'] === 'true', 'rendered All Tasks replacement').props.onClick(mockEvent())
  await env.runtime.settle()
  root = env.runtime.getRoot()
  const before = record(env, 'after-non-Reload-replacement-before-old-pin', root)
  const evidenceBefore = JSON.stringify({ before, timeline: env.timeline }, null, 2)
  t.diagnostic(evidenceBefore)
  assert.equal(before.panelOpen, true, `replacement panel remains open; evidence=${evidenceBefore}`)
  assert.equal(before.detail?.taskId, taskT.taskId, `replacement preserves selected T; evidence=${evidenceBefore}`)
  assert.deepEqual(before.quickAccessMembers, [], `T remains unpinned before replay; evidence=${evidenceBefore}`)
  oldPin()
  await env.runtime.settle()
  const afterOld = record(env, 'after-non-Reload-replacement-old-pin')
  expectNoActionEffects(t, env, before, afterOld, 'old Pin after non-Reload replacement')

  captureDetailAction(env.runtime.getRoot(), 'pin', taskT.taskId)()
  await env.runtime.settle()
  const afterCurrent = record(env, 'after-non-Reload-replacement-current-pin')
  const positiveEvidence = JSON.stringify({ before, afterOld, afterCurrent, timeline: env.timeline }, null, 2)
  t.diagnostic(positiveEvidence)
  assert.deepEqual(afterCurrent.quickAccessMembers, [{ taskId: taskT.taskId, sourceConversationId: taskT.sourceConversationId }], `replacement panel's current Pin works; evidence=${positiveEvidence}`)
})

test('same-panel Reload and relation navigation preserve valid captured T Pin and Unpin callbacks', async (t) => {
  const env = await setup()
  t.after(() => env.mounted.cleanup())
  let root = await openAndSelect(env, taskT.taskId)
  const savedPin = captureDetailAction(root, 'pin', taskT.taskId)
  const reload = deferred()
  env.taskLedgerQueue.push(reload.promise)
  requireOne(root, (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'rendered Reload').props.onClick(mockEvent())
  await env.runtime.settle()
  const loading = record(env, 'same-panel-Reload-loading')
  reload.resolve({ ok: true, value: makeLedger(2) })
  await env.runtime.settle()
  root = env.runtime.getRoot()
  const ready = record(env, 'same-panel-Reload-ready')
  const reloadEvidence = JSON.stringify({ loading, ready, timeline: env.timeline }, null, 2)
  t.diagnostic(reloadEvidence)
  assert.equal(loading.status?.value, 'loading', `Reload entered controlled loading; evidence=${reloadEvidence}`)
  assert.equal(ready.status?.value, 'ready', `same-panel Reload resolved; evidence=${reloadEvidence}`)
  assert.equal(ready.detail?.taskId, taskT.taskId, `Reload preserved T identity; evidence=${reloadEvidence}`)
  savedPin()
  await env.runtime.settle()
  root = env.runtime.getRoot()
  const afterSavedPin = record(env, 'saved-T-pin-after-Reload')
  assert.deepEqual(afterSavedPin.quickAccessMembers, [{ taskId: taskT.taskId, sourceConversationId: taskT.sourceConversationId }], `saved T Pin remains valid after Reload; evidence=${JSON.stringify({ ready, afterSavedPin, timeline: env.timeline })}`)
  const savedUnpin = captureDetailAction(root, 'unpin', taskT.taskId)

  requireOne(root, (node) => node.props?.['data-wo-task-child-view'] === taskU.taskId, 'rendered View Child U').props.onClick(mockEvent())
  await env.runtime.settle()
  const selectedU = record(env, 'relation-navigation-to-U')
  root = env.runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-task-parent-view'] === taskT.taskId, 'rendered View Parent T').props.onClick(mockEvent())
  await env.runtime.settle()
  root = env.runtime.getRoot()
  const selectedT = record(env, 'relation-navigation-back-to-T')
  const relationEvidence = JSON.stringify({ afterSavedPin, selectedU, selectedT, timeline: env.timeline }, null, 2)
  t.diagnostic(relationEvidence)
  assert.equal(selectedU.detail?.taskId, taskU.taskId, `legal child navigation selects U; evidence=${relationEvidence}`)
  assert.equal(selectedT.detail?.taskId, taskT.taskId, `legal parent navigation returns to T in same panel; evidence=${relationEvidence}`)
  savedUnpin()
  await env.runtime.settle()
  const afterSavedUnpin = record(env, 'saved-T-unpin-after-relation-navigation')
  const finalEvidence = JSON.stringify({ selectedT, afterSavedUnpin, timeline: env.timeline }, null, 2)
  t.diagnostic(finalEvidence)
  assert.deepEqual(afterSavedUnpin.quickAccessMembers, [], `valid captured T Unpin still works after relation navigation; evidence=${finalEvidence}`)
})

test('current detail Unpin remains available in error render with the last observed ledger', async (t) => {
  const env = await setup()
  t.after(() => env.mounted.cleanup())
  let root = await openAndSelect(env, taskT.taskId)
  captureDetailAction(root, 'pin', taskT.taskId)()
  await env.runtime.settle()
  root = env.runtime.getRoot()
  const reload = deferred()
  env.taskLedgerQueue.push(reload.promise)
  requireOne(root, (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'rendered Reload before rejection').props.onClick(mockEvent())
  await env.runtime.settle()
  reload.reject(new Error('synthetic FP-133 Reload rejection'))
  await env.runtime.settle()
  root = env.runtime.getRoot()
  const stale = record(env, 'Reload-error-with-retained-ledger')
  const beforeEvidence = JSON.stringify({ stale, timeline: env.timeline }, null, 2)
  t.diagnostic(beforeEvidence)
  assert.equal(stale.status?.value, 'error', `Reload rejection rendered error; evidence=${beforeEvidence}`)
  assert.equal(stale.detail?.taskId, taskT.taskId, `last selected T remains visible; evidence=${beforeEvidence}`)
  assert.deepEqual(stale.quickAccessMembers, [{ taskId: taskT.taskId, sourceConversationId: taskT.sourceConversationId }], `T remains pinned before current stale Unpin; evidence=${beforeEvidence}`)
  captureDetailAction(root, 'unpin', taskT.taskId)()
  await env.runtime.settle()
  const after = record(env, 'current-Unpin-after-Reload-error')
  const afterEvidence = JSON.stringify({ stale, after, timeline: env.timeline }, null, 2)
  t.diagnostic(afterEvidence)
  assert.deepEqual(after.quickAccessMembers, [], `existing current Unpin cleanup still works in error/stale render; evidence=${afterEvidence}`)
  assert.deepEqual(after.remoteCalls, stale.remoteCalls, `stale Unpin adds no RPC; evidence=${afterEvidence}`)
})

test('saved detail callbacks are inert immediately after Close render and after unmount', async (t) => {
  const env = await setup()
  let mountedCleanupDone = false
  t.after(async () => {
    if (env.runtime.isMounted()) env.runtime.unmount()
    if (!mountedCleanupDone) {
      await env.mounted.cleanup()
      mountedCleanupDone = true
    }
  })
  let root = await openAndSelect(env, taskT.taskId)
  const savedPin = captureDetailAction(root, 'pin', taskT.taskId)
  requireOne(root, (node) => node.props?.['data-wo-task-center-close'] === 'true', 'rendered Close before inert callback').props.onClick()
  const beforeCloseRender = record(env, 'synchronous-Close-state-before-render')
  savedPin()
  const afterImmediateReplay = record(env, 'saved-Pin-called-before-Close-render')
  expectNoActionEffects(t, env, beforeCloseRender, afterImmediateReplay, 'saved detail Pin immediately after Close handler')
  await env.runtime.settle()
  const beforeCloseReplay = record(env, 'after-Close-render-before-saved-Pin')
  assert.equal(beforeCloseReplay.panelOpen, false, `Close has rendered before saved callback; evidence=${JSON.stringify(beforeCloseReplay)}`)
  savedPin()
  await env.runtime.settle()
  const afterCloseReplay = record(env, 'after-saved-Pin-after-Close')
  expectNoActionEffects(t, env, beforeCloseReplay, afterCloseReplay, 'saved detail Pin after Close')

  root = await openAndSelect(env, taskT.taskId)
  const savedUnmountPin = captureDetailAction(root, 'pin', taskT.taskId)
  savedUnmountPin()
  await env.runtime.settle()
  root = env.runtime.getRoot()
  const savedUnpin = captureDetailAction(root, 'unpin', taskT.taskId)
  const beforeRuntimeUnmount = record(env, 'before-runtime-unmount-with-saved-Pin-and-Unpin', root)
  beforeRuntimeUnmount.runtimeMounted = env.runtime.isMounted()
  beforeRuntimeUnmount.runtimeStats = { ...env.runtime.stats }
  beforeRuntimeUnmount.stateReferenceMaps = env.snapshotMapRefs()

  const effectCleanupsBefore = env.runtime.stats.effectCleanups
  const unmountsBefore = env.runtime.stats.unmounts
  env.runtime.unmount()
  const afterRuntimeUnmount = recordUnmountProbe(env, 'after-runtime-unmount-before-mounted-cleanup')
  await env.mounted.cleanup()
  mountedCleanupDone = true
  const afterBothCleanups = recordUnmountProbe(env, 'after-both-cleanups-before-saved-callbacks')

  const baseline = {
    runtimeMounted: afterBothCleanups.runtimeMounted,
    runtimePending: afterBothCleanups.runtimePending,
    runtimeStats: afterBothCleanups.runtimeStats,
    mountedLifecycle: afterBothCleanups.mountedLifecycle,
    setterCalls: afterBothCleanups.setterCalls,
    taskLedgerCalls: afterBothCleanups.taskLedgerCalls,
    remoteCalls: afterBothCleanups.remoteCalls,
    illegalRemoteCalls: afterBothCleanups.illegalRemoteCalls,
    timerEvents: afterBothCleanups.timerEvents,
    pendingTimerIds: afterBothCleanups.pendingTimerIds,
    stateReferenceMaps: afterBothCleanups.stateReferenceMaps
  }
  const callbackErrors = []
  try { savedUnpin() } catch (error) { callbackErrors.push({ callback: 'saved-Unpin', message: String(error) }) }
  const afterSavedUnpin = recordUnmountProbe(env, 'after-saved-Unpin-after-both-cleanups')
  try { savedUnmountPin() } catch (error) { callbackErrors.push({ callback: 'saved-Pin', message: String(error) }) }
  const afterSavedPin = recordUnmountProbe(env, 'after-saved-Pin-after-both-cleanups')
  const unmountEvidence = JSON.stringify({
    beforeRuntimeUnmount,
    afterRuntimeUnmount,
    afterBothCleanups,
    baseline,
    afterSavedUnpin,
    afterSavedPin,
    callbackErrors,
    timeline: env.timeline
  }, null, 2)
  t.diagnostic(unmountEvidence)

  assert.equal(afterRuntimeUnmount.runtimeMounted, false, `runtime.unmount() marks the runtime unmounted; evidence=${unmountEvidence}`)
  assert.equal(afterRuntimeUnmount.runtimeStats.unmounts, unmountsBefore + 1, `runtime unmount count increments; evidence=${unmountEvidence}`)
  assert.ok(afterRuntimeUnmount.runtimeStats.effectCleanups > effectCleanupsBefore, `runtime unmount executes effect cleanup; evidence=${unmountEvidence}`)
  assert.equal(afterBothCleanups.mountedLifecycle.mountDisposed, afterRuntimeUnmount.mountedLifecycle.mountDisposed + 1, `mounted cleanup is awaited after runtime unmount; evidence=${unmountEvidence}`)
  assert.equal(baseline.runtimeMounted, false, `the callback baseline is after runtime unmount; evidence=${unmountEvidence}`)
  assert.deepEqual(callbackErrors, [], `saved callbacks do not throw; evidence=${unmountEvidence}`)
  for (const [label, after] of [['saved Unpin', afterSavedUnpin], ['saved Pin', afterSavedPin]]) {
    assert.equal(after.runtimeMounted, baseline.runtimeMounted, `${label}: runtime mount state is unchanged; evidence=${unmountEvidence}`)
    assert.equal(after.runtimePending, baseline.runtimePending, `${label}: no render was requested; evidence=${unmountEvidence}`)
    assert.deepEqual(after.runtimeStats, baseline.runtimeStats, `${label}: runtime stats are unchanged; evidence=${unmountEvidence}`)
    assert.deepEqual(after.mountedLifecycle, baseline.mountedLifecycle, `${label}: mounted lifecycle is unchanged; evidence=${unmountEvidence}`)
    assert.equal(after.setterCalls, baseline.setterCalls, `${label}: zero new state setters; evidence=${unmountEvidence}`)
    assert.equal(after.taskLedgerCalls, baseline.taskLedgerCalls, `${label}: zero new task ledger calls; evidence=${unmountEvidence}`)
    assert.deepEqual(after.remoteCalls, baseline.remoteCalls, `${label}: zero new RPCs; evidence=${unmountEvidence}`)
    assert.deepEqual(after.illegalRemoteCalls, baseline.illegalRemoteCalls, `${label}: zero illegal RPCs; evidence=${unmountEvidence}`)
    assert.deepEqual(after.timerEvents, baseline.timerEvents, `${label}: zero new timer events; evidence=${unmountEvidence}`)
    assert.deepEqual(after.pendingTimerIds, baseline.pendingTimerIds, `${label}: pending timers are unchanged; evidence=${unmountEvidence}`)
    assert.deepEqual(after.stateReferenceMaps, baseline.stateReferenceMaps, `${label}: live map references and entries are unchanged; evidence=${unmountEvidence}`)
  }
})
