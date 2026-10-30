/**
 * FP-114: Create Project Form Session Lifecycle & Resubmission Blocking Contract Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. 表单会话凭证分配与显式绑定 (Create project session token allocation & binding):
 *    - Each startCreateProject allocates a new token and locks parent ID.
 *    - Confirm, Cancel, and Input callbacks capture { parentId, token } at render time.
 *    - Pre-execution validation checks mounted, token match, and locked parent match before
 *      reading draft, changing state/refs, or dispatching RPCs.
 * 2. 跨表单与跨会话污染防御 (Cross-target & cross-session pollution defense):
 *    - Saved Confirm from Parent A invoked while Parent B form is active is rejected with 0 RPCs.
 *    - Saved Confirm from Parent A Session 1 invoked in Parent A Session 2 is rejected with 0 RPCs.
 *    - Saved Cancel from Parent A cannot close active form of Parent B.
 *    - Saved Input from Parent A cannot overwrite draft of active form of Parent B.
 * 3. 关闭点同步失效 (Synchronous session invalidation on closure):
 *    - Cancel, successful create, and unmount immediately invalidate session token.
 *    - Saved callbacks after Cancel (even without awaiting next render) are immediately rejected.
 * 4. 结果未确认同步 live 锁存 (Live unconfirmed latching):
 *    - On failure, unconfirmed state is synchronously latched before releasing submission lock.
 *    - Resubmission via stale callback is blocked even if closure captured false or draft is modified.
 * 5. 世代与已确认请求连续性 (Generation isolation & readback continuity):
 *    - Token invalidation on success does NOT cancel confirmed request's subsequent readback.
 *    - Double-click Confirm dispatches exactly 1 createProject RPC.
 * 6. 挂载守卫 (Mounted lifecycle guard):
 *    - Confirm, Cancel, and Input reject after unmount with 0 RPCs and 0 state writes.
 * 7. 零非法调用与快照不可变性 (RPC boundaries & fixture immutability):
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
  nodes: Object.freeze([
    Object.freeze({ id: 'root', parentId: null, kind: 'project', title: 'Root Project' }),
    Object.freeze({ id: 'p_a', parentId: 'root', kind: 'project', title: 'Project Alpha' }),
    Object.freeze({ id: 'p_b', parentId: 'root', kind: 'project', title: 'Project Beta' }),
    Object.freeze({ id: 'p_dup1', parentId: 'root', kind: 'project', title: 'Dup Project' }),
    Object.freeze({ id: 'p_dup2', parentId: 'root', kind: 'project', title: 'Dup Project' }),
    Object.freeze({ id: 'w1', parentId: 'p_a', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' }),
    Object.freeze({ id: 'cnv_1', parentId: 'p_a', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-1' })
  ])
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-create-project-session-lifecycle-test'
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

async function setupCreateComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  createProjectHandler,
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
  if (typeof createProjectHandler === 'function') {
    remote.allowed.createProject = createProjectHandler
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
    markUnmounted: () => { isUnmounted = true },
    getStateWritesAfterUnmount: () => stateWritesAfterUnmount
  }
}

// ============================================================================
// Core Counterexamples (Must Fail on Baseline)
// ============================================================================

test('1. [COUNTEREXAMPLE 1] Cross-target session pollution: saved Confirm from Parent A invoked while Parent B is active is rejected', async () => {
  const createCalls = []
  const createProjectHandler = async (req) => {
    createCalls.push({ parentId: req.parentId, title: req.title })
    return {
      ...scenarioSnapshot,
      nodes: [
        ...scenarioSnapshot.nodes,
        { id: 'p_new', parentId: req.parentId, kind: 'project', title: req.title }
      ]
    }
  }

  const { runtime } = await setupCreateComponent({ createProjectHandler })
  const root = runtime.getRoot()

  // 1. Open create project form under Parent A (p_a)
  const selectA = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_a', 'Select A')
  selectA.props.onClick(mockEvent())
  await runtime.settle()

  const createToggle = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Capture Confirm callback of Form A
  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel A')
  const confirmBtnA = requireOne(panel, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'Confirm A')
  const savedConfirmA = confirmBtnA.props.onClick

  // 2. Cancel Form A
  const cancelBtnA = requireOne(panel, (n) => n.props?.['data-wo-create-project-cancel'] === 'true', 'Cancel A')
  cancelBtnA.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null, 'Panel A closed')

  // 3. Open create project form under Parent B (p_b)
  const selectB = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'p_b', 'Select B')
  selectB.props.onClick(mockEvent())
  await runtime.settle()

  const startBtnB = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project B')
  startBtnB.props.onClick(mockEvent())
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel B')
  const inputB = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input B')
  inputB.props.onChange({ target: { value: 'Project B Unique Draft' } })
  await runtime.settle()

  // 4. Invoke the saved old Confirm callback from Parent A!
  savedConfirmA(mockEvent())
  await runtime.settle()

  // Contract requirement:
  // Must be rejected! ZERO createProject calls dispatched!
  // On baseline, savedConfirmA() reads live createProjectParentRef.current (p_b) and draft ('Project B Unique Draft')
  // and dispatches createProject({ parentId: 'p_b', title: 'Project B Unique Draft' })!
  assert.equal(
    createCalls.length,
    0,
    `Saved Confirm from A must be rejected and dispatch 0 RPCs, but dispatched: ${JSON.stringify(createCalls)}`
  )
})

test('2. [COUNTEREXAMPLE 2] Cross-session pollution on same parent: saved Confirm from Session 1 rejected in Session 2', async () => {
  const createCalls = []
  const createProjectHandler = async (req) => {
    createCalls.push({ parentId: req.parentId, title: req.title })
    return {
      ...scenarioSnapshot,
      nodes: [
        ...scenarioSnapshot.nodes,
        { id: 'p_new', parentId: req.parentId, kind: 'project', title: req.title }
      ]
    }
  }

  const { runtime } = await setupCreateComponent({ createProjectHandler })
  const root = runtime.getRoot()

  // 1. Open create project form under Parent A in Session 1
  const selectA = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_a', 'Select A')
  selectA.props.onClick(mockEvent())
  await runtime.settle()

  const createToggle = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel A1')
  const confirmBtnA1 = requireOne(panel, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'Confirm A1')
  const savedConfirmA1 = confirmBtnA1.props.onClick

  // 2. Cancel Session 1
  const cancelBtnA = requireOne(panel, (n) => n.props?.['data-wo-create-project-cancel'] === 'true', 'Cancel A1')
  cancelBtnA.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Open create project under same Parent A again (Session 2)
  const startBtn2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project 2')
  startBtn2.props.onClick(mockEvent())
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel A2')
  const inputA2 = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input A2')
  inputA2.props.onChange({ target: { value: 'Session 2 Draft Title' } })
  await runtime.settle()

  // 4. Invoke saved Confirm callback from Session 1
  savedConfirmA1(mockEvent())
  await runtime.settle()

  // Contract requirement:
  // Parent ID match (both are p_a) is NOT enough. Session token changed, so Session 1 callback must be rejected!
  assert.equal(
    createCalls.length,
    0,
    `Saved Confirm from Session 1 must be rejected by token mismatch, but dispatched: ${JSON.stringify(createCalls)}`
  )
})

test('3. [COUNTEREXAMPLE 3] Saved Cancel from Parent A cannot close or cancel active form Parent B', async () => {
  const { runtime } = await setupCreateComponent()
  const root = runtime.getRoot()

  // 1. Open create form under Parent A
  const selectA = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_a', 'Select A')
  selectA.props.onClick(mockEvent())
  await runtime.settle()

  const createToggle = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel A')
  const cancelBtnA = requireOne(panel, (n) => n.props?.['data-wo-create-project-cancel'] === 'true', 'Cancel A')
  const savedCancelA = cancelBtnA.props.onClick

  // 2. Open create form under Parent B
  const selectB = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'p_b', 'Select B')
  selectB.props.onClick(mockEvent())
  await runtime.settle()

  // Cancel A
  cancelBtnA.props.onClick(mockEvent())
  await runtime.settle()

  // Open B
  const startBtnB = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project B')
  startBtnB.props.onClick(mockEvent())
  await runtime.settle()

  // Form B is active
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel B')
  const parentIndicator = requireOne(panel, (n) => n.props?.['data-wo-create-project-parent'] === 'p_b', 'Parent B indicator')
  assert.ok(parentIndicator)

  // 3. Invoke saved Cancel from Parent A!
  savedCancelA(mockEvent())
  await runtime.settle()

  // Form B must NOT be closed!
  const panelAfter = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true')
  assert.ok(
    panelAfter !== null,
    'Active Form B must NOT be closed by stale Cancel callback from Form A'
  )
  const parentAfter = requireOne(panelAfter, (n) => n.props?.['data-wo-create-project-parent'] === 'p_b')
  assert.ok(parentAfter)
})

test('4. [COUNTEREXAMPLE 4] Saved Input onChange from Form A cannot overwrite draft of active Form B', async () => {
  const { runtime } = await setupCreateComponent()
  const root = runtime.getRoot()

  // 1. Open create form under Parent A
  const selectA = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_a', 'Select A')
  selectA.props.onClick(mockEvent())
  await runtime.settle()

  const createToggle = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel A')
  const inputA = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input A')
  const savedInputA = inputA.props.onChange

  // Cancel A
  const cancelBtnA = requireOne(panel, (n) => n.props?.['data-wo-create-project-cancel'] === 'true', 'Cancel A')
  cancelBtnA.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Open create form under Parent B
  const selectB = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'p_b', 'Select B')
  selectB.props.onClick(mockEvent())
  await runtime.settle()

  const startBtnB = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project B')
  startBtnB.props.onClick(mockEvent())
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel B')
  const inputB = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input B')
  inputB.props.onChange({ target: { value: 'Original Form B Draft' } })
  await runtime.settle()

  // 3. Invoke saved old Input callback from Form A
  savedInputA({ target: { value: 'Polluted Draft From A' } })
  await runtime.settle()

  // Form B draft must NOT be overwritten!
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel B')
  const inputBAfter = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input B')
  assert.equal(
    inputBAfter.props.value,
    'Original Form B Draft',
    `Form B draft must remain intact, but was changed to: ${inputBAfter.props.value}`
  )
})

test('5. [COUNTEREXAMPLE 5] Post-failure resubmission blocking: saved Confirm callback cannot re-submit after failure', async () => {
  let callCount = 0
  const createProjectHandler = async (req) => {
    callCount += 1
    const err = new Error('Remote network failure')
    err.code = 'ENOTFOUND'
    throw err
  }

  const { runtime } = await setupCreateComponent({ createProjectHandler })
  const root = runtime.getRoot()

  // 1. Open form under Parent A
  const selectA = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_a', 'Select A')
  selectA.props.onClick(mockEvent())
  await runtime.settle()

  const createToggle = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel A')
  const input = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input')
  input.props.onChange({ target: { value: 'Failure Retry Project' } })
  await runtime.settle()

  // Capture Confirm callback BEFORE failure
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel A')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'Confirm')
  const savedConfirmPreFailure = confirmBtn.props.onClick

  // 2. Click confirm -> fails and latches unconfirmed
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(callCount, 1, 'First createProject attempt occurred')

  // Unconfirmed message displayed
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel A')
  const unconfirmedNotice = requireOne(panel, (n) => n.props?.['data-wo-create-project-unconfirmed'] === 'true', 'Unconfirmed notice')
  assert.ok(unconfirmedNotice)

  // 3. User or stale event invokes the saved Confirm callback (which was captured when createProjectUnconfirmed was false)!
  savedConfirmPreFailure(mockEvent())
  await runtime.settle()

  // Contract requirement (Clause 4):
  // Synchronous live latch MUST block duplicate RPC dispatch!
  assert.equal(
    callCount,
    1,
    `Resubmission via saved Confirm must be rejected by live unconfirmed latch, but called ${callCount} times`
  )
})

// ============================================================================
// Lifecycle, Concurrency & Positive Path Contracts
// ============================================================================

test('6. Synchronous invalidation on Cancel: callbacks invoked immediately after Cancel reject without waiting for render', async () => {
  const createCalls = []
  const createProjectHandler = async (req) => {
    createCalls.push(req)
    return scenarioSnapshot
  }

  const { runtime } = await setupCreateComponent({ createProjectHandler })
  const root = runtime.getRoot()

  const selectA = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_a', 'Select A')
  selectA.props.onClick(mockEvent())
  await runtime.settle()

  const createToggle = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel')
  const input = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input')
  input.props.onChange({ target: { value: 'Sync Invalidation Title' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'Confirm')
  const cancelBtn = requireOne(panel, (n) => n.props?.['data-wo-create-project-cancel'] === 'true', 'Cancel')
  const savedConfirm = confirmBtn.props.onClick

  // Cancel synchronously
  cancelBtn.props.onClick(mockEvent())

  // Invoke savedConfirm immediately without runtime.settle()
  savedConfirm(mockEvent())
  await runtime.settle()

  assert.equal(createCalls.length, 0, 'Synchronous token invalidation must block immediate confirm call')
})

test('7. Mounted lifecycle guard: Confirm, Cancel, Input reject after unmount with 0 RPCs and 0 state writes', async () => {
  const createCalls = []
  const { runtime, markUnmounted, getStateWritesAfterUnmount } = await setupCreateComponent({
    createProjectHandler: async (req) => {
      createCalls.push(req)
      return scenarioSnapshot
    }
  })

  const root = runtime.getRoot()
  const selectA = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_a', 'Select A')
  selectA.props.onClick(mockEvent())
  await runtime.settle()

  const createToggle = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel')
  const input = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'Confirm')
  const cancelBtn = requireOne(panel, (n) => n.props?.['data-wo-create-project-cancel'] === 'true', 'Cancel')

  const savedInput = input.props.onChange
  const savedConfirm = confirmBtn.props.onClick
  const savedCancel = cancelBtn.props.onClick

  // Unmount component
  runtime.unmount()
  markUnmounted()
  const initialWrites = getStateWritesAfterUnmount()

  // Invoke callbacks after unmount
  savedInput({ target: { value: 'Post Unmount Value' } })
  savedConfirm(mockEvent())
  savedCancel(mockEvent())
  await runtime.settle()

  assert.equal(createCalls.length, 0, 'No RPCs dispatched after unmount')
  assert.equal(
    getStateWritesAfterUnmount(),
    initialWrites,
    'No state writes permitted after unmount'
  )
})

test('8. Positive path under nested Project: exactly 1 createProject RPC, form closes, snapshot/status readback succeeds', async () => {
  const createCalls = []
  let snapshotReadbackCalls = 0
  let statusReadbackCalls = 0
  let initialMountDone = false

  const createdSnapshot = {
    rootId: 'root',
    revision: 11,
    nodes: [
      ...scenarioSnapshot.nodes,
      { id: 'p_created_sub', parentId: 'p_a', kind: 'project', title: 'New Subproject' }
    ]
  }

  const { runtime, remote } = await setupCreateComponent({
    createProjectHandler: async (req) => {
      createCalls.push({ parentId: req.parentId, title: req.title })
      return createdSnapshot
    },
    snapshotHandler: async () => {
      if (!initialMountDone) {
        return { ok: true, value: scenarioSnapshot }
      }
      snapshotReadbackCalls += 1
      return { ok: true, value: createdSnapshot }
    },
    statusHandler: async () => {
      if (!initialMountDone) {
        return { ok: true, value: scenarioStatus }
      }
      statusReadbackCalls += 1
      return { ok: true, value: scenarioStatus }
    }
  })
  initialMountDone = true

  const root = runtime.getRoot()
  const selectA = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_a', 'Select A')
  selectA.props.onClick(mockEvent())
  await runtime.settle()

  const createToggle = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel')
  const input = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input')
  input.props.onChange({ target: { value: 'New Subproject' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Asserts
  assert.equal(createCalls.length, 1)
  assert.deepEqual(createCalls[0], { parentId: 'p_a', title: 'New Subproject' })
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null, 'Panel closed')
  assert.equal(snapshotReadbackCalls, 1, 'Readback snapshot called')
  assert.equal(statusReadbackCalls, 1, 'Readback status called')

  // Tree contains new project node
  const newSubprojectNode = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'p_created_sub')
  assert.ok(newSubprojectNode, 'Created project node rendered in tree')
})

test('9. Positive path under Root without selection: creates under root, locked parent does not divert on select', async () => {
  const createCalls = []
  const createdRootSnapshot = {
    rootId: 'root',
    revision: 12,
    nodes: [
      ...scenarioSnapshot.nodes,
      { id: 'p_root_sub', parentId: 'root', kind: 'project', title: 'Root Child Project' }
    ]
  }

  const { runtime } = await setupCreateComponent({
    createProjectHandler: async (req) => {
      createCalls.push({ parentId: req.parentId, title: req.title })
      return createdRootSnapshot
    }
  })

  const root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel')
  const parentIndicator = requireOne(panel, (n) => n.props?.['data-wo-create-project-parent'] === 'root', 'Root parent')
  assert.ok(parentIndicator)

  // Selecting another node while panel is active does not divert locked parent
  const selectB = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'p_b', 'Select B')
  selectB.props.onClick(mockEvent())
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel')
  const parentStillRoot = requireOne(panel, (n) => n.props?.['data-wo-create-project-parent'] === 'root', 'Still root')
  assert.ok(parentStillRoot)

  const input = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input')
  input.props.onChange({ target: { value: 'Root Child Project' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(createCalls.length, 1)
  assert.deepEqual(createCalls[0], { parentId: 'root', title: 'Root Child Project' })
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null)
})

test('10. Concurrency guard: double-click Confirm dispatches exactly 1 createProject RPC', async () => {
  const createCalls = []
  const gate = deferred()

  const { runtime } = await setupCreateComponent({
    createProjectHandler: async (req) => {
      createCalls.push(req)
      await gate.promise
      return {
        ...scenarioSnapshot,
        nodes: [
          ...scenarioSnapshot.nodes,
          { id: 'p_concurrent', parentId: req.parentId, kind: 'project', title: req.title }
        ]
      }
    }
  })

  const root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel')
  const input = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input')
  input.props.onChange({ target: { value: 'Concurrent Test' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'Confirm')

  // Double-click
  confirmBtn.props.onClick(mockEvent())
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(createCalls.length, 1, 'Only 1 RPC dispatched on simultaneous click')

  gate.resolve()
  await runtime.settle()
  assert.equal(createCalls.length, 1)
})

test('11. Generation isolation & readback continuity: closing form does NOT cancel in-flight readback', async () => {
  let readbackFinished = false
  const updatedSnapshot = {
    rootId: 'root',
    revision: 15,
    nodes: [
      ...scenarioSnapshot.nodes,
      { id: 'p_gen', parentId: 'root', kind: 'project', title: 'Gen Project' }
    ]
  }

  const { runtime } = await setupCreateComponent({
    createProjectHandler: async (req) => {
      return updatedSnapshot
    },
    snapshotHandler: async () => {
      readbackFinished = true
      return { ok: true, value: updatedSnapshot }
    }
  })

  const root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel')
  const input = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input')
  input.props.onChange({ target: { value: 'Gen Project' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(readbackFinished, true, 'Subsequent snapshot readback finished cleanly')
  const staleIndicator = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-snapshot-stale'] === 'true')
  assert.equal(staleIndicator, null, 'Snapshot should not be stale')
})

test('12. Layered failure preservation: creation succeeds, readback fails -> snapshot marked stale, form stays closed', async () => {
  let initialMountDone = false
  const updatedSnapshot = {
    rootId: 'root',
    revision: 16,
    nodes: [
      ...scenarioSnapshot.nodes,
      { id: 'p_stale_test', parentId: 'root', kind: 'project', title: 'Layered Project' }
    ]
  }

  const { runtime } = await setupCreateComponent({
    createProjectHandler: async (req) => {
      return updatedSnapshot
    },
    snapshotHandler: async () => {
      if (!initialMountDone) {
        return { ok: true, value: scenarioSnapshot }
      }
      const err = new Error('Readback failed')
      err.code = 'EFAULT'
      throw err
    }
  })
  initialMountDone = true

  const root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true', 'Start project')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'Create panel')
  const input = requireOne(panel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'Input')
  input.props.onChange({ target: { value: 'Layered Project' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null, 'Form remains closed')
  const staleIndicator = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-snapshot-stale'] === 'true', 'Stale indicator')
  assert.ok(staleIndicator, 'Snapshot must be marked stale on readback error')
})

test('13. RPC whitelist & fixture immutability: zero unexpected RPCs and snapshot deeply frozen', async () => {
  const { remote } = await setupCreateComponent()
  const nonInitialCalls = remote.calls.filter(c => c.method !== 'snapshot' && c.method !== 'status')
  assert.deepEqual(nonInitialCalls, [], 'Zero unexpected RPCs beyond initial mount')
  assert.ok(Object.isFrozen(scenarioSnapshot))
  assert.ok(Object.isFrozen(scenarioSnapshot.nodes))
  for (const node of scenarioSnapshot.nodes) {
    assert.ok(Object.isFrozen(node))
  }
})
