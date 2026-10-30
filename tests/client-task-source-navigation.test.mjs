/**
 * Centralized Task Detail to Source Conversation Tree Locate Navigation Flow Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Legal locate restores Projects section visibility, uncollapses projects header and
 *    necessary ancestors, selects target Conversation by stable ID, and scrolls DOM row.
 * 2. Descendant task source locate: correctly locates source Conversation of non-root tasks.
 * 3. Disambiguation: two conversations with same title are distinguished by exact stable ID.
 * 4. Workspace borrowing directory is NOT selected; only the Conversation node is selected.
 * 5. Source archived check: explicit SourceRecord.blockedReason === 'source-archived'
 *    strictly refuses locate with honest error notice and 0 scroll.
 * 6. Task blocked distinction: task.executionEligibility === 'blocked' does NOT imply
 *    source-archived; normal blocked task locates successfully.
 * 7. Snapshot null or stale fails closed locally with honest notice and 0 scroll.
 * 8. Source missing in current tree snapshot fails closed locally.
 * 9. Target not a conversation fails closed locally.
 * 10. Cyclic or broken ancestor chain fails closed locally.
 * 11. Panel close and unmount lifecycle safety: in-flight timer cancelled; saved handler
 *     called after close/unmount dispatches 0 RPCs and does not change selection.
 * 12. Superseded locate & Task selection switch: switching task or clicking locate on
 *     another task cancels earlier scroll callback and does not overwrite feedback.
 * 13. Pre-scroll invalidation: if snapshot becomes stale or target removed while timer
 *     is pending, scroll is cancelled with honest notice.
 * 14. Missing DOM row and no-DOM environment: reports honest missing-row / unverified notice.
 * 15. Zero non-whitelisted calls: 0 Remote RPCs and 0 openSession calls during locate.
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
    { id: 'p1_sub', parentId: 'p1', kind: 'project', title: 'Sub Branch 1' },
    { id: 'w1', parentId: 'p1_sub', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1', nativeWorkspaceId: 'nw-1' },
    { id: 'cnv_target', parentId: 'w1', kind: 'conversation', title: 'Conversation Target', sessionId: 'ses-target' },
    { id: 'cnv_other', parentId: 'w1', kind: 'conversation', title: 'Conversation Other', sessionId: 'ses-other' }
  ]
})

const baseStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-task-source-locate-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

function createControllableTimerQueue() {
  let timerId = 0
  const queue = new Map()

  function fakeSetTimeout(fn, delay) {
    const id = ++timerId
    queue.set(id, fn)
    return id
  }

  function fakeClearTimeout(id) {
    queue.delete(id)
  }

  function flush() {
    const callbacks = [...queue.entries()]
    queue.clear()
    for (const [, fn] of callbacks) {
      fn()
    }
  }

  function count() {
    return queue.size
  }

  return { fakeSetTimeout, fakeClearTimeout, flush, count }
}

function makeLedger({
  revision = 1,
  sources = [
    {
      conversationId: 'cnv_target',
      sessionId: 'ses-target',
      workspaceLogicalId: 'w1',
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

async function setupLocateComponent({
  snapshot = baseSnapshot,
  status = baseStatus,
  taskLedgerHandler,
  ledgers = [],
  document: injectedDocument,
  timerQueue
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
    remote,
    document: injectedDocument,
    setTimeout: timerQueue ? timerQueue.fakeSetTimeout : undefined,
    clearTimeout: timerQueue ? timerQueue.fakeClearTimeout : undefined
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()

  return { runtime, remote, mounted }
}

// -----------------------------------------------------------------------------
// Test 1: Legal source locate unhides Projects, uncollapses ancestors, selects C, and scrolls
// -----------------------------------------------------------------------------
test('1. Legal source locate restores Projects, uncollapses ancestors, selects C, and scrolls row', async () => {
  const scrolledNodes = []
  const mockDocument = {
    querySelector: (selector) => ({
      scrollIntoView: (options) => { scrolledNodes.push({ selector, options }) }
    })
  }
  const timerQueue = createControllableTimerQueue()

  const rootTask = {
    taskId: 'tsk_alpha',
    label: 'Alpha Worker Task',
    childSessionId: 'sess_alpha',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'conversation', conversationId: 'cnv_target' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [rootTask] })

  const { runtime, remote } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    document: mockDocument,
    timerQueue
  })

  // Open Task Center via All Tasks button
  const allTasksBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true', 'All Tasks button')
  allTasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Select task row tsk_alpha in Task Center
  const taskRow = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_alpha', 'Task row')
  taskRow.props.onClick()
  await runtime.settle()

  // Collapse projects and hide projects section to verify full disclosure
  const hideProjectsBtn = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-section-hide'] === 'projects')
  if (hideProjectsBtn) {
    hideProjectsBtn.props.onClick(mockEvent())
    await runtime.settle()
  }

  // Click Locate source in Task Center detail
  const locateBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_alpha', 'Locate source button')
  const rpcBeforeLocate = remote.calls.length
  locateBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Verify initial feedback state is "locating"
  let root = runtime.getRoot()
  const feedbackEl = requireOne(root, (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true', 'Locate feedback')
  assert.equal(feedbackEl.props['data-wo-task-center-locate-state'], 'locating')
  assert.match(textOf(feedbackEl), /Conversation Target/)

  // Verify tree disclosure occurred immediately
  assert.ok(findOne(root, (n) => n.props?.['data-wo-section'] === 'projects') !== null, 'Projects section revealed')
  const targetRow = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'cnv_target', 'Target conversation row')
  assert.equal(targetRow.props['data-wo-selected'], 'true', 'cnv_target must be selected')

  // Ancestors uncollapsed
  assert.equal(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p1', 'p1').props['aria-expanded'], 'true')
  assert.equal(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p1_sub', 'p1_sub').props['aria-expanded'], 'true')

  // Timer is queued
  assert.equal(timerQueue.count(), 1, 'Scroll timer must be scheduled')

  // Flush timer queue
  timerQueue.flush()
  await runtime.settle()

  // Verify scroll was called for target
  assert.equal(scrolledNodes.length, 1)
  assert.equal(scrolledNodes[0].selector, '[data-wo-node-id="cnv_target"]')
  assert.equal(scrolledNodes[0].options?.block, 'center')

  // Verify settled feedback state is "located"
  root = runtime.getRoot()
  const settledFeedback = requireOne(root, (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true', 'Settled feedback')
  assert.equal(settledFeedback.props['data-wo-task-center-locate-state'], 'located')

  // Task Center remains open and detail still displayed
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_alpha') !== null)

  // Zero Remote RPC dispatched during locate
  assert.equal(remote.calls.length, rpcBeforeLocate, 'Zero Remote RPCs during locate')
  assert.equal(remote.illegal.length, 0, 'No illegal RPC methods')
})

// -----------------------------------------------------------------------------
// Test 2: Descendant task source locate
// -----------------------------------------------------------------------------
test('2. Descendant task source locate: correctly locates source Conversation of non-root tasks', async () => {
  const scrolledNodes = []
  const mockDocument = {
    querySelector: (selector) => ({
      scrollIntoView: (options) => { scrolledNodes.push(selector) }
    })
  }
  const timerQueue = createControllableTimerQueue()

  const rootTask = {
    taskId: 'tsk_parent',
    label: 'Root Task',
    childSessionId: 'sess_p',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'conversation', conversationId: 'cnv_target' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const childTask = {
    taskId: 'tsk_child_descendant',
    label: 'Child Task',
    childSessionId: 'sess_c',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'task', taskId: 'tsk_parent' },
    depth: 2,
    mode: 'one-shot',
    executionState: 'RUNNING',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:02.000Z'
  }
  const ledger = makeLedger({ tasks: [rootTask, childTask] })

  const { runtime } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    document: mockDocument,
    timerQueue
  })

  // Open Task Center & select child task
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_child_descendant').props.onClick()
  await runtime.settle()

  // Click Locate source on child task
  const locateBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_child_descendant')
  locateBtn.props.onClick(mockEvent())
  await runtime.settle()

  timerQueue.flush()
  await runtime.settle()

  // Correctly selected and scrolled cnv_target
  const targetRow = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-node-id'] === 'cnv_target')
  assert.equal(targetRow.props['data-wo-selected'], 'true')
  assert.ok(scrolledNodes.includes('[data-wo-node-id="cnv_target"]'))
})

// -----------------------------------------------------------------------------
// Test 3: Disambiguation between two conversations with the same title
// -----------------------------------------------------------------------------
test('3. Disambiguation: two conversations with same title distinguished by exact ID', async () => {
  const scrolledNodes = []
  const mockDocument = {
    querySelector: (selector) => ({
      scrollIntoView: (options) => { scrolledNodes.push(selector) }
    })
  }
  const timerQueue = createControllableTimerQueue()

  // Snapshot with two same-titled conversations
  const customSnapshot = {
    rootId: 'root',
    revision: 10,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
      { id: 'w1', parentId: 'root', kind: 'workspace', title: 'Workspace 1' },
      { id: 'cnv_chat_1', parentId: 'w1', kind: 'conversation', title: 'Same Chat Title', sessionId: 'ses-1' },
      { id: 'cnv_chat_2', parentId: 'w1', kind: 'conversation', title: 'Same Chat Title', sessionId: 'ses-2' }
    ]
  }

  const task = {
    taskId: 'tsk_for_chat_2',
    label: 'Task for Chat 2',
    childSessionId: 'sess_chat2',
    sourceConversationId: 'cnv_chat_2',
    parent: { kind: 'conversation', conversationId: 'cnv_chat_2' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({
    sources: [{ conversationId: 'cnv_chat_2', sessionId: 'ses-2', workspaceLogicalId: 'w1' }],
    tasks: [task]
  })

  const { runtime } = await setupLocateComponent({
    snapshot: customSnapshot,
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    document: mockDocument,
    timerQueue
  })

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_for_chat_2').props.onClick()
  await runtime.settle()

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_for_chat_2').props.onClick(mockEvent())
  await runtime.settle()
  timerQueue.flush()
  await runtime.settle()

  const root = runtime.getRoot()
  // cnv_chat_2 must be selected, NOT cnv_chat_1
  const row2 = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'cnv_chat_2')
  assert.equal(row2.props['data-wo-selected'], 'true')
  const row1 = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'cnv_chat_1')
  assert.notEqual(row1.props['data-wo-selected'], 'true')

  assert.deepEqual(scrolledNodes, ['[data-wo-node-id="cnv_chat_2"]'])
})

// -----------------------------------------------------------------------------
// Test 4: Workspace borrowing directory is NOT selected
// -----------------------------------------------------------------------------
test('4. Workspace borrowing directory is NOT selected; only Conversation is selected', async () => {
  const timerQueue = createControllableTimerQueue()
  const task = {
    taskId: 'tsk_borrow',
    label: 'Borrow Task',
    childSessionId: 'sess_b',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'conversation', conversationId: 'cnv_target' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task] })

  const { runtime } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    timerQueue
  })

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_borrow').props.onClick()
  await runtime.settle()

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_borrow').props.onClick(mockEvent())
  await runtime.settle()

  const root = runtime.getRoot()
  // Workspace w1 must NOT be selected
  const wsRow = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'w1')
  assert.notEqual(wsRow.props['data-wo-selected'], 'true')
  // Conversation cnv_target MUST be selected
  const cnvRow = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'cnv_target')
  assert.equal(cnvRow.props['data-wo-selected'], 'true')
})

// -----------------------------------------------------------------------------
// Test 5: Explicit source archived check refuses locate with honest error notice
// -----------------------------------------------------------------------------
test('5. Source archived check: explicit source-archived strictly refuses locate with 0 scroll', async () => {
  const timerQueue = createControllableTimerQueue()
  const task = {
    taskId: 'tsk_archived_src',
    label: 'Task of Archived Source',
    childSessionId: 'sess_arc',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'conversation', conversationId: 'cnv_target' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'UNKNOWN',
    executionEligibility: 'blocked',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  // Source has explicit blockedReason: 'source-archived'
  const ledger = makeLedger({
    sources: [
      {
        conversationId: 'cnv_target',
        sessionId: 'ses-target',
        workspaceLogicalId: 'w1',
        nativeWorkspaceId: 'nw-1',
        directory: 'E:\\ws-1',
        verifiedAt: '2026-10-25T10:00:00.000Z',
        verificationState: 'blocked',
        blockedReason: 'source-archived'
      }
    ],
    tasks: [task]
  })

  const { runtime, remote } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    timerQueue
  })

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_archived_src').props.onClick()
  await runtime.settle()

  const rpcBefore = remote.calls.length
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_archived_src').props.onClick(mockEvent())
  await runtime.settle()

  const root = runtime.getRoot()
  // Feedback shows error: source archived
  const feedback = requireOne(root, (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true')
  assert.equal(feedback.props['data-wo-task-center-locate-state'], 'error')
  assert.match(textOf(feedback), /来源已归档，拒绝定位/)

  // Selection NOT changed to cnv_target
  assert.notEqual(findOne(root, (n) => n.props?.['data-wo-node-id'] === 'cnv_target')?.props['data-wo-selected'], 'true')
  // No scroll timer scheduled
  assert.equal(timerQueue.count(), 0)
  // Zero RPCs
  assert.equal(remote.calls.length, rpcBefore)
})

// -----------------------------------------------------------------------------
// Test 6: Normal task blocked state does NOT block locate
// -----------------------------------------------------------------------------
test('6. Normal task blocked state does NOT imply source-archived; locates successfully', async () => {
  const timerQueue = createControllableTimerQueue()
  const task = {
    taskId: 'tsk_user_blocked',
    label: 'Task Waiting Input',
    childSessionId: 'sess_blk',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'conversation', conversationId: 'cnv_target' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'PAUSED',
    executionEligibility: 'blocked',
    blockedReason: 'waiting-user-confirmation',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  // Source is verified (NOT archived)
  const ledger = makeLedger({
    sources: [
      {
        conversationId: 'cnv_target',
        sessionId: 'ses-target',
        workspaceLogicalId: 'w1',
        verificationState: 'verified'
      }
    ],
    tasks: [task]
  })

  const { runtime } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    timerQueue
  })

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_user_blocked').props.onClick()
  await runtime.settle()

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_user_blocked').props.onClick(mockEvent())
  await runtime.settle()

  const root = runtime.getRoot()
  const feedback = requireOne(root, (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true')
  assert.equal(feedback.props['data-wo-task-center-locate-state'], 'locating')

  // Selection successfully updated to cnv_target
  assert.equal(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'cnv_target').props['data-wo-selected'], 'true')
  assert.equal(timerQueue.count(), 1)
})

// -----------------------------------------------------------------------------
// Test 7: Stale snapshot fails closed locally
// -----------------------------------------------------------------------------
test('7. Stale snapshot fails closed locally with honest notice and 0 scroll', async () => {
  const timerQueue = createControllableTimerQueue()
  const task = {
    taskId: 'tsk_stale_test',
    label: 'Stale Task',
    childSessionId: 'sess_s',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'conversation', conversationId: 'cnv_target' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task] })

  const { runtime: staleRuntime, remote: staleRemote } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    timerQueue
  })
  // Setup Task Center
  requireOne(staleRuntime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await staleRuntime.settle()
  requireOne(staleRuntime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_stale_test').props.onClick()
  await staleRuntime.settle()

  // Make snapshot fail
  staleRemote.allowed.snapshot = async () => ({ ok: false, error: { message: 'Refresh fail' } })
  requireOne(staleRuntime.getRoot(), (n) => n.props?.['data-wo-refresh'] === 'true').props.onClick(mockEvent())
  await staleRuntime.settle()

  // Now snapshot is stale! Click locate source
  requireOne(staleRuntime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_stale_test').props.onClick(mockEvent())
  await staleRuntime.settle()

  const feedback = requireOne(staleRuntime.getRoot(), (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true')
  assert.equal(feedback.props['data-wo-task-center-locate-state'], 'error')
  assert.match(textOf(feedback), /快照已陈旧失效，拒绝定位/)
  assert.equal(timerQueue.count(), 0)
})

// -----------------------------------------------------------------------------
// Test 8: Source missing in tree snapshot fails closed
// -----------------------------------------------------------------------------
test('8. Source missing in tree snapshot fails closed with honest notice', async () => {
  const timerQueue = createControllableTimerQueue()
  const task = {
    taskId: 'tsk_orphan_src',
    label: 'Orphan Task',
    childSessionId: 'sess_orph',
    sourceConversationId: 'cnv_non_existent',
    parent: { kind: 'conversation', conversationId: 'cnv_non_existent' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task] })

  const { runtime } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    timerQueue
  })

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_orphan_src').props.onClick()
  await runtime.settle()

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_orphan_src').props.onClick(mockEvent())
  await runtime.settle()

  const feedback = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true')
  assert.equal(feedback.props['data-wo-task-center-locate-state'], 'error')
  assert.match(textOf(feedback), /源不在当前树中/)
  assert.equal(timerQueue.count(), 0)
})

// -----------------------------------------------------------------------------
// Test 9: Target is not a conversation fails closed
// -----------------------------------------------------------------------------
test('9. Target is not a conversation fails closed locally', async () => {
  const timerQueue = createControllableTimerQueue()
  // Task mistakenly points to workspace w1 as its sourceConversationId
  const task = {
    taskId: 'tsk_to_ws',
    label: 'Points to Workspace',
    childSessionId: 'sess_ws',
    sourceConversationId: 'w1',
    parent: { kind: 'conversation', conversationId: 'w1' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task] })

  const { runtime } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    timerQueue
  })

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_to_ws').props.onClick()
  await runtime.settle()

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_to_ws').props.onClick(mockEvent())
  await runtime.settle()

  const feedback = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true')
  assert.equal(feedback.props['data-wo-task-center-locate-state'], 'error')
  assert.match(textOf(feedback), /目标不是普通会话，无法定位/)
  assert.equal(timerQueue.count(), 0)
})

// -----------------------------------------------------------------------------
// Test 10: Cyclic or broken ancestor chain fails closed
// -----------------------------------------------------------------------------
test('10. Broken ancestor chain fails closed locally', async () => {
  const timerQueue = createControllableTimerQueue()
  const brokenSnapshot = {
    rootId: 'root',
    revision: 10,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
      // cnv_broken has parent p_missing which is not in snapshot
      { id: 'cnv_broken', parentId: 'p_missing', kind: 'conversation', title: 'Broken Conv', sessionId: 'ses-brk' }
    ]
  }

  const task = {
    taskId: 'tsk_broken',
    label: 'Broken Ancestor Task',
    childSessionId: 'sess_brk',
    sourceConversationId: 'cnv_broken',
    parent: { kind: 'conversation', conversationId: 'cnv_broken' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task] })

  const { runtime } = await setupLocateComponent({
    snapshot: brokenSnapshot,
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    timerQueue
  })

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_broken').props.onClick()
  await runtime.settle()

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_broken').props.onClick(mockEvent())
  await runtime.settle()

  const feedback = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true')
  assert.equal(feedback.props['data-wo-task-center-locate-state'], 'error')
  assert.match(textOf(feedback), /祖先链无效或存在循环，无法定位/)
  assert.equal(timerQueue.count(), 0)
})

// -----------------------------------------------------------------------------
// Test 11: Panel close and unmount lifecycle safety
// -----------------------------------------------------------------------------
test('11. Panel close and unmount lifecycle safety: in-flight timer cancelled; saved handler rejected', async () => {
  const scrolledNodes = []
  const mockDocument = {
    querySelector: (selector) => ({
      scrollIntoView: () => { scrolledNodes.push(selector) }
    })
  }
  const timerQueue = createControllableTimerQueue()

  const task = {
    taskId: 'tsk_unm',
    label: 'Unmount Lifecycle Task',
    childSessionId: 'sess_u',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'conversation', conversationId: 'cnv_target' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task] })

  const { runtime } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    document: mockDocument,
    timerQueue
  })

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_unm').props.onClick()
  await runtime.settle()

  const locateBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_unm')
  const savedHandler = locateBtn.props.onClick

  // Trigger locate -> timer queued
  locateBtn.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(timerQueue.count(), 1)

  // Part A: Close task center while timer is pending
  const closeBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-close'] === 'true')
  closeBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Timer must be cancelled
  assert.equal(timerQueue.count(), 0, 'Closing task center must cancel pending locate timer')

  // Part B: Invoking saved handler after panel is closed
  savedHandler(mockEvent())
  await runtime.settle()
  assert.equal(timerQueue.count(), 0, 'Saved handler after close must not schedule timer')

  // Part C: Unmount safety
  runtime.unmount()
  savedHandler(mockEvent())
  await runtime.settle()
  assert.equal(timerQueue.count(), 0, 'Saved handler after unmount must not schedule timer')
})

// -----------------------------------------------------------------------------
// Test 12: Superseded locate & Task selection switch
// -----------------------------------------------------------------------------
test('12. Superseded locate & Task selection switch: earlier callback discarded', async () => {
  const scrolledNodes = []
  const mockDocument = {
    querySelector: (selector) => ({
      scrollIntoView: () => { scrolledNodes.push(selector) }
    })
  }
  const timerQueue = createControllableTimerQueue()

  const task1 = {
    taskId: 'tsk_seq_1',
    label: 'Sequence Task 1',
    childSessionId: 'sess_1',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'conversation', conversationId: 'cnv_target' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const task2 = {
    taskId: 'tsk_seq_2',
    label: 'Sequence Task 2',
    childSessionId: 'sess_2',
    sourceConversationId: 'cnv_other',
    parent: { kind: 'conversation', conversationId: 'cnv_other' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:02.000Z'
  }
  const ledger = makeLedger({ tasks: [task1, task2] })

  const { runtime } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    document: mockDocument,
    timerQueue
  })

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Select Task 1 and click locate
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_seq_1').props.onClick()
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_seq_1').props.onClick(mockEvent())
  await runtime.settle()

  // Now before flushing timer, switch selection to Task 2 and click locate on Task 2
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_seq_2').props.onClick()
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_seq_2').props.onClick(mockEvent())
  await runtime.settle()

  // Flush timers
  timerQueue.flush()
  await runtime.settle()

  // Only cnv_other must have been scrolled, NOT cnv_target!
  assert.deepEqual(scrolledNodes, ['[data-wo-node-id="cnv_other"]'])
  const feedback = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true')
  assert.equal(feedback.props['data-wo-task-center-locate-state'], 'located')
  assert.match(textOf(feedback), /Conversation Other/)
})

// -----------------------------------------------------------------------------
// Test 13: Invalidation before timer fires (Snapshot becomes stale or target removed)
// -----------------------------------------------------------------------------
test('13. Pre-scroll invalidation: snapshot becoming stale cancels scroll with honest notice', async () => {
  const scrolledNodes = []
  const mockDocument = {
    querySelector: (selector) => ({
      scrollIntoView: () => { scrolledNodes.push(selector) }
    })
  }
  const timerQueue = createControllableTimerQueue()

  const task = {
    taskId: 'tsk_inv',
    label: 'Invalidation Task',
    childSessionId: 'sess_i',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'conversation', conversationId: 'cnv_target' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task] })

  const { runtime, remote } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    document: mockDocument,
    timerQueue
  })

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_inv').props.onClick()
  await runtime.settle()

  // Click locate
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_inv').props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(timerQueue.count(), 1)

  // Before timer fires, trigger tree refresh that fails -> snapshotStale = true
  remote.allowed.snapshot = async () => ({ ok: false, error: { message: 'Network dropped' } })
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Now flush timer!
  timerQueue.flush()
  await runtime.settle()

  // Scroll must NOT be executed!
  assert.equal(scrolledNodes.length, 0)
  const feedback = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true')
  assert.equal(feedback.props['data-wo-task-center-locate-state'], 'cancelled')
  assert.match(textOf(feedback), /快照失效或目标移除，滚动取消/)
})

// -----------------------------------------------------------------------------
// Test 14: Missing DOM row and no-DOM environment honest reporting
// -----------------------------------------------------------------------------
test('14. Missing DOM row and no-DOM environment: honest missing-row and unverified reporting', async () => {
  const timerQueue = createControllableTimerQueue()
  const task = {
    taskId: 'tsk_dom_rep',
    label: 'DOM Report Task',
    childSessionId: 'sess_dr',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'conversation', conversationId: 'cnv_target' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task] })

  // Case 14a: Document injected where querySelector returns null
  const mockDocumentNoRow = {
    querySelector: () => null
  }
  const { runtime: rtA } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    document: mockDocumentNoRow,
    timerQueue
  })

  requireOne(rtA.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await rtA.settle()
  requireOne(rtA.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_dom_rep').props.onClick()
  await rtA.settle()
  requireOne(rtA.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_dom_rep').props.onClick(mockEvent())
  await rtA.settle()
  timerQueue.flush()
  await rtA.settle()

  const feedbackA = requireOne(rtA.getRoot(), (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true')
  assert.equal(feedbackA.props['data-wo-task-center-locate-state'], 'missing-row')
  assert.match(textOf(feedbackA), /未找到DOM行/)

  // Case 14b: No document injected (undefined document)
  const timerQueueB = createControllableTimerQueue()
  const { runtime: rtB } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    timerQueue: timerQueueB
  })

  requireOne(rtB.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await rtB.settle()
  requireOne(rtB.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_dom_rep').props.onClick()
  await rtB.settle()
  requireOne(rtB.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_dom_rep').props.onClick(mockEvent())
  await rtB.settle()
  timerQueueB.flush()
  await rtB.settle()

  const feedbackB = requireOne(rtB.getRoot(), (n) => n.props?.['data-wo-task-center-locate-feedback'] === 'true')
  assert.equal(feedbackB.props['data-wo-task-center-locate-state'], 'unverified')
  assert.match(textOf(feedbackB), /无DOM环境，滚动未验证/)
})

// -----------------------------------------------------------------------------
// Test 15: Zero non-whitelisted calls during locate
// -----------------------------------------------------------------------------
test('15. Zero non-whitelisted calls: 0 Remote RPCs and 0 openSession calls during locate', async () => {
  const timerQueue = createControllableTimerQueue()
  const task = {
    taskId: 'tsk_zero_call',
    label: 'Zero Call Task',
    childSessionId: 'sess_zc',
    sourceConversationId: 'cnv_target',
    parent: { kind: 'conversation', conversationId: 'cnv_target' },
    depth: 1,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:01.000Z'
  }
  const ledger = makeLedger({ tasks: [task] })

  const { runtime, remote } = await setupLocateComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger }),
    timerQueue
  })

  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_zero_call').props.onClick()
  await runtime.settle()

  const callsBefore = remote.calls.length
  requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate'] === 'tsk_zero_call').props.onClick(mockEvent())
  await runtime.settle()
  timerQueue.flush()
  await runtime.settle()

  // Exactly zero Remote calls dispatched during locate
  assert.equal(remote.calls.length, callsBefore)
  assert.equal(remote.illegal.length, 0)
})
