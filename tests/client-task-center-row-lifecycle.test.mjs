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
const baseStatus = Object.freeze({ conversationsCreatable: true, sessionSource: 'task-center-row-lifecycle-test' })

const sourceA = Object.freeze({
  conversationId: 'source-a',
  sessionId: 'session-a',
  workspaceLogicalId: 'workspace',
  nativeWorkspaceId: 'native-workspace',
  directory: 'C:\\synthetic',
  verifiedAt: '2026-10-29T00:00:00.000Z',
  verificationState: 'verified',
  hostVersion: '0.2.1-rc.2'
})
const sourceB = Object.freeze({
  ...sourceA,
  conversationId: 'source-b',
  sessionId: 'session-b'
})

const taskA = Object.freeze({
  taskId: 'task-A',
  label: 'Task A',
  sourceConversationId: 'source-a',
  parent: { kind: 'conversation', conversationId: 'source-a' },
  childSessionId: 'session-task-A',
  depth: 0,
  mode: 'plan',
  executionState: 'running',
  executionEligibility: 'eligible',
  observedAt: '2026-10-29T00:00:01.000Z'
})
const taskB = Object.freeze({
  taskId: 'task-B',
  label: 'Task B',
  sourceConversationId: 'source-b',
  parent: { kind: 'conversation', conversationId: 'source-b' },
  childSessionId: 'session-task-B',
  depth: 0,
  mode: 'plan',
  executionState: 'running',
  executionEligibility: 'eligible',
  observedAt: '2026-10-29T00:00:02.000Z'
})
const taskAChild = Object.freeze({
  taskId: 'task-A-child',
  label: 'Task A child',
  sourceConversationId: 'source-a',
  parent: { kind: 'task', taskId: 'task-A' },
  childSessionId: 'session-task-A-child',
  depth: 1,
  mode: 'code',
  executionState: 'running',
  executionEligibility: 'eligible',
  observedAt: '2026-10-29T00:00:03.000Z'
})

function makeLedger({ includeChild = false } = {}) {
  return {
    revision: 1,
    sources: [sourceA, sourceB],
    tasks: includeChild ? [taskA, taskAChild, taskB] : [taskA, taskB]
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
            scrolled.push({
              selector,
              block: options?.block,
              optionKeys: Object.keys(options ?? {})
            })
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

async function openTasks(runtime) {
  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center'] === 'true', 'All Tasks').props.onClick()
  await runtime.settle()
}

async function closeTasks(runtime) {
  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-close'] === 'true', 'Close').props.onClick()
  await runtime.settle()
}

async function selectTask(runtime, taskId) {
  rowCallback(runtime, taskId)()
  await runtime.settle()
}

function rowCallback(runtime, taskId) {
  return requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === taskId, 'Task row ' + taskId).props.onClick
}

function locateCallback(runtime, taskId) {
  return requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate'] === taskId, 'Locate ' + taskId).props.onClick
}

function observeView(runtime) {
  const root = runtime.getRoot()
  const feedbackNode = findOne(root, (node) => node.props?.['data-wo-task-center-locate-feedback'] === 'true')
  const filter = findOne(root, (node) => node.props?.['data-wo-task-center-filter-select'] === 'true')
  return {
    panelOpen: findOne(root, (node) => node.props?.['data-wo-task-center-panel'] === 'true') !== null,
    taskCenter: extractTaskCenterState(root),
    selectedTreeIds: findAll(root, (node) => node.props?.['data-wo-selected'] === 'true').map((node) => node.props['data-wo-node-id']),
    filterValue: filter?.props?.value ?? null,
    feedback: feedbackNode === null ? null : {
      state: feedbackNode.props['data-wo-task-center-locate-state'] ?? null,
      text: textOf(feedbackNode)
    }
  }
}

function record(env, step) {
  return {
    step,
    view: observeView(env.runtime),
    stateSetterCalls: env.stateSetterCalls,
    rpcLedger: env.remote.calls.map((call) => ({ method: call.method, args: call.args })),
    timerLedger: [...env.timerQueue.events],
    pendingTimerIds: [...env.timerQueue.pending.keys()],
    renderCount: env.runtime.stats.renders
  }
}

async function cleanup(env) {
  await env.mounted.cleanup()
  env.runtime.unmount()
}

test('Old rendered A row cannot alter the reopened panel B or its pending Locate timer', async (t) => {
  const ledger = makeLedger()
  const env = await setup({ ledgers: [ledger, ledger] })
  const timeline = []
  try {
    timeline.push(record(env, 'initial render'))
    await openTasks(env.runtime)
    const oldACallback = rowCallback(env.runtime, 'task-A')
    timeline.push(record(env, 'panel A open; capture rendered A callback'))

    await closeTasks(env.runtime)
    timeline.push(record(env, 'panel A closed'))
    await openTasks(env.runtime)
    timeline.push(record(env, 'panel reopened with same ledger'))
    await selectTask(env.runtime, 'task-B')
    timeline.push(record(env, 'new panel selects B'))
    locateCallback(env.runtime, 'task-B')()
    await env.runtime.settle()
    const before = observeView(env.runtime)
    const rpcBefore = JSON.stringify(env.remote.calls)
    const timersBefore = JSON.stringify(env.timerQueue.events)
    const pendingBefore = [...env.timerQueue.pending.keys()]
    const rendersBefore = env.runtime.stats.renders
    env.resetStateSetterCalls()
    timeline.push(record(env, 'B Locate scheduled and pending'))

    oldACallback()
    await env.runtime.settle()
    const after = observeView(env.runtime)
    assert.equal(env.stateSetterCalls, 0, 'stale A callback invokes no state setters')
    assert.equal(JSON.stringify(after), JSON.stringify(before), 'stale A callback leaves every observed panel field unchanged')
    assert.equal(JSON.stringify(env.remote.calls), rpcBefore, 'stale A callback dispatches no RPC')
    assert.equal(JSON.stringify(env.timerQueue.events), timersBefore, 'stale A callback neither schedules nor cancels a timer')
    assert.deepEqual([...env.timerQueue.pending.keys()], pendingBefore, 'B pending timer remains queued')
    assert.equal(env.runtime.stats.renders, rendersBefore, 'stale A callback requests no render')
    timeline.push(record(env, 'old A callback rejected with zero side effects'))

    env.timerQueue.flush()
    await env.runtime.settle()
    assert.equal(env.scrolled.length, 1, 'the still-pending B timer scrolls once')
    assert.equal(env.scrolled[0].selector, '[data-wo-node-id="source-b"]', 'B Locate uses its exact source selector')
    assert.equal(env.scrolled[0].block, 'center', 'B Locate centers the source')
    assert.deepEqual([...env.scrolled[0].optionKeys].sort(), ['block'], 'scroll options have only the own block key')
    assert.equal(observeView(env.runtime).feedback?.state, 'located')
    timeline.push(record(env, 'B timer flushed normally'))

    const freshACallback = rowCallback(env.runtime, 'task-A')
    const rpcBeforeCurrentA = JSON.stringify(env.remote.calls)
    freshACallback()
    await env.runtime.settle()
    assert.equal(observeView(env.runtime).taskCenter.detailId, 'task-A', 'the current rendered A row still selects A')
    assert.equal(JSON.stringify(env.remote.calls), rpcBeforeCurrentA, 'current row selection is local and dispatches no RPC')
    timeline.push(record(env, 'current A row remains usable'))
    assert.deepEqual(env.remote.illegal, [])
  } finally {
    await cleanup(env)
    timeline.push(record(env, 'component cleanup completed'))
    t.diagnostic(JSON.stringify({ timeline, fullRpcLedger: env.remote.calls, fullTimerLedger: env.timerQueue.events, scrolled: env.scrolled }, null, 2))
  }
})

test('Non-Reload replacement, close-before-render, and unmount invalidate saved row callbacks', async () => {
  const ledger = makeLedger()
  const env = await setup({ ledgers: [ledger, ledger, ledger] })
  try {
    await openTasks(env.runtime)
    const oldPanelA = rowCallback(env.runtime, 'task-A')
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-B')

    const beforeReplacementCallback = JSON.stringify(observeView(env.runtime))
    const rpcBeforeReplacementCallback = JSON.stringify(env.remote.calls)
    const timersBeforeReplacementCallback = JSON.stringify(env.timerQueue.events)
    env.resetStateSetterCalls()
    oldPanelA()
    await env.runtime.settle()
    assert.equal(env.stateSetterCalls, 0, 'non-Reload panel replacement expires old row callback')
    assert.equal(JSON.stringify(observeView(env.runtime)), beforeReplacementCallback)
    assert.equal(JSON.stringify(env.remote.calls), rpcBeforeReplacementCallback)
    assert.equal(JSON.stringify(env.timerQueue.events), timersBeforeReplacementCallback)

    const callbackBeforeClose = rowCallback(env.runtime, 'task-A')
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-close'] === 'true', 'Close').props.onClick()
    const rpcAfterClose = JSON.stringify(env.remote.calls)
    const timersAfterClose = JSON.stringify(env.timerQueue.events)
    env.resetStateSetterCalls()
    callbackBeforeClose()
    assert.equal(env.stateSetterCalls, 0, 'close invalidates row callback before the close render commits')
    assert.equal(JSON.stringify(env.remote.calls), rpcAfterClose)
    assert.equal(JSON.stringify(env.timerQueue.events), timersAfterClose)
    await env.runtime.settle()
    assert.equal(observeView(env.runtime).panelOpen, false)

    await openTasks(env.runtime)
    const callbackBeforeUnmount = rowCallback(env.runtime, 'task-A')
    const rpcBeforeUnmount = JSON.stringify(env.remote.calls)
    const timersBeforeUnmount = JSON.stringify(env.timerQueue.events)
    await env.mounted.cleanup()
    env.runtime.unmount()
    env.resetStateSetterCalls()
    callbackBeforeUnmount()
    await env.runtime.settle()
    assert.equal(env.stateSetterCalls, 0, 'unmount invalidates the saved row callback before any setter')
    assert.equal(JSON.stringify(env.remote.calls), rpcBeforeUnmount)
    assert.equal(JSON.stringify(env.timerQueue.events), timersBeforeUnmount)
    assert.deepEqual(env.remote.illegal, [])
  } finally {
    if (env.runtime.isMounted()) await cleanup(env)
  }
})

test('Same-panel Reload and relation navigation preserve the rendered row lifetime', async () => {
  const ledger = makeLedger({ includeChild: true })
  const env = await setup({ ledgers: [ledger, ledger, ledger] })
  try {
    await openTasks(env.runtime)
    const savedA = rowCallback(env.runtime, 'task-A')
    await selectTask(env.runtime, 'task-B')
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'Reload').props.onClick()
    await env.runtime.settle()
    assert.equal(observeView(env.runtime).taskCenter.detailId, 'task-B', 'successful Reload retains the selected task')

    const reloadRpcCount = env.remote.calls.length
    env.resetStateSetterCalls()
    savedA()
    await env.runtime.settle()
    assert.ok(env.stateSetterCalls > 0, 'same-panel Reload does not expire the previously rendered A callback')
    assert.equal(observeView(env.runtime).taskCenter.detailId, 'task-A')
    assert.equal(env.remote.calls.length, reloadRpcCount, 'row callback after Reload dispatches no RPC')

    const savedBeforeRelationNavigation = rowCallback(env.runtime, 'task-A')
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-child-view'] === 'task-A-child', 'View Child').props.onClick()
    await env.runtime.settle()
    assert.equal(observeView(env.runtime).taskCenter.detailId, 'task-A-child', 'relationship navigation selects the child in the same panel')
    const relationRpcCount = env.remote.calls.length
    env.resetStateSetterCalls()
    savedBeforeRelationNavigation()
    await env.runtime.settle()
    assert.ok(env.stateSetterCalls > 0, 'shared navigation token changes do not expire a row callback in the same panel')
    assert.equal(observeView(env.runtime).taskCenter.detailId, 'task-A')
    assert.equal(env.remote.calls.length, relationRpcCount, 'row callback after relation navigation dispatches no RPC')
    assert.deepEqual(env.remote.illegal, [])
  } finally {
    await cleanup(env)
  }
})
