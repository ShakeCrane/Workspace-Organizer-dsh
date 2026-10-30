/**
 * FP-117: Move Preview Lifecycle & Stale Callback Isolation Contract Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. 移动预览凭证分配与隔离 (Move preview token allocation & context binding):
 *    - Each legitimate preview generation or replacement allocates a new movePreviewToken.
 *    - Confirm and Cancel callbacks capture { sourceId, targetId, token } at render time.
 *    - Pre-execution validation verifies mounted and token/target matching before reading refs or dispatching RPCs.
 * 2. 跨目标/跨会话/跨源污染防御 (Cross-target, cross-session, and cross-source pollution defense):
 *    - Saved Confirm from X->P_A invoked while X->P_B is active is rejected with 0 RPCs.
 *    - Saved Confirm from X->P_A Session 1 invoked in Session 2 is rejected with 0 RPCs.
 *    - Saved Cancel from X->P_A cannot close active preview X->P_B.
 *    - Saved Cancel from empty preview cannot close later preview.
 *    - Switching source node invalidates active preview and token; old Confirm rejected with 0 RPCs.
 * 3. 关闭点同步失效 (Synchronous invalidation on preview closure):
 *    - Cancel, tree selection change, confirm success, and unmount immediately invalidate preview token.
 * 4. 挂载守卫 (Mounted lifecycle guard):
 *    - Confirm and Cancel reject after component unmount with 0 RPCs and 0 state writes.
 * 5. 世代与双读回连续性 (Generation isolation & readback continuity):
 *    - In-flight generation guard ensures double-click Confirm dispatches exactly 1 move RPC.
 *    - Closing preview on success does NOT cancel subsequent snapshot and status readback.
 *    - Move success with subsequent refresh failure preserves confirmed move and marks snapshot stale.
 * 6. 零非法调用与快照不可变性 (RPC boundaries & fixture immutability):
 *    - Strictly zero unexpected Remote RPCs (whitelist: moveNode, snapshot, status).
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
  nodes: Object.freeze([
    Object.freeze({ id: 'root', parentId: null, kind: 'project', title: 'Root Project' }),
    Object.freeze({ id: 'p1_a', parentId: 'root', kind: 'project', title: 'Branch A' }),
    Object.freeze({ id: 'p_deep', parentId: 'p1_a', kind: 'project', title: 'Deep Project' }),
    Object.freeze({ id: 'w1', parentId: 'p1_a', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' }),
    Object.freeze({ id: 'cnv_1', parentId: 'p1_a', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-1' }),
    Object.freeze({ id: 'p1_b', parentId: 'root', kind: 'project', title: 'Branch B' }),
    Object.freeze({ id: 'p2_deep', parentId: 'p1_b', kind: 'project', title: 'Branch B Subproject' }),
    Object.freeze({ id: 'w2', parentId: 'p1_b', kind: 'workspace', title: 'Workspace 2', directory: 'E:\\ws-2' })
  ])
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-move-preview-lifecycle-test'
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

async function setupMoveComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  moveHandler,
  snapshotHandler,
  statusHandler,
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
  if (typeof moveHandler === 'function') {
    remote.allowed.moveNode = moveHandler
  }
  if (typeof snapshotHandler === 'function') {
    remote.allowed.snapshot = snapshotHandler
  }
  if (typeof statusHandler === 'function') {
    remote.allowed.status = statusHandler
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
    triggerUnmount() {
      runtime.unmount()
      isUnmounted = true
    },
    getStateWritesAfterUnmount: () => stateWritesAfterUnmount
  }
}

async function selectTreeNode(runtime, nodeId) {
  const root = runtime.getRoot()
  const selectBtn = requireOne(root, (n) => n.props?.['data-wo-select'] === nodeId, `Select ${nodeId}`)
  selectBtn.props.onClick(mockEvent())
  await runtime.settle()
}

async function clickMoveTarget(runtime, targetId) {
  const root = runtime.getRoot()
  const movePanel = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'Move panel')
  const targetBtn = requireOne(movePanel, (n) => n.props?.['data-wo-move-to'] === targetId, `Target ${targetId}`)
  targetBtn.props.onClick(mockEvent())
  await runtime.settle()
}

// ============================================================================
// Core Counterexamples (Must Fail on Baseline)
// ============================================================================

test('1. [COUNTEREXAMPLE 1] Cross-target preview pollution: saved Confirm from X->P_A invoked after switching to X->P_B is rejected', async () => {
  const moveCalls = []
  const moveHandler = async (req) => {
    moveCalls.push({ id: req.id, parentId: req.parentId })
    return {
      ...scenarioSnapshot,
      nodes: scenarioSnapshot.nodes.map((n) => (n.id === req.id ? { ...n, parentId: req.parentId } : n))
    }
  }

  const { runtime } = await setupMoveComponent({ moveHandler })

  // 1. Select p_deep and preview move to p1_b
  await selectTreeNode(runtime, 'p_deep')
  await clickMoveTarget(runtime, 'p1_b')

  let root = runtime.getRoot()
  let preview = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview P1B')
  const confirmBtnP1B = requireOne(preview, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm P1B')
  const savedConfirmP1B = confirmBtnP1B.props.onClick

  // 2. Legitimate replacement: switch target to p2_deep
  await clickMoveTarget(runtime, 'p2_deep')
  root = runtime.getRoot()
  preview = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview P2Deep')
  assert.equal(requireOne(preview, (n) => n.props?.['data-wo-move-target'] === 'p2_deep').props['data-wo-move-target'], 'p2_deep')

  // Zero RPCs on target replacement
  assert.equal(moveCalls.length, 0, 'Zero RPCs on target replacement')

  // 3. Invoke the saved old Confirm from P1B!
  savedConfirmP1B(mockEvent())
  await runtime.settle()

  // CONTRACT REQUIREMENT:
  // Must be rejected! ZERO move RPC calls dispatched!
  // On baseline, savedConfirmP1B() reads live movePreviewRef.current (which is now p2_deep)
  // and dispatches moveNode({ id: 'p_deep', parentId: 'p2_deep' })!
  assert.equal(
    moveCalls.length,
    0,
    `Saved Confirm from P1B must be rejected with 0 RPCs, but dispatched: ${JSON.stringify(moveCalls)}`
  )

  // 4. Now click active Confirm for P2Deep: must succeed with exactly 1 RPC
  root = runtime.getRoot()
  const activeConfirm = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Active Confirm P2Deep')
  activeConfirm.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1, 'Exactly one move RPC dispatched for active preview')
  assert.deepEqual(moveCalls[0], { id: 'p_deep', parentId: 'p2_deep' })
})

test('2. [COUNTEREXAMPLE 2] Cross-session pollution on same source/target: saved Confirm from Session 1 rejected in Session 2', async () => {
  const moveCalls = []
  const moveHandler = async (req) => {
    moveCalls.push({ id: req.id, parentId: req.parentId })
    return {
      ...scenarioSnapshot,
      nodes: scenarioSnapshot.nodes.map((n) => (n.id === req.id ? { ...n, parentId: req.parentId } : n))
    }
  }

  const { runtime } = await setupMoveComponent({ moveHandler })

  // 1. Select p_deep and preview move to p1_b (Session 1)
  await selectTreeNode(runtime, 'p_deep')
  await clickMoveTarget(runtime, 'p1_b')

  let root = runtime.getRoot()
  let preview = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview Session 1')
  const confirmBtnS1 = requireOne(preview, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm S1')
  const savedConfirmS1 = confirmBtnS1.props.onClick

  // 2. Cancel Session 1
  const cancelBtnS1 = requireOne(preview, (n) => n.props?.['data-wo-move-cancel'] === 'true', 'Cancel S1')
  cancelBtnS1.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-move-preview'] === 'true'), null, 'Preview closed')

  // 3. Open preview for same source and target (Session 2)
  await selectTreeNode(runtime, 'p_deep')
  await clickMoveTarget(runtime, 'p1_b')
  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), 'Preview Session 2 opened')

  // 4. Invoke saved Confirm from Session 1!
  savedConfirmS1(mockEvent())
  await runtime.settle()

  // CONTRACT REQUIREMENT:
  // Must be rejected! ZERO move RPC calls dispatched!
  // On baseline, same sourceId and targetId match live ref, so baseline executes move RPC!
  assert.equal(
    moveCalls.length,
    0,
    `Saved Confirm from Session 1 must be rejected with 0 RPCs, but dispatched: ${JSON.stringify(moveCalls)}`
  )
})

test('3. [COUNTEREXAMPLE 3] Saved Cancel from P_A cannot close active preview P_B', async () => {
  const { runtime } = await setupMoveComponent()

  // 1. Select p_deep and preview move to p1_b
  await selectTreeNode(runtime, 'p_deep')
  await clickMoveTarget(runtime, 'p1_b')

  let root = runtime.getRoot()
  let preview = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview P1B')
  const cancelBtnP1B = requireOne(preview, (n) => n.props?.['data-wo-move-cancel'] === 'true', 'Cancel P1B')
  const savedCancelP1B = cancelBtnP1B.props.onClick

  // 2. Switch target to p2_deep
  await clickMoveTarget(runtime, 'p2_deep')
  root = runtime.getRoot()
  preview = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview P2Deep')
  assert.ok(preview, 'Preview P2Deep is open')

  // 3. Invoke saved Cancel from P1B!
  savedCancelP1B(mockEvent())
  await runtime.settle()

  // CONTRACT REQUIREMENT:
  // Active preview P2Deep MUST REMAIN OPEN!
  // On baseline, cancelMove() takes no arguments and unconditionally closes the active preview!
  root = runtime.getRoot()
  const previewAfter = findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true')
  assert.ok(
    previewAfter !== null,
    'Active preview P2Deep must not be closed by saved Cancel from P1B'
  )
  assert.equal(
    requireOne(previewAfter, (n) => n.props?.['data-wo-move-target'] === 'p2_deep').props['data-wo-move-target'],
    'p2_deep'
  )
})

test('4. [COUNTEREXAMPLE 4] Saved Cancel from empty preview cannot close later preview', async () => {
  const { runtime } = await setupMoveComponent()

  // 1. Select p_deep (Move panel open, but movePreview is null)
  await selectTreeNode(runtime, 'p_deep')
  let root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), null)

  const emptyCancelBtn = requireOne(root, (n) => n.props?.['data-wo-move-cancel'] === 'true', 'Empty cancel')
  const savedEmptyCancel = emptyCancelBtn.props.onClick

  // 2. Open preview for p1_b
  await clickMoveTarget(runtime, 'p1_b')
  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), 'Preview P1B open')

  // 3. Invoke saved Empty Cancel!
  savedEmptyCancel(mockEvent())
  await runtime.settle()

  // CONTRACT REQUIREMENT:
  // Active preview P1B must remain open!
  // On baseline, savedEmptyCancel() calls cancelMove() which destroys the preview!
  root = runtime.getRoot()
  const previewAfter = findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true')
  assert.ok(
    previewAfter !== null,
    'Active preview must not be closed by saved Cancel from empty preview'
  )
})

test('5. [COUNTEREXAMPLE 5] Source switch isolation: saved Confirm from Source A cannot move Source B; old target button cannot tamper with Source B', async () => {
  const moveCalls = []
  const moveHandler = async (req) => {
    moveCalls.push({ id: req.id, parentId: req.parentId })
    return {
      ...scenarioSnapshot,
      nodes: scenarioSnapshot.nodes.map((n) => (n.id === req.id ? { ...n, parentId: req.parentId } : n))
    }
  }

  const { runtime } = await setupMoveComponent({ moveHandler })

  // 1. Select Source A (p_deep) and open preview for p1_b
  await selectTreeNode(runtime, 'p_deep')
  let root = runtime.getRoot()
  const movePanelA = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'Panel A')
  const targetBtnP2DeepA = requireOne(movePanelA, (n) => n.props?.['data-wo-move-to'] === 'p2_deep', 'Target P2Deep from Source A')
  const savedTargetBtnP2DeepA = targetBtnP2DeepA.props.onClick

  await clickMoveTarget(runtime, 'p1_b')
  root = runtime.getRoot()
  let previewA = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview A')
  const confirmBtnA = requireOne(previewA, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm A')
  const savedConfirmA = confirmBtnA.props.onClick

  // 2. Cancel Source A preview
  const cancelBtnA = requireOne(previewA, (n) => n.props?.['data-wo-move-cancel'] === 'true', 'Cancel A')
  cancelBtnA.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Select Source B (w1) and open preview for root
  await selectTreeNode(runtime, 'w1')
  await clickMoveTarget(runtime, 'root')
  root = runtime.getRoot()
  let previewB = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview B')
  assert.equal(requireOne(previewB, (n) => n.props?.['data-wo-move-source'] === 'w1').props['data-wo-move-source'], 'w1')

  // 4. Invoke saved Confirm from Source A!
  savedConfirmA(mockEvent())
  await runtime.settle()

  // CONTRACT REQUIREMENT:
  // Must be rejected! ZERO move RPC calls dispatched!
  // On baseline, savedConfirmA reads live preview (w1 -> root) and dispatches moveNode({ id: 'w1', parentId: 'root' })!
  assert.equal(
    moveCalls.length,
    0,
    `Saved Confirm from Source A must be rejected with 0 RPCs, but dispatched: ${JSON.stringify(moveCalls)}`
  )

  // 5. Invoke saved Target Button from Source A!
  savedTargetBtnP2DeepA(mockEvent())
  await runtime.settle()

  // Must not tamper with active preview of Source B
  root = runtime.getRoot()
  previewB = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview B still active')
  assert.equal(requireOne(previewB, (n) => n.props?.['data-wo-move-source'] === 'w1').props['data-wo-move-source'], 'w1')
  assert.equal(requireOne(previewB, (n) => n.props?.['data-wo-move-target'] === 'root').props['data-wo-move-target'], 'root')

  // 6. Confirm active preview for Source B
  const activeConfirmB = requireOne(previewB, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm B')
  activeConfirmB.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1, 'Exactly one RPC for active Source B')
  assert.deepEqual(moveCalls[0], { id: 'w1', parentId: 'root' })
})

test('6. [COUNTEREXAMPLE 6] Unmounted lifecycle guard: Confirm and Cancel reject after unmount with 0 RPCs and 0 state writes', async () => {
  const moveCalls = []
  const moveHandler = async (req) => {
    moveCalls.push(req)
    return { ...scenarioSnapshot }
  }

  const { runtime, triggerUnmount, getStateWritesAfterUnmount } = await setupMoveComponent({ moveHandler })

  // 1. Select p_deep and open preview for p1_b
  await selectTreeNode(runtime, 'p_deep')
  await clickMoveTarget(runtime, 'p1_b')

  let root = runtime.getRoot()
  const preview = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview')
  const confirmBtn = requireOne(preview, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm')
  const cancelBtn = requireOne(preview, (n) => n.props?.['data-wo-move-cancel'] === 'true', 'Cancel')
  const savedConfirm = confirmBtn.props.onClick
  const savedCancel = cancelBtn.props.onClick

  // 2. Trigger component unmount
  triggerUnmount()

  // 3. Invoke saved Confirm and Cancel after unmount
  savedConfirm(mockEvent())
  savedCancel(mockEvent())
  await runtime.settle()

  // CONTRACT REQUIREMENT:
  // Zero move RPC calls and zero state writes after unmount!
  // On baseline, cancelMove() has no mounted check and writes to 3 states after unmount!
  assert.equal(moveCalls.length, 0, 'Zero RPCs dispatched after unmount')
  assert.equal(
    getStateWritesAfterUnmount(),
    0,
    `Zero state writes allowed after unmount, but observed: ${getStateWritesAfterUnmount()}`
  )
})

// ============================================================================
// Positive Paths and Architectural Contracts
// ============================================================================

test('7. Valid Project move: preview forms without RPC, confirm submits one move, tree updates', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const moveCalls = []

  const moveHandler = async ({ id, parentId }) => {
    moveCalls.push({ id, parentId })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const node = updated.nodes.find((n) => n.id === id)
    node.parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return updated
  }

  const { runtime } = await setupMoveComponent({
    snapshot: () => currentSnapshot,
    moveHandler
  })

  await selectTreeNode(runtime, 'p_deep')
  await clickMoveTarget(runtime, 'p1_b')

  assert.equal(moveCalls.length, 0, 'Zero RPC on preview')

  let root = runtime.getRoot()
  const preview = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview')
  const confirmBtn = requireOne(preview, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1, 'Exactly 1 move RPC')
  assert.deepEqual(moveCalls[0], { id: 'p_deep', parentId: 'p1_b' })

  // Verify preview is closed
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), null, 'Preview closed after confirm')
})

test('8. Valid Workspace move to Root: selecting root maps to snapshot.rootId, directory preserved', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const moveCalls = []

  const moveHandler = async ({ id, parentId }) => {
    moveCalls.push({ id, parentId })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const node = updated.nodes.find((n) => n.id === id)
    node.parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return updated
  }

  const { runtime } = await setupMoveComponent({
    snapshot: () => currentSnapshot,
    moveHandler
  })

  await selectTreeNode(runtime, 'w1')
  await clickMoveTarget(runtime, 'root')

  assert.equal(moveCalls.length, 0, 'Zero RPC on preview')

  let root = runtime.getRoot()
  const preview = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview')
  const confirmBtn = requireOne(preview, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1)
  assert.deepEqual(moveCalls[0], { id: 'w1', parentId: 'root' })
  assert.equal(currentSnapshot.nodes.find((n) => n.id === 'w1').directory, 'E:\\ws-1')
})

test('9. Valid Conversation move (directory-less): dispatches 1 move RPC, preserves sessionId', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const moveCalls = []

  const moveHandler = async ({ id, parentId }) => {
    moveCalls.push({ id, parentId })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const node = updated.nodes.find((n) => n.id === id)
    node.parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return updated
  }

  const { runtime } = await setupMoveComponent({
    snapshot: () => currentSnapshot,
    moveHandler
  })

  await selectTreeNode(runtime, 'cnv_1')
  await clickMoveTarget(runtime, 'p1_b')

  let root = runtime.getRoot()
  const preview = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'Preview')
  const disclosure = requireOne(preview, (n) => n.props?.['data-wo-move-disclosure'] === 'true', 'Disclosure')
  assert.match(textOf(disclosure), /仅逻辑归属；保留原 Session/u)

  const confirmBtn = requireOne(preview, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1)
  assert.deepEqual(moveCalls[0], { id: 'cnv_1', parentId: 'p1_b' })
  assert.equal(currentSnapshot.nodes.find((n) => n.id === 'cnv_1').sessionId, 'ses-1')
})

test('10. Concurrency guard: double-click Confirm dispatches exactly 1 move RPC', async () => {
  const moveDef = deferred()
  const moveCalls = []

  const moveHandler = async (req) => {
    moveCalls.push(req)
    await moveDef.promise
    return {
      ...scenarioSnapshot,
      nodes: scenarioSnapshot.nodes.map((n) => (n.id === req.id ? { ...n, parentId: req.parentId } : n))
    }
  }

  const { runtime } = await setupMoveComponent({ moveHandler })

  await selectTreeNode(runtime, 'p_deep')
  await clickMoveTarget(runtime, 'p1_b')

  let root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm')

  // First click
  confirmBtn.props.onClick(mockEvent())
  // Second click immediately
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1, 'Exactly one RPC dispatched despite rapid double-click')

  // Resolve deferred
  moveDef.resolve()
  await runtime.settle()
})

test('11. Readback continuity & generation isolation: preview closes on success without cancelling in-flight snapshot/status readback', async () => {
  let snapshotReadbacks = 0
  let statusReadbacks = 0

  const moveHandler = async (req) => {
    return {
      ...scenarioSnapshot,
      nodes: scenarioSnapshot.nodes.map((n) => (n.id === req.id ? { ...n, parentId: req.parentId } : n))
    }
  }

  const snapshotHandler = async () => {
    snapshotReadbacks++
    return scenarioSnapshot
  }

  const statusHandler = async () => {
    statusReadbacks++
    return scenarioStatus
  }

  const { runtime } = await setupMoveComponent({ moveHandler, snapshotHandler, statusHandler })

  await selectTreeNode(runtime, 'p_deep')
  await clickMoveTarget(runtime, 'p1_b')

  const initialSnapshotCalls = snapshotReadbacks
  const initialStatusCalls = statusReadbacks

  let root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Readbacks must have executed
  assert.equal(snapshotReadbacks, initialSnapshotCalls + 1, 'snapshot readback executed on move success')
  assert.equal(statusReadbacks, initialStatusCalls + 1, 'status readback executed on move success')
})

test('12. Layered failure handling: move succeeds, background readback fails -> marks snapshot stale, preserves confirmed move', async () => {
  let moveSuccessSnapshot = null
  let initialLoaded = false

  const moveHandler = async (req) => {
    moveSuccessSnapshot = {
      ...scenarioSnapshot,
      revision: 11,
      nodes: scenarioSnapshot.nodes.map((n) => (n.id === req.id ? { ...n, parentId: req.parentId } : n))
    }
    return moveSuccessSnapshot
  }

  const snapshotHandler = async () => {
    if (!initialLoaded) {
      initialLoaded = true
      return scenarioSnapshot
    }
    throw new Error('Network timeout during background refresh')
  }

  const { runtime } = await setupMoveComponent({ moveHandler, snapshotHandler })

  await selectTreeNode(runtime, 'p_deep')
  await clickMoveTarget(runtime, 'p1_b')

  let root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Stale banner or notice present
  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'Notice')
  assert.match(textOf(notice), /移动已确认；但后续快照刷新失败/u)

  const staleBanner = requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true', 'Stale banner')
  assert.ok(staleBanner, 'snapshot must be marked stale')
})

test('13. Pre-validations without fallback: root node, cycle, descendant, same parent rejected with 0 RPCs', async () => {
  const moveCalls = []
  const { runtime } = await setupMoveComponent({
    moveHandler: async (req) => { moveCalls.push(req); return scenarioSnapshot }
  })

  // 1. Same parent no-op: p_deep is already under p1_a
  await selectTreeNode(runtime, 'p_deep')
  let root = runtime.getRoot()
  const movePanel = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'Move panel')
  const sameParentTarget = findOne(movePanel, (n) => n.props?.['data-wo-move-to'] === 'p1_a')
  if (sameParentTarget) {
    sameParentTarget.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
    const errorEl = requireOne(root, (n) => n.props?.['data-wo-move-error'] === 'true', 'Move error')
    assert.match(textOf(errorEl), /目标已是当前父项目/u)
    assert.equal(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), null, 'No preview for same parent')
  }

  // 2. Descendant and self filtering: select p1_a
  await selectTreeNode(runtime, 'p1_a')
  root = runtime.getRoot()
  const panelP1A = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'Panel P1A')
  // Verify self (p1_a) and descendant (p_deep) cannot be targeted
  assert.equal(findOne(panelP1A, (n) => n.props?.['data-wo-move-to'] === 'p1_a'), null, 'Cannot target self')
  assert.equal(findOne(panelP1A, (n) => n.props?.['data-wo-move-to'] === 'p_deep'), null, 'Cannot target descendant')

  // 3. Root project cannot be moved
  await selectTreeNode(runtime, 'root')
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true'), null, 'Root cannot show move panel')

  // 0 RPCs for all invalid attempts
  assert.equal(moveCalls.length, 0, 'Zero RPCs for invalid attempts')
})

test('14. RPC whitelist & fixture immutability: zero unauthorized RPCs (only moveNode, snapshot, status), fixtures frozen', async () => {
  const ledgers = []
  const { runtime, remote } = await setupMoveComponent({
    ledgers,
    moveHandler: async (req) => {
      return {
        ...scenarioSnapshot,
        nodes: scenarioSnapshot.nodes.map((n) => (n.id === req.id ? { ...n, parentId: req.parentId } : n))
      }
    }
  })

  await selectTreeNode(runtime, 'p_deep')
  await clickMoveTarget(runtime, 'p1_b')

  let root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Whitelist check
  const allowedMethods = new Set(['moveNode', 'snapshot', 'status'])
  for (const entry of ledgers) {
    assert.ok(allowedMethods.has(entry.method), `Unauthorized RPC: ${entry.method}`)
  }

  // Fixture immutability check
  assert.throws(() => { scenarioSnapshot.revision = 999 }, TypeError)
  assert.throws(() => { scenarioSnapshot.nodes.push({}) }, TypeError)
})

test('15. Live stale snapshot protection: Confirm rejected with error notice and zero move RPC when refresh marks snapshot stale during active preview', async () => {
  const moveCalls = []
  let snapshotFail = false

  const { runtime } = await setupMoveComponent({
    moveHandler: async (req) => {
      moveCalls.push(req)
      return { ...scenarioSnapshot, revision: 11 }
    },
    snapshotHandler: async () => {
      if (snapshotFail) {
        throw new Error('Synthetic network failure during refresh')
      }
      return scenarioSnapshot
    }
  })

  // 1. Select p_deep and create preview targeting p1_b
  await selectTreeNode(runtime, 'p_deep')
  await clickMoveTarget(runtime, 'p1_b')

  // Capture confirm callback while preview is active and snapshot was fresh
  let root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true')
  const savedConfirm = confirmBtn.props.onClick

  // 2. Trigger real component refresh path that fails, setting snapshotStaleRef.current = true
  snapshotFail = true
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const staleNotice = findOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true')
  assert.ok(staleNotice, 'UI shows snapshot is stale')

  // 3. Invoke saved Confirm callback
  savedConfirm(mockEvent())
  await runtime.settle()

  // 4. Assertions:
  // - ZERO move RPC calls dispatched
  assert.equal(moveCalls.length, 0, 'Zero moveNode calls dispatched when snapshot is stale')

  // - Move error message set indicating snapshot is stale
  root = runtime.getRoot()
  const errorEl = requireOne(root, (n) => n.props?.['data-wo-move-error'] === 'true', 'Move error element')
  assert.match(textOf(errorEl), /快照已陈旧失效，拒绝保存/u)
})
