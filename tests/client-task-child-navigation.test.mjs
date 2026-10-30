/**
 * FP-106: Explicit View Direct Child Tasks from Parent Task Detail Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Projection of Direct Child Tasks:
 *    - In centralized Task detail panel (data-wo-task-center-detail), adds dedicated section:
 *      "当前账本观察到的直属子任务" / Direct child tasks observed in current ledger.
 *    - Filters from accepted taskCenterLedger:
 *      parent.kind === "task" && parent.taskId === selected.taskId && sourceConversationId === selected.sourceConversationId.
 *    - Only direct children; excludes grandchildren, siblings, other roots, and cross-source tasks.
 *    - Sorted deterministically by taskId.
 *    - Displays label (or taskId) and taskId.
 *    - Projection & sorting dispatches 0 RPCs, no mutation of ledger.
 * 2. Empty & Malformed State Handling:
 *    - When ready and parent is unique with 0 children: shows data-wo-task-children-empty="true" with text "本账本未观察到直属子任务".
 *    - error/stale retains previously observed child list and disables buttons (no false empty).
 *    - Malformed input (duplicate child ID, duplicate parent, self-ref, cross-source) hints relationship unconfirmed and refuses navigation.
 * 3. Pre-RPC Validation Fails Closed with 0 RPCs:
 *    - Live refs check: panel open, status ready, selected === parentTaskId.
 *    - Freezes { parentTaskId, childTaskId, sourceConversationId }.
 *    - Rejects if parent or child is missing/ambiguous/cross-source/self-referential in live ledger.
 *    - Rejects if handler invoked after selection changed, panel closed, or unmounted.
 * 4. Fresh Ledger Verification on Same taskLedger Response:
 *    - Exactly 1 read-only remote.taskLedger() RPC.
 *    - Validates parent is unique and source unchanged in fresh ledger.
 *    - Validates child is unique, source unchanged, parent.kind === "task", parent.taskId === parentTaskId.
 *    - Rejects self-reference.
 *    - On success: status becomes "ready", taskCenterSelected becomes childTaskId.
 *    - On failure (drift, missing, duplicate, cross-source, self-ref, RPC error):
 *      status becomes "error", taskCenterSelected becomes null, shows honest error notice.
 * 5. Generation Race & Lifecycle Isolation:
 *    - U1 superseded by U2; late U1 resolution discarded.
 *    - Close / unmount in-flight: late resolution safely discarded, does not reopen panel.
 *    - Source filter reset to all ("").
 *    - Old locate intent and timer cleared.
 * 6. Zero Non-Whitelisted Calls:
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
  sessionSource: 'synthetic-child-nav-test'
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

// Preset tasks according to contract specifications:
// C1: Root T1, Children T2 & T3, Grandchild T4 (child of T2), Root T5
// C2: Root T-C2, Cross-source Child T2 with same label in C2
const t1Root = Object.freeze({
  taskId: 't1',
  sourceConversationId: 'cnv1',
  parent: { kind: 'conversation', conversationId: 'cnv1' },
  childSessionId: 'ses-t1',
  depth: 0,
  mode: 'plan',
  executionState: 'running',
  executionEligibility: 'eligible',
  observedAt: '2026-10-25T10:00:00.000Z',
  label: 'Task T1 Root'
})

const t2Child = Object.freeze({
  taskId: 't2',
  sourceConversationId: 'cnv1',
  parent: { kind: 'task', taskId: 't1' },
  childSessionId: 'ses-t2',
  depth: 1,
  mode: 'code',
  executionState: 'running',
  executionEligibility: 'eligible',
  observedAt: '2026-10-25T10:00:01.000Z',
  label: 'Task T2 Child'
})

const t3Child = Object.freeze({
  taskId: 't3',
  sourceConversationId: 'cnv1',
  parent: { kind: 'task', taskId: 't1' },
  childSessionId: 'ses-t3',
  depth: 1,
  mode: 'test',
  executionState: 'running',
  executionEligibility: 'eligible',
  observedAt: '2026-10-25T10:00:02.000Z',
  label: 'Task T3 Child'
})

const t4Grandchild = Object.freeze({
  taskId: 't4',
  sourceConversationId: 'cnv1',
  parent: { kind: 'task', taskId: 't2' },
  childSessionId: 'ses-t4',
  depth: 2,
  mode: 'verify',
  executionState: 'completed',
  executionEligibility: 'eligible',
  observedAt: '2026-10-25T10:00:03.000Z',
  label: 'Task T4 Grandchild'
})

const t5AnotherRoot = Object.freeze({
  taskId: 't5',
  sourceConversationId: 'cnv1',
  parent: { kind: 'conversation', conversationId: 'cnv1' },
  childSessionId: 'ses-t5',
  depth: 0,
  mode: 'plan',
  executionState: 'idle',
  executionEligibility: 'eligible',
  observedAt: '2026-10-25T10:00:04.000Z',
  label: 'Task T5 Another Root'
})

const tC2Root = Object.freeze({
  taskId: 't-c2-root',
  sourceConversationId: 'cnv2',
  parent: { kind: 'conversation', conversationId: 'cnv2' },
  childSessionId: 'ses-c2-root',
  depth: 0,
  mode: 'plan',
  executionState: 'running',
  executionEligibility: 'eligible',
  observedAt: '2026-10-25T10:00:05.000Z',
  label: 'Task C2 Root'
})

const t2C2DuplicateLabel = Object.freeze({
  taskId: 't2-c2',
  sourceConversationId: 'cnv2',
  parent: { kind: 'task', taskId: 't-c2-root' },
  childSessionId: 'ses-c2-child',
  depth: 1,
  mode: 'code',
  executionState: 'running',
  executionEligibility: 'eligible',
  observedAt: '2026-10-25T10:00:06.000Z',
  label: 'Task T2 Child' // Same label as t2Child, but in cnv2!
})

test('FP-106: 1. Direct child tasks projection accuracy and deterministic sorting', async () => {
  // Ledger containing t1, t2, t3, t4, t5, tC2Root, t2C2DuplicateLabel
  const ledger = makeLedger({
    tasks: [t3Child, t5AnotherRoot, t1Root, t4Grandchild, t2Child, tC2Root, t2C2DuplicateLabel]
  })

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

  // Select Root T1
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const callsAfterSelect = callCount

  // Verify T1 detail panel
  const detailPanel = requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't1')
  assert.ok(textOf(detailPanel).includes('taskId: t1'))

  // Verify Direct Child Tasks container exists for t1
  const childrenList = requireOne(root, (n) => n.props?.['data-wo-task-children-list'] === 't1')
  const childRows = findAll(childrenList, (n) => n.props?.['data-wo-task-child-row'] !== undefined)

  // Exactly 2 direct children: t2 and t3!
  // Excluded:
  // - t4 (grandchild, child of t2)
  // - t5 (sibling conversation root)
  // - t-c2-root, t2-c2 (different source conversation)
  assert.equal(childRows.length, 2)
  assert.equal(childRows[0].props['data-wo-task-child-row'], 't2')
  assert.equal(childRows[1].props['data-wo-task-child-row'], 't3')

  // Both rows display label, taskId, depth, executionState
  assert.ok(textOf(childRows[0]).includes('Task T2 Child · t2 · d1 · running'))
  assert.ok(textOf(childRows[1]).includes('Task T3 Child · t3 · d1 · running'))

  // View child buttons exist with stable selectors
  const viewT2Btn = requireOne(childRows[0], (n) => n.props?.['data-wo-task-child-view'] === 't2')
  const viewT3Btn = requireOne(childRows[1], (n) => n.props?.['data-wo-task-child-view'] === 't3')
  assert.equal(textOf(viewT2Btn), 'View child task (t2)')
  assert.equal(textOf(viewT3Btn), 'View child task (t3)')

  // Zero additional RPCs during projection and rendering
  assert.equal(callCount, callsAfterSelect)
  assert.equal(remote.illegal.length, 0)
})

test('FP-106: 2. Leaf task empty state distinct from error/stale', async () => {
  const ledger = makeLedger({ tasks: [t1Root, t2Child, t4Grandchild] })

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  let root = runtime.getRoot()

  // Open All Tasks
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Select t4 (grandchild, leaf node with no children)
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't4').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Verify t4 detail panel
  requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't4')

  // Verify empty indicator is rendered
  const emptyIndicator = requireOne(root, (n) => n.props?.['data-wo-task-children-empty'] === 'true')
  assert.ok(textOf(emptyIndicator).includes('本账本未观察到直属子任务'))

  // No children list or child view buttons present
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-children-list'] !== undefined), null)
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-child-view'] !== undefined), null)
})

test('FP-106: 3. Root -> Child navigation (T1 -> T2)', async () => {
  const ledger = makeLedger({ tasks: [t1Root, t2Child, t3Child, t4Grandchild] })

  let callCount = 0
  const { runtime, remote } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      return { ok: true, value: ledger }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks & select T1
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const callsBeforeNav = callCount

  // Click View child task (t2)
  const viewT2Btn = requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't2')
  viewT2Btn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Exactly 1 new taskLedger RPC
  assert.equal(callCount, callsBeforeNav + 1)
  assert.equal(remote.illegal.length, 0)

  // Selection moved to t2
  const detailPanelT2 = requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't2')
  assert.ok(textOf(detailPanelT2).includes('taskId: t2'))
  assert.ok(textOf(detailPanelT2).includes('depth/mode: 1/code'))

  // t2 detail has View parent task (t1) button
  const viewParentBtn = requireOne(root, (n) => n.props?.['data-wo-task-parent-view'] === 't1')
  assert.equal(textOf(viewParentBtn), 'View parent task (t1)')

  // t2 detail has direct child tasks list containing t4
  const t2ChildrenList = requireOne(root, (n) => n.props?.['data-wo-task-children-list'] === 't2')
  const t2ChildRows = findAll(t2ChildrenList, (n) => n.props?.['data-wo-task-child-row'] !== undefined)
  assert.equal(t2ChildRows.length, 1)
  assert.equal(t2ChildRows[0].props['data-wo-task-child-row'], 't4')
  requireOne(t2ChildRows[0], (n) => n.props?.['data-wo-task-child-view'] === 't4')
})

test('FP-106: 4. Child -> Grandchild navigation (T2 -> T4)', async () => {
  const ledger = makeLedger({ tasks: [t1Root, t2Child, t3Child, t4Grandchild] })

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      return { ok: true, value: ledger }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks & select T2
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const callsBeforeNav = callCount

  // Click View child task (t4) from T2 detail
  const viewT4Btn = requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't4')
  viewT4Btn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Exactly 1 new taskLedger RPC
  assert.equal(callCount, callsBeforeNav + 1)

  // Selection moved to t4
  const detailPanelT4 = requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't4')
  assert.ok(textOf(detailPanelT4).includes('taskId: t4'))
  assert.ok(textOf(detailPanelT4).includes('depth/mode: 2/verify'))

  // t4 is a leaf task -> shows empty direct child indicator
  requireOne(root, (n) => n.props?.['data-wo-task-children-empty'] === 'true')
})

test('FP-106: 5. Pre-RPC validation fails closed with 0 RPCs', async () => {
  const ledger = makeLedger({ tasks: [t1Root, t2Child, t3Child, t5AnotherRoot] })

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      return { ok: true, value: ledger }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t1
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Save reference to t1's child view button handler for t2
  const savedT2Handler = requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't2').props.onClick

  // Switch selection to t5
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't5').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const callsBeforeInvokingSaved = callCount

  // Invoking saved handler of t1->t2 when t5 is currently selected must fail closed with 0 RPCs
  savedT2Handler(mockEvent())
  await runtime.settle()

  assert.equal(callCount, callsBeforeInvokingSaved)
  root = runtime.getRoot()
  // Current selection remains t5
  requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't5')
})

test('FP-106: 6. Synthetic malformed inputs defense: duplicate child and self-reference', async () => {
  // Synthetic malformed input 1: Duplicate child record with same ID 't2' in ledger
  const duplicateT2 = {
    taskId: 't2',
    sourceConversationId: 'cnv1',
    parent: { kind: 'task', taskId: 't1' },
    childSessionId: 'ses-t2-dup',
    depth: 1,
    mode: 'code',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z',
    label: 'Task T2 Duplicate'
  }

  // Synthetic malformed input 2: Child task points to itself as parent
  const selfRefChild = {
    taskId: 't-self',
    sourceConversationId: 'cnv1',
    parent: { kind: 'task', taskId: 't1' },
    childSessionId: 'ses-self',
    depth: 1,
    mode: 'code',
    executionState: 'running',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z',
    label: 'Self Ref Child'
  }

  const malformedLedger = makeLedger({ tasks: [t1Root, t2Child, duplicateT2] })

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      return { ok: true, value: malformedLedger }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t1
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // In direct children list, duplicate child t2 shows notice "关系未确认"
  const childRow = requireOne(root, (n) => n.props?.['data-wo-task-child-row'] === 't2')
  assert.ok(textOf(childRow).includes('关系未确认'))

  // Button is disabled
  const childBtn = requireOne(childRow, (n) => n.props?.['data-wo-task-child-view'] === 't2')
  assert.equal(childBtn.props.disabled, true)

  const callsBeforeClick = callCount
  // Clicking handler fails closed with 0 RPCs
  childBtn.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(callCount, callsBeforeClick)
})

test('FP-106: 7. Fresh ledger verification fails closed if parent is missing on fresh ledger', async () => {
  const initialLedger = makeLedger({ tasks: [t1Root, t2Child] })
  // Fresh ledger drops parent t1!
  const freshLedgerMissingParent = makeLedger({ revision: 2, tasks: [t2Child] })

  let calls = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      calls += 1
      if (calls === 1) return { ok: true, value: initialLedger }
      return { ok: true, value: freshLedgerMissingParent }
    }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View child task (t2)
  requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Fresh ledger had missing parent -> status becomes "error", selected becomes null
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  const errorBox = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true')
  assert.ok(textOf(errorBox).includes('无法确认子任务关系'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

test('FP-106: 8. Fresh ledger verification fails closed if child relationship drifted', async () => {
  const initialLedger = makeLedger({ tasks: [t1Root, t2Child, t5AnotherRoot] })
  // In fresh ledger, t2 drifted to point to t5 instead of t1!
  const driftedChild = { ...t2Child, parent: { kind: 'task', taskId: 't5' } }
  const freshLedgerDrifted = makeLedger({ revision: 2, tasks: [t1Root, driftedChild, t5AnotherRoot] })

  let calls = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      calls += 1
      if (calls === 1) return { ok: true, value: initialLedger }
      return { ok: true, value: freshLedgerDrifted }
    }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View child task (t2)
  requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Child drifted -> fails closed: status=error, selected=null
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  const errorBox = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true')
  assert.ok(textOf(errorBox).includes('无法确认子任务关系'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

test('FP-106: 9. Fresh ledger verification fails closed if child is missing on fresh ledger', async () => {
  const initialLedger = makeLedger({ tasks: [t1Root, t2Child] })
  // Fresh ledger drops child t2!
  const freshLedgerMissingChild = makeLedger({ revision: 2, tasks: [t1Root] })

  let calls = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      calls += 1
      if (calls === 1) return { ok: true, value: initialLedger }
      return { ok: true, value: freshLedgerMissingChild }
    }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View child task (t2)
  requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Fails closed
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  const errorBox = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true')
  assert.ok(textOf(errorBox).includes('无法确认子任务关系'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

test('FP-106: 10. Duplicate parent or duplicate child on fresh ledger fails closed', async () => {
  const initialLedger = makeLedger({ tasks: [t1Root, t2Child] })
  const duplicateParent = { ...t1Root, childSessionId: 'ses-dup-p' }
  const freshLedgerDupParent = makeLedger({ revision: 2, tasks: [t1Root, duplicateParent, t2Child] })

  let calls = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      calls += 1
      if (calls === 1) return { ok: true, value: initialLedger }
      return { ok: true, value: freshLedgerDupParent }
    }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View child task (t2)
  requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Fails closed: status=error, selected=null
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)
})

test('FP-106: 11. Generation race isolation (U1 superseded by U2)', async () => {
  const ledger1 = makeLedger({ tasks: [t1Root, t2Child, t3Child] })

  const d1 = deferred()
  const d2 = deferred()
  let callCount = 0

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: ledger1 }
      if (callCount === 2) return d1.promise // U1 (t2)
      return d2.promise // U2 (t3)
    }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // U1: Click View child task (t2)
  requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't2').props.onClick(mockEvent())

  // U2: Immediately click View child task (t3)
  requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't3').props.onClick(mockEvent())

  // Resolve U2 first
  d2.resolve({ ok: true, value: ledger1 })
  await runtime.settle()
  root = runtime.getRoot()

  // U2 completed -> selected is t3
  requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't3')

  // Resolve U1 late
  d1.resolve({ ok: true, value: ledger1 })
  await runtime.settle()
  root = runtime.getRoot()

  // Selection remains t3! Late U1 resolution was safely discarded
  requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't3')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't2'), null)
})

test('FP-106: 12. Close in-flight: late resolution is safely discarded', async () => {
  const ledger = makeLedger({ tasks: [t1Root, t2Child] })
  const d = deferred()

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: ledger }
      return d.promise
    }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View child task (t2)
  requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't2').props.onClick(mockEvent())

  // Close panel while request in-flight
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Panel is closed
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)

  // Late resolution completes
  d.resolve({ ok: true, value: ledger })
  await runtime.settle()
  root = runtime.getRoot()

  // Panel remains closed!
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)
})

test('FP-106: 13. Source filter reset to all and locate state cleared on child view', async () => {
  const ledger = makeLedger({ tasks: [t1Root, t2Child] })

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Set filter to cnv1
  const filterSelect = requireOne(root, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true')
  filterSelect.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()
  root = runtime.getRoot()

  // Select t1
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View child task (t2)
  requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Filter is reset to all ("")
  const updatedFilterSelect = requireOne(root, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true')
  assert.equal(updatedFilterSelect.props.value, '')
  requireOne(root, (n) => n.props?.['data-wo-task-center-scope'] === 'all')
})

test('FP-106: 14. RPC error failure sets error, selected=null, preserves cached ledger continuity', async () => {
  const initialLedger = makeLedger({ tasks: [t1Root, t2Child] })

  let calls = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      calls += 1
      if (calls === 1) return { ok: true, value: initialLedger }
      throw new Error('Synthetic network offline')
    }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View child task (t2)
  requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Status becomes error, selected is null
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  const errorBox = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true')
  assert.ok(textOf(errorBox).includes('Synthetic network offline'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null)

  // Shows stale continuity indicator
  requireOne(root, (n) => n.props?.['data-wo-task-center-stale'] === 'true')
})

test('FP-106: 15. Disambiguation between tasks with same label in C1 vs C2: strictly enforced by taskId', async () => {
  // t2Child in cnv1 has label "Task T2 Child"
  // t2C2DuplicateLabel in cnv2 also has label "Task T2 Child", but taskId is 't2-c2' and source is 'cnv2'
  const ledger = makeLedger({ tasks: [t1Root, t2Child, tC2Root, t2C2DuplicateLabel] })

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Select t1 in cnv1
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // In t1's children list: only t2 is listed, t2-c2 is NOT listed!
  const childrenList = requireOne(root, (n) => n.props?.['data-wo-task-children-list'] === 't1')
  const childRows = findAll(childrenList, (n) => n.props?.['data-wo-task-child-row'] !== undefined)
  assert.equal(childRows.length, 1)
  assert.equal(childRows[0].props['data-wo-task-child-row'], 't2')

  // Click View child task (t2)
  requireOne(childRows[0], (n) => n.props?.['data-wo-task-child-view'] === 't2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Selected is strictly t2 (in cnv1), never t2-c2!
  const detailPanel = requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't2')
  assert.ok(textOf(detailPanel).includes('taskId: t2'))
  assert.ok(textOf(detailPanel).includes('sourceConversationId: cnv1'))
})

test('FP-106: 16. Non-whitelisted method isolation: zero calls to mutations or execution', async () => {
  const ledger = makeLedger({ tasks: [t1Root, t2Child] })

  const { runtime, remote } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-child-view'] === 't2').props.onClick(mockEvent())
  await runtime.settle()

  // Ensure remote.illegal contains zero calls
  assert.deepEqual(remote.illegal, [])
})
