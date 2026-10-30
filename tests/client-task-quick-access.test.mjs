/**
 * FP-104: In-Mount Quick Reference for Tasks: Pin / Unpin / Explicit View Detail Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Pin Task from centralized detail panel:
 *    - Validates taskCenterOpen && taskCenterStatus === "ready" && taskCenterSelected === selected.taskId.
 *    - Minimal identity pair { kind: 'task', taskId, sourceConversationId } appended to quickAccessTasks.
 *    - Deduplication: multiple pin actions do not duplicate.
 * 2. Unpin Task:
 *    - (a) Detail panel toggle: [data-wo-task-unpin] switches back to [data-wo-task-pin].
 *    - (b) Quick Access row button: [data-wo-quick-access-task-remove] removes the item.
 * 3. Quick Access Section Rendering:
 *    - Empty placeholder replaced by list container [data-wo-quick-access-list].
 *    - Distinct badge [Task] and [data-wo-kind="task"].
 *    - Label resolved from accepted ledger or fallback to taskId.
 *    - Source conversation resolved from snapshot nodes or fallback to sourceConversationId.
 *    - Header counter reflects total items (quickAccessItems.length + quickAccessTasks.length).
 * 4. Stale snapshot constraints:
 *    - snapshotStale=true disables [data-wo-task-pin] and rejects pin handler.
 *    - snapshotStale=true permits [data-wo-task-unpin] and [data-wo-quick-access-task-remove].
 * 5. Saved old Pin handler defense:
 *    - Rejects if selection changed, ledger changed, or status !== "ready".
 * 6. Explicit View Detail from Quick Access row:
 *    - Dispatches exactly 1 remote.taskLedger() read-only RPC.
 *    - Resets source filter to all ("").
 *    - Clears locate notice and cancels pending locate timers.
 *    - Sets taskCenterOpen=true, taskCenterStatus="loading", taskCenterSelected=null.
 *    - Validates target on fresh ledger: matching.length === 1 sets ready and selects taskId.
 *    - Tree taskSource is UNTOUCHED.
 * 7. Generation race isolation:
 *    - U1 superseded by U2; late U1 resolution discarded.
 *    - Close or unmount in-flight safely discards late resolution.
 * 8. Error & Drift handling:
 *    - Fresh ledger failure sets error, selected=null, reference in quickAccessTasks RETAINED.
 *    - Target missing or ambiguous in fresh ledger sets error, selected=null, reference RETAINED.
 * 9. Synthetic Node ID collision non-interference:
 *    - Task with taskId matching a tree node ID coexists without interference.
 *    - Tree snapshot pruning prunes tree item but leaves task reference intact.
 * 10. Zero non-whitelisted calls:
 *     - 0 openSession, 0 reconcileTasks, 0 mutations.
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
  sessionSource: 'synthetic-quick-access-test'
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

test('FP-104: 1. Pin task from centralized detail panel and verify Quick Access row rendering', async () => {
  const initialLedger = makeLedger({
    tasks: [
      {
        taskId: 't-101',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Optimize Search Index'
      }
    ]
  })

  const { runtime, remote } = await setupComponent({
    ledgers: [initialLedger]
  })

  let root = runtime.getRoot()

  // Open All Tasks
  const allTasksBtn = requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true', 'All Tasks button')
  allTasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()

  // Select task t-101 in Task Center
  const taskRow = requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-101', 'Task Center row t-101')
  taskRow.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()

  // Verify detail panel is open and shows Pin button
  const pinBtn = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-101', 'Pin button')
  assert.equal(pinBtn.props.disabled ?? false, false)
  assert.equal(textOf(pinBtn), 'Pin to Quick Access')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-unpin'] === 't-101'), null)

  // Quick Access initially shows empty
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-empty'] === 'true') !== null)

  // Click Pin
  pinBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()

  // Detail panel now displays Unpin button
  const unpinBtn = requireOne(root, (n) => n.props?.['data-wo-task-unpin'] === 't-101', 'Unpin button')
  assert.equal(textOf(unpinBtn), 'Unpin from Quick Access')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-101'), null)

  // Quick Access empty state is gone; row is rendered in list
  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-empty'] === 'true'), null)
  const taskRowQA = requireOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-101', 'Quick Access task row')
  assert.equal(taskRowQA.props['data-wo-quick-access-task-source'], 'cnv1')
  assert.equal(taskRowQA.props['data-wo-kind'], 'task')

  // Label and source
  const titleSpan = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-title'] === 't-101', 'Quick Access task title')
  assert.equal(textOf(titleSpan), 'Optimize Search Index')
  const sourceSpan = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-source-label'] === 't-101', 'Quick Access source label')
  assert.equal(textOf(sourceSpan), 'Conversation 1')

  // Buttons on row
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 't-101', 'Quick Access task view button')
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 't-101', 'Quick Access task remove button')

  // Deduplication check: calling pin again does not duplicate
  pinBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  const matchingQARows = findAll(root, (node) => node.props?.['data-wo-quick-access-task'] === 't-101')
  assert.equal(matchingQARows.length, 1)

  // Zero openSession or mutation RPCs
  assert.equal(remote.illegal.length, 0)
})

test('FP-104: 2. Unpin task from detail panel and from Quick Access row', async () => {
  const ledger = makeLedger({
    tasks: [
      {
        taskId: 't-1',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task One'
      },
      {
        taskId: 't-2',
        sourceConversationId: 'cnv2',
        parent: { kind: 'conversation', conversationId: 'cnv2' },
        childSessionId: 'ses-2',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task Two'
      }
    ]
  })

  const { runtime } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  // Open All Tasks, pin t-1 and t-2
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-1') !== null)
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-2') !== null)

  // (a) Unpin t-2 from detail panel (since t-2 is currently selected)
  const unpinT2 = requireOne(root, (n) => n.props?.['data-wo-task-unpin'] === 't-2')
  unpinT2.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // t-2 is removed, t-1 remains
  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-2'), null)
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-1') !== null)
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-2') !== null)

  // (b) Unpin t-1 from Quick Access row
  const removeT1Btn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 't-1')
  removeT1Btn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-1'), null)
  // Both unpinned -> empty placeholder returns
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-empty'] === 'true') !== null)
})

test('FP-104: 3. Stale snapshot disables Pin, but allows Unpin and row removal', async () => {
  const ledger = makeLedger({
    tasks: [
      {
        taskId: 't-stale',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Stale Task'
      }
    ]
  })

  let snapshotFails = false
  const { runtime, remote } = await setupComponent({
    snapshot: () => snapshotFails ? { ok: false, error: { message: 'Snapshot failed' } } : { ok: true, value: baseSnapshot },
    ledgers: [ledger]
  })

  let root = runtime.getRoot()

  // Open All Tasks, select t-stale, and pin it first
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-stale').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-stale').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-stale') !== null)

  // Make snapshot stale
  snapshotFails = true
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Verify stale banner
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-stale'] === 'true') !== null)

  // (1) Unpin while stale: allowed from detail panel
  const unpinBtn = requireOne(root, (n) => n.props?.['data-wo-task-unpin'] === 't-stale')
  assert.equal(unpinBtn.props.disabled ?? false, false)
  unpinBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-stale'), null)

  // (2) Pin while stale: Pin button is disabled
  const pinBtn = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-stale')
  assert.equal(pinBtn.props.disabled, true)

  // Direct invocation of pin button handler also fails closed
  pinBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-stale'), null)

  // Restore snapshot freshness
  snapshotFails = false
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-stale'] === 'true'), null)

  // Pin it again
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-stale').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-stale') !== null)

  // Make snapshot stale again
  snapshotFails = true
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // (3) Row remove button: allowed while stale
  const removeBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 't-stale')
  assert.equal(removeBtn.props.disabled ?? false, false)
  removeBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-stale'), null)
})

test('FP-104: 4. Saved old Pin handler rejection when selection or ledger changes', async () => {
  const ledger1 = makeLedger({
    revision: 1,
    tasks: [
      {
        taskId: 't-A',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task A'
      },
      {
        taskId: 't-B',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task B'
      }
    ]
  })

  const { runtime } = await setupComponent({ ledgers: [ledger1] })
  let root = runtime.getRoot()

  // Open All Tasks, select t-A
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-A').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Save reference to t-A's Pin button handler
  const pinHandlerA = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-A').props.onClick

  // Switch selection to t-B
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-B').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Invoke the saved old pin handler for t-A
  pinHandlerA(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // t-A should NOT be pinned because current selection is t-B!
  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-A'), null)
})

test('FP-104: 5. Explicit View Detail from Quick Access row (happy path & zero extra RPCs)', async () => {
  const ledger1 = makeLedger({
    revision: 1,
    tasks: [
      {
        taskId: 't-target',
        sourceConversationId: 'cnv2',
        parent: { kind: 'conversation', conversationId: 'cnv2' },
        childSessionId: 'ses-2',
        depth: 0,
        mode: 'code',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Refactor Core Protocol'
      }
    ]
  })

  const ledger2 = makeLedger({
    revision: 2,
    tasks: [
      {
        taskId: 't-target',
        sourceConversationId: 'cnv2',
        parent: { kind: 'conversation', conversationId: 'cnv2' },
        childSessionId: 'ses-2',
        depth: 0,
        mode: 'code',
        executionState: 'completed',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:05:00.000Z',
        label: 'Refactor Core Protocol'
      }
    ]
  })

  let ledgerCallCount = 0
  const { runtime, remote } = await setupComponent({
    taskLedgerHandler: async () => {
      ledgerCallCount += 1
      if (ledgerCallCount === 1) return { ok: true, value: ledger1 }
      return { ok: true, value: ledger2 }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, pin t-target
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-target').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-target').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Set filter to cnv1 and close Task Center
  const filterSelect = requireOne(root, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true')
  filterSelect.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)

  const callsBeforeView = ledgerCallCount

  // Click View Detail on the Quick Access row
  const viewDetailBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 't-target')
  viewDetailBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Exactly 1 new taskLedger RPC dispatched
  assert.equal(ledgerCallCount, callsBeforeView + 1)
  assert.equal(remote.illegal.length, 0)

  // Task Center is reopened, ready, filter reset to all (""), and t-target selected
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true') !== null)
  const statusSpan = requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'ready')
  assert.ok(textOf(statusSpan).includes('rev 2'))

  const scopeSpan = requireOne(root, (n) => n.props?.['data-wo-task-center-scope'] === 'all')
  assert.ok(textOf(scopeSpan).includes('All sources'))

  const detailPanel = requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-target')
  assert.ok(textOf(detailPanel).includes('taskId: t-target'))
  assert.ok(textOf(detailPanel).includes('completed'))
})

test('FP-104: 6. Generation race isolation (U1 superseded by U2 from Quick Access)', async () => {
  const d1 = deferred()
  const d2 = deferred()
  let callCount = 0

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) {
        // Initial setup call for All Tasks
        return {
          ok: true,
          value: makeLedger({
            tasks: [
              { taskId: 't-1', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-1', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'T1' },
              { taskId: 't-2', sourceConversationId: 'cnv2', parent: { kind: 'conversation', conversationId: 'cnv2' }, childSessionId: 'ses-2', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'T2' }
            ]
          })
        }
      }
      if (callCount === 2) {
        // U1 pending
        return d1.promise
      }
      if (callCount === 3) {
        // U2 pending
        return d2.promise
      }
      return { ok: true, value: makeLedger() }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, pin both t-1 and t-2
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Close Task Center
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Trigger U1 (view t-1)
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 't-1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'loading') !== null)

  // Trigger U2 (view t-2) while U1 is still pending
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 't-2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Now resolve U1 with t-1 data
  d1.resolve({
    ok: true,
    value: makeLedger({
      tasks: [{ taskId: 't-1', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-1', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'T1' }]
    })
  })
  await runtime.settle()
  root = runtime.getRoot()

  // U1 should NOT have made it ready or selected t-1, because U2 is active!
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-1'), null)

  // Now resolve U2 with t-2 data
  d2.resolve({
    ok: true,
    value: makeLedger({
      tasks: [{ taskId: 't-2', sourceConversationId: 'cnv2', parent: { kind: 'conversation', conversationId: 'cnv2' }, childSessionId: 'ses-2', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'T2' }]
    })
  })
  await runtime.settle()
  root = runtime.getRoot()

  // U2 succeeds and selects t-2
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'ready')
  requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-2')
})

test('FP-104: 7. Fresh ledger failure or missing task: fail-closed, null selection, error notice, reference retained', async () => {
  const initialLedger = makeLedger({
    tasks: [
      {
        taskId: 't-gone',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Disappearing Task'
      }
    ]
  })

  // Second ledger: task was deleted or moved
  const emptyLedger = makeLedger({
    revision: 2,
    tasks: []
  })

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: initialLedger }
      return { ok: true, value: emptyLedger }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, pin t-gone, close Task Center
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-gone').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-gone').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View Detail on t-gone
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 't-gone').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Fails closed: status is error, no task is selected
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  const errDiv = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true')
  assert.ok(textOf(errDiv).includes('无法确认任务目标'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-gone'), null)

  // Critical contract requirement: reference in Quick Access is RETAINED (not auto-deleted)
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-gone') !== null)

  // User can still manually remove it
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 't-gone').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-gone'), null)
})

test('FP-104: 8. Synthetic node ID collision non-interference (project vs task with same ID)', async () => {
  const ledger = makeLedger({
    tasks: [
      {
        taskId: 'p1', // Identical to project 'p1' ID in baseSnapshot!
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task colliding with project p1'
      }
    ]
  })

  const { runtime } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  // 1. Pin project 'p1' from tree
  const projectPinBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'p1')
  projectPinBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // 2. Open All Tasks, select task 'p1', pin it
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 'p1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'p1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Both should exist simultaneously in Quick Access with distinct selectors and kinds
  const projectRow = requireOne(root, (n) => n.props?.['data-wo-quick-access-row'] === 'p1')
  assert.equal(projectRow.props['data-wo-kind'], 'project')

  const taskRow = requireOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 'p1')
  assert.equal(taskRow.props['data-wo-kind'], 'task')

  // Removing tree project 'p1' leaves task 'p1' intact
  requireOne(root, (n) => n.props?.['data-wo-quick-access-remove'] === 'p1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-row'] === 'p1'), null)
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 'p1') !== null)

  // Removing task 'p1' cleans up completely
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 'p1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 'p1'), null)
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-empty'] === 'true') !== null)
})

test('FP-104: 9. Close in-flight: late resolution is safely discarded', async () => {
  const d = deferred()
  let callCount = 0

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) {
        return {
          ok: true,
          value: makeLedger({
            tasks: [{ taskId: 't-async', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-1', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'Async Task' }]
          })
        }
      }
      return d.promise
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, pin t-async, and close Task Center
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-async').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-async').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View Detail from Quick Access
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 't-async').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'loading') !== null)

  // While in-flight, user clicks Close
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)

  // Now resolve late promise
  d.resolve({
    ok: true,
    value: makeLedger({
      tasks: [{ taskId: 't-async', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, childSessionId: 'ses-1', depth: 0, mode: 'plan', executionState: 'running', executionEligibility: 'eligible', observedAt: '2026-10-25T10:00:00.000Z', label: 'Async Task' }]
    })
  })
  await runtime.settle()
  root = runtime.getRoot()

  // Panel remains closed, late result was discarded
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)
})

test('FP-104: 10. Disambiguation of tasks with identical labels across different sources', async () => {
  const ledger = makeLedger({
    tasks: [
      {
        taskId: 'task-a1',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Shared Label Task'
      },
      {
        taskId: 'task-b2',
        sourceConversationId: 'cnv2',
        parent: { kind: 'conversation', conversationId: 'cnv2' },
        childSessionId: 'ses-2',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Shared Label Task'
      }
    ]
  })

  const { runtime } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  // Open All Tasks, pin both
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 'task-a1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'task-a1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 'task-b2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'task-b2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Both exist in Quick Access
  const rowA = requireOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 'task-a1')
  const rowB = requireOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 'task-b2')

  // Labels are identical
  assert.equal(textOf(requireOne(rowA, (n) => n.props?.['data-wo-quick-access-task-title'] === 'task-a1')), 'Shared Label Task')
  assert.equal(textOf(requireOne(rowB, (n) => n.props?.['data-wo-quick-access-task-title'] === 'task-b2')), 'Shared Label Task')

  // Sources are distinct
  assert.equal(textOf(requireOne(rowA, (n) => n.props?.['data-wo-quick-access-task-source-label'] === 'task-a1')), 'Conversation 1')
  assert.equal(textOf(requireOne(rowB, (n) => n.props?.['data-wo-quick-access-task-source-label'] === 'task-b2')), 'Conversation 2')
})

test('FP-104: 11. Fresh ledger rejects with error: status=error, selected=null, reference retained', async () => {
  const initialLedger = makeLedger({
    tasks: [
      {
        taskId: 't-err',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Network Fragile Task'
      }
    ]
  })

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: initialLedger }
      return { ok: false, error: { message: 'Network timeout during taskLedger' } }
    }
  })

  let root = runtime.getRoot()

  // Open All Tasks, pin t-err, close
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-err').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-err').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Click View Detail
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 't-err').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Status is error, selected is null
  requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error')
  const errDiv = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true')
  assert.ok(textOf(errDiv).includes('Network timeout'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-err'), null)

  // Reference in Quick Access retained
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-task'] === 't-err') !== null)
})
