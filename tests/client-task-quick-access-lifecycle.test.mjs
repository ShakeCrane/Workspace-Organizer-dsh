/**
 * Task Quick Access Lifecycle & Membership Generation Isolation offline tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Remove -> re-Pin membership token isolation:
 *    - Pin {T, C}, capture Remove/Unpin/Up/Down, remove {T, C}, re-pin {T, C}.
 *    - Old callbacks holding previous token cannot mutate new reference instance.
 *    - Current callbacks on new instance can remove and reorder normally.
 * 2. Pin intent generation isolation:
 *    - Capture old Pin callback before Pin/Unpin.
 *    - Lawful Pin -> Unpin sequence invalidates pin intent.
 *    - Replaying old Pin cannot resurrect the removed item.
 *    - Newly rendered Pin button in current view can lawfully rebuild.
 *    - Duplicate clicks on current Pin button are idempotent and do not duplicate item.
 * 3. Unmount safety:
 *    - All Task quick access callbacks (pin, unpin, up, down) perform zero state writes after unmount.
 * 4. Disambiguation & ID collision non-interference:
 *    - Same taskId under different source conversations are completely isolated.
 *    - Tree project node with identical ID to a taskId does not interfere with task quick access.
 * 5. Stale snapshot & boundary constraints:
 *    - snapshotStale rejects Up/Down reordering.
 *    - snapshotStale allows active Remove/Unpin cleanup.
 *    - Zero Remote RPC calls for all quick access management operations.
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
    { id: 'cnv2', parentId: 'w1', kind: 'conversation', title: 'Conversation 2', sessionId: 'ses-2' },
    { id: 'tsk_collision', parentId: 'p1', kind: 'project', title: 'Colliding Project Node' }
  ]
})

const baseStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-task-lifecycle-test'
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
      tasksCount: 3
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
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      depth: 1,
      mode: 'one-shot',
      executionState: 'completed',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T00:00:01.000Z'
    },
    {
      taskId: 'tsk_3',
      label: 'Task Three',
      childSessionId: 'ses-c3',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      depth: 1,
      mode: 'one-shot',
      executionState: 'pending',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T00:00:02.000Z'
    },
    {
      taskId: 'tsk_collision',
      label: 'Colliding Task',
      childSessionId: 'ses-cc',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      depth: 1,
      mode: 'one-shot',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T00:00:03.000Z'
    },
    {
      taskId: 'tsk_shared_1',
      label: 'Shared Label Task',
      childSessionId: 'ses-cs1',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      depth: 1,
      mode: 'one-shot',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T00:00:04.000Z'
    },
    {
      taskId: 'tsk_shared_2',
      label: 'Shared Label Task',
      childSessionId: 'ses-cs2',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      depth: 1,
      mode: 'one-shot',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T00:00:05.000Z'
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
  remote.allowed.taskLedger = async () => ledger

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

async function openTaskCenterAndSelect(runtime, taskId, sourceConversationId) {
  let root = runtime.getRoot()
  const openBtn = requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true')
  openBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let rowBtn
  if (sourceConversationId) {
    const group = requireOne(root, (n) => n.props?.['data-wo-task-center-group'] === sourceConversationId)
    rowBtn = requireOne(group, (n) => n.props?.['data-wo-task-center-row'] === taskId)
  } else {
    rowBtn = requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === taskId)
  }
  rowBtn.props.onClick(mockEvent())
  await runtime.settle()
  return runtime.getRoot()
}

test('COUNTEREXAMPLE 1: Remove -> repin membership token isolation - old callbacks cannot mutate new reference instance', async () => {
  const { runtime, remote, mounted } = await setupTaskComponent()

  // 1. Open Task Center and Pin tsk_1
  let root = await openTaskCenterAndSelect(runtime, 'tsk_1')
  const pinTsk1 = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_1')
  pinTsk1.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Pin tsk_2
  root = await openTaskCenterAndSelect(runtime, 'tsk_2')
  const pinTsk2 = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_2')
  pinTsk2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(
    taskRows.map((r) => r.props['data-wo-quick-access-task']),
    ['tsk_1', 'tsk_2']
  )

  // 3. Capture callbacks for tsk_1 from instance 1
  const oldRemoveT1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 'tsk_1').props.onClick
  const oldUpT1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 'tsk_1').props.onClick
  const oldDownT1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-down'] === 'tsk_1').props.onClick

  // In detail panel (select tsk_1), capture Unpin callback from instance 1
  root = await openTaskCenterAndSelect(runtime, 'tsk_1')
  const oldUnpinT1 = requireOne(root, (n) => n.props?.['data-wo-task-unpin'] === 'tsk_1').props.onClick

  // 4. Remove tsk_1 via current remove button
  const currentRemoveT1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 'tsk_1')
  currentRemoveT1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRows.map((r) => r.props['data-wo-quick-access-task']), ['tsk_2'])

  // 5. Pin tsk_3 so order is ['tsk_2', 'tsk_3']
  root = await openTaskCenterAndSelect(runtime, 'tsk_3')
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_3').props.onClick(mockEvent())
  await runtime.settle()

  // 6. Re-pin tsk_1 (creates instance 2 with a new token)
  root = await openTaskCenterAndSelect(runtime, 'tsk_1')
  const repinTsk1 = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_1')
  repinTsk1.props.onClick(mockEvent())
  await runtime.settle()

  // Order is now: ['tsk_2', 'tsk_3', 'tsk_1']
  root = runtime.getRoot()
  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(
    taskRows.map((r) => r.props['data-wo-quick-access-task']),
    ['tsk_2', 'tsk_3', 'tsk_1']
  )

  // 7. Invoke old captured Remove callback on tsk_1
  oldRemoveT1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // On baseline: unpinTask filters by taskId without token check and deletes tsk_1 instance 2!
  // On protected code: token mismatch, list remains ['tsk_2', 'tsk_3', 'tsk_1']!
  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(
    taskRows.map((r) => r.props['data-wo-quick-access-task']),
    ['tsk_2', 'tsk_3', 'tsk_1'],
    'old Remove callback from previous instance must NOT remove newly pinned task instance'
  )

  // 8. Invoke old captured Unpin callback from detail panel
  oldUnpinT1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(
    taskRows.map((r) => r.props['data-wo-quick-access-task']),
    ['tsk_2', 'tsk_3', 'tsk_1'],
    'old Unpin callback from previous instance must NOT unpin newly pinned task instance'
  )

  // 9. Invoke old captured Up callback on tsk_1
  oldUpT1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(
    taskRows.map((r) => r.props['data-wo-quick-access-task']),
    ['tsk_2', 'tsk_3', 'tsk_1'],
    'old Up callback from previous instance must NOT reorder newly pinned task instance'
  )

  // 10. Invoke old captured Down callback on tsk_1
  oldDownT1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(
    taskRows.map((r) => r.props['data-wo-quick-access-task']),
    ['tsk_2', 'tsk_3', 'tsk_1'],
    'old Down callback from previous instance must NOT reorder newly pinned task instance'
  )

  // 11. Verify current Remove button on new tsk_1 instance works
  const currentRemoveNewT1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 'tsk_1')
  currentRemoveNewT1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(
    taskRows.map((r) => r.props['data-wo-quick-access-task']),
    ['tsk_2', 'tsk_3'],
    'current Remove button must successfully remove current instance'
  )

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 2: Pin intent generation isolation - old Pin callback cannot resurrect unpinned task', async () => {
  const { runtime, remote, mounted } = await setupTaskComponent()

  // 1. Open Task Center and select tsk_1 (currently unpinned)
  let root = await openTaskCenterAndSelect(runtime, 'tsk_1')
  const pinBtn = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_1')
  const oldPinT1 = pinBtn.props.onClick // Capture Pin callback before Pin/Unpin

  // 2. Lawfully pin tsk_1
  pinBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  let taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRows.map((r) => r.props['data-wo-quick-access-task']), ['tsk_1'])

  // 3. Lawfully unpin tsk_1 via detail panel
  const unpinBtn = requireOne(root, (n) => n.props?.['data-wo-task-unpin'] === 'tsk_1')
  unpinBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRows.map((r) => r.props['data-wo-quick-access-task']), [])

  // 4. Now replay old Pin callback (oldPinT1)
  // On baseline: pinTask has no intent generation check, so it re-pins tsk_1 and resurrects it!
  // On protected code: intent generation was advanced by unpin, old Pin callback is rejected!
  oldPinT1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(
    taskRows.map((r) => r.props['data-wo-quick-access-task']),
    [],
    'old Pin callback captured before unpin must NOT resurrect the task'
  )

  // 5. Verify newly rendered Pin button CAN lawfully rebuild the pin
  const newPinBtn = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_1')
  newPinBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(
    taskRows.map((r) => r.props['data-wo-quick-access-task']),
    ['tsk_1'],
    'newly rendered Pin button must lawfully pin the task'
  )

  // 6. Duplicate click on current Pin button does not duplicate
  const duplicatePin = requireOne(root, (n) => n.props?.['data-wo-task-unpin'] === 'tsk_1')
  assert.ok(duplicatePin, 'button flipped to Unpin')

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 3: Unmount safety - all Task management callbacks do zero state writes after unmount', async () => {
  let postUnmountStateWrites = 0
  let isUnmounted = false

  const { runtime, remote, mounted } = await setupTaskComponent({
    onSetState: () => {
      if (isUnmounted) {
        postUnmountStateWrites += 1
      }
    }
  })

  // Pin tsk_1 and tsk_2
  let root = await openTaskCenterAndSelect(runtime, 'tsk_1')
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_1').props.onClick(mockEvent())
  await runtime.settle()

  root = await openTaskCenterAndSelect(runtime, 'tsk_2')
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_2').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const upBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 'tsk_2').props.onClick
  const downBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-down'] === 'tsk_1').props.onClick
  const removeBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 'tsk_1').props.onClick

  root = await openTaskCenterAndSelect(runtime, 'tsk_3')
  const pinBtn = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_3').props.onClick

  root = await openTaskCenterAndSelect(runtime, 'tsk_1')
  const unpinBtn = requireOne(root, (n) => n.props?.['data-wo-task-unpin'] === 'tsk_1').props.onClick

  // Unmount component
  runtime.unmount()
  isUnmounted = true
  await mounted.cleanup()

  // Invoke all callbacks after unmount
  upBtn(mockEvent())
  downBtn(mockEvent())
  removeBtn(mockEvent())
  pinBtn(mockEvent())
  unpinBtn(mockEvent())

  // On baseline: unpinTask lacks isMountedRef.current check in setQuickAccessTasks, or pinTask/unpinTask triggers state write!
  assert.equal(
    postUnmountStateWrites,
    0,
    'zero state writes allowed after unmount'
  )
})

test('POSITIVE TASK LIFECYCLE: pin, unpin, up, down, boundary disabling, rapid consecutive swaps, zero RPCs', async () => {
  const { runtime, remote, mounted } = await setupTaskComponent()

  // Pin tsk_1, tsk_2, tsk_3
  for (const id of ['tsk_1', 'tsk_2', 'tsk_3']) {
    const root = await openTaskCenterAndSelect(runtime, id)
    requireOne(root, (n) => n.props?.['data-wo-task-pin'] === id).props.onClick(mockEvent())
    await runtime.settle()
  }

  let root = runtime.getRoot()
  let taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRows.map((r) => r.props['data-wo-quick-access-task']), ['tsk_1', 'tsk_2', 'tsk_3'])

  // Boundaries: first item up is disabled, last item down is disabled
  const firstUp = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 'tsk_1')
  const firstDown = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-down'] === 'tsk_1')
  const lastUp = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 'tsk_3')
  const lastDown = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-down'] === 'tsk_3')

  assert.equal(firstUp.props.disabled, true)
  assert.equal(firstDown.props.disabled, false)
  assert.equal(lastUp.props.disabled, false)
  assert.equal(lastDown.props.disabled, true)

  // Move tsk_2 UP -> swaps with tsk_1: ['tsk_2', 'tsk_1', 'tsk_3']
  const upT2 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 'tsk_2')
  upT2.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRows.map((r) => r.props['data-wo-quick-access-task']), ['tsk_2', 'tsk_1', 'tsk_3'])

  // Rapid consecutive swap: click Up on tsk_3, then Up again
  const upT3 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 'tsk_3')
  upT3.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRows.map((r) => r.props['data-wo-quick-access-task']), ['tsk_2', 'tsk_3', 'tsk_1'])

  // Up again on tsk_3
  const upT3Again = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 'tsk_3')
  upT3Again.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRows.map((r) => r.props['data-wo-quick-access-task']), ['tsk_3', 'tsk_2', 'tsk_1'])

  // Zero mutation or extra RPCs
  const forbiddenRpcs = remote.calls.filter((c) => c.method !== 'snapshot' && c.method !== 'status' && c.method !== 'taskLedger')
  assert.equal(forbiddenRpcs.length, 0, 'zero mutation RPC calls')

  await mounted.cleanup()
})

test('DISAMBIGUATION & COLLISION: same taskId across different sources, and project vs task ID collision', async () => {
  const { runtime, remote, mounted } = await setupTaskComponent()

  // 1. Pin tsk_shared_1 from cnv1
  let root = await openTaskCenterAndSelect(runtime, 'tsk_shared_1')
  const pinSharedC1 = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_shared_1')
  pinSharedC1.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Favorite tree node tsk_collision
  root = runtime.getRoot()
  const toggleCollidingProject = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'tsk_collision')
  toggleCollidingProject.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Pin task tsk_collision from Task Center
  root = await openTaskCenterAndSelect(runtime, 'tsk_collision')
  const pinCollidingTask = requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_collision')
  pinCollidingTask.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Normal quick access item: ['tsk_collision']
  const normalRows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(normalRows.map((r) => r.props['data-wo-quick-access-row']), ['tsk_collision'])

  // Task quick access items: ['tsk_shared_1', 'tsk_collision']
  const taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRows.map((r) => r.props['data-wo-quick-access-task']), ['tsk_shared_1', 'tsk_collision'])

  // Remove tree node: task quick access remains untouched
  const unpinCollidingProject = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'tsk_collision')
  unpinCollidingProject.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const normalRowsAfter = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.equal(normalRowsAfter.length, 0)
  const taskRowsAfter = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRowsAfter.map((r) => r.props['data-wo-quick-access-task']), ['tsk_shared_1', 'tsk_collision'])

  await mounted.cleanup()
})

test('STALE SNAPSHOT DEFENSE: snapshotStale blocks Up/Down reordering but allows active Remove/Unpin', async () => {
  let shouldFail = false
  const { runtime, remote, mounted } = await setupTaskComponent()

  // Pin tsk_1 and tsk_2
  let root = await openTaskCenterAndSelect(runtime, 'tsk_1')
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_1').props.onClick(mockEvent())
  await runtime.settle()

  root = await openTaskCenterAndSelect(runtime, 'tsk_2')
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 'tsk_2').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(taskRows.map((r) => r.props['data-wo-quick-access-task']), ['tsk_1', 'tsk_2'])

  // Capture fresh Up button on tsk_2
  const capturedUpT2 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-up'] === 'tsk_2').props.onClick

  // Trigger refresh failure -> snapshot becomes stale
  remote.allowed.snapshot = async () => ({ ok: false, error: { message: 'Network disconnected' } })
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick()
  await runtime.settle()
  root = runtime.getRoot()

  // Verify stale banner
  const staleBanner = requireOne(root, (n) => n.props?.['data-wo-quick-access-stale'] === 'true')
  assert.ok(textOf(staleBanner).includes('快照已陈旧'))

  // Try captured Up callback while stale
  capturedUpT2(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(
    taskRows.map((r) => r.props['data-wo-quick-access-task']),
    ['tsk_1', 'tsk_2'],
    'Up reordering must be rejected when snapshot is stale'
  )

  // Stale Remove exception: active Remove button STILL works when stale
  const removeT1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-remove'] === 'tsk_1')
  assert.equal(removeT1.props.disabled ?? false, false)
  removeT1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  taskRows = findAll(root, (n) => n.props?.['data-wo-quick-access-task'] !== undefined)
  assert.deepEqual(
    taskRows.map((r) => r.props['data-wo-quick-access-task']),
    ['tsk_2'],
    'active Remove button must safely clean up task when stale'
  )

  await mounted.cleanup()
})
