import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createHooksRuntime,
  createRemoteProxy,
  createZodTestDouble,
  extractTaskCenterState,
  findAll,
  findOne,
  mountClientApplication,
  requireOne,
  textOf
} from '../scripts/lib/c3a-synthetic-component-runtime.mjs'

const baseSnapshot = Object.freeze({
  rootId: 'root',
  revision: 1,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root' },
    { id: 'workspace', parentId: 'root', kind: 'workspace', title: 'Workspace', directory: 'C:\\synthetic', nativeWorkspaceId: 'native-workspace' },
    { id: 'source-a', parentId: 'workspace', kind: 'conversation', title: 'Source A', sessionId: 'session-a' },
    { id: 'source-b', parentId: 'workspace', kind: 'conversation', title: 'Source B', sessionId: 'session-b' }
  ]
})
const baseStatus = Object.freeze({ conversationsCreatable: true, sessionSource: 'task-center-close-lifecycle-test' })
const sourceA = Object.freeze({
  conversationId: 'source-a', sessionId: 'session-a', workspaceLogicalId: 'workspace',
  nativeWorkspaceId: 'native-workspace', directory: 'C:\\synthetic', verifiedAt: '2026-10-29T00:00:00.000Z',
  verificationState: 'verified', hostVersion: '0.2.1-rc.2'
})
const sourceB = Object.freeze({ ...sourceA, conversationId: 'source-b', sessionId: 'session-b' })
const taskA = Object.freeze({
  taskId: 'task-A', label: 'Task A', sourceConversationId: 'source-a',
  parent: { kind: 'conversation', conversationId: 'source-a' }, childSessionId: 'session-task-A',
  depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-29T00:00:01.000Z'
})
const taskB = Object.freeze({
  taskId: 'task-B', label: 'Task B', sourceConversationId: 'source-b',
  parent: { kind: 'conversation', conversationId: 'source-b' }, childSessionId: 'session-task-B',
  depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-29T00:00:02.000Z'
})
const taskAChild = Object.freeze({
  taskId: 'task-A-child', label: 'Task A child', sourceConversationId: 'source-a',
  parent: { kind: 'task', taskId: 'task-A' }, childSessionId: 'session-task-A-child',
  depth: 1, mode: 'code', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-29T00:00:03.000Z'
})

function makeLedger({ revision = 1, includeChild = false } = {}) {
  return {
    revision,
    sources: [sourceA, sourceB],
    tasks: includeChild ? [taskA, taskAChild, taskB] : [taskA, taskB]
  }
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
    },
    flush() {
      const callbacks = [...pending.entries()]
      pending.clear()
      for (const [id, callback] of callbacks) {
        events.push({ action: 'fire', id })
        callback()
      }
    }
  }
}

async function setup({ ledgers = [makeLedger()], taskLedgerHandler } = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  let stateSetterCalls = 0
  const originalUseState = runtime.React.useState.bind(runtime.React)
  runtime.React.useState = (initialValue) => {
    const [value, setState] = originalUseState(initialValue)
    return [value, (...args) => {
      stateSetterCalls += 1
      return setState(...args)
    }]
  }
  const timerQueue = makeTimerQueue()
  const scrolled = []
  const remote = createRemoteProxy({ snapshot: baseSnapshot, status: baseStatus, ledgers })
  if (typeof taskLedgerHandler === 'function') {
    remote.allowed.taskLedger = async (...args) => {
      remote.calls.push({ method: 'taskLedger', args })
      return taskLedgerHandler(...args)
    }
  }
  const mounted = await mountClientApplication({
    source,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote,
    document: {
      querySelector(selector) {
        return {
          scrollIntoView(options) {
            scrolled.push({ selector, block: options?.block, optionKeys: Object.keys(options ?? {}) })
          }
        }
      }
    },
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()
  return {
    runtime,
    remote,
    mounted,
    timerQueue,
    scrolled,
    get stateSetterCalls() { return stateSetterCalls },
    resetStateSetterCalls() { stateSetterCalls = 0 }
  }
}

function observeView(runtime) {
  const root = runtime.getRoot()
  const feedbackNode = findOne(root, (node) => node.props?.['data-wo-task-center-locate-feedback'] === 'true')
  const filter = findOne(root, (node) => node.props?.['data-wo-task-center-filter-select'] === 'true')
  const taskCenter = extractTaskCenterState(root)
  return {
    panelOpen: findOne(root, (node) => node.props?.['data-wo-task-center-panel'] === 'true') !== null,
    status: taskCenter.status,
    error: taskCenter.error,
    stale: taskCenter.stale,
    rows: taskCenter.rows,
    detailId: taskCenter.detailId,
    sourceStale: taskCenter.sourceStale,
    sourceStaleAttr: taskCenter.sourceStaleAttr,
    selectedTreeIds: findAll(root, (node) => node.props?.['data-wo-selected'] === 'true').map((node) => node.props['data-wo-node-id']),
    filterValue: filter?.props?.value ?? null,
    feedback: feedbackNode === null ? null : {
      state: feedbackNode.props['data-wo-task-center-locate-state'] ?? null,
      text: textOf(feedbackNode)
    }
  }
}

function assertSameList(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`)
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(actual[index], expected[index], `${label}[${index}]`)
  }
}

function assertSameView(actual, expected, label = 'visible panel state') {
  for (const field of ['panelOpen', 'status', 'error', 'stale', 'detailId', 'sourceStale', 'sourceStaleAttr', 'filterValue']) {
    assert.equal(actual[field], expected[field], `${label}.${field}`)
  }
  assertSameList(actual.rows, expected.rows, `${label}.rows`)
  assertSameList(actual.selectedTreeIds, expected.selectedTreeIds, `${label}.selectedTreeIds`)
  assert.equal(actual.feedback?.state ?? null, expected.feedback?.state ?? null, `${label}.feedback.state`)
  assert.equal(actual.feedback?.text ?? null, expected.feedback?.text ?? null, `${label}.feedback.text`)
}

function closeCallback(runtime) {
  return requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-close'] === 'true', 'Close').props.onClick
}

function rowCallback(runtime, taskId) {
  return requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === taskId, `Task row ${taskId}`).props.onClick
}

function locateCallback(runtime, taskId) {
  return requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate'] === taskId, `Locate ${taskId}`).props.onClick
}

async function openTasks(runtime) {
  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center'] === 'true', 'All Tasks').props.onClick()
  await runtime.settle()
}

async function selectTask(runtime, taskId) {
  rowCallback(runtime, taskId)()
  await runtime.settle()
}

function record(env, step) {
  return {
    step,
    view: observeView(env.runtime),
    stateSetterCalls: env.stateSetterCalls,
    rpcLedger: env.remote.calls.map((call) => ({ method: call.method, args: call.args })),
    timerLedger: [...env.timerQueue.events],
    pendingTimerIds: [...env.timerQueue.pending.keys()],
    renderCount: env.runtime.stats.renders,
    scrolled: [...env.scrolled]
  }
}

function assertNoStaleCloseEffects(env, before, after, label) {
  assert.equal(env.stateSetterCalls, 0, `${label}: zero state setter calls`)
  assertSameView(after.view, before.view, `${label}: visible state`)
  assert.equal(JSON.stringify(after.rpcLedger), JSON.stringify(before.rpcLedger), `${label}: RPC ledger unchanged`)
  assert.equal(JSON.stringify(after.timerLedger), JSON.stringify(before.timerLedger), `${label}: timer ledger unchanged`)
  assert.equal(JSON.stringify(after.pendingTimerIds), JSON.stringify(before.pendingTimerIds), `${label}: pending timer IDs unchanged`)
  assert.equal(after.renderCount, before.renderCount, `${label}: no render requested`)
}

function assertReadOnlyCalls(env) {
  for (const call of env.remote.calls) {
    assert.ok(['snapshot', 'status', 'taskLedger'].includes(call.method), `unexpected RPC method: ${call.method}`)
  }
  assert.equal(env.remote.illegal.length, 0, 'no mutation, reconcile, openSession, or other unsupported RPC')
}

async function cleanup(env) {
  await env.mounted.cleanup()
  env.runtime.unmount()
}

test('saved A Close has zero effect on reopened B and its pending Locate timer', async (t) => {
  const ledger = makeLedger()
  const env = await setup({ ledgers: [ledger, ledger] })
  const timeline = []
  try {
    await openTasks(env.runtime)
    const savedAClose = closeCallback(env.runtime)
    timeline.push(record(env, 'A open; captured real rendered Close callback'))

    savedAClose()
    await env.runtime.settle()
    timeline.push(record(env, 'A closed through its current Close callback'))

    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-B')
    locateCallback(env.runtime, 'task-B')()
    await env.runtime.settle()
    const before = record(env, 'B open, task-B selected, B Locate pending')
    env.resetStateSetterCalls()

    savedAClose()
    await env.runtime.settle()
    const after = record(env, 'saved A Close invoked in panel B')
    assertNoStaleCloseEffects(env, before, after, 'saved A Close')
    assert.equal(before.view.panelOpen, true)
    assert.equal(before.view.detailId, 'task-B')
    assert.equal(before.pendingTimerIds.length, 1, 'B Locate timer was pending before stale callback')
    timeline.push(after)

    env.timerQueue.flush()
    await env.runtime.settle()
    assert.equal(env.scrolled.length, 1, 'B Locate timer fires exactly once')
    assert.equal(env.scrolled[0].selector, '[data-wo-node-id="source-b"]', 'B Locate uses the exact source selector')
    assert.equal(env.scrolled[0].block, 'center', 'B Locate keeps centered scroll behavior')
    assert.equal(Object.hasOwn(env.scrolled[0], 'block'), true)
    assert.equal(JSON.stringify(env.scrolled[0].optionKeys), JSON.stringify(['block']), 'scroll options contain only own block key')
    assert.equal(observeView(env.runtime).feedback?.state, 'located')
    timeline.push(record(env, 'B Locate timer flushed and completed'))
    assertReadOnlyCalls(env)
  } finally {
    await cleanup(env)
    timeline.push(record(env, 'component cleanup completed'))
    t.diagnostic(JSON.stringify({ timeline, finalRpcLedger: env.remote.calls, finalTimerLedger: env.timerQueue.events, finalPendingTimerIds: [...env.timerQueue.pending.keys()], scrolled: env.scrolled }, null, 2))
  }
})

test('non-Reload replacement and synchronous duplicate Close callbacks are isolated', async (t) => {
  const ledger = makeLedger()
  const env = await setup({ ledgers: [ledger, ledger] })
  const timeline = []
  try {
    await openTasks(env.runtime)
    const oldPanelClose = closeCallback(env.runtime)
    timeline.push(record(env, 'panel A open; captured Close'))

    await openTasks(env.runtime)
    const beforeReplacementStale = record(env, 'non-Reload All Tasks replacement completed')
    env.resetStateSetterCalls()
    oldPanelClose()
    await env.runtime.settle()
    const afterReplacementStale = record(env, 'old Close called after non-Reload replacement')
    assertNoStaleCloseEffects(env, beforeReplacementStale, afterReplacementStale, 'old Close after replacement')
    timeline.push(afterReplacementStale)

    const currentClose = closeCallback(env.runtime)
    env.resetStateSetterCalls()
    currentClose()
    const firstCloseSetterCalls = env.stateSetterCalls
    assert.ok(firstCloseSetterCalls > 0, 'current Close retains its state updates')
    const afterFirstSynchronousClose = record(env, 'current Close called before render')
    env.resetStateSetterCalls()
    currentClose()
    const afterDuplicateClose = record(env, 'same rendered Close callback called again before render')
    assert.equal(env.stateSetterCalls, 0, 'duplicate stale callback writes no state before rerender')
    assert.equal(JSON.stringify(afterDuplicateClose.rpcLedger), JSON.stringify(afterFirstSynchronousClose.rpcLedger), 'duplicate close sends no RPC')
    assert.equal(JSON.stringify(afterDuplicateClose.timerLedger), JSON.stringify(afterFirstSynchronousClose.timerLedger), 'duplicate close changes no timers')
    assert.equal(JSON.stringify(afterDuplicateClose.pendingTimerIds), JSON.stringify(afterFirstSynchronousClose.pendingTimerIds), 'duplicate close preserves pending timer IDs')
    timeline.push(afterDuplicateClose)
    await env.runtime.settle()
    assert.equal(observeView(env.runtime).panelOpen, false, 'first current Close still closes the panel')
    assertReadOnlyCalls(env)
  } finally {
    await cleanup(env)
    timeline.push(record(env, 'component cleanup completed'))
    t.diagnostic(JSON.stringify({ timeline, finalRpcLedger: env.remote.calls, finalTimerLedger: env.timerQueue.events }, null, 2))
  }
})

test('saved Close after unmount has zero state, RPC, and timer effects', async (t) => {
  const env = await setup({ ledgers: [makeLedger()] })
  const timeline = []
  let cleaned = false
  try {
    await openTasks(env.runtime)
    const savedClose = closeCallback(env.runtime)
    const beforeUnmount = record(env, 'panel open; captured Close')
    timeline.push(beforeUnmount)

    await env.mounted.cleanup()
    env.runtime.unmount()
    cleaned = true
    const beforeStaleCallback = record(env, 'component unmounted')
    env.resetStateSetterCalls()
    savedClose()
    await env.runtime.settle()
    const afterStaleCallback = record(env, 'saved Close called after unmount')
    assertNoStaleCloseEffects(env, beforeStaleCallback, afterStaleCallback, 'saved Close after unmount')
    timeline.push(afterStaleCallback)
    assertReadOnlyCalls(env)
  } finally {
    if (!cleaned) await cleanup(env)
    t.diagnostic(JSON.stringify({ timeline, finalRpcLedger: env.remote.calls, finalTimerLedger: env.timerQueue.events }, null, 2))
  }
})

test('stale A Close does not invalidate a pending B taskLedger response', async (t) => {
  const pendingB = deferred()
  let taskLedgerCalls = 0
  const env = await setup({
    taskLedgerHandler: () => {
      taskLedgerCalls += 1
      return taskLedgerCalls === 1 ? makeLedger() : pendingB.promise
    }
  })
  const timeline = []
  try {
    await openTasks(env.runtime)
    const savedAClose = closeCallback(env.runtime)
    timeline.push(record(env, 'panel A open; captured Close'))
    savedAClose()
    await env.runtime.settle()

    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center'] === 'true', 'All Tasks B').props.onClick()
    await env.runtime.settle()
    assert.equal(observeView(env.runtime).panelOpen, true, 'panel B is open while its ledger read is pending')
    assert.equal(observeView(env.runtime).status, 'Tasks ledger: loading (rev 1)')
    const before = record(env, 'panel B loading with deferred taskLedger read')
    env.resetStateSetterCalls()
    savedAClose()
    await env.runtime.settle()
    const after = record(env, 'saved A Close invoked during pending B read')
    assertNoStaleCloseEffects(env, before, after, 'saved A Close during B read')
    timeline.push(after)

    pendingB.resolve(makeLedger({ revision: 2 }))
    await env.runtime.settle()
    assert.equal(taskLedgerCalls, 2, 'B load dispatched exactly one taskLedger RPC')
    assert.equal(observeView(env.runtime).panelOpen, true, 'B remains open after the read resolves')
    assert.equal(observeView(env.runtime).status, 'Tasks ledger: ready (rev 2)', 'pending B read was accepted')
    timeline.push(record(env, 'B ledger response accepted after stale A callback'))
    assertReadOnlyCalls(env)
  } finally {
    await cleanup(env)
    timeline.push(record(env, 'component cleanup completed'))
    t.diagnostic(JSON.stringify({ timeline, finalRpcLedger: env.remote.calls, finalTimerLedger: env.timerQueue.events }, null, 2))
  }
})

test('current Close remains valid after Reload, relation navigation, and an error render', async (t) => {
  let taskLedgerCalls = 0
  let rejectNextTaskLedger = false
  const taskLedgerOutcomes = []
  const ledger = makeLedger({ includeChild: true })
  const env = await setup({
    taskLedgerHandler: () => {
      taskLedgerCalls += 1
      if (rejectNextTaskLedger) {
        rejectNextTaskLedger = false
        taskLedgerOutcomes.push({ call: taskLedgerCalls, outcome: 'rejected' })
        throw new Error('synthetic read failure')
      }
      taskLedgerOutcomes.push({ call: taskLedgerCalls, outcome: 'resolved', revision: ledger.revision })
      return ledger
    }
  })
  const timeline = []
  try {
    await openTasks(env.runtime)
    const closeBeforeReload = closeCallback(env.runtime)
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'Reload').props.onClick()
    await env.runtime.settle()
    assert.equal(observeView(env.runtime).status, 'Tasks ledger: ready (rev 1)')
    closeBeforeReload()
    await env.runtime.settle()
    assert.equal(observeView(env.runtime).panelOpen, false, 'Close captured before same-panel Reload remains valid')
    timeline.push(record(env, 'same-panel Reload preserved Close lifetime'))

    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-A')
    const closeBeforeRelationNavigation = closeCallback(env.runtime)
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-child-view'] === 'task-A-child', 'View Child').props.onClick()
    await env.runtime.settle()
    assert.equal(observeView(env.runtime).detailId, 'task-A-child', 'relation navigation changed the selected detail')
    assert.equal(taskLedgerCalls, 4, 'View Child ledger read completed before the error fixture is armed')
    assert.equal(taskLedgerOutcomes[3].outcome, 'resolved', 'View Child receives a successful ledger response')
    closeBeforeRelationNavigation()
    await env.runtime.settle()
    assert.equal(observeView(env.runtime).panelOpen, false, 'Close captured before relation navigation remains valid')
    timeline.push(record(env, 'relation navigation preserved Close lifetime'))

    rejectNextTaskLedger = true
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center'] === 'true', 'All Tasks error panel').props.onClick()
    await env.runtime.settle()
    assert.equal(taskLedgerCalls, 5, 'independent error/stale panel uses the next explicitly rejected read')
    assert.equal(rejectNextTaskLedger, false, 'the explicit rejection was consumed')
    assert.equal(taskLedgerOutcomes[4].outcome, 'rejected', 'error panel read is the explicit rejected response')
    const errorView = observeView(env.runtime)
    assert.equal(errorView.panelOpen, true)
    assert.equal(errorView.status, 'Tasks ledger: error (rev 1)')
    assert.ok(errorView.error !== null, 'read failure is visible')
    assert.ok(errorView.rows.length > 0, 'the last observed ledger remains visible in the error panel')
    assert.ok(errorView.stale !== null, 'the stale ledger state remains visible')
    const closeOnError = closeCallback(env.runtime)
    closeOnError()
    await env.runtime.settle()
    assert.equal(observeView(env.runtime).panelOpen, false, 'error/stale panel remains closable')
    timeline.push(record(env, 'error/stale panel closed normally'))
    assert.equal(taskLedgerCalls, 5)
    assertReadOnlyCalls(env)
  } finally {
    await cleanup(env)
    timeline.push(record(env, 'component cleanup completed'))
    t.diagnostic(JSON.stringify({ timeline, taskLedgerOutcomes, finalRpcLedger: env.remote.calls, finalTimerLedger: env.timerQueue.events }, null, 2))
  }
})

test('a valid Close discards pending taskLedger success and failure', async (t) => {
  const timelines = []
  for (const outcome of ['resolve', 'reject']) {
    const pending = deferred()
    let taskLedgerCalls = 0
    const env = await setup({
      taskLedgerHandler: () => {
        taskLedgerCalls += 1
        return taskLedgerCalls === 1 ? makeLedger() : pending.promise
      }
    })
    const timeline = []
    try {
      await openTasks(env.runtime)
      requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'Reload deferred read').props.onClick()
      await env.runtime.settle()
      const currentClose = closeCallback(env.runtime)
      currentClose()
      await env.runtime.settle()
      assert.equal(observeView(env.runtime).panelOpen, false)
      const beforeSettlement = record(env, `panel closed with pending read (${outcome})`)
      env.resetStateSetterCalls()

      if (outcome === 'resolve') pending.resolve(makeLedger({ revision: 2 }))
      else pending.reject(new Error('deferred read rejected after Close'))
      await env.runtime.settle()
      const afterSettlement = record(env, `pending read ${outcome}d after valid Close`)
      assert.equal(env.stateSetterCalls, 0, `${outcome}: discarded response invokes no setter after close`)
      assertSameView(afterSettlement.view, beforeSettlement.view, `${outcome}: closed state remains unchanged`)
      assert.equal(JSON.stringify(afterSettlement.rpcLedger), JSON.stringify(beforeSettlement.rpcLedger), `${outcome}: no extra RPC`)
      assert.equal(JSON.stringify(afterSettlement.timerLedger), JSON.stringify(beforeSettlement.timerLedger), `${outcome}: no timer change`)
      assert.equal(afterSettlement.renderCount, beforeSettlement.renderCount, `${outcome}: discarded response requests no render`)
      timeline.push(afterSettlement)
      assert.equal(taskLedgerCalls, 2)
      assertReadOnlyCalls(env)
    } finally {
      await cleanup(env)
      timeline.push(record(env, 'component cleanup completed'))
      timelines.push({ outcome, timeline, finalRpcLedger: env.remote.calls, finalTimerLedger: env.timerQueue.events })
    }
  }
  t.diagnostic(JSON.stringify({ timelines }, null, 2))
})
