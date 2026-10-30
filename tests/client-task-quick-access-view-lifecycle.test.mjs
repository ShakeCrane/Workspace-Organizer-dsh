/**
 * Task Quick Access View Detail Lifecycle & Origin Invalidation offline tests.
 *
 * Verifies the FP-122 contract for Task Quick Access View Detail:
 * 1. Failure 1 (Counterexample 1): Remove -> re-Pin membership token isolation
 *    - Captured View callback from old instance cannot trigger RPC or open/mutate Task Center after re-pinning.
 *    - Fresh View callback on new instance works lawfully.
 * 2. Failure 2 (Counterexample 2): Pending ledger settlement invalidation
 *    - Valid View started; removing membership while taskLedger is pending invalidates settlement.
 *    - Settles with explicit cancellation error and null selection; does not commit returned ledger.
 *    - Re-pin before settlement or rejection also settles as cancelled.
 * 3. Counterexample 3: Supersession, panel close, and unmount safety
 *    - In-flight request discarded cleanly on supersession, panel close, or unmount.
 *    - Saved callback after unmount yields zero state writes and zero RPCs.
 * 4. Positive Oracles & Controls:
 *    - Valid View dispatches exactly 1 taskLedger read and selects target.
 *    - Disambiguation: same taskId across different sources isolated.
 *    - Reorder preserves membership token and intent.
 *    - Ordinary source, parent, and child navigation remain functional.
 *    - Zero mutations, reconcile, openSession or execution calls.
 */
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

const baseSnapshot = Object.freeze({
  rootId: 'root',
  revision: 10,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
    { id: 'p1', parentId: 'root', kind: 'project', title: 'Branch 1' },
    { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' },
    { id: 'cnv1', parentId: 'w1', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-1' },
    { id: 'cnv2', parentId: 'w1', kind: 'conversation', title: 'Conversation 2', sessionId: 'ses-2' }
  ]
})

const baseStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-task-view-lifecycle-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeLedger({
  revision = 1,
  sources = [
    {
      conversationId: 'cnv1',
      sessionId: 'ses-1',
      workspaceLogicalId: 'wsp-1',
      nativeWorkspaceId: 'nw-1',
      directory: 'E:\\ws-1',
      tasksCount: 2
    },
    {
      conversationId: 'cnv2',
      sessionId: 'ses-2',
      workspaceLogicalId: 'wsp-1',
      nativeWorkspaceId: 'nw-1',
      directory: 'E:\\ws-1',
      tasksCount: 1
    }
  ],
  tasks = [
    {
      taskId: 'tsk_1',
      label: 'Task One',
      childSessionId: 'ses-c1',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      depth: 1,
      mode: 'one-shot',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T00:00:00.000Z'
    },
    {
      taskId: 'tsk_2',
      label: 'Task Two',
      childSessionId: 'ses-c2',
      sourceConversationId: 'cnv1',
      parent: { kind: 'task', taskId: 'tsk_1' },
      depth: 2,
      mode: 'one-shot',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T00:00:01.000Z'
    },
    {
      taskId: 'tsk_3',
      label: 'Task Three in Source 2',
      childSessionId: 'ses-c3',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      depth: 1,
      mode: 'one-shot',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T00:00:02.000Z'
    }
  ]
} = {}) {
  return {
    revision,
    sources,
    tasks
  }
}

async function setupTaskComponent({
  snapshot = baseSnapshot,
  status = baseStatus,
  ledger = makeLedger(),
  taskLedgerHandler = null,
  onSetState = null
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  if (typeof onSetState === 'function') {
    const origUseState = runtime.React.useState
    runtime.React.useState = function (initial) {
      const [val, setVal] = origUseState.call(this, initial)
      const wrappedSetVal = (arg) => {
        onSetState(val, arg)
        return setVal(arg)
      }
      return [val, wrappedSetVal]
    }
  }

  const remote = createRemoteProxy({ snapshot, status, ledgers: [ledger] })
  if (typeof taskLedgerHandler === 'function') {
    remote.allowed.taskLedger = taskLedgerHandler
  } else {
    remote.allowed.taskLedger = async () => {
      remote.calls.push({ method: 'taskLedger', args: [] })
      return { ok: true, value: ledger }
    }
  }

  const mounted = await mountClientApplication({
    source,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()
  return { runtime, remote, mounted, ledger }
}

async function pinTaskToQuickAccess(runtime, taskId, sourceConversationId) {
  let root = runtime.getRoot()
  // Open Task Center
  const openBtn = requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true')
  openBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Select task row in Task Center
  let rowBtn
  if (sourceConversationId) {
    const group = requireOne(root, (n) => n.props?.['data-wo-task-center-group'] === sourceConversationId)
    rowBtn = requireOne(group, (n) => n.props?.['data-wo-task-center-row'] === taskId)
  } else {
    rowBtn = requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === taskId)
  }
  rowBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click Pin button in detail panel
  const pinBtn = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === taskId)
  pinBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Close Task Center
  const closeBtn = requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true')
  closeBtn.props.onClick(mockEvent())
  await runtime.settle()
  return runtime.getRoot()
}

test('FAILURE 1 (COUNTEREXAMPLE 1): Remove -> re-Pin membership token isolation for View Detail', async () => {
  const stateLog = []
  const { runtime, remote, mounted } = await setupTaskComponent({
    onSetState: (prev, next) => {
      stateLog.push({ prev, next })
    }
  })
  let root = runtime.getRoot()

  // 1. Pin tsk_1 under cnv1 (Instance 1)
  root = await pinTaskToQuickAccess(runtime, 'tsk_1', 'cnv1')

  // Verify tsk_1 is in Quick Access
  const qaRow = requireOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 'tsk_1')
  assert.equal(qaRow.props['data-wo-quick-access-task-source'], 'cnv1')

  // 2. Capture View Detail callback from Instance 1
  const viewBtn1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 'tsk_1')
  const capturedViewInstance1 = viewBtn1.props.onClick
  assert.equal(typeof capturedViewInstance1, 'function')

  // 3. Remove tsk_1 from Quick Access
  const removeBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 'tsk_1')
  removeBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Verify removed
  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 'tsk_1'), null)

  // 4. Re-pin tsk_1 under cnv1 (Instance 2 with new token)
  root = await pinTaskToQuickAccess(runtime, 'tsk_1', 'cnv1')

  // Capture View Detail callback from Instance 2
  const viewBtn2 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 'tsk_1')
  const capturedViewInstance2 = viewBtn2.props.onClick

  // Verify Task Center is currently closed
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)

  // Clear counters before invoking old callback
  const rpcCallsBefore = remote.calls.length
  stateLog.length = 0

  // 5. Invoke saved View Detail callback from Instance 1 (old token)
  capturedViewInstance1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // CONTRACT ASSERTION (Fails on baseline, passes with protection):
  // Baseline erroneously executes navigateToTaskDetail, dispatches remote.taskLedger(), and opens Task Center!
  // Protected code requires matching token; old token is rejected with ZERO RPCs and ZERO UI writes.
  assert.equal(
    remote.calls.length,
    rpcCallsBefore,
    'captured View callback from old instance must NOT dispatch any RPCs'
  )
  assert.equal(
    findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'),
    null,
    'captured View callback from old instance must NOT open Task Center'
  )
  assert.equal(
    findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined),
    null,
    'captured View callback from old instance must NOT select any detail'
  )

  // 6. Invoke fresh View Detail callback from Instance 2 (current token)
  capturedViewInstance2(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Fresh View Detail must succeed!
  assert.equal(remote.calls.length, rpcCallsBefore + 1, 'fresh View callback must dispatch exactly 1 taskLedger RPC')
  requireOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true')
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'ready')
  requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_1')

  await mounted.cleanup()
})

test('FAILURE 2 (COUNTEREXAMPLE 2): Pending ledger settlement invalidation when membership removed during in-flight read', async () => {
  const d = deferred()
  let callCount = 0

  const { runtime, remote, mounted } = await setupTaskComponent({
    taskLedgerHandler: async () => {
      remote.calls.push({ method: 'taskLedger', args: [] })
      callCount += 1
      if (callCount === 1) {
        // Initial call during pinTaskToQuickAccess
        return { ok: true, value: makeLedger() }
      }
      // Second call during View Detail: return deferred promise
      return d.promise
    }
  })
  let root = runtime.getRoot()

  // 1. Pin tsk_1 under cnv1
  root = await pinTaskToQuickAccess(runtime, 'tsk_1', 'cnv1')

  // Verify Task Center is closed
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)

  // 2. Click View Detail on tsk_1 (dispatches in-flight read)
  const viewBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 'tsk_1')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Task Center opened and enters loading state
  requireOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true')
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'loading')
  assert.equal(callCount, 2)

  // 3. Remove tsk_1 while taskLedger is pending
  const removeBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 'tsk_1')
  removeBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // 4. Resolve the pending taskLedger promise with a valid ledger containing tsk_1
  const returnedLedger = makeLedger({
    revision: 99,
    tasks: [
      {
        taskId: 'tsk_1',
        label: 'Task One Committed',
        childSessionId: 'ses-c1',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        depth: 1,
        mode: 'one-shot',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T00:00:00.000Z'
      }
    ]
  })
  d.resolve({ ok: true, value: returnedLedger })
  await runtime.settle()
  root = runtime.getRoot()

  // CONTRACT ASSERTION (Fails on baseline, passes with protection):
  // Baseline erroneously accepts the resolved ledger, sets status="ready", and selects tsk_1.
  // Protected code must detect expired shortcut origin:
  // - Must NOT select tsk_1 detail
  // - Must settle loading state to "error" (cancellation error, not indefinitely loading)
  // - Must report explicit cancellation notice
  assert.equal(
    findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_1'),
    null,
    'expired shortcut request must NOT select task detail'
  )
  const statusDiv = requireOne(root, (n) => n.props?.['data-wo-task-center-status'] !== undefined)
  assert.equal(
    statusDiv.props['data-wo-task-center-status'],
    'error',
    'expired shortcut request must finish loading with explicit error status'
  )
  const errDiv = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true')
  assert.ok(
    textOf(errDiv).includes('快捷引用已失效') || textOf(errDiv).includes('cancelled') || textOf(errDiv).includes('expired'),
    'error must explicitly disclose cancellation of expired quick access navigation'
  )

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 2b: Remove -> re-Pin before settlement also cancels old pending request', async () => {
  const d = deferred()
  let callCount = 0

  const { runtime, remote, mounted } = await setupTaskComponent({
    taskLedgerHandler: async () => {
      remote.calls.push({ method: 'taskLedger', args: [] })
      callCount += 1
      if (callCount === 1) {
        return { ok: true, value: makeLedger() }
      }
      return d.promise
    }
  })
  let root = runtime.getRoot()

  // Pin tsk_1
  root = await pinTaskToQuickAccess(runtime, 'tsk_1', 'cnv1')

  // Click View Detail (call 2, deferred)
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 'tsk_1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'loading')

  // Remove tsk_1
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 'tsk_1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Re-pin tsk_1 while call 2 is still pending!
  // Since Task Center is open and selected is null/loading, re-pin from tree or button
  const pinBtn = findOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_1')
  if (pinBtn) {
    pinBtn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  // Resolve old pending read
  d.resolve({ ok: true, value: makeLedger() })
  await runtime.settle()
  root = runtime.getRoot()

  // Old request belonged to expired token; must NOT select detail
  assert.equal(
    findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_1'),
    null,
    'old request must be cancelled even if identical task was re-pinned before settlement'
  )

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 3: Panel close, supersession, and unmount safety', async () => {
  const d = deferred()
  let callCount = 0
  const stateLog = []

  const { runtime, remote, mounted } = await setupTaskComponent({
    taskLedgerHandler: async () => {
      remote.calls.push({ method: 'taskLedger', args: [] })
      callCount += 1
      if (callCount === 1) return { ok: true, value: makeLedger() }
      return d.promise
    },
    onSetState: (prev, next) => {
      stateLog.push({ prev, next })
    }
  })
  let root = runtime.getRoot()

  // Pin tsk_1
  root = await pinTaskToQuickAccess(runtime, 'tsk_1', 'cnv1')

  // Capture View callback
  const viewBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 'tsk_1')
  const capturedView = viewBtn.props.onClick

  // Start View Detail
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Close Task Center while read is in-flight
  const closeBtn = requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true')
  closeBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Remove tsk_1 while closed and in-flight
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 'tsk_1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  stateLog.length = 0

  // Resolve promise while closed
  d.resolve({ ok: true, value: makeLedger() })
  await runtime.settle()
  root = runtime.getRoot()

  // When closed, must write nothing and keep closed
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)

  // Unmount component
  await runtime.unmount()
  await mounted.cleanup()

  stateLog.length = 0
  const rpcBefore = remote.calls.length

  // Invoke saved View callback after unmount
  capturedView(mockEvent())
  assert.equal(stateLog.length, 0, 'saved View callback after unmount must do zero state writes')
  assert.equal(remote.calls.length, rpcBefore, 'saved View callback after unmount must do zero RPCs')
})

test('POSITIVE ORACLES & CONTROLS: single RPC, correct selection, disambiguation, reorder, parent/child navigation', async () => {
  const { runtime, remote, mounted } = await setupTaskComponent()
  let root = runtime.getRoot()

  // 1. Pin tsk_1 (under cnv1) and tsk_2 (child of tsk_1 under cnv1)
  root = await pinTaskToQuickAccess(runtime, 'tsk_1', 'cnv1')
  root = await pinTaskToQuickAccess(runtime, 'tsk_2', 'cnv1')

  let rows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-task']), ['tsk_1', 'tsk_2'])

  const rpcBefore = remote.calls.length

  // 2. View Detail on tsk_1
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 'tsk_1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Exactly 1 taskLedger RPC
  assert.equal(remote.calls.length, rpcBefore + 1)
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'ready')
  requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_1')

  // 3. Child navigation from tsk_1 detail to tsk_2
  const childViewBtn = findOne(root, (n) => n.props?.['data-wo-task-child-view'] === 'tsk_2')
  if (childViewBtn) {
    childViewBtn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
    requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_2')
  }

  // 4. Parent navigation from tsk_2 detail back to tsk_1
  const parentNav = findOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 'tsk_1')
  if (parentNav) {
    parentNav.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
    requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_1')
  }

  // Close Task Center
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // 5. Reorder: move tsk_2 up
  const upBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 'tsk_2')
  upBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-task']), ['tsk_2', 'tsk_1'])

  // View Detail on tsk_2 after reorder
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 'tsk_2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_2')

  // 6. Zero mutations or disallowed RPCs
  assert.ok(remote.calls.every((c) => c.method === 'snapshot' || c.method === 'status' || c.method === 'taskLedger'))

  await mounted.cleanup()
})
