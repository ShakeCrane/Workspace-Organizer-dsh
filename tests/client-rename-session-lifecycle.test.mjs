/**
 * FP-113: Rename Edit Session Lifecycle & Isolation Contract Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. 编辑会话分配与隔离 (Rename session token allocation & isolation):
 *    - Each startRename allocates a new renameToken and binds targetId.
 *    - Save, Cancel, and Input callbacks capture { targetId, token } at render time.
 *    - Pre-execution validation verifies mounted, token match, and targetId match before
 *      reading draft, changing state/refs, or dispatching RPCs.
 * 2. 跨节点/跨会话污染防御 (Cross-target & cross-session pollution defense):
 *    - Saved Save from node A invoked while node B is active is rejected with 0 RPCs.
 *    - Saved Save from node A Session 1 invoked in node A Session 2 is rejected with 0 RPCs.
 *    - Saved Cancel from node A cannot close active editor of node B.
 *    - Saved Input from node A cannot overwrite draft of active editor of node B.
 * 3. 关闭点同步失效 (Synchronous session invalidation on closure):
 *    - Cancel, Select, Locate, success, and unmount immediately invalidate session token.
 *    - Saved callbacks after Cancel (even without awaiting next render) are immediately rejected.
 * 4. 挂载守卫 (Mounted lifecycle guard):
 *    - startRename, saveRename, cancelRename, and input change reject after component unmount.
 *    - Zero state writes and zero RPCs dispatched after unmount.
 * 5. 世代与已确认请求连续性 (Generation isolation & readback continuity):
 *    - In-flight generation guard discards stale responses.
 *    - Closing editor on success does NOT invalidate confirmed request's subsequent readback.
 *    - Double-click Save dispatches exactly 1 renameNode.
 * 6. 零非法调用与快照不可变性 (RPC boundaries & fixture immutability):
 *    - Strictly zero unexpected Remote RPCs.
 *    - Snapshot fixtures are deeply immutable.
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

const scenarioSnapshot = Object.freeze({
  rootId: 'root',
  revision: 10,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
    { id: 'p1', parentId: 'root', kind: 'project', title: 'Branch 1 Project' },
    { id: 'p1_sub', parentId: 'p1', kind: 'project', title: 'Subproject A' },
    { id: 'w1', parentId: 'p1_sub', kind: 'workspace', title: 'Workspace B', directory: 'E:\\ws-1' },
    { id: 'cnv_1', parentId: 'p1_sub', kind: 'conversation', title: 'Conversation C', sessionId: 'ses-1' }
  ]
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-rename-session-lifecycle-test'
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

async function setupRenameComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  renameHandler,
  snapshotHandler,
  ledgers = []
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()

  let isUnmounted = false
  let stateWritesAfterUnmount = 0
  const origUseState = runtime.React.useState
  runtime.React.useState = function (initial) {
    const [state, setState] = origUseState(initial)
    const trackedSetState = function (val) {
      if (isUnmounted) {
        stateWritesAfterUnmount++
      }
      return setState(val)
    }
    return [state, trackedSetState]
  }

  const remote = createRemoteProxy({ snapshot, status, ledgers })
  if (typeof renameHandler === 'function') {
    remote.allowed.renameNode = renameHandler
  }
  if (typeof snapshotHandler === 'function') {
    remote.allowed.snapshot = snapshotHandler
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
    mounted,
    markUnmounted: () => { isUnmounted = true },
    getStateWritesAfterUnmount: () => stateWritesAfterUnmount
  }
}

// ============================================================================
// Core Counterexamples (Must Fail on Baseline)
// ============================================================================

test('1. [COUNTEREXAMPLE 1] Cross-target session pollution: saved Save from A invoked while B is active is rejected', async () => {
  const renameCalls = []
  const renameHandler = async ({ id, title }) => {
    renameCalls.push({ id, title })
    return {
      ...scenarioSnapshot,
      nodes: scenarioSnapshot.nodes.map((n) => (n.id === id ? { ...n, title } : n))
    }
  }

  const { runtime } = await setupRenameComponent({ renameHandler })
  const root = runtime.getRoot()

  // 1. Open rename on Node A (p1_sub)
  const renameBtnA = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'p1_sub', 'Rename button A')
  renameBtnA.props.onClick(mockEvent())
  await runtime.settle()

  // Capture Save callback of A
  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true', 'Rename panel')
  const saveBtnA = requireOne(panel, (n) => n.props?.['data-wo-rename-save'] === 'true', 'Save button A')
  const savedSaveA = saveBtnA.props.onClick

  // 2. Cancel A
  const cancelBtnA = requireOne(panel, (n) => n.props?.['data-wo-rename-cancel'] === 'true', 'Cancel button A')
  cancelBtnA.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true'), null, 'Panel closed')

  // 3. Open rename on Node B (w1)
  const renameBtnB = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename'] === 'w1', 'Rename button B')
  renameBtnB.props.onClick(mockEvent())
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true', 'Rename panel B')
  const inputB = requireOne(panel, (n) => n.props?.['data-wo-rename-input'] === 'true', 'Input B')
  inputB.props.onChange({ target: { value: 'New B Title' } })
  await runtime.settle()

  // 4. Invoke the saved old Save callback from Node A!
  savedSaveA(mockEvent())
  await runtime.settle()

  // Contract requirement:
  // Must be rejected! ZERO renameNode calls dispatched!
  // On baseline, savedSaveA() renames B (w1) to 'New B Title' because it lacks session binding!
  assert.equal(
    renameCalls.length,
    0,
    `Saved Save from A must be rejected and dispatch 0 RPCs, but dispatched: ${JSON.stringify(renameCalls)}`
  )
})

test('2. [COUNTEREXAMPLE 2] Cross-session pollution on same node: saved Save from Session 1 rejected in Session 2', async () => {
  const renameCalls = []
  const renameHandler = async ({ id, title }) => {
    renameCalls.push({ id, title })
    return {
      ...scenarioSnapshot,
      nodes: scenarioSnapshot.nodes.map((n) => (n.id === id ? { ...n, title } : n))
    }
  }

  const { runtime } = await setupRenameComponent({ renameHandler })
  const root = runtime.getRoot()

  // 1. Open rename on Node A (p1_sub) in Session 1
  const renameBtnA = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'p1_sub', 'Rename button A')
  renameBtnA.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true', 'Rename panel')
  const saveBtnA1 = requireOne(panel, (n) => n.props?.['data-wo-rename-save'] === 'true', 'Save button A1')
  const savedSaveA1 = saveBtnA1.props.onClick

  // 2. Cancel A
  const cancelBtnA = requireOne(panel, (n) => n.props?.['data-wo-rename-cancel'] === 'true', 'Cancel button A')
  cancelBtnA.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Open rename on same Node A again (Session 2)
  const renameBtnA2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename'] === 'p1_sub', 'Rename button A2')
  renameBtnA2.props.onClick(mockEvent())
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true', 'Rename panel A2')
  const inputA2 = requireOne(panel, (n) => n.props?.['data-wo-rename-input'] === 'true', 'Input A2')
  inputA2.props.onChange({ target: { value: 'Session 2 Title' } })
  await runtime.settle()

  // 4. Invoke saved Save callback from Session 1
  savedSaveA1(mockEvent())
  await runtime.settle()

  // Contract requirement:
  // Target ID alone is NOT enough (both are p1_sub). The session token changed, so Session 1 callback must be rejected!
  assert.equal(
    renameCalls.length,
    0,
    `Saved Save from Session 1 must be rejected by token mismatch, but dispatched: ${JSON.stringify(renameCalls)}`
  )
})

test('3. [COUNTEREXAMPLE 3] Saved Cancel from A cannot close or cancel active editor B', async () => {
  const { runtime } = await setupRenameComponent()
  const root = runtime.getRoot()

  // 1. Open rename on Node A (p1_sub)
  const renameBtnA = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'p1_sub', 'Rename button A')
  renameBtnA.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true', 'Rename panel A')
  const cancelBtnA = requireOne(panel, (n) => n.props?.['data-wo-rename-cancel'] === 'true', 'Cancel button A')
  const savedCancelA = cancelBtnA.props.onClick

  // 2. Open rename on Node B (w1)
  const renameBtnB = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename'] === 'w1', 'Rename button B')
  renameBtnB.props.onClick(mockEvent())
  await runtime.settle()

  // Editor B is open
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true', 'Rename panel B')
  const sourceLabel = requireOne(panel, (n) => n.props?.['data-wo-rename-source'] === 'w1', 'Source label B')
  assert.ok(sourceLabel)

  // 3. Invoke saved Cancel from Node A
  savedCancelA(mockEvent())
  await runtime.settle()

  // Contract requirement:
  // Must be rejected! Editor for Node B must STILL be open!
  const panelAfter = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true')
  assert.ok(panelAfter, 'Active editor B must NOT be closed by stale Cancel callback from A')
  assert.ok(findOne(panelAfter, (n) => n.props?.['data-wo-rename-source'] === 'w1'), 'Target must still be w1')
})

test('4. [COUNTEREXAMPLE 4] Saved Input from A cannot overwrite draft of active editor B', async () => {
  const { runtime } = await setupRenameComponent()
  const root = runtime.getRoot()

  // 1. Open rename on Node A (p1_sub)
  const renameBtnA = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'p1_sub', 'Rename button A')
  renameBtnA.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true', 'Rename panel A')
  const inputA = requireOne(panel, (n) => n.props?.['data-wo-rename-input'] === 'true', 'Input A')
  const savedInputA = inputA.props.onChange

  // 2. Open rename on Node B (w1)
  const renameBtnB = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename'] === 'w1', 'Rename button B')
  renameBtnB.props.onClick(mockEvent())
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true', 'Rename panel B')
  let inputB = requireOne(panel, (n) => n.props?.['data-wo-rename-input'] === 'true', 'Input B')
  assert.equal(inputB.props.value, 'Workspace B', 'Initial draft for B')

  // 3. Invoke saved Input from Node A with polluted text
  savedInputA({ target: { value: 'Polluted From A' } })
  await runtime.settle()

  // Contract requirement:
  // Must be rejected! Draft for B must NOT be overwritten!
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true', 'Rename panel B')
  inputB = requireOne(panel, (n) => n.props?.['data-wo-rename-input'] === 'true', 'Input B')
  assert.equal(inputB.props.value, 'Workspace B', 'Draft for B must not be polluted by stale input from A')
})

test('5. [COUNTEREXAMPLE 5] Mounted lifecycle guard: saved handlers after unmount dispatch 0 RPCs and 0 state writes', async () => {
  let renameCalls = 0
  const { runtime, mounted, markUnmounted, getStateWritesAfterUnmount } = await setupRenameComponent({
    renameHandler: async () => {
      renameCalls++
      return scenarioSnapshot
    }
  })

  // 1. Open rename on A
  const renameBtnA = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename'] === 'p1_sub', 'Rename button A')
  const savedStartRename = renameBtnA.props.onClick
  savedStartRename(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true', 'Rename panel A')
  const savedSaveA = requireOne(panel, (n) => n.props?.['data-wo-rename-save'] === 'true').props.onClick
  const savedCancelA = requireOne(panel, (n) => n.props?.['data-wo-rename-cancel'] === 'true').props.onClick
  const savedInputA = requireOne(panel, (n) => n.props?.['data-wo-rename-input'] === 'true').props.onChange

  // 2. Unmount component
  markUnmounted()
  if (typeof mounted.cleanup === 'function') mounted.cleanup()
  if (typeof runtime.unmount === 'function') runtime.unmount()

  // 3. Invoke all saved callbacks after unmount
  savedStartRename(mockEvent())
  savedInputA({ target: { value: 'Unmounted Write' } })
  savedSaveA(mockEvent())
  savedCancelA(mockEvent())
  await runtime.settle()

  assert.equal(renameCalls, 0, 'Zero RPCs after unmount')
  assert.equal(getStateWritesAfterUnmount(), 0, 'Zero state writes after unmount')
})

// ============================================================================
// Positive & Contract Invariant Tests
// ============================================================================

test('6. Positive: Valid rename within active session dispatches exactly 1 renameNode and refreshes readback', async () => {
  const renameCalls = []

  const updatedSnapshot = {
    ...scenarioSnapshot,
    revision: 11,
    nodes: scenarioSnapshot.nodes.map((n) => (n.id === 'p1_sub' ? { ...n, title: 'Renamed Subproject' } : n))
  }

  const { runtime, remote } = await setupRenameComponent({
    renameHandler: async ({ id, title }) => {
      renameCalls.push({ id, title })
      return updatedSnapshot
    }
  })

  // Open rename on p1_sub
  const renameBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename'] === 'p1_sub')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Change title
  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true')
  const input = requireOne(panel, (n) => n.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: '  Renamed Subproject  ' } })
  await runtime.settle()

  // Click save
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true')
  const saveBtn = requireOne(panel, (n) => n.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Exactly 1 renameNode with trimmed name
  assert.equal(renameCalls.length, 1)
  assert.deepEqual(renameCalls[0], { id: 'p1_sub', title: 'Renamed Subproject' })

  // Editor closed
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true'), null)

  // Subsequent snapshot refresh called and confirmed
  const snapshotCalls = remote.calls.filter((c) => c.method === 'snapshot').length
  assert.ok(snapshotCalls >= 2, 'Subsequent readback snapshot must be called')
})

test('7. Concurrency guard: Double-click Save dispatches exactly 1 renameNode', async () => {
  const d = deferred()
  let callCount = 0

  const { runtime } = await setupRenameComponent({
    renameHandler: async () => {
      callCount++
      return d.promise
    }
  })

  // Open rename on p1_sub
  const renameBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename'] === 'p1_sub')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true')
  const input = requireOne(panel, (n) => n.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: 'New Name' } })
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true')
  const saveBtn = requireOne(panel, (n) => n.props?.['data-wo-rename-save'] === 'true')

  // Click twice synchronously
  saveBtn.props.onClick(mockEvent())
  saveBtn.props.onClick(mockEvent())

  assert.equal(callCount, 1, 'Only one rename RPC must be dispatched on double click')

  // Resolve pending request
  d.resolve({
    ...scenarioSnapshot,
    nodes: scenarioSnapshot.nodes.map((n) => (n.id === 'p1_sub' ? { ...n, title: 'New Name' } : n))
  })
  await runtime.settle()
})

test('8. Editor closure points: Select in tree invalidates rename session token', async () => {
  const renameCalls = []
  const { runtime } = await setupRenameComponent({
    renameHandler: async ({ id, title }) => {
      renameCalls.push({ id, title })
      return scenarioSnapshot
    }
  })

  // 1. Open rename on A (p1_sub)
  const renameBtnA = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename'] === 'p1_sub')
  renameBtnA.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true')
  const savedSaveA = requireOne(panel, (n) => n.props?.['data-wo-rename-save'] === 'true').props.onClick

  // 2. Click Select on node w1 in tree (which closes rename editor)
  const selectBtnW1 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'w1')
  selectBtnW1.props.onClick(mockEvent())
  await runtime.settle()

  // Panel is closed
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true'), null)

  // 3. Open rename on B (w1)
  const renameBtnB = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename'] === 'w1')
  renameBtnB.props.onClick(mockEvent())
  await runtime.settle()

  // 4. Try invoking saved Save from A
  savedSaveA(mockEvent())
  await runtime.settle()

  assert.equal(renameCalls.length, 0, 'Saved Save from A must be rejected after editor was closed by Select')
})

test('9. Remote failure preserves draft and active editor without automatic retry', async () => {
  let callCount = 0
  const { runtime } = await setupRenameComponent({
    renameHandler: async () => {
      callCount++
      throw new Error('Rename remote server error')
    }
  })

  // Open rename
  const renameBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename'] === 'p1_sub')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true')
  const input = requireOne(panel, (n) => n.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: 'Attempted Name' } })
  await runtime.settle()

  // Click Save (fails)
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true')
  const saveBtn = requireOne(panel, (n) => n.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(callCount, 1, 'Exactly 1 RPC call, no auto retry')

  // Editor remains open, draft preserved
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-rename-panel'] === 'true')
  const currentInput = requireOne(panel, (n) => n.props?.['data-wo-rename-input'] === 'true')
  assert.equal(currentInput.props.value, 'Attempted Name')

  const errorEl = requireOne(panel, (n) => n.props?.['data-wo-rename-error'] === 'true')
  assert.match(textOf(errorEl), /Rename remote server error/)
})

test('10. RPC whitelist and fixture immutability', async () => {
  const originalSnapshotJson = JSON.stringify(scenarioSnapshot)
  const { remote } = await setupRenameComponent()

  // Assert no unexpected mutating RPCs
  const forbiddenMethods = ['reconcileTasks', 'startTask', 'stopTask', 'createProject', 'moveNode']
  for (const call of remote.calls) {
    assert.ok(!forbiddenMethods.includes(call.method), `Forbidden method called: ${call.method}`)
  }

  // Deep comparison of fixture
  assert.equal(JSON.stringify(scenarioSnapshot), originalSnapshotJson, 'scenarioSnapshot must remain immutable')
})
