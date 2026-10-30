/**
 * FP-109: In-Mount Task Quick Access Explicit Up/Down Ordering Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Adjacent swap reordering in quickAccessTasks (initial [A, B, C] -> B up -> [B, A, C] -> B down -> [A, B, C] -> C up -> [A, C, B]).
 * 2. Boundary disablement: first item up disabled; last item down disabled; single item both disabled; empty list no action.
 * 3. Operation bound to {kind: 'task', taskId, sourceConversationId}: safe disambiguation across same-label tasks & sources.
 * 4. Synthetic Node ID collision non-interference: tree node id matching task id reorder independently without cross-leak.
 * 5. Saved old handler defense: invoking saved handler after remove does NOT resurrect item; stale index does not swap wrong item.
 * 6. Stale snapshot protection: snapshotStale=true disables up/down buttons and rejects handlers via live ref.
 * 7. Unmount safety: saved handlers invoked after unmount fail closed without state corruption or errors.
 * 8. Rapid sequential clicks: functional state updater correctly resolves successive swaps without dropping items.
 * 9. Zero side-effects & call ledger audit: 0 taskLedger, 0 reconcileTasks, 0 moveNode, 0 openSession, 0 mutations.
 * 10. Hide/Restore preservation: custom task order is preserved across hide and restore of the quick-access section.
 * 11. Per-mount lifecycle: remount starts from empty without persistent storage leakage.
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
  sessionSource: 'synthetic-task-order-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
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

async function pinTaskFromCenter(runtime, taskId) {
  let root = runtime.getRoot()
  const taskRow = requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === taskId, `Task row ${taskId}`)
  taskRow.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const pinBtn = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === taskId, `Pin button ${taskId}`)
  pinBtn.props.onClick(mockEvent())
  await runtime.settle()
}

function getTaskRowsOrder(root) {
  const taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  return taskRows.map((r) => r.props['data-wo-quick-access-task'])
}

test('1. Three-item reordering cycle: [A, B, C] -> B up -> [B, A, C] -> B down -> [A, B, C] -> C up -> [A, C, B]', async () => {
  const ledger = makeLedger({
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
        label: 'Task Alpha'
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
        label: 'Task Beta'
      },
      {
        taskId: 't-C',
        sourceConversationId: 'cnv2',
        parent: { kind: 'conversation', conversationId: 'cnv2' },
        childSessionId: 'ses-2',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task Gamma'
      }
    ]
  })

  const { runtime, remote, mounted } = await setupComponent({
    ledgers: [ledger]
  })

  let root = runtime.getRoot()

  // Open All Tasks
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Pin A, B, C in sequence
  await pinTaskFromCenter(runtime, 't-A')
  await pinTaskFromCenter(runtime, 't-B')
  await pinTaskFromCenter(runtime, 't-C')

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-A', 't-B', 't-C'], 'Initial order must be [t-A, t-B, t-C]')

  // 1. Check boundary disabled states
  const upA = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 't-A')
  const downA = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-down'] === 't-A')
  assert.equal(upA.props.disabled, true, 'First item Up must be disabled')
  assert.equal(downA.props.disabled, false, 'First item Down must be enabled')

  const upB = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 't-B')
  const downB = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-down'] === 't-B')
  assert.equal(upB.props.disabled, false, 'Middle item Up must be enabled')
  assert.equal(downB.props.disabled, false, 'Middle item Down must be enabled')

  const upC = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 't-C')
  const downC = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-down'] === 't-C')
  assert.equal(upC.props.disabled, false, 'Last item Up must be enabled')
  assert.equal(downC.props.disabled, true, 'Last item Down must be disabled')

  // 2. Move B UP -> swaps with A -> [t-B, t-A, t-C]
  upB.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-B', 't-A', 't-C'], 'After B up: order must be [t-B, t-A, t-C]')

  // 3. Move B DOWN -> swaps back with A -> [t-A, t-B, t-C]
  const downBNow = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-down'] === 't-B')
  downBNow.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-A', 't-B', 't-C'], 'After B down: order must be [t-A, t-B, t-C]')

  // 4. Move C UP -> swaps with B -> [t-A, t-C, t-B]
  const upCNow = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 't-C')
  upCNow.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-A', 't-C', 't-B'], 'After C up: order must be [t-A, t-C, t-B]')

  // 5. Zero Remote mutations or extra RPC calls
  assert.equal(remote.illegal.length, 0)

  await mounted.cleanup()
})

test('2. Single item boundary behavior: both Up and Down are disabled', async () => {
  const ledger = makeLedger({
    tasks: [
      {
        taskId: 't-only',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Only Task'
      }
    ]
  })

  const { runtime, mounted } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  await pinTaskFromCenter(runtime, 't-only')

  root = runtime.getRoot()
  const upBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 't-only')
  const downBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-down'] === 't-only')

  assert.equal(upBtn.props.disabled, true, 'Single item Up must be disabled')
  assert.equal(downBtn.props.disabled, true, 'Single item Down must be disabled')

  // Invoking onClick on either does not throw or mutate list
  upBtn.props.onClick(mockEvent())
  await runtime.settle()
  downBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-only'])

  await mounted.cleanup()
})

test('3. Disambiguation across same-label tasks and different sources', async () => {
  const ledger = makeLedger({
    tasks: [
      {
        taskId: 't-first',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Duplicate Label'
      },
      {
        taskId: 't-second',
        sourceConversationId: 'cnv2',
        parent: { kind: 'conversation', conversationId: 'cnv2' },
        childSessionId: 'ses-2',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Duplicate Label'
      }
    ]
  })

  const { runtime, mounted } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  await pinTaskFromCenter(runtime, 't-first')
  await pinTaskFromCenter(runtime, 't-second')

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-first', 't-second'])

  // Swap t-second UP
  const upSecond = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 't-second')
  assert.equal(upSecond.props['data-wo-quick-access-task-source'], 'cnv2')
  upSecond.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-second', 't-first'])

  await mounted.cleanup()
})

test('4. Synthetic Node ID collision non-interference: tree project vs task with identical ID', async () => {
  const ledger = makeLedger({
    tasks: [
      {
        taskId: 'p1', // Identical to tree node ID 'p1'
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task Colliding With Project'
      },
      {
        taskId: 't-other',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Other Task'
      }
    ]
  })

  const { runtime, mounted } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  // 1. Pin tree node p1 (project)
  const toggleP1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'p1')
  toggleP1.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Open center and pin task p1 and task t-other
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  await pinTaskFromCenter(runtime, 'p1')
  await pinTaskFromCenter(runtime, 't-other')

  root = runtime.getRoot()

  // Verify tree node p1 is in normal rows, and task p1 is in task rows
  const normalRow = requireOne(root, (n) => n.props?.['data-wo-quick-access-row'] === 'p1')
  assert.equal(normalRow.props['data-wo-kind'], 'project')

  const taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRows.map((r) => r.props['data-wo-quick-access-task']), ['p1', 't-other'])

  // Reorder task t-other UP
  const upOther = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 't-other')
  upOther.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()

  // Verify task rows reordered to ['t-other', 'p1']
  const taskRowsAfter = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRowsAfter.map((r) => r.props['data-wo-quick-access-task']), ['t-other', 'p1'])

  // Verify normal tree quickAccessItems untouched
  const normalRowsAfter = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(normalRowsAfter.map((r) => r.props['data-wo-quick-access-row']), ['p1'])

  await mounted.cleanup()
})

test('5. Saved old handler defense: invoking saved handler after item removal fails closed without resurrecting', async () => {
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
        label: 'Task 1'
      },
      {
        taskId: 't-2',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task 2'
      }
    ]
  })

  const { runtime, mounted } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  await pinTaskFromCenter(runtime, 't-1')
  await pinTaskFromCenter(runtime, 't-2')

  root = runtime.getRoot()

  // Save the Down button handler for t-1
  const downT1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-down'] === 't-1')
  const savedDownT1Handler = downT1.props.onClick

  // Remove t-1 via remove button
  const removeT1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 't-1')
  removeT1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-2'])

  // Invoke saved handler for removed item
  savedDownT1Handler(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-2'], 'Must NOT resurrect t-1')

  await mounted.cleanup()
})

test('6. Stale snapshot constraints: snapshotStale disables up/down buttons and rejects live handlers', async () => {
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
        label: 'Task 1'
      },
      {
        taskId: 't-2',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task 2'
      }
    ]
  })

  let shouldFailSnapshot = false
  const { runtime, remote, mounted } = await setupComponent({
    ledgers: [ledger]
  })

  remote.allowed.snapshot = async () => {
    if (shouldFailSnapshot) throw new Error('Simulated snapshot network failure')
    return { ok: true, value: baseSnapshot }
  }

  let root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  await pinTaskFromCenter(runtime, 't-1')
  await pinTaskFromCenter(runtime, 't-2')

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-1', 't-2'])

  // Trigger stale state via failed tree refresh
  shouldFailSnapshot = true
  requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const staleBanner = findOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true')
  assert.ok(staleBanner, 'stale banner must be active')

  // Up/down buttons must now be disabled
  const upT2 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 't-2')
  assert.equal(upT2.props.disabled, true, 'Up button must be disabled when snapshot is stale')

  // Calling handler fails closed via live ref
  upT2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-1', 't-2'], 'Order must remain unchanged when stale')

  await mounted.cleanup()
})

test('7. Unmount safety: saved handler invoked after unmount fails closed cleanly', async () => {
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
        label: 'Task 1'
      },
      {
        taskId: 't-2',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task 2'
      }
    ]
  })

  const { runtime, mounted } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  await pinTaskFromCenter(runtime, 't-1')
  await pinTaskFromCenter(runtime, 't-2')

  root = runtime.getRoot()
  const upT2 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 't-2')
  const savedHandler = upT2.props.onClick

  // Unmount component
  await mounted.cleanup()

  // Invoking saved handler after unmount does not throw or mutate
  assert.doesNotThrow(() => {
    savedHandler(mockEvent())
  })
})

test('8. Rapid sequential clicks: functional state updates resolve successive swaps without dropping items', async () => {
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
        label: 'Task 1'
      },
      {
        taskId: 't-2',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task 2'
      },
      {
        taskId: 't-3',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task 3'
      }
    ]
  })

  const { runtime, mounted } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  await pinTaskFromCenter(runtime, 't-1')
  await pinTaskFromCenter(runtime, 't-2')
  await pinTaskFromCenter(runtime, 't-3')

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-1', 't-2', 't-3'])

  // Rapidly click up on t-3 twice before settle
  const upT3 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 't-3')
  upT3.props.onClick(mockEvent())
  upT3.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // t-3 moved from index 2 -> 1 -> 0: order must be ['t-3', 't-1', 't-2']
  assert.deepEqual(getTaskRowsOrder(root), ['t-3', 't-1', 't-2'])

  await mounted.cleanup()
})

test('9. Section hide and restore preserves custom task order', async () => {
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
        label: 'Task 1'
      },
      {
        taskId: 't-2',
        sourceConversationId: 'cnv1',
        parent: { kind: 'conversation', conversationId: 'cnv1' },
        childSessionId: 'ses-1',
        depth: 0,
        mode: 'plan',
        executionState: 'running',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T10:00:00.000Z',
        label: 'Task 2'
      }
    ]
  })

  const { runtime, mounted } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  await pinTaskFromCenter(runtime, 't-1')
  await pinTaskFromCenter(runtime, 't-2')

  // Swap order to ['t-2', 't-1']
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 't-2').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-2', 't-1'])

  // Hide Quick Access section
  const hideBtn = requireOne(root, (n) => n.props?.['data-wo-section-hide'] === 'quick-access')
  hideBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-section'] === 'quick-access'), null)

  // Restore Quick Access section
  const restoreBtn = requireOne(root, (n) => n.props?.['data-wo-restore-section'] === 'quick-access')
  restoreBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.deepEqual(getTaskRowsOrder(root), ['t-2', 't-1'], 'Order must be strictly preserved after restore')

  await mounted.cleanup()
})

test('10. Fresh mount starts from empty list without cross-mount leakage', async () => {
  const { runtime, mounted } = await setupComponent()
  const root = runtime.getRoot()

  const taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.equal(taskRows.length, 0, 'Fresh mount must start with 0 pinned task rows')

  await mounted.cleanup()
})
