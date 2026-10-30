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
    { id: 'source-1', parentId: 'workspace', kind: 'conversation', title: 'Source', sessionId: 'session-1' }
  ]
})
const baseStatus = Object.freeze({ conversationsCreatable: true, sessionSource: 'task-relation-view-lifecycle-test' })

const parentTask = Object.freeze({
  taskId: 'task-parent',
  sourceConversationId: 'source-1',
  parent: { kind: 'conversation', conversationId: 'source-1' },
  childSessionId: 'session-parent',
  depth: 0,
  mode: 'plan',
  executionState: 'running',
  executionEligibility: 'eligible',
  observedAt: '2026-10-29T00:00:00.000Z',
  label: 'Parent P'
})
const childTask = Object.freeze({
  taskId: 'task-child',
  sourceConversationId: 'source-1',
  parent: { kind: 'task', taskId: 'task-parent' },
  childSessionId: 'session-child',
  depth: 1,
  mode: 'code',
  executionState: 'running',
  executionEligibility: 'eligible',
  observedAt: '2026-10-29T00:00:01.000Z',
  label: 'Child C'
})
const secondChildTask = Object.freeze({
  ...childTask,
  taskId: 'task-child-2',
  childSessionId: 'session-child-2',
  label: 'Child D'
})

function makeLedger(revision = 7) {
  return {
    revision,
    sources: [{
      conversationId: 'source-1',
      sessionId: 'session-1',
      workspaceLogicalId: 'workspace',
      nativeWorkspaceId: 'native-workspace',
      directory: 'C:\\synthetic',
      verifiedAt: '2026-10-29T00:00:00.000Z',
      verificationState: 'verified',
      hostVersion: '0.2.1-rc.2'
    }],
    tasks: [parentTask, childTask]
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

function observedState(root) {
  const scope = findOne(root, (node) => node.props?.['data-wo-task-center-scope'] !== undefined)
  const filter = findOne(root, (node) => node.props?.['data-wo-task-center-filter-select'] === 'true')
  const detail = findOne(root, (node) => node.props?.['data-wo-task-center-detail'] !== undefined)
  const notices = findAll(root, (node) => node.props?.['data-wo-task-center-error'] !== undefined || node.props?.['data-wo-task-center-locate-feedback'] !== undefined || node.props?.['data-wo-task-center-empty'] !== undefined || node.props?.['data-wo-task-center-source-empty'] !== undefined || node.props?.['data-wo-task-children-notice'] !== undefined || node.props?.['data-wo-task-child-notice'] !== undefined)
    .map((node) => ({
      error: node.props['data-wo-task-center-error'] ?? null,
      locate: node.props['data-wo-task-center-locate-feedback'] ?? null,
      empty: node.props['data-wo-task-center-empty'] ?? null,
      sourceEmpty: node.props['data-wo-task-center-source-empty'] ?? null,
      children: node.props['data-wo-task-children-notice'] ?? null,
      child: node.props['data-wo-task-child-notice'] ?? null,
      text: textOf(node)
    }))
  return {
    panelOpen: findOne(root, (node) => node.props?.['data-wo-task-center-panel'] === 'true') !== null,
    ...extractTaskCenterState(root),
    ledgerRows: findAll(root, (node) => node.props?.['data-wo-task-center-row'] !== undefined)
      .map((node) => ({ taskId: node.props['data-wo-task-center-row'], text: textOf(node) })),
    detailText: detail === null ? null : textOf(detail),
    scope: scope?.props?.['data-wo-task-center-scope'] ?? null,
    filterValue: filter?.props?.value ?? null,
    notices
  }
}

async function setupComponent({ ledgers = [makeLedger(), makeLedger(), makeLedger(), makeLedger()], taskLedgerHandler, sourceOverride } = {}) {
  const source = sourceOverride ?? await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  let stateWrites = 0
  const originalUseState = runtime.React.useState
  runtime.React.useState = (initial) => {
    const [value, setState] = originalUseState(initial)
    return [value, (next) => { stateWrites += 1; return setState(next) }]
  }
  const remote = createRemoteProxy({ snapshot: baseSnapshot, status: baseStatus, ledgers })
  if (typeof taskLedgerHandler === 'function') {
    remote.allowed.taskLedger = async (...args) => {
      remote.calls.push({ method: 'taskLedger', args })
      return taskLedgerHandler(...args)
    }
  }
  const mounted = await mountClientApplication({ source, react: runtime.React, zod: createZodTestDouble(), remote })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()
  return {
    runtime,
    remote,
    mounted,
    stateWriteCount: () => stateWrites,
    resetStateWrites: () => { stateWrites = 0 }
  }
}

async function openTasks(runtime) {
  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center'] === 'true', 'All Tasks').props.onClick(mockEvent())
  await runtime.settle()
}

async function selectTask(runtime, taskId) {
  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === taskId, 'Task row ' + taskId).props.onClick(mockEvent())
  await runtime.settle()
}

function parentViewCallback(runtime) {
  return requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-parent-view'] === 'task-parent', 'View Parent button').props.onClick
}

function childViewCallback(runtime) {
  return requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-child-view'] === 'task-child', 'View Child button').props.onClick
}

async function cleanup(env) {
  await env.mounted.cleanup()
  env.runtime.unmount()
}

test('1. Old View Parent callback is rejected after close/reopen and reselecting the same child; current button still works', async () => {
  const env = await setupComponent()
  try {
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-child')
    const oldCallback = parentViewCallback(env.runtime)
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-close'] === 'true', 'Close').props.onClick(mockEvent())
    const immediateCloseState = observedState(env.runtime.getRoot())
    const immediateCloseCallStart = env.remote.calls.length
    env.resetStateWrites()
    oldCallback(mockEvent())
    assert.deepEqual(env.remote.calls.slice(immediateCloseCallStart), [], 'close must expire the callback before the next render')
    assert.equal(env.stateWriteCount(), 0, 'immediately expired callback must perform no state writes')
    assert.deepEqual(observedState(env.runtime.getRoot()), immediateCloseState)
    await env.runtime.settle()
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-child')

    const before = observedState(env.runtime.getRoot())
    const callStart = env.remote.calls.length
    env.resetStateWrites()
    oldCallback(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(callStart), [], 'expired View Parent callback must dispatch no RPC')
    assert.equal(env.stateWriteCount(), 0, 'expired View Parent callback must perform no state writes')
    assert.deepEqual(observedState(env.runtime.getRoot()), before, 'expired View Parent callback must leave all visible Task Center state unchanged')

    const freshCallStart = env.remote.calls.length
    parentViewCallback(env.runtime)(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(freshCallStart).map((call) => call.method), ['taskLedger'])
    assert.equal(observedState(env.runtime.getRoot()).detailId, 'task-parent', 'newly rendered View Parent must navigate to the exact parent Task')
    assert.deepEqual(env.remote.illegal, [])
  } finally {
    await cleanup(env)
  }
})

test('2. Old View Child callback is rejected after close/reopen and reselecting the same parent; current button still works', async () => {
  const env = await setupComponent()
  try {
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-parent')
    const oldCallback = childViewCallback(env.runtime)
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-close'] === 'true', 'Close').props.onClick(mockEvent())
    await env.runtime.settle()
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-parent')

    const before = observedState(env.runtime.getRoot())
    const callStart = env.remote.calls.length
    env.resetStateWrites()
    oldCallback(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(callStart), [], 'expired View Child callback must dispatch no RPC')
    assert.equal(env.stateWriteCount(), 0, 'expired View Child callback must perform no state writes')
    assert.deepEqual(observedState(env.runtime.getRoot()), before, 'expired View Child callback must leave all visible Task Center state unchanged')

    const freshCallStart = env.remote.calls.length
    childViewCallback(env.runtime)(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(freshCallStart).map((call) => call.method), ['taskLedger'])
    assert.equal(observedState(env.runtime.getRoot()).detailId, 'task-child', 'newly rendered View Child must navigate to the exact child Task')
    assert.deepEqual(env.remote.illegal, [])
  } finally {
    await cleanup(env)
  }
})

test('2a. Non-Reload open expires an old View callback while replacing the live panel', async () => {
  const env = await setupComponent()
  try {
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-child')
    const oldCallback = parentViewCallback(env.runtime)

    await openTasks(env.runtime)
    const replacedPanelState = observedState(env.runtime.getRoot())
    assert.match(replacedPanelState.status, /ready/)
    assert.equal(replacedPanelState.detailId, 'task-child', 'the completed non-Reload open preserves the selected task as the active baseline')
    const callStart = env.remote.calls.length
    env.resetStateWrites()
    oldCallback(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(callStart), [], 'non-Reload panel replacement must expire its prior View callback')
    assert.equal(env.stateWriteCount(), 0)
    assert.deepEqual(observedState(env.runtime.getRoot()), replacedPanelState)

    const freshCallStart = env.remote.calls.length
    parentViewCallback(env.runtime)(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(freshCallStart).map((call) => call.method), ['taskLedger'])
    assert.equal(observedState(env.runtime.getRoot()).detailId, 'task-parent')
    assert.deepEqual(env.remote.illegal, [])
  } finally {
    await cleanup(env)
  }
})

test('3. Same-token Reload retaining the relationship does not invalidate an already rendered View Parent callback', async () => {
  const env = await setupComponent({ ledgers: [makeLedger(), makeLedger(), makeLedger()] })
  try {
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-child')
    const savedCallback = parentViewCallback(env.runtime)
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'Reload').props.onClick(mockEvent())
    await env.runtime.settle()
    assert.equal(observedState(env.runtime.getRoot()).detailId, 'task-child', 'Reload must retain the selected relationship')
    assert.match(observedState(env.runtime.getRoot()).status, /ready/)

    const callStart = env.remote.calls.length
    env.resetStateWrites()
    savedCallback(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(callStart).map((call) => call.method), ['taskLedger'])
    assert.equal(observedState(env.runtime.getRoot()).detailId, 'task-parent')
    assert.deepEqual(env.remote.illegal, [])
  } finally {
    await cleanup(env)
  }
})

test('3a. A committed Reload loading render still blocks its captured View callback', async () => {
  const pendingReload = deferred()
  let ledgerCalls = 0
  const env = await setupComponent({
    taskLedgerHandler: async () => {
      ledgerCalls += 1
      return ledgerCalls === 2 ? pendingReload.promise : { ok: true, value: makeLedger() }
    }
  })
  try {
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-parent')
    const savedCallback = childViewCallback(env.runtime)
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'Reload').props.onClick(mockEvent())
    await env.runtime.settle()
    const loadingState = observedState(env.runtime.getRoot())
    assert.match(loadingState.status, /loading/)

    const callStart = env.remote.calls.length
    env.resetStateWrites()
    savedCallback(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(callStart), [], 'ready guard must reject a saved callback after the loading render commits')
    assert.equal(env.stateWriteCount(), 0)
    assert.deepEqual(observedState(env.runtime.getRoot()), loadingState)
  } finally {
    pendingReload.resolve({ ok: true, value: makeLedger() })
    await cleanup(env)
  }
})

test('4. A valid relationship read completes after its own navigation increments the panel token', async () => {
  const pending = deferred()
  let ledgerCalls = 0
  const env = await setupComponent({
    taskLedgerHandler: async () => {
      ledgerCalls += 1
      return ledgerCalls === 2 ? pending.promise : { ok: true, value: makeLedger() }
    }
  })
  try {
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-parent')
    const callStart = env.remote.calls.length
    childViewCallback(env.runtime)(mockEvent())
    await env.runtime.settle()
    assert.match(observedState(env.runtime.getRoot()).status, /loading/, 'navigation must be in flight before the controlled response resolves')
    assert.deepEqual(env.remote.calls.slice(callStart).map((call) => call.method), ['taskLedger'])
    pending.resolve({ ok: true, value: makeLedger() })
    await env.runtime.settle()
    assert.equal(observedState(env.runtime.getRoot()).detailId, 'task-child', 'valid read must settle despite the token increment performed at dispatch')
    assert.match(observedState(env.runtime.getRoot()).status, /ready/)
    assert.deepEqual(env.remote.illegal, [])
  } finally {
    pending.resolve({ ok: true, value: makeLedger() })
    await cleanup(env)
  }
})

test('4a. Same-render U1 and U2 both dispatch; reverse settlement commits only U2', async () => {
  const ledger = { ...makeLedger(7), tasks: [parentTask, childTask, secondChildTask] }
  const u1 = deferred()
  const u2 = deferred()
  let ledgerCalls = 0
  const env = await setupComponent({
    taskLedgerHandler: async () => {
      ledgerCalls += 1
      if (ledgerCalls === 1) return { ok: true, value: ledger }
      return ledgerCalls === 2 ? u1.promise : u2.promise
    }
  })
  try {
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-parent')
    const root = env.runtime.getRoot()
    const u1Callback = requireOne(root, (node) => node.props?.['data-wo-task-child-view'] === 'task-child', 'U1 child View').props.onClick
    const u2Callback = requireOne(root, (node) => node.props?.['data-wo-task-child-view'] === 'task-child-2', 'U2 child View').props.onClick
    const callStart = env.remote.calls.length

    u1Callback(mockEvent())
    u2Callback(mockEvent())
    assert.deepEqual(env.remote.calls.slice(callStart).map((call) => call.method), ['taskLedger', 'taskLedger'], 'both same-render View callbacks must dispatch')

    u2.resolve({ ok: true, value: { ...ledger, revision: 9 } })
    await env.runtime.settle()
    const committedU2State = observedState(env.runtime.getRoot())
    assert.equal(committedU2State.detailId, 'task-child-2')
    assert.match(committedU2State.status, /ready/)
    assert.match(committedU2State.status, /rev 9/)

    env.resetStateWrites()
    u1.resolve({ ok: true, value: { ...ledger, revision: 8 } })
    await env.runtime.settle()
    assert.equal(env.stateWriteCount(), 0, 'late U1 settlement must not write state')
    assert.deepEqual(observedState(env.runtime.getRoot()), committedU2State, 'late U1 must not change the selected detail, ledger revision or status')
    assert.deepEqual(env.remote.calls.slice(callStart).map((call) => call.method), ['taskLedger', 'taskLedger'])
    assert.deepEqual(env.remote.illegal, [])
  } finally {
    u1.resolve({ ok: true, value: ledger })
    u2.resolve({ ok: true, value: ledger })
    await cleanup(env)
  }
})

test('4b. U1 rejection after U2 success is handled and cannot change committed state', async () => {
  const ledger = { ...makeLedger(7), tasks: [parentTask, childTask, secondChildTask] }
  const u1 = deferred()
  const u2 = deferred()
  let ledgerCalls = 0
  const unhandled = []
  const onUnhandled = (reason) => { unhandled.push(String(reason)) }
  process.on('unhandledRejection', onUnhandled)
  const env = await setupComponent({
    taskLedgerHandler: async () => {
      ledgerCalls += 1
      if (ledgerCalls === 1) return { ok: true, value: ledger }
      return ledgerCalls === 2 ? u1.promise : u2.promise
    }
  })
  try {
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-parent')
    const root = env.runtime.getRoot()
    requireOne(root, (node) => node.props?.['data-wo-task-child-view'] === 'task-child', 'U1 child View').props.onClick(mockEvent())
    requireOne(root, (node) => node.props?.['data-wo-task-child-view'] === 'task-child-2', 'U2 child View').props.onClick(mockEvent())
    u2.resolve({ ok: true, value: { ...ledger, revision: 9 } })
    await env.runtime.settle()
    const committedU2State = observedState(env.runtime.getRoot())
    assert.equal(committedU2State.detailId, 'task-child-2')

    env.resetStateWrites()
    u1.reject(new Error('controlled U1 rejection after U2 success'))
    await env.runtime.settle()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(env.stateWriteCount(), 0, 'superseded U1 rejection must not write state')
    assert.deepEqual(observedState(env.runtime.getRoot()), committedU2State)
    assert.deepEqual(unhandled, [], 'superseded U1 rejection must not become unhandled')
    assert.deepEqual(env.remote.illegal, [])
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    u1.resolve({ ok: true, value: ledger })
    u2.resolve({ ok: true, value: ledger })
    await cleanup(env)
  }
})

test('5. Expired relationship callbacks are no-ops while closed, while reloading, and after unmount', async () => {
  const pendingReload = deferred()
  let ledgerCalls = 0
  const env = await setupComponent({
    taskLedgerHandler: async () => {
      ledgerCalls += 1
      return ledgerCalls === 2 ? pendingReload.promise : { ok: true, value: makeLedger() }
    }
  })
  try {
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-child')
    const expiredCallback = parentViewCallback(env.runtime)

    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-close'] === 'true', 'Close').props.onClick(mockEvent())
    await env.runtime.settle()
    let before = observedState(env.runtime.getRoot())
    let callStart = env.remote.calls.length
    env.resetStateWrites()
    expiredCallback(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(callStart), [])
    assert.equal(env.stateWriteCount(), 0)
    assert.deepEqual(observedState(env.runtime.getRoot()), before)

    await openTasks(env.runtime)
    before = observedState(env.runtime.getRoot())
    assert.match(before.status, /loading/)
    callStart = env.remote.calls.length
    env.resetStateWrites()
    expiredCallback(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(callStart), [], 'stale callback must not add a read during a new panel load')
    assert.equal(env.stateWriteCount(), 0, 'stale callback must not write while panel is loading')
    assert.deepEqual(observedState(env.runtime.getRoot()), before)

    pendingReload.resolve({ ok: true, value: makeLedger() })
    await env.runtime.settle()
    await selectTask(env.runtime, 'task-child')
    const callbackBeforeUnmount = parentViewCallback(env.runtime)
    await env.mounted.cleanup()
    env.runtime.unmount()
    before = observedState(env.runtime.getRoot())
    callStart = env.remote.calls.length
    env.resetStateWrites()
    callbackBeforeUnmount(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(callStart), [], 'unmounted callback must dispatch no RPC')
    assert.equal(env.stateWriteCount(), 0, 'unmounted callback must perform no state writes')
    assert.deepEqual(observedState(env.runtime.getRoot()), before)
    assert.deepEqual(env.remote.illegal, [])
  } finally {
    pendingReload.resolve({ ok: true, value: makeLedger() })
    if (env.runtime.isMounted()) await cleanup(env)
  }
})

test('6. Missing context is rejected before any state write or RPC', async () => {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const callSite = 'viewParentTaskDetail(selected, { relationViewLifetime })'
  assert.equal(source.split(callSite).length - 1, 1, 'test must transform exactly the parent View call site')
  const sourceWithoutContext = source.replace(callSite, 'viewParentTaskDetail(selected, null)')
  const env = await setupComponent({ sourceOverride: sourceWithoutContext, ledgers: [makeLedger(), makeLedger()] })
  try {
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-child')
    const before = observedState(env.runtime.getRoot())
    const callStart = env.remote.calls.length
    env.resetStateWrites()
    parentViewCallback(env.runtime)(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(callStart), [])
    assert.equal(env.stateWriteCount(), 0)
    assert.deepEqual(observedState(env.runtime.getRoot()), before)
  } finally {
    await cleanup(env)
  }
})

test('7. Invalid relation lifetime is rejected before any state write or RPC', async () => {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const callSite = 'viewChildTaskDetail(selected, child, { relationViewLifetime })'
  assert.equal(source.split(callSite).length - 1, 1, 'test must transform exactly the child View call site')
  const sourceWithInvalidToken = source.replace(callSite, 'viewChildTaskDetail(selected, child, { relationViewLifetime: Number.NaN })')
  const env = await setupComponent({ sourceOverride: sourceWithInvalidToken, ledgers: [makeLedger(), makeLedger()] })
  try {
    await openTasks(env.runtime)
    await selectTask(env.runtime, 'task-parent')
    const before = observedState(env.runtime.getRoot())
    const callStart = env.remote.calls.length
    env.resetStateWrites()
    childViewCallback(env.runtime)(mockEvent())
    await env.runtime.settle()
    assert.deepEqual(env.remote.calls.slice(callStart), [])
    assert.equal(env.stateWriteCount(), 0)
    assert.deepEqual(observedState(env.runtime.getRoot()), before)
  } finally {
    await cleanup(env)
  }
})
