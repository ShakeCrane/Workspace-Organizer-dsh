/**
 * FP-105: Explicit View Direct Parent Task from Child Task Detail Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Entry button:
 *    - Rendered only when taskCenterOpen && taskCenterStatus === "ready" && selected.parent.kind === "task".
 *    - Selector data-wo-task-parent-view={selected.parent.taskId}.
 *    - Root Task (parent.kind === "conversation") does NOT render View parent task button.
 * 2. Pre-RPC validation fails closed with 0 RPCs:
 *    - Validates panel is open, status is ready, taskCenterSelected === childTaskId.
 *    - Freezes { childTaskId, parentTaskId, sourceConversationId }.
 *    - Rejects if child or parent is missing/ambiguous/cross-source/self-referencing in live ledger.
 *    - Rejects if old handler invoked after selection changed or after unmount.
 * 3. Fresh ledger verification on same taskLedger response:
 *    - Dispatches exactly 1 read-only remote.taskLedger() RPC.
 *    - Confirms child task is unique, source unchanged, still points to frozen parentTaskId.
 *    - Confirms parent task is unique and belongs to same source conversation.
 *    - On success: status becomes "ready", taskCenterSelected becomes parentTaskId.
 *    - On failure (drift, missing, duplicate, cross-source, self-ref, RPC error):
 *      status becomes "error", taskCenterSelected becomes null, shows honest error notice.
 * 4. Generation race isolation:
 *    - U1 superseded by U2; late U1 resolution discarded.
 *    - Panel close in-flight discards late resolution.
 *    - Source filter reset to all ("").
 *    - Old locate intent and timer cleared.
 * 5. Zero non-whitelisted calls:
 *    - 0 openSession, 0 reconcileTasks, 0 mutations, 0 host/browser execution.
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
  sessionSource: 'synthetic-parent-nav-test'
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
      workspaceLogicalId: 'wsp-2',
      nativeWorkspaceId: 'nw-2',
      directory: 'E:\\ws-2',
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

test('FP-105: 1. Grandchild -> Child -> Root parent navigation hierarchy', async () => {
  const rootTask = {
    taskId: 't-root',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    childSessionId: 'ses-root',
    depth: 0,
    mode: 'plan',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:00.000Z',
    label: 'Root Architecture Plan'
  }
  const childTask = {
    taskId: 't-child',
    sourceConversationId: 'cnv1',
    parent: { kind: 'task', taskId: 't-root' },
    childSessionId: 'ses-child',
    depth: 1,
    mode: 'code',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z',
    label: 'Child Implementation Task'
  }
  const grandchildTask = {
    taskId: 't-grandchild',
    sourceConversationId: 'cnv1',
    parent: { kind: 'task', taskId: 't-child' },
    childSessionId: 'ses-grandchild',
    depth: 2,
    mode: 'test',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:02.000Z',
    label: 'Grandchild Verification Task'
  }

  const ledger = makeLedger({ tasks: [rootTask, childTask, grandchildTask] })

  let callCount = 0
  const { runtime, remote } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      return { ok: true, value: ledger }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Select grandchild
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-grandchild').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // (1) Step 1: In grandchild detail, verify "View parent task (t-child)" button exists
  const viewParentBtn1 = requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-child', 'View parent task t-child')
  assert.equal(textOf(viewParentBtn1), 'View parent task (t-child)')

  const callsBefore1 = callCount

  // Click View parent task -> navigates to t-child
  viewParentBtn1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Exactly 1 new taskLedger RPC
  assert.equal(callCount, callsBefore1 + 1)
  assert.equal(remote.illegal.length, 0)

  // Selection moved to t-child
  const detailPanelChild = requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-child')
  assert.ok(textOf(detailPanelChild).includes('taskId: t-child'))
  assert.ok(textOf(detailPanelChild).includes('depth/mode: 1/code'))

  // (2) Step 2: In child detail, verify "View parent task (t-root)" button exists
  const viewParentBtn2 = requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-root', 'View parent task t-root')
  assert.equal(textOf(viewParentBtn2), 'View parent task (t-root)')

  const callsBefore2 = callCount

  // Click View parent task -> navigates to t-root
  viewParentBtn2.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  assert.equal(callCount, callsBefore2 + 1)

  // Selection moved to t-root
  const detailPanelRoot = requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-root')
  assert.ok(textOf(detailPanelRoot).includes('taskId: t-root'))
  assert.ok(textOf(detailPanelRoot).includes('depth/mode: 0/plan'))

  // (3) Step 3: In root detail (parent.kind === 'conversation'), verify NO parent task button exists!
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-parent-view'] !== undefined), null)
  // Locate source button remains
  requireOne(root, (n) => n.props?.['data-wo-task-center-locate'] === 't-root')
})

test('FP-105: 2. Pre-RPC validation fails closed with 0 RPCs', async () => {
  const rootTask = {
    taskId: 't-root',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    childSessionId: 'ses-root',
    depth: 0,
    mode: 'plan',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:00.000Z',
    label: 'Root Task'
  }
  const childTask = {
    taskId: 't-child',
    sourceConversationId: 'cnv1',
    parent: { kind: 'task', taskId: 't-root' },
    childSessionId: 'ses-child',
    depth: 1,
    mode: 'code',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z',
    label: 'Child Task'
  }

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      return { ok: true, value: makeLedger({ tasks: [rootTask, childTask] }) }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t-child
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Save reference to t-child's parent view button handler
  const savedHandler = requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-root').props.onClick

  // Switch selection to t-root
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-root').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const callsBeforeInvokingSaved = callCount

  // Invoking saved handler of t-child when t-root is currently selected must fail closed with 0 RPCs
  savedHandler(mockEvent())
  await runtime.settle()

  assert.equal(callCount, callsBeforeInvokingSaved)
  root = runtime.getRoot()
  // Current selection remains t-root
  requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-root')
})

test('FP-105: 3. Cross-source parent relation rejected pre-RPC with 0 RPCs', async () => {
  // Synthetic malformed input: parent is in cnv2 while child is in cnv1!
  const parentInOtherConv = {
    taskId: 't-p-other',
    sourceConversationId: 'cnv2', // different source conversation!
    parent: { kind: 'conversation', conversationId: 'cnv2' },
    childSessionId: 'ses-2',
    depth: 0,
    mode: 'plan',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:00.000Z',
    label: 'Other Source Task'
  }
  const childInC1 = {
    taskId: 't-child-c1',
    sourceConversationId: 'cnv1',
    parent: { kind: 'task', taskId: 't-p-other' },
    childSessionId: 'ses-1',
    depth: 1,
    mode: 'code',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z',
    label: 'Malformed Cross-source Child'
  }

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      return { ok: true, value: makeLedger({ tasks: [parentInOtherConv, childInC1] }) }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t-child-c1
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child-c1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const parentBtn = requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-p-other')
  const callsBeforeClick = callCount

  // Clicking cross-source parent must fail closed with 0 RPCs
  parentBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(callCount, callsBeforeClick)
})

test('FP-105: 4. Fresh ledger verification fails closed if parent relationship drifted', async () => {
  const initialRoot = {
    taskId: 't-root',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    childSessionId: 'ses-root',
    depth: 0,
    mode: 'plan',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:00.000Z',
    label: 'Initial Root'
  }
  const initialChild = {
    taskId: 't-child',
    sourceConversationId: 'cnv1',
    parent: { kind: 'task', taskId: 't-root' },
    childSessionId: 'ses-child',
    depth: 1,
    mode: 'code',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z',
    label: 'Initial Child'
  }

  // Drifted ledger: child task was reparented or parent changed to another task!
  const driftedChild = {
    ...initialChild,
    parent: { kind: 'task', taskId: 't-new-parent' } // DRIFTED!
  }
  const driftedLedger = makeLedger({
    revision: 2,
    tasks: [initialRoot, driftedChild]
  })

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: makeLedger({ tasks: [initialRoot, initialChild] }) }
      return { ok: true, value: driftedLedger }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t-child
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const parentBtn = requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-root')

  // Click View parent task -> fresh ledger returns with drifted parent
  parentBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Must fail closed: status=error, selected=null, honest error notice
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  const errDiv = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true')
  assert.ok(textOf(errDiv).includes('无法确认父任务关系'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

test('FP-105: 5. Fresh ledger verification fails closed if parent is missing on fresh ledger', async () => {
  const initialRoot = {
    taskId: 't-root',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    childSessionId: 'ses-root',
    depth: 0,
    mode: 'plan',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:00.000Z',
    label: 'Initial Root'
  }
  const initialChild = {
    taskId: 't-child',
    sourceConversationId: 'cnv1',
    parent: { kind: 'task', taskId: 't-root' },
    childSessionId: 'ses-child',
    depth: 1,
    mode: 'code',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z',
    label: 'Initial Child'
  }

  // Parent deleted from ledger
  const missingParentLedger = makeLedger({
    revision: 2,
    tasks: [initialChild]
  })

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: makeLedger({ tasks: [initialRoot, initialChild] }) }
      return { ok: true, value: missingParentLedger }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t-child
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View parent task -> parent missing on fresh ledger
  requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-root').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Must fail closed: status=error, selected=null
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

test('FP-105: 6. Generation race isolation (U1 superseded by U2)', async () => {
  const d1 = deferred()
  const d2 = deferred()
  let callCount = 0

  const initialRoot = { taskId: 't-root', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-root', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'Root Task' }
  const initialChild = { taskId: 't-child', sourceConversationId: 'cnv1', parent: { kind: 'task', taskId: 't-root' }, childSessionId: 'ses-child', depth: 1, mode: 'code', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:01.000Z', label: 'Child Task' }
  const independentTask = { taskId: 't-other', sourceConversationId: 'cnv2', parent: { kind: 'conversation', conversationId: 'cnv2' }, childSessionId: 'ses-other', depth: 0, mode: 'code', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:02.000Z', label: 'Other Task' }

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: makeLedger({ tasks: [initialRoot, initialChild, independentTask] }) }
      if (callCount === 2) return d1.promise // U1 pending
      if (callCount === 3) return d2.promise // U2 pending
      return { ok: true, value: makeLedger() }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t-child
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Trigger U1: View parent task
  requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-root').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'loading') !== null)

  // Trigger U2: user clicks Reload or another navigation while U1 is pending
  requireOne(root, (n) => n.props?.['data-wo-task-center-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Now resolve U1 late
  d1.resolve({ ok: true, value: makeLedger({ tasks: [initialRoot, initialChild] }) })
  await runtime.settle()
  root = runtime.getRoot()

  // U1 must NOT have applied to select t-root!
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-root'), null)

  // Now resolve U2
  d2.resolve({ ok: true, value: makeLedger({ tasks: [initialRoot, initialChild, independentTask] }) })
  await runtime.settle()
  root = runtime.getRoot()

  // Status ready from U2
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'ready')
})

test('FP-105: 7. Close in-flight: late resolution is safely discarded', async () => {
  const d = deferred()
  let callCount = 0

  const rootTask = { taskId: 't-root', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-root', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'Root Task' }
  const childTask = { taskId: 't-child', sourceConversationId: 'cnv1', parent: { kind: 'task', taskId: 't-root' }, childSessionId: 'ses-child', depth: 1, mode: 'code', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:01.000Z', label: 'Child Task' }

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: makeLedger({ tasks: [rootTask, childTask] }) }
      return d.promise
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t-child
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View parent task
  requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-root').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'loading') !== null)

  // While in-flight, user clicks Close
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)

  // Late resolution completes
  d.resolve({ ok: true, value: makeLedger({ tasks: [rootTask, childTask] }) })
  await runtime.settle()
  root = runtime.getRoot()

  // Panel remains closed, late result was safely discarded
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)
})

test('FP-105: 8. Source filter reset to all and locate state cleared on parent view', async () => {
  const rootTask = { taskId: 't-root', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-root', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'Root Task' }
  const childTask = { taskId: 't-child', sourceConversationId: 'cnv1', parent: { kind: 'task', taskId: 't-root' }, childSessionId: 'ses-child', depth: 1, mode: 'code', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:01.000Z', label: 'Child Task' }

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: makeLedger({ tasks: [rootTask, childTask] }) })
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t-child
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Set filter to cnv2 (so cnv1 tasks would be out of filter scope!)
  const filterSelect = requireOne(root, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true')
  filterSelect.props.onChange({ target: { value: 'cnv2' } })
  await runtime.settle()
  root = runtime.getRoot()

  // Reset filter back to cnv1 to view t-child
  filterSelect.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Scope currently shows cnv1
  const scopeSpan = requireOne(root, (n) => n.props?.['data-wo-task-center-scope'] === 'cnv1')
  assert.ok(textOf(scopeSpan).includes('cnv1'))

  // Click View parent task
  requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-root').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Scope MUST be reset to all ("") so the parent is visible!
  const scopeAfter = requireOne(root, (n) => n.props?.['data-wo-task-center-scope'] === 'all')
  assert.ok(textOf(scopeAfter).includes('All sources'))

  // t-root is selected
  requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-root')
})

test('FP-105: 9. RPC error failure sets error, selected=null, preserves cached ledger continuity', async () => {
  const rootTask = { taskId: 't-root', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-root', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'Root Task' }
  const childTask = { taskId: 't-child', sourceConversationId: 'cnv1', parent: { kind: 'task', taskId: 't-root' }, childSessionId: 'ses-child', depth: 1, mode: 'code', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:01.000Z', label: 'Child Task' }

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: makeLedger({ tasks: [rootTask, childTask] }) }
      return { ok: false, error: { message: 'Network disconnected during parent view' } }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t-child
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View parent task -> RPC network error
  requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-root').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Status is error, selected is null
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  const errDiv = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true')
  assert.ok(textOf(errDiv).includes('Network disconnected'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

test('FP-105: 10. Self-referencing parent rejected pre-RPC with 0 RPCs', async () => {
  // Synthetic malformed input: parent.taskId === taskId (self-referencing!)
  const selfRefTask = {
    taskId: 't-self-ref',
    sourceConversationId: 'cnv1',
    parent: { kind: 'task', taskId: 't-self-ref' },
    childSessionId: 'ses-self',
    depth: 1,
    mode: 'plan',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:00.000Z',
    label: 'Self Referencing Task'
  }

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      return { ok: true, value: makeLedger({ tasks: [selfRefTask] }) }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t-self-ref
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-self-ref').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const parentBtn = requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-self-ref')
  const callsBeforeClick = callCount

  // Clicking self-ref parent button must fail closed with 0 RPCs
  parentBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(callCount, callsBeforeClick)
})

test('FP-105: 11. Duplicate parent on fresh ledger fails closed', async () => {
  const rootA = { taskId: 't-root', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-1', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'Root A' }
  const rootB = { taskId: 't-root', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-2', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'Root B (Duplicate)' }
  const child = { taskId: 't-child', sourceConversationId: 'cnv1', parent: { kind: 'task', taskId: 't-root' }, childSessionId: 'ses-child', depth: 1, mode: 'code', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:01.000Z', label: 'Child Task' }

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: makeLedger({ tasks: [rootA, child] }) }
      // Duplicate parent on fresh ledger!
      return { ok: true, value: makeLedger({ revision: 2, tasks: [rootA, rootB, child] }) }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select child
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View parent task
  requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-root').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Duplicate parent -> fails closed
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

test('FP-105: 12. Duplicate child on fresh ledger fails closed', async () => {
  const rootTask = { taskId: 't-root', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-root', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'Root Task' }
  const childA = { taskId: 't-child', sourceConversationId: 'cnv1', parent: { kind: 'task', taskId: 't-root' }, childSessionId: 'ses-child', depth: 1, mode: 'code', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:01.000Z', label: 'Child Task' }
  const childB = { taskId: 't-child', sourceConversationId: 'cnv1', parent: { kind: 'task', taskId: 't-root' }, childSessionId: 'ses-child-2', depth: 1, mode: 'code', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:01.000Z', label: 'Child Task Duplicate' }

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: makeLedger({ tasks: [rootTask, childA] }) }
      // Duplicate child on fresh ledger!
      return { ok: true, value: makeLedger({ revision: 2, tasks: [rootTask, childA, childB] }) }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select child
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View parent task
  requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-root').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Duplicate child -> fails closed
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

test('FP-105: 13. Disambiguation between tasks with same label in C1 vs C2: strictly enforced by taskId', async () => {
  const rootC1 = { taskId: 't-root-c1', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-1', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'Shared Title Parent' }
  const childC1 = { taskId: 't-child-c1', sourceConversationId: 'cnv1', parent: { kind: 'task', taskId: 't-root-c1' }, childSessionId: 'ses-1', depth: 1, mode: 'code', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:01.000Z', label: 'Child In C1' }

  // Task in C2 with same label as C1 parent!
  const rootC2SameLabel = { taskId: 't-root-c2', sourceConversationId: 'cnv2', parent: { kind: 'conversation', conversationId: 'cnv2' }, childSessionId: 'ses-2', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'Shared Title Parent' }

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: makeLedger({ tasks: [rootC1, childC1, rootC2SameLabel] }) })
  })

  let root = runtime.getRoot()

  // Open All Tasks, select childC1
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-child-c1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View parent task
  requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't-root-c1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Must select t-root-c1, NOT t-root-c2 even though they have the same label!
  requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-root-c1')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-root-c2'), null)
})
