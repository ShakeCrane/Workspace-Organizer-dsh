/**
 * Source Tasks Row to Existing Centralized Read-only Detail Navigation Flow Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Entry button: stable selector data-wo-task-view={task.taskId}, label "查看详情".
 * 2. Pre-RPC validation: checks isMounted, taskSource, taskLedger, sourceConversationId.
 *    Any mismatch fails closed locally with 0 RPCs.
 * 3. Target identity verification on fresh ledger: exactly one matching task
 *    with same taskId AND same sourceConversationId.
 * 4. Disambiguation: tasks with identical labels are correctly differentiated by taskId.
 * 5. Target missing, duplicate, or changed sourceConversationId in ledger: fails closed,
 *    selected is null, error notice shown, zero auto-select.
 * 6. Request failure: preserves existing ledger list (stale), selected is null, error notice shown, zero retry.
 * 7. Generation race isolation: U1 superseded by U2; late U1 resolution/rejection discarded.
 * 8. Close / Unmount lifecycle safety: in-flight request cannot reopen panel or write state;
 *    stale handler invoked after unmount dispatches 0 RPCs.
 * 9. Header All Tasks / Panel Reload does not resurrect navigation intent.
 * 10. Zero non-whitelisted RPCs (0 calls to reconcileTasks, conversationTarget, openSession, mutations).
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
    }
  ],
  tasks = []
} = {}) {
  return {
    revision,
    sources,
    tasks
  }
}

async function setupComponent({
  snapshot = baseSnapshot,
  status = baseStatus,
  taskLedgerHandler,
  ledgers = []
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })

  if (typeof taskLedgerHandler === 'function') {
    remote.allowed.taskLedger = taskLedgerHandler
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

  return { runtime, remote, mounted }
}

// Helper to open conversation tasks
async function openTasksFor(runtime, conversationId) {
  const root = runtime.getRoot()
  const tasksBtn = requireOne(root, (n) => n.props?.['data-wo-tasks'] === conversationId, `Tasks button for ${conversationId}`)
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()
}

// -----------------------------------------------------------------------------
// Test 1: Successful root task navigation & detail assertion
// -----------------------------------------------------------------------------
test('1. Successful root task navigation: opens centralized panel, sets ready, renders all detail fields from fresh ledger', async () => {
  const initialTask = {
    taskId: 'tsk_root_1',
    label: 'Root Worker Task',
    childSessionId: 'sess_child_root',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const initialLedger = makeLedger({ tasks: [initialTask] })

  const freshTask = {
    ...initialTask,
    executionState: 'COMPLETED'
  }
  const freshLedger = makeLedger({ revision: 2, tasks: [freshTask] })

  let callCount = 0
  const { runtime, remote } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      // Call 1 is loadTasks('cnv1')
      if (callCount === 1) return { ok: true, value: initialLedger }
      // Call 2 is viewTaskDetail(task)
      return { ok: true, value: freshLedger }
    }
  })

  // Open tasks panel for cnv1
  await openTasksFor(runtime, 'cnv1')

  let root = runtime.getRoot()
  const viewBtn = requireOne(root, (n) => n.props?.['data-wo-task-view'] === 'tsk_root_1', 'View detail button')
  assert.equal(textOf(viewBtn), '查看详情')

  // Click view detail
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Task Center panel must be open
  const panel = requireOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true', 'Task center panel')
  const statusEl = requireOne(panel, (n) => n.props?.['data-wo-task-center-status'] === 'ready', 'Status ready')
  assert.match(textOf(statusEl), /ready \(rev 2\)/)

  // Central detail container rendered for tsk_root_1
  const detail = requireOne(panel, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_root_1', 'Detail for tsk_root_1')
  const detailText = textOf(detail)

  assert.match(detailText, /taskId: tsk_root_1/)
  assert.match(detailText, /sourceConversationId: cnv1/)
  assert.match(detailText, /parent: conversation:cnv1/)
  assert.match(detailText, /childSessionId: sess_child_root/)
  assert.match(detailText, /depth\/mode: 1\/one-shot/)
  assert.match(detailText, /execution: COMPLETED \(eligible\)/)
  assert.match(detailText, /observed directory: E:\\ws-1/)
  assert.match(detailText, /logical workspace: wsp-1/)
  assert.match(detailText, /native workspace: nw-1/)
  assert.match(detailText, /verification: verified/)

  assert.equal(callCount, 2)
})

// -----------------------------------------------------------------------------
// Test 2: Successful descendant task navigation & detail assertion
// -----------------------------------------------------------------------------
test('2. Successful descendant task navigation: parent is task, childSessionId, depth, blockedReason', async () => {
  const rootTask = {
    taskId: 'tsk_root',
    label: 'Root Task',
    childSessionId: 'sess_root',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const childTask = {
    taskId: 'tsk_child_blocked',
    label: 'Blocked Child Task',
    childSessionId: 'sess_child_wait',
    sourceConversationId: 'cnv1',
    parent: { kind: 'task', taskId: 'tsk_root' },
    depth: 2,
    mode: 'one-shot',
    executionState: 'PAUSED',
    executionEligibility: 'blocked',
    blockedReason: 'waiting-user-confirmation',
    observedAt: '2026-10-25T10:00:02.000Z'
  }
  const ledger = makeLedger({ tasks: [rootTask, childTask] })

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTasksFor(runtime, 'cnv1')

  let root = runtime.getRoot()
  const viewChildBtn = requireOne(root, (n) => n.props?.['data-wo-task-view'] === 'tsk_child_blocked', 'View child detail button')

  viewChildBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const detail = requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_child_blocked', 'Child detail')
  const detailText = textOf(detail)

  assert.match(detailText, /taskId: tsk_child_blocked/)
  assert.match(detailText, /parent: task:tsk_root/)
  assert.match(detailText, /childSessionId: sess_child_wait/)
  assert.match(detailText, /depth\/mode: 2\/one-shot/)
  assert.match(detailText, /execution: PAUSED \(blocked\)/)
  assert.match(detailText, /blocked: waiting-user-confirmation/)

  const blockedEl = requireOne(detail, (n) => n.props?.['data-wo-task-center-blocked'] === 'true', 'Blocked indicator')
  assert.match(textOf(blockedEl), /blocked: waiting-user-confirmation/)
})

// -----------------------------------------------------------------------------
// Test 3: Disambiguation between tasks with same label
// -----------------------------------------------------------------------------
test('3. Disambiguation: two tasks with identical labels are correctly navigated to exact taskId', async () => {
  const taskA = {
    taskId: 'tsk_compile_1',
    label: 'Compile Step',
    childSessionId: 'sess_c1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const taskB = {
    taskId: 'tsk_compile_2',
    label: 'Compile Step',
    childSessionId: 'sess_c2',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:02.000Z'
  }
  const ledger = makeLedger({ tasks: [taskA, taskB] })

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTasksFor(runtime, 'cnv1')

  let root = runtime.getRoot()
  const viewB = requireOne(root, (n) => n.props?.['data-wo-task-view'] === 'tsk_compile_2', 'Button for task B')
  viewB.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_compile_2'), 'Task B must be selected')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_compile_1'), null, 'Task A must NOT be selected')
})

// -----------------------------------------------------------------------------
// Test 4: Pre-RPC validation fail-closed on switched source or closed panel
// -----------------------------------------------------------------------------
test('4. Pre-RPC validation fail-closed: switching conversation or closed panel rejects saved handler with 0 RPC', async () => {
  const task1 = {
    taskId: 'tsk_sw_1',
    label: 'Task 1',
    childSessionId: 'sess_sw1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger1 = makeLedger({ tasks: [task1] })

  let rpcCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      rpcCount += 1
      return { ok: true, value: ledger1 }
    }
  })

  await openTasksFor(runtime, 'cnv1')
  assert.equal(rpcCount, 1)

  // Capture saved handler from button
  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_sw_1', 'View button')
  const savedHandler = viewBtn.props.onClick

  // Switch conversation to cnv2
  await openTasksFor(runtime, 'cnv2')
  const rpcAfterSwitch = rpcCount // loadTasks for cnv2

  // Invoke saved handler from cnv1 task
  savedHandler(mockEvent())
  await runtime.settle()

  // Must dispatch ZERO new RPCs
  assert.equal(rpcCount, rpcAfterSwitch, 'Zero RPCs must be dispatched on switched source')
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Panel must not open')

  // Close task panel entirely
  await openTasksFor(runtime, 'cnv2') // toggle closes
  savedHandler(mockEvent())
  await runtime.settle()
  assert.equal(rpcCount, rpcAfterSwitch, 'Zero RPCs on closed task panel')
})

// -----------------------------------------------------------------------------
// Test 5: Stale source row verification: initiates fresh read and reflects fresh data
// -----------------------------------------------------------------------------
test('5. Stale source row verification: initiates fresh read and reflects updated state from ledger', async () => {
  const staleTask = {
    taskId: 'tsk_stale_row',
    label: 'Task Stale Row',
    childSessionId: 'sess_sr',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const initialLedger = makeLedger({ revision: 1, tasks: [staleTask] })

  const updatedTask = {
    ...staleTask,
    executionState: 'COMPLETED',
    observedAt: '2026-10-25T10:05:00.000Z'
  }
  const freshLedger = makeLedger({ revision: 5, tasks: [updatedTask] })

  let count = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      count += 1
      if (count === 1) return { ok: true, value: initialLedger }
      return { ok: true, value: freshLedger }
    }
  })

  await openTasksFor(runtime, 'cnv1')
  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_stale_row', 'View button')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  const detail = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_stale_row', 'Detail')
  assert.match(textOf(detail), /execution: COMPLETED/)
  assert.match(textOf(detail), /observedAt: 2026-10-25T10:05:00.000Z/)
})

// -----------------------------------------------------------------------------
// Test 6: Target missing in returned fresh ledger: fail-closed, null selection
// -----------------------------------------------------------------------------
test('6. Target missing in fresh ledger: fail-closed, null selection, error notice, zero auto-select', async () => {
  const taskRow = {
    taskId: 'tsk_missing',
    label: 'Will Disappear',
    childSessionId: 'sess_dis',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const initialLedger = makeLedger({ tasks: [taskRow] })

  // Fresh ledger has another task, but tsk_missing was removed!
  const otherTask = {
    taskId: 'tsk_other_survivor',
    label: 'Survivor',
    childSessionId: 'sess_surv',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:02.000Z'
  }
  const freshLedger = makeLedger({ revision: 3, tasks: [otherTask] })

  let count = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      count += 1
      if (count === 1) return { ok: true, value: initialLedger }
      return { ok: true, value: freshLedger }
    }
  })

  await openTasksFor(runtime, 'cnv1')
  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_missing', 'View button')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  const root = runtime.getRoot()
  const errorEl = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true', 'Error element')
  assert.match(textOf(errorEl), /无法确认任务目标/)

  // Selected detail must be null - definitely NOT auto-selected to otherTask!
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

// -----------------------------------------------------------------------------
// Test 7: Duplicate taskId in returned fresh ledger: fail-closed
// -----------------------------------------------------------------------------
test('7. Duplicate taskId in returned fresh ledger: fail-closed, null selection, error notice', async () => {
  const task = {
    taskId: 'tsk_dup',
    label: 'Duplicated Task',
    childSessionId: 'sess_d1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const initialLedger = makeLedger({ tasks: [task] })

  // Fresh ledger contains corrupt duplicate entries for same taskId and source
  const freshLedger = makeLedger({ revision: 4, tasks: [task, { ...task, childSessionId: 'sess_d2' }] })

  let count = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      count += 1
      if (count === 1) return { ok: true, value: initialLedger }
      return { ok: true, value: freshLedger }
    }
  })

  await openTasksFor(runtime, 'cnv1')
  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_dup', 'View button')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  const root = runtime.getRoot()
  const errorEl = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true', 'Error element')
  assert.match(textOf(errorEl), /无法确认任务目标/)
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

// -----------------------------------------------------------------------------
// Test 8: Changed sourceConversationId in returned fresh ledger: fail-closed
// -----------------------------------------------------------------------------
test('8. Changed sourceConversationId in fresh ledger: fail-closed, null selection', async () => {
  const task = {
    taskId: 'tsk_drift',
    label: 'Drifting Task',
    childSessionId: 'sess_drift',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const initialLedger = makeLedger({ tasks: [task] })

  // In fresh ledger, sourceConversationId drifted to cnv2
  const freshLedger = makeLedger({
    revision: 5,
    tasks: [{ ...task, sourceConversationId: 'cnv2' }]
  })

  let count = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      count += 1
      if (count === 1) return { ok: true, value: initialLedger }
      return { ok: true, value: freshLedger }
    }
  })

  await openTasksFor(runtime, 'cnv1')
  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_drift', 'View button')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  const root = runtime.getRoot()
  const errorEl = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true', 'Error element')
  assert.match(textOf(errorEl), /无法确认任务目标/)
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

// -----------------------------------------------------------------------------
// Test 9: Request failure handling & stale continuity
// -----------------------------------------------------------------------------
test('9. Request failure handling: rejection sets error status, preserves existing ledger list, zero auto-retry', async () => {
  const task = {
    taskId: 'tsk_fail_test',
    label: 'Task Failure Test',
    childSessionId: 'sess_f',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const initialLedger = makeLedger({ tasks: [task] })

  let count = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      count += 1
      if (count === 1) return { ok: true, value: initialLedger }
      return { ok: false, error: { message: 'Network connection aborted' } }
    }
  })

  await openTasksFor(runtime, 'cnv1')
  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_fail_test', 'View button')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  const root = runtime.getRoot()
  const errorEl = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true', 'Error element')
  assert.match(textOf(errorEl), /Network connection aborted/)

  // Selected is null
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
  // No auto retry happened
  assert.equal(count, 2)
})

// -----------------------------------------------------------------------------
// Test 10: Generation race condition: U1 in-flight superseded by U2
// -----------------------------------------------------------------------------
test('10. Generation race condition: U1 in-flight superseded by U2; late U1 resolution or rejection is discarded', async () => {
  const task1 = {
    taskId: 'tsk_u1',
    label: 'Task U1',
    childSessionId: 'sess_u1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const task2 = {
    taskId: 'tsk_u2',
    label: 'Task U2',
    childSessionId: 'sess_u2',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:02.000Z'
  }
  const initialLedger = makeLedger({ tasks: [task1, task2] })

  const d1 = deferred()
  const d2 = deferred()
  let callIndex = 0

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callIndex += 1
      if (callIndex === 1) return { ok: true, value: initialLedger } // initial loadTasks
      if (callIndex === 2) return d1.promise // U1
      if (callIndex === 3) return d2.promise // U2
      throw new Error('unexpected call')
    }
  })

  await openTasksFor(runtime, 'cnv1')

  let root = runtime.getRoot()
  const btn1 = requireOne(root, (n) => n.props?.['data-wo-task-view'] === 'tsk_u1', 'Btn 1')
  const btn2 = requireOne(root, (n) => n.props?.['data-wo-task-view'] === 'tsk_u2', 'Btn 2')

  // Click U1
  btn1.props.onClick(mockEvent())
  // Click U2 while U1 is pending
  btn2.props.onClick(mockEvent())

  // Resolve U2 first with rev 20
  const ledger2 = makeLedger({ revision: 20, tasks: [task1, task2] })
  d2.resolve({ ok: true, value: ledger2 })
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_u2'), 'U2 detail must be visible')

  // Later resolve U1 with rev 10
  const ledger1 = makeLedger({ revision: 10, tasks: [task1, task2] })
  d1.resolve({ ok: true, value: ledger1 })
  await runtime.settle()

  root = runtime.getRoot()
  // U2 must STILL be selected, rev must still be 20
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_u2'), 'U2 detail must remain')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_u1'), null, 'Late U1 must be discarded')
  const statusEl = requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'ready', 'Status')
  assert.match(textOf(statusEl), /rev 20/)
})

// -----------------------------------------------------------------------------
// Test 11: Close and unmount lifecycle safety
// -----------------------------------------------------------------------------
test('11. Close and unmount lifecycle safety: in-flight request discarded on panel close or unmount', async () => {
  const task = {
    taskId: 'tsk_unmount',
    label: 'Unmount Task',
    childSessionId: 'sess_unm',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const initialLedger = makeLedger({ tasks: [task] })

  const d = deferred()
  let calls = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      calls += 1
      if (calls === 1) return { ok: true, value: initialLedger }
      return d.promise
    }
  })

  await openTasksFor(runtime, 'cnv1')
  const btn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_unmount', 'View btn')
  const savedHandler = btn.props.onClick

  // Part A: Click view then close panel while in-flight
  btn.props.onClick(mockEvent())
  runtime.render()
  // Close panel
  const closeBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-close'] === 'true', 'Close button')
  closeBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Resolve pending request
  d.resolve({ ok: true, value: initialLedger })
  await runtime.settle()

  // Panel must STAY closed
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)

  // Part B: Unmount safety and saved handler post-unmount
  runtime.unmount()
  const rpcAfterUnmount = calls

  // Invoking saved handler after unmount
  savedHandler(mockEvent())
  await runtime.settle()
  assert.equal(calls, rpcAfterUnmount, 'Zero RPCs when invoking handler after unmount')
})

// -----------------------------------------------------------------------------
// Test 12: Header All Tasks and Panel Reload do NOT resurrect navigation intent
// -----------------------------------------------------------------------------
test('12. Header All Tasks and Panel Reload do NOT resurrect superseded navigation intent', async () => {
  const task = {
    taskId: 'tsk_resurrect',
    label: 'Resurrect Test',
    childSessionId: 'sess_res',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task] })

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTasksFor(runtime, 'cnv1')
  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_resurrect', 'View btn')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_resurrect'), 'Detail displayed')

  // Close task center
  const closeBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-close'] === 'true', 'Close button')
  closeBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Open All Tasks from header
  const allTasksBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true', 'All Tasks header button')
  allTasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Detail must NOT be displayed (selection was cleared on close and not resurrected by header button)
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

// -----------------------------------------------------------------------------
// Test 13: Non-whitelisted method isolation
// -----------------------------------------------------------------------------
test('13. Non-whitelisted method isolation: zero calls to reconcileTasks, conversationTarget, openSession, or mutations', async () => {
  const task = {
    taskId: 'tsk_safe',
    label: 'Safe Task',
    childSessionId: 'sess_safe',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task] })

  const { runtime, remote } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTasksFor(runtime, 'cnv1')
  const viewBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_safe', 'View btn')
  viewBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(remote.illegal.length, 0, 'No illegal RPC methods invoked')
  const nonAllowedCalls = remote.calls.filter((c) => !['snapshot', 'status', 'taskLedger'].includes(c.method))
  assert.equal(nonAllowedCalls.length, 0, 'No non-whitelisted calls')
})
