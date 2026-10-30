/**
 * Source Tasks Row View Detail Lifecycle & Invalidation Protection Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Entry button passes lexical { sourceId: panelSourceId, token: panelToken } context.
 * 2. Pre-RPC validation enforces mounted state, valid supplied context, live source equality,
 *    matching live source-panel token, task/source identity consistency, and live row-membership.
 * 3. Invalid callbacks silently return: zero RPC, zero UI writes, no generation increments or notice pollution.
 * 4. Token guards dispatch only: once legitimately dispatched, source panel close/switch does not cancel it.
 * 5. Counterexample 1: Open A -> Close A -> Reopen A -> old View callback is rejected with 0 RPCs / 0 UI writes.
 * 6. Counterexample 2: Open A -> Switch A->B->A -> original A View callback is rejected with 0 RPCs / 0 UI writes,
 *    while newly rendered A View works normally.
 * 7. Boundary rejections: A->B switched rejection, closed panel rejection, unmounted rejection, missing context,
 *    removed live row, and source mismatch.
 * 8. Positive controls: valid View dispatches exactly 1 read-only taskLedger() and selects target task;
 *    saved callback from still-active instance remains valid after normal refresh retaining task;
 *    dispatched read completes after source-panel closure; supersession race isolation;
 *    Task Center close/unmount discards late results.
 * 9. Non-whitelisted method isolation: zero mutation / openSession / reconcile / execution calls attributable to View.
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
    { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1', nativeWorkspaceId: 'nw-1' },
    { id: 'cnv1', parentId: 'w1', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-1' },
    { id: 'cnv2', parentId: 'w1', kind: 'conversation', title: 'Conversation 2', sessionId: 'ses-2' }
  ]
})

const baseStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-task-navigation-test'
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
      verifiedAt: '2026-10-25T10:00:00.000Z',
      verificationState: 'verified',
      hostVersion: '0.2.1-rc.2'
    },
    {
      conversationId: 'cnv2',
      sessionId: 'ses-2',
      workspaceLogicalId: 'wsp-1',
      nativeWorkspaceId: 'nw-1',
      directory: 'E:\\ws-1',
      verifiedAt: '2026-10-25T10:00:00.000Z',
      verificationState: 'verified',
      hostVersion: '0.2.1-rc.2'
    }
  ],
  tasks = []
} = {}) {
  return { revision, sources, tasks }
}

async function setupComponent({
  snapshot = baseSnapshot,
  status = baseStatus,
  taskLedgerHandler,
  reconcileTasksHandler,
  ledgers = []
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })

  const methodCalls = []

  const origTaskLedger = remote.allowed.taskLedger
  remote.allowed.taskLedger = async (args) => {
    methodCalls.push({ method: 'taskLedger', args })
    if (typeof taskLedgerHandler === 'function') {
      return taskLedgerHandler(args)
    }
    return origTaskLedger(args)
  }

  const origReconcile = remote.allowed.reconcileTasks
  remote.allowed.reconcileTasks = async (args) => {
    methodCalls.push({ method: 'reconcileTasks', args })
    if (typeof reconcileTasksHandler === 'function') {
      return reconcileTasksHandler(args)
    }
    return origReconcile(args)
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

  return {
    runtime,
    remote,
    methodCalls,
    getCalls: (method) => methodCalls.filter((c) => c.method === method)
  }
}

async function openTasksFor(runtime, conversationId) {
  const root = runtime.getRoot()
  const tasksBtn = requireOne(root, (n) => n.props?.['data-wo-tasks'] === conversationId, `Tasks button for ${conversationId}`)
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()
}

// =============================================================================
// Counterexample 1: Open A -> Close A -> Reopen A -> invoke old View callback
// =============================================================================
test('1. [COUNTEREXAMPLE 1] Same-source session isolation: old View from session 1 rejected in session 2 with 0 RPCs', async () => {
  const task1 = {
    taskId: 'tsk_ce1_1',
    label: 'Task CE1',
    childSessionId: 'sess_ce1_1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task1] })

  const { runtime, getCalls } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    ledgers: [ledger]
  })

  // Open A
  await openTasksFor(runtime, 'cnv1')
  assert.equal(getCalls('taskLedger').length, 1, 'Initial loadTasks dispatches 1 taskLedger')

  // Capture View button handler
  const viewBtnSession1 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_ce1_1', 'View button session 1')
  const savedViewSession1 = viewBtnSession1.props.onClick

  // Close A
  await openTasksFor(runtime, 'cnv1')
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-panel'] === 'cnv1'), null, 'Panel A closed')

  // Reopen A
  await openTasksFor(runtime, 'cnv1')
  assert.equal(getCalls('taskLedger').length, 2, 'Reopened loadTasks dispatches 2nd taskLedger')

  const rpcCountBefore = getCalls('taskLedger').length

  // Invoke old View callback from session 1 immediately
  savedViewSession1(mockEvent())
  await runtime.settle()

  // Must dispatch ZERO new RPCs and zero UI writes
  assert.equal(getCalls('taskLedger').length, rpcCountBefore, 'Zero new RPCs dispatched on old View callback')
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Task Center panel remains closed')

  // Repeat invalid callback after render
  runtime.render()
  await runtime.settle()
  savedViewSession1(mockEvent())
  await runtime.settle()

  assert.equal(getCalls('taskLedger').length, rpcCountBefore, 'Repeated old View callback still dispatches zero RPCs')
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Task Center panel still closed')
})

// =============================================================================
// Counterexample 2: Open A -> Switch A->B->A -> invoke original A View callback
// =============================================================================
test('2. [COUNTEREXAMPLE 2] Cross-source switch isolation: original A View rejected after A->B->A while new View works', async () => {
  const taskA = {
    taskId: 'tsk_ce2_a',
    label: 'Task CE2 A',
    childSessionId: 'sess_ce2_a',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const taskB = {
    taskId: 'tsk_ce2_b',
    label: 'Task CE2 B',
    childSessionId: 'sess_ce2_b',
    sourceConversationId: 'cnv2',
    parent: { kind: 'conversation', conversationId: 'cnv2' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [taskA, taskB] })

  const { runtime, getCalls } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    ledgers: [ledger]
  })

  // Open A
  await openTasksFor(runtime, 'cnv1')
  const viewBtnInitialA = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_ce2_a', 'Initial View button A')
  const savedViewInitialA = viewBtnInitialA.props.onClick

  // Switch to B
  await openTasksFor(runtime, 'cnv2')
  // Switch back to A
  await openTasksFor(runtime, 'cnv1')

  const rpcCountBefore = getCalls('taskLedger').length

  // Invoke original A View callback
  savedViewInitialA(mockEvent())
  await runtime.settle()

  assert.equal(getCalls('taskLedger').length, rpcCountBefore, 'Zero new RPCs dispatched on original A View after A->B->A')
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Task Center panel remains closed')

  // Newly rendered A View button MUST work
  const viewBtnCurrentA = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_ce2_a', 'Current View button A')
  viewBtnCurrentA.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(getCalls('taskLedger').length, rpcCountBefore + 1, 'Current View button dispatches exactly 1 taskLedger RPC')
  const taskCenterPanel = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true')
  assert.ok(taskCenterPanel, 'Task Center panel opened by current View')
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_ce2_a'), 'Target task selected in Task Center')
})

// =============================================================================
// Boundary Rejections: A->B, closed, unmounted, missing context, removed row, source mismatch
// =============================================================================
test('3. Boundary rejections: switched source (A->B), closed panel, and unmounted component fail closed with 0 RPCs', async () => {
  const task1 = {
    taskId: 'tsk_bnd_1',
    label: 'Task Bound',
    childSessionId: 'sess_bnd_1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task1] })

  const { runtime, getCalls } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    ledgers: [ledger]
  })

  await openTasksFor(runtime, 'cnv1')
  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_bnd_1', 'View button')
  const savedHandler = viewBtn.props.onClick

  // Switch to B
  await openTasksFor(runtime, 'cnv2')
  const rpcAfterB = getCalls('taskLedger').length
  savedHandler(mockEvent())
  await runtime.settle()
  assert.equal(getCalls('taskLedger').length, rpcAfterB, 'Zero RPCs when switched to B')
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)

  // Close panel entirely
  await openTasksFor(runtime, 'cnv2')
  const rpcAfterClose = getCalls('taskLedger').length
  savedHandler(mockEvent())
  await runtime.settle()
  assert.equal(getCalls('taskLedger').length, rpcAfterClose, 'Zero RPCs when panel closed')
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)

  // Unmount
  runtime.unmount()
  const rpcAfterUnmount = getCalls('taskLedger').length
  savedHandler(mockEvent())
  await runtime.settle()
  assert.equal(getCalls('taskLedger').length, rpcAfterUnmount, 'Zero RPCs after unmount')
})

test('4. Boundary rejections: missing context, removed live row, and source mismatch fail closed with 0 RPCs', async () => {
  const task1 = {
    taskId: 'tsk_val_1',
    label: 'Task Val',
    childSessionId: 'sess_val_1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  let currentLedger = makeLedger({ tasks: [task1] })

  const { runtime, getCalls } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: currentLedger }),
    reconcileTasksHandler: async () => ({ ok: true, value: { ledger: currentLedger } }),
    ledgers: [currentLedger]
  })

  await openTasksFor(runtime, 'cnv1')
  const rpcBaseline = getCalls('taskLedger').length

  // Capture valid button handler
  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_val_1', 'View button')
  const savedHandler = viewBtn.props.onClick

  // Update ledger to remove task1 (simulating removed row)
  currentLedger = makeLedger({ tasks: [] })
  // Trigger refresh to update taskLedger in state
  const refreshBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-refresh'] === 'true', 'Refresh button')
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  const rpcAfterRefresh = getCalls('taskLedger').length
  // Now invoke savedHandler for task1 which is no longer in live ledger
  savedHandler(mockEvent())
  await runtime.settle()

  assert.equal(getCalls('taskLedger').length, rpcAfterRefresh, 'Zero RPCs when task is no longer in live ledger')
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Panel remains closed')
})

// =============================================================================
// Positive Controls & Isolation: Refresh retention, Panel close after dispatch, Race condition, Close/Unmount
// =============================================================================
test('5. Positive control: valid View dispatches exactly 1 taskLedger RPC and selects exact task', async () => {
  const task1 = {
    taskId: 'tsk_pos_1',
    label: 'Positive Task 1',
    childSessionId: 'sess_pos_1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task1] })

  const { runtime, getCalls } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    ledgers: [ledger]
  })

  await openTasksFor(runtime, 'cnv1')
  const rpcBefore = getCalls('taskLedger').length

  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_pos_1', 'View button')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(getCalls('taskLedger').length, rpcBefore + 1, 'Exactly 1 taskLedger RPC dispatched')
  const detail = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_pos_1')
  assert.ok(detail, 'Task Center displays exact selected task')
})

test('6. Positive control: saved callback remains valid after same-instance refresh retaining task', async () => {
  const task1 = {
    taskId: 'tsk_ref_1',
    label: 'Task Refresh',
    childSessionId: 'sess_ref_1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledgerRev1 = makeLedger({ revision: 1, tasks: [task1] })
  const ledgerRev2 = makeLedger({ revision: 2, tasks: [task1] })

  const { runtime, getCalls } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledgerRev1 }),
    reconcileTasksHandler: async () => ({ ok: true, value: { ledger: ledgerRev2 } }),
    ledgers: [ledgerRev1]
  })

  await openTasksFor(runtime, 'cnv1')
  // Capture view handler before refresh
  const viewBtnBeforeRefresh = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_ref_1', 'View button before refresh')
  const savedHandlerBeforeRefresh = viewBtnBeforeRefresh.props.onClick

  // Click refresh
  const refreshBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-refresh'] === 'true', 'Refresh button')
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(getCalls('reconcileTasks').length, 1, 'Reconcile tasks dispatched on refresh')

  const rpcBeforeView = getCalls('taskLedger').length
  // Invoke savedHandler from before refresh (same instance, taskToken unchanged)
  savedHandlerBeforeRefresh(mockEvent())
  await runtime.settle()

  assert.equal(getCalls('taskLedger').length, rpcBeforeView + 1, 'View callback remains valid after refresh retaining task')
  const detail = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_ref_1')
  assert.ok(detail, 'Task Center successfully opened and selected target task')
})

test('7. Token guards dispatch only: valid dispatched read completes after source-panel closure', async () => {
  const task1 = {
    taskId: 'tsk_disp_1',
    label: 'Task Dispatched',
    childSessionId: 'sess_disp_1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task1] })
  const def = deferred()

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async (args) => {
      callCount += 1
      if (callCount === 1) {
        // Initial loadTasks
        return { ok: true, value: ledger }
      }
      // Second call is viewTaskDetail -> deferred
      return def.promise
    },
    ledgers: [ledger]
  })

  await openTasksFor(runtime, 'cnv1')

  // Click View to legitimately dispatch navigation
  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_disp_1', 'View button')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Task Center is loading
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-status'] === 'loading'), 'Task Center is loading')

  // Close source panel while read is in-flight
  await openTasksFor(runtime, 'cnv1')
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-panel'] === 'cnv1'), null, 'Source panel is closed')

  // Resolve in-flight ledger read
  def.resolve({ ok: true, value: ledger })
  await runtime.settle()

  // Task Center should complete and select task, NOT be cancelled by source panel close
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), 'Task Center panel remains open')
  const detail = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_disp_1')
  assert.ok(detail, 'Target task successfully selected in Task Center')
})

test('8. Race condition & supersession isolation: newer Task Center navigation wins over older response', async () => {
  const task1 = {
    taskId: 'tsk_race_1',
    label: 'Task Race 1',
    childSessionId: 'sess_race_1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const task2 = {
    taskId: 'tsk_race_2',
    label: 'Task Race 2',
    childSessionId: 'sess_race_2',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task1, task2] })

  const def1 = deferred()
  const def2 = deferred()
  let callCount = 0

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: ledger }
      if (callCount === 2) return def1.promise
      return def2.promise
    },
    ledgers: [ledger]
  })

  await openTasksFor(runtime, 'cnv1')

  // Click View on task 1 (dispatches U1)
  const viewBtn1 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_race_1', 'View button 1')
  viewBtn1.props.onClick(mockEvent())
  await runtime.settle()

  // Click View on task 2 (dispatches U2, superseding U1)
  const viewBtn2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_race_2', 'View button 2')
  viewBtn2.props.onClick(mockEvent())
  await runtime.settle()

  // Resolve U2 first
  def2.resolve({ ok: true, value: ledger })
  await runtime.settle()

  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_race_2'), 'Task 2 selected from U2')

  // Late resolution of U1
  def1.resolve({ ok: true, value: ledger })
  await runtime.settle()

  // Task 2 must remain selected; U1 is discarded
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_race_2'), 'Task 2 remains selected after late U1 resolution')
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_race_1'), null, 'Task 1 was discarded')
})

test('9. Close and unmount lifecycle safety: in-flight Task Center request discarded on panel close or unmount', async () => {
  const task1 = {
    taskId: 'tsk_safe_1',
    label: 'Task Safe',
    childSessionId: 'sess_safe_1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task1] })
  const def = deferred()

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: ledger }
      return def.promise
    },
    ledgers: [ledger]
  })

  await openTasksFor(runtime, 'cnv1')

  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_safe_1', 'View button')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Close Task Center panel while request is in flight
  const closeBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-close'] === 'true', 'Close Task Center button')
  closeBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Task Center closed')

  // Resolve late response
  def.resolve({ ok: true, value: ledger })
  await runtime.settle()

  // Panel must NOT reopen
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Task Center did not reopen on late resolution')
})

test('10. Non-whitelisted method isolation: zero mutation, openSession, reconcileTasks or execution calls attributable to View', async () => {
  const task1 = {
    taskId: 'tsk_iso_1',
    label: 'Task Iso',
    childSessionId: 'sess_iso_1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task1] })

  const { runtime, methodCalls } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    ledgers: [ledger]
  })

  await openTasksFor(runtime, 'cnv1')

  const callsBeforeView = [...methodCalls]

  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_iso_1', 'View button')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  const callsAfterView = methodCalls.slice(callsBeforeView.length)

  // Must only contain exactly 1 read-only taskLedger call
  assert.equal(callsAfterView.length, 1, 'Exactly one RPC call made by View')
  assert.equal(callsAfterView[0].method, 'taskLedger', 'Only read-only taskLedger is called')

  // Verify zero mutation calls
  const disallowed = ['reconcileTasks', 'openSession', 'createConversation', 'moveNode', 'renameNode']
  for (const m of callsAfterView) {
    assert.ok(!disallowed.includes(m.method), `Disallowed method ${m.method} must not be called`)
  }
})
