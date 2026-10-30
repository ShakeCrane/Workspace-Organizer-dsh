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

const snapshot = {
  rootId: 'root',
  revision: 1,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root' },
    { id: 'workspace', parentId: 'root', kind: 'workspace', title: 'Workspace', directory: 'synthetic:/workspace', nativeWorkspaceId: 'synthetic-workspace' },
    { id: 'src-a', parentId: 'workspace', kind: 'conversation', title: 'Source A', sessionId: 'synthetic-session-a' },
    { id: 'src-b', parentId: 'workspace', kind: 'conversation', title: 'Source B', sessionId: 'synthetic-session-b' }
  ]
}

function makeLedger(revision = 1) {
  return {
    revision,
    sources: [
      { conversationId: 'src-a', sessionId: 'synthetic-session-a', workspaceLogicalId: 'workspace', nativeWorkspaceId: 'synthetic-workspace', directory: 'synthetic:/workspace', verifiedAt: '2026-10-29T00:00:00.000Z', verificationState: 'verified', hostVersion: 'synthetic' },
      { conversationId: 'src-b', sessionId: 'synthetic-session-b', workspaceLogicalId: 'workspace', nativeWorkspaceId: 'synthetic-workspace', directory: 'synthetic:/workspace', verifiedAt: '2026-10-29T00:00:00.000Z', verificationState: 'verified', hostVersion: 'synthetic' }
    ],
    tasks: [
      { taskId: 'task-a', label: 'Task A', sourceConversationId: 'src-a', parent: { kind: 'conversation', conversationId: 'src-a' }, childSessionId: 'child-a', depth: 0, mode: 'one-shot', executionState: 'READY', executionEligibility: 'eligible', observedAt: '2026-10-29T00:00:00.000Z' },
      { taskId: 'task-b', label: 'Task B', sourceConversationId: 'src-b', parent: { kind: 'conversation', conversationId: 'src-b' }, childSessionId: 'child-b', depth: 0, mode: 'one-shot', executionState: 'READY', executionEligibility: 'eligible', observedAt: '2026-10-29T00:00:00.000Z' }
    ]
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

function observeStateSetters(runtime) {
  let calls = 0
  const originalUseState = runtime.React.useState.bind(runtime.React)
  runtime.React.useState = (initialValue) => {
    const [value, setState] = originalUseState(initialValue)
    return [value, (...args) => {
      calls += 1
      return setState(...args)
    }]
  }
  return { get calls() { return calls } }
}

async function setup({ taskLedgerHandler } = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const timerQueue = makeTimerQueue()
  const scrolled = []
  const runtime = createHooksRuntime()
  const stateSetters = observeStateSetters(runtime)
  const remote = createRemoteProxy({
    snapshot,
    status: { conversationsCreatable: true, sessionSource: 'fp129-synthetic-filter-test' },
    ledgers: [makeLedger(), makeLedger(2), makeLedger(3), makeLedger(4)]
  })
  if (typeof taskLedgerHandler === 'function') remote.allowed.taskLedger = taskLedgerHandler
  const mounted = await mountClientApplication({
    source,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote,
    document: {
      querySelector(selector) {
        return { scrollIntoView(options) { scrolled.push({ selector, options }) } }
      }
    },
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()
  return { runtime, remote, mounted, timerQueue, stateSetters, scrolled }
}

async function cleanup(env) {
  await env.mounted.cleanup()
  env.runtime.unmount()
}

async function openTaskCenter(runtime) {
  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center'] === 'true', 'header All Tasks button').props.onClick()
  await runtime.settle()
}

function filterSelect(root) {
  return requireOne(root, (node) => node.props?.['data-wo-task-center-filter-select'] === 'true', 'Task Center source filter select')
}

function viewState(root) {
  const panel = findOne(root, (node) => node.props?.['data-wo-task-center-panel'] === 'true')
  if (panel === null) return { panel: false }
  const select = filterSelect(root)
  const scope = requireOne(panel, (node) => node.props?.['data-wo-task-center-scope'] !== undefined, 'scope indicator')
  const status = requireOne(panel, (node) => node.props?.['data-wo-task-center-status'] !== undefined, 'Task Center status')
  const feedbackNode = findOne(root, (node) => node.props?.['data-wo-task-center-locate-feedback'] === 'true')
  const errorNode = findOne(root, (node) => node.props?.['data-wo-task-center-error'] === 'true')
  return {
    panel: true,
    filter: select.props.value,
    disabled: select.props.disabled,
    scope: scope.props['data-wo-task-center-scope'],
    status: status.props['data-wo-task-center-status'],
    groups: findAll(root, (node) => node.props?.['data-wo-task-center-group'] !== undefined).map((node) => node.props['data-wo-task-center-group']),
    selectedTree: findAll(root, (node) => node.props?.['data-wo-selected'] === 'true').map((node) => node.props['data-wo-node-id']),
    selectedTasks: findAll(root, (node) => node.props?.['data-wo-task-center-detail'] !== undefined).map((node) => node.props['data-wo-task-center-detail']),
    feedback: feedbackNode === null ? null : {
      state: feedbackNode.props['data-wo-task-center-locate-state'],
      text: textOf(feedbackNode)
    },
    error: errorNode === null ? null : textOf(errorNode),
    stale: findOne(root, (node) => node.props?.['data-wo-task-center-stale'] === 'true') !== null
  }
}

function observe(env) {
  return {
    state: viewState(env.runtime.getRoot()),
    setters: env.stateSetters.calls,
    remote: JSON.stringify(env.remote.calls),
    timerEvents: JSON.stringify(env.timerQueue.events),
    pendingTimers: [...env.timerQueue.pending.keys()],
    renders: env.runtime.stats.renders
  }
}

async function runCloseReopenCounterexample(kind) {
  const env = await setup()
  try {
    await openTaskCenter(env.runtime)
    let oldCallback
    if (kind === 'select') {
      oldCallback = filterSelect(env.runtime.getRoot()).props.onChange
    } else {
      filterSelect(env.runtime.getRoot()).props.onChange({ target: { value: 'src-a' } })
      await env.runtime.settle()
      oldCallback = requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-filter-all'] === 'true', 'panel A All sources button').props.onClick
    }

    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-close'] === 'true', 'panel A Close button').props.onClick()
    await env.runtime.settle()
    await openTaskCenter(env.runtime)
    filterSelect(env.runtime.getRoot()).props.onChange({ target: { value: 'src-b' } })
    await env.runtime.settle()
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === 'task-b', 'panel B Task B row').props.onClick()
    await env.runtime.settle()
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate'] === 'task-b', 'panel B Locate button').props.onClick()
    await env.runtime.settle()

    const before = observe(env)
    assert.equal(before.state.filter, 'src-b')
    assert.deepEqual(before.state.selectedTasks, ['task-b'])
    assert.equal(before.state.feedback.state, 'locating')
    assert.equal(before.pendingTimers.length, 1, 'B Locate is pending before stale callback')

    if (kind === 'select') oldCallback({ target: { value: 'src-a' } })
    else oldCallback()
    await env.runtime.settle()
    const after = observe(env)

    assert.equal(after.setters - before.setters, 0, 'old panel A callback invokes zero state setters')
    assert.deepEqual(after.state, before.state, 'old callback leaves visible state unchanged')
    assert.equal(after.remote, before.remote, 'old callback adds zero RPCs')
    assert.equal(after.timerEvents, before.timerEvents, 'old callback schedules or cancels no timer')
    assert.deepEqual(after.pendingTimers, before.pendingTimers, 'old callback preserves B pending timer')
    assert.equal(after.renders, before.renders, 'old callback requests no render')

    env.timerQueue.flush()
    await env.runtime.settle()
    assert.equal(env.scrolled.length, 1, 'B pending Locate flushes exactly once')
    assert.equal(env.scrolled[0].selector, '[data-wo-node-id="src-b"]')
    assert.equal(Object.hasOwn(env.scrolled[0].options, 'block'), true)
    assert.equal(env.scrolled[0].options.block, 'center')
    assert.deepEqual(Object.keys(env.scrolled[0].options).sort(), ['block'])
    assert.equal(viewState(env.runtime.getRoot()).feedback.state, 'located')
    assert.deepEqual(env.timerQueue.events.map((event) => event.action), ['schedule', 'fire'])
  } finally {
    await cleanup(env)
  }
}

test('old rendered select callback cannot alter reopened panel B or cancel B Locate', async () => {
  await runCloseReopenCounterexample('select')
})

test('old rendered All sources callback cannot alter reopened panel B or cancel B Locate', async () => {
  await runCloseReopenCounterexample('all')
})

test('current select and All controls keep filtering semantics and cancel a valid pending Locate without RPC', async () => {
  const env = await setup()
  try {
    await openTaskCenter(env.runtime)
    filterSelect(env.runtime.getRoot()).props.onChange({ target: { value: 'src-b' } })
    await env.runtime.settle()
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === 'task-b', 'current Task B row').props.onClick()
    await env.runtime.settle()
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate'] === 'task-b', 'current Task B Locate').props.onClick()
    await env.runtime.settle()
    assert.equal(env.timerQueue.pending.size, 1)
    const rpcBeforeFilter = JSON.stringify(env.remote.calls)

    filterSelect(env.runtime.getRoot()).props.onChange({ target: { value: 'src-a' } })
    await env.runtime.settle()
    assert.equal(viewState(env.runtime.getRoot()).filter, 'src-a')
    assert.deepEqual(viewState(env.runtime.getRoot()).selectedTasks, [])
    assert.equal(env.timerQueue.pending.size, 0, 'valid source change cancels current panel Locate')
    assert.deepEqual(env.timerQueue.events.map((event) => event.action), ['schedule', 'cancel'])

    const allButton = requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-filter-all'] === 'true', 'current All sources button')
    allButton.props.onClick()
    await env.runtime.settle()
    assert.equal(viewState(env.runtime.getRoot()).filter, '')
    assert.deepEqual(viewState(env.runtime.getRoot()).groups.sort(), ['src-a', 'src-b'])
    assert.equal(JSON.stringify(env.remote.calls), rpcBeforeFilter, 'filter controls perform no RPC')
    assert.equal(env.scrolled.length, 0, 'cancelled timer never scrolls')
  } finally {
    await cleanup(env)
  }
})

test('saved filter callback remains valid through same-panel successful Reload', async () => {
  const env = await setup()
  try {
    await openTaskCenter(env.runtime)
    const savedSelect = filterSelect(env.runtime.getRoot()).props.onChange
    const reloadCallsBefore = env.remote.calls.filter((call) => call.method === 'taskLedger').length
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'same-panel Reload').props.onClick()
    await env.runtime.settle()
    assert.equal(env.remote.calls.filter((call) => call.method === 'taskLedger').length, reloadCallsBefore + 1)
    assert.equal(viewState(env.runtime.getRoot()).status, 'ready')

    const callsAfterReload = JSON.stringify(env.remote.calls)
    savedSelect({ target: { value: 'src-b' } })
    await env.runtime.settle()
    assert.equal(viewState(env.runtime.getRoot()).filter, 'src-b', 'same-panel Reload does not invalidate saved filter callback')
    assert.equal(JSON.stringify(env.remote.calls), callsAfterReload, 'saved filter callback remains local')
  } finally {
    await cleanup(env)
  }
})

test('loading rejects a saved filter callback before any additional state write', async () => {
  let taskLedgerCalls = 0
  let resolveReload
  const reloadPromise = new Promise((resolve) => { resolveReload = resolve })
  const env = await setup({
    taskLedgerHandler: async () => {
      taskLedgerCalls += 1
      if (taskLedgerCalls === 1) return { ok: true, value: makeLedger() }
      return reloadPromise
    }
  })
  try {
    await openTaskCenter(env.runtime)
    const savedSelect = filterSelect(env.runtime.getRoot()).props.onChange
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'Reload').props.onClick()
    await env.runtime.settle()
    assert.equal(viewState(env.runtime.getRoot()).status, 'loading')
    const before = observe(env)

    savedSelect({ target: { value: 'src-a' } })
    await env.runtime.settle()
    const after = observe(env)
    assert.equal(after.setters, before.setters, 'loading guard runs before any filter setter')
    assert.deepEqual(after.state, before.state)
    assert.equal(after.remote, before.remote, 'saved filter does not issue a read')
    assert.equal(after.timerEvents, before.timerEvents)

    resolveReload({ ok: true, value: makeLedger(2) })
    await env.runtime.settle()
    assert.equal(viewState(env.runtime.getRoot()).status, 'ready')
  } finally {
    resolveReload({ ok: true, value: makeLedger(2) })
    await cleanup(env)
  }
})

test('error/stale cached ledger remains locally filterable by a saved same-panel callback', async () => {
  let taskLedgerCalls = 0
  const env = await setup({
    taskLedgerHandler: async () => {
      taskLedgerCalls += 1
      if (taskLedgerCalls === 1) return { ok: true, value: makeLedger() }
      throw new Error('synthetic ledger failure')
    }
  })
  try {
    await openTaskCenter(env.runtime)
    const savedSelect = filterSelect(env.runtime.getRoot()).props.onChange
    requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'Reload').props.onClick()
    await env.runtime.settle()
    const errorState = viewState(env.runtime.getRoot())
    assert.equal(errorState.status, 'error')
    assert.equal(errorState.stale, true)
    const callsAfterFailure = JSON.stringify(env.remote.calls)

    savedSelect({ target: { value: 'src-a' } })
    await env.runtime.settle()
    const filteredState = viewState(env.runtime.getRoot())
    assert.equal(filteredState.filter, 'src-a')
    assert.equal(filteredState.status, 'error')
    assert.equal(filteredState.stale, true)
    assert.match(filteredState.error, /synthetic ledger failure/u)
    assert.deepEqual(filteredState.groups, ['src-a'])
    assert.equal(JSON.stringify(env.remote.calls), callsAfterFailure, 'cached filtering remains local after failure')
  } finally {
    await cleanup(env)
  }
})

test('close, non-Reload replacement, and unmount invalidate saved filter callbacks', async (t) => {
  await t.test('close rejects the saved callback before the next render', async () => {
    const env = await setup()
    try {
      await openTaskCenter(env.runtime)
      const savedSelect = filterSelect(env.runtime.getRoot()).props.onChange
      requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-close'] === 'true', 'Close').props.onClick()
      const before = observe(env)
      const pendingBefore = env.runtime.pending()
      savedSelect({ target: { value: 'src-a' } })
      assert.equal(env.stateSetters.calls, before.setters, 'old callback adds zero setters before Close render')
      assert.equal(JSON.stringify(env.remote.calls), before.remote)
      assert.equal(JSON.stringify(env.timerQueue.events), before.timerEvents)
      assert.equal(env.runtime.pending(), pendingBefore, 'old callback requests no extra render')
      await env.runtime.settle()
      assert.deepEqual(viewState(env.runtime.getRoot()), { panel: false })
    } finally {
      await cleanup(env)
    }
  })

  await t.test('non-Reload panel replacement rejects the old callback', async () => {
    const env = await setup()
    try {
      await openTaskCenter(env.runtime)
      const savedSelect = filterSelect(env.runtime.getRoot()).props.onChange
      await openTaskCenter(env.runtime)
      const before = observe(env)
      savedSelect({ target: { value: 'src-a' } })
      await env.runtime.settle()
      const after = observe(env)
      assert.equal(after.setters, before.setters)
      assert.deepEqual(after.state, before.state)
      assert.equal(after.remote, before.remote)
      assert.equal(after.timerEvents, before.timerEvents)
      assert.equal(after.renders, before.renders)
    } finally {
      await cleanup(env)
    }
  })

  await t.test('unmount rejects the saved callback', async () => {
    const env = await setup()
    await openTaskCenter(env.runtime)
    const savedSelect = filterSelect(env.runtime.getRoot()).props.onChange
    await env.mounted.cleanup()
    env.runtime.unmount()
    const before = observe(env)
    savedSelect({ target: { value: 'src-a' } })
    await env.runtime.settle()
    const after = observe(env)
    assert.equal(after.setters, before.setters)
    assert.deepEqual(after.state, before.state)
    assert.equal(after.remote, before.remote)
    assert.equal(after.timerEvents, before.timerEvents)
    assert.equal(after.renders, before.renders)
  })
})
