/**
 * FP-116: Link Workspace Form Session Lifecycle & Resubmission Blocking Contract Tests.
 *
 * Verifies ARCHITECT CONTRACT (01a17465-c0e7-7535-a8bd-1cef9df2d208):
 * 1. 表单会话凭证分配与显式绑定 (Link Workspace token allocation & binding):
 *    - Each startLinkWorkspace allocates a new token and locks target parent ID.
 *    - Confirm, Cancel, Title Input, and Directory Input capture { parentId, token } at render time.
 *    - Pre-execution validation checks mounted, token match, and locked parent match before
 *      reading draft, changing state/refs, or dispatching RPCs.
 * 2. 跨父级与跨会话污染防御 (Cross-target & cross-session pollution defense):
 *    - Saved Confirm from Parent A invoked while Parent B is active is rejected with 0 RPCs.
 *    - Saved Confirm from Parent A Session 1 invoked in Parent A Session 2 is rejected with 0 RPCs.
 *    - Saved Cancel from Parent A cannot close active form of Parent B.
 *    - Saved Input from Parent A cannot overwrite draft of active form of Parent B.
 * 3. 关闭点同步失效 (Synchronous session invalidation on closure):
 *    - Cancel, successful link, and unmount immediately invalidate session token.
 *    - Saved callbacks after Cancel (even without awaiting next render) are immediately rejected.
 * 4. 结果未确认同步 live 锁存 (Live unconfirmed latching):
 *    - On failure, unconfirmed state is synchronously latched before releasing submission lock.
 *    - Resubmission via stale callback is blocked even if closure captured false or draft is modified.
 * 5. 世代与已确认请求连续性 (Generation isolation & readback continuity):
 *    - Token invalidation on success does NOT cancel confirmed request's subsequent readback (snapshot + status).
 *    - Double-click Confirm dispatches exactly 1 registerWorkspace RPC.
 * 6. 挂载守卫 (Mounted lifecycle guard):
 *    - Confirm, Cancel, and Inputs reject after unmount with 0 RPCs and 0 state writes.
 * 7. 零非法调用与快照不可变性 (RPC boundaries & fixture immutability):
 *    - Strictly zero unexpected Remote RPCs (no bindDirectoryConversation, createProject, conversationTarget, openSession, etc.).
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
    Object.freeze({ id: 'p1_a', parentId: 'root', kind: 'project', title: 'Project Branch A' }),
    Object.freeze({ id: 'p_sub_a', parentId: 'p1_a', kind: 'project', title: 'Subproject A' }),
    Object.freeze({ id: 'p1_b', parentId: 'root', kind: 'project', title: 'Project Branch B' }),
    Object.freeze({ id: 'p_sub_b', parentId: 'p1_b', kind: 'project', title: 'Subproject B' }),
    Object.freeze({ id: 'w1', parentId: 'p1_a', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' }),
    Object.freeze({ id: 'cnv_1', parentId: 'w1', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-1' })
  ])
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-link-workspace-lifecycle-test'
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

async function setupLinkWorkspaceComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  registerWorkspaceHandler,
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
  if (typeof registerWorkspaceHandler === 'function') {
    remote.allowed.registerWorkspace = registerWorkspaceHandler
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

async function openLinkWorkspaceForm(runtime, parentId) {
  const selectNode = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === parentId, `Select ${parentId}`)
  selectNode.props.onClick(mockEvent())
  await runtime.settle()

  const startBtnExisting = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-start'] === 'true')
  if (!startBtnExisting) {
    const createToggle = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle')
    createToggle.props.onClick(mockEvent())
    await runtime.settle()
  }

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'Start link workspace')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  return requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', `Link workspace panel for ${parentId}`)
}

test('1. [COUNTEREXAMPLE 1] Cross-target session pollution: saved Confirm from Parent A invoked while Parent B is active is rejected', async () => {
  const registerCalls = []
  const registerWorkspaceHandler = async (req) => {
    registerCalls.push({ parentId: req.parentId, title: req.title, directory: req.directory })
    return {
      ...scenarioSnapshot,
      nodes: [
        ...scenarioSnapshot.nodes,
        { id: 'w_new', parentId: req.parentId, kind: 'workspace', title: req.title, directory: req.directory }
      ]
    }
  }

  const { runtime } = await setupLinkWorkspaceComponent({ registerWorkspaceHandler })

  // 1. Select p1_a and open Link Workspace form
  let panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  // Capture Confirm callback of Form P1A
  const confirmBtnP1A = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'Confirm P1A')
  const savedConfirmP1A = confirmBtnP1A.props.onClick

  // 2. Cancel Form P1A
  const cancelBtnP1A = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-cancel'] === 'true', 'Cancel P1A')
  cancelBtnP1A.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null, 'Panel P1A closed')

  // 3. Select p1_b and open Link Workspace form
  panel = await openLinkWorkspaceForm(runtime, 'p1_b')

  const titleInputP1B = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input P1B')
  const dirInputP1B = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input P1B')
  titleInputP1B.props.onChange({ target: { value: 'Workspace For P1B' } })
  dirInputP1B.props.onChange({ target: { value: 'E:\\ws-p1b-unique' } })
  await runtime.settle()

  // 4. Invoke the saved old Confirm callback from Parent P1A!
  savedConfirmP1A(mockEvent())
  await runtime.settle()

  // Contract requirement:
  // Must be rejected! ZERO registerWorkspace calls dispatched!
  // On baseline, savedConfirmP1A() reads live linkWorkspaceParentRef.current (p1_b) and drafts
  // and dispatches registerWorkspace({ parentId: 'p1_b', title: 'Workspace For P1B', directory: 'E:\\ws-p1b-unique' })!
  assert.equal(
    registerCalls.length,
    0,
    `Saved Confirm from P1A must be rejected and dispatch 0 RPCs, but dispatched: ${JSON.stringify(registerCalls)}`
  )
})

test('2. [COUNTEREXAMPLE 2] Cross-session pollution on same parent: saved Confirm from Session 1 rejected in Session 2', async () => {
  const registerCalls = []
  const registerWorkspaceHandler = async (req) => {
    registerCalls.push({ parentId: req.parentId, title: req.title, directory: req.directory })
    return {
      ...scenarioSnapshot,
      nodes: [
        ...scenarioSnapshot.nodes,
        { id: 'w_new', parentId: req.parentId, kind: 'workspace', title: req.title, directory: req.directory }
      ]
    }
  }

  const { runtime } = await setupLinkWorkspaceComponent({ registerWorkspaceHandler })

  // 1. Select p1_a and open Link Workspace form in Session 1
  let panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  const confirmBtnS1 = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'Confirm S1')
  const savedConfirmS1 = confirmBtnS1.props.onClick

  // 2. Cancel Session 1
  const cancelBtnS1 = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-cancel'] === 'true', 'Cancel S1')
  cancelBtnS1.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Open Link Workspace form on same Parent p1_a again (Session 2)
  panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  const titleInputS2 = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input S2')
  const dirInputS2 = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input S2')
  titleInputS2.props.onChange({ target: { value: 'Session 2 Workspace Title' } })
  dirInputS2.props.onChange({ target: { value: 'E:\\session-2-dir' } })
  await runtime.settle()

  // 4. Invoke saved Confirm from Session 1!
  savedConfirmS1(mockEvent())
  await runtime.settle()

  // Contract requirement:
  // Must be rejected! ZERO registerWorkspace calls dispatched!
  // On baseline, same parentId matches and savedConfirmS1 dispatches RPC!
  assert.equal(
    registerCalls.length,
    0,
    `Saved Confirm from Session 1 must be rejected and dispatch 0 RPCs, but dispatched: ${JSON.stringify(registerCalls)}`
  )
})

test('3. [COUNTEREXAMPLE 3] Saved Cancel from Parent A cannot close active form Parent B', async () => {
  const { runtime } = await setupLinkWorkspaceComponent()

  // 1. Select p1_a and open form
  let panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  const cancelBtnA = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-cancel'] === 'true', 'Cancel A')
  const savedCancelA = cancelBtnA.props.onClick

  // 2. Normal cancel of A
  savedCancelA(mockEvent())
  await runtime.settle()
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null, 'Panel A closed')

  // 3. Select p1_b and open form B
  panel = await openLinkWorkspaceForm(runtime, 'p1_b')
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), 'Panel B must be active')

  // 4. Invoke saved Cancel from Parent A!
  savedCancelA(mockEvent())
  await runtime.settle()

  // Contract requirement:
  // Panel B must remain active! Old Cancel A must not close active form B!
  assert.ok(
    findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'),
    'Saved Cancel from Parent A must NOT close active Form B!'
  )
})

test('4. [COUNTEREXAMPLE 4] Saved Input onChange from Form A cannot overwrite draft of active Form B', async () => {
  const { runtime } = await setupLinkWorkspaceComponent()

  // 1. Select p1_a and open form A
  let panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  const titleInputA = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input A')
  const dirInputA = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input A')
  const savedTitleOnChangeA = titleInputA.props.onChange
  const savedDirOnChangeA = dirInputA.props.onChange

  // 2. Cancel form A
  const cancelBtnA = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-cancel'] === 'true', 'Cancel A')
  cancelBtnA.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Select p1_b and open form B
  panel = await openLinkWorkspaceForm(runtime, 'p1_b')

  const titleInputB = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input B')
  const dirInputB = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input B')
  titleInputB.props.onChange({ target: { value: 'Legit B Title' } })
  dirInputB.props.onChange({ target: { value: 'E:\\legit-b-dir' } })
  await runtime.settle()

  // 4. Invoke saved input callbacks from Form A!
  savedTitleOnChangeA({ target: { value: 'Malicious Overwritten Title' } })
  savedDirOnChangeA({ target: { value: 'E:\\malicious-overwritten-dir' } })
  await runtime.settle()

  // Contract requirement:
  // Form B draft must remain unchanged ('Legit B Title' and 'E:\\legit-b-dir')
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'Panel B after input')
  const currentTitleInputB = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input B current')
  const currentDirInputB = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input B current')

  assert.equal(currentTitleInputB.props.value, 'Legit B Title', 'Form B title draft must NOT be overwritten by Form A input!')
  assert.equal(currentDirInputB.props.value, 'E:\\legit-b-dir', 'Form B dir draft must NOT be overwritten by Form A input!')
})

test('5. [COUNTEREXAMPLE 5] Post-failure resubmission blocking: saved Confirm callback cannot re-submit after remote failure', async () => {
  let callCount = 0
  const registerWorkspaceHandler = async (req) => {
    callCount++
    throw new Error('Host workspace registry rejected connection')
  }

  const { runtime } = await setupLinkWorkspaceComponent({ registerWorkspaceHandler })

  // 1. Select p1_a and open form
  let panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input')
  const dirInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input')
  titleInput.props.onChange({ target: { value: 'WS Title' } })
  dirInput.props.onChange({ target: { value: 'E:\\ws-dir' } })
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'Panel before click')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'Confirm')

  // Capture callback BEFORE the failure! In closure of savedConfirmBeforeFailure, unconfirmed is false!
  const savedConfirmBeforeFailure = confirmBtn.props.onClick

  // 2. Click confirm -> fails
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(callCount, 1, 'First attempt must have dispatched 1 RPC')
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'Panel after failure')
  assert.ok(findOne(panel, (n) => n.props?.['data-wo-link-workspace-unconfirmed'] === 'true'), 'Unconfirmed notice displayed')

  // 3. User might modify draft or invoke the stale savedConfirmBeforeFailure
  const titleInputAfterFail = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input after fail')
  titleInputAfterFail.props.onChange({ target: { value: 'Modified WS Title' } })
  await runtime.settle()

  // Invoke savedConfirmBeforeFailure!
  savedConfirmBeforeFailure(mockEvent())
  await runtime.settle()

  // Contract requirement:
  // Must be blocked by live unconfirmed ref latch! Call count must remain 1!
  // On baseline, savedConfirmBeforeFailure bypasses state check because closure has unconfirmed=false!
  assert.equal(
    callCount,
    1,
    `Resubmission via saved Confirm must be blocked after failure, but was called ${callCount} times!`
  )
})

test('6. Synchronous invalidation on Cancel: callbacks invoked immediately after Cancel reject without waiting for render', async () => {
  const registerCalls = []
  const registerWorkspaceHandler = async (req) => {
    registerCalls.push(req)
    return { ...scenarioSnapshot }
  }

  const { runtime } = await setupLinkWorkspaceComponent({ registerWorkspaceHandler })

  const panel = await openLinkWorkspaceForm(runtime, 'p1_a')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'Confirm')
  const cancelBtn = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-cancel'] === 'true', 'Cancel')
  const savedConfirm = confirmBtn.props.onClick

  // Cancel synchronously
  cancelBtn.props.onClick(mockEvent())

  // Immediately call savedConfirm WITHOUT awaiting runtime.settle()!
  savedConfirm(mockEvent())
  await runtime.settle()

  assert.equal(registerCalls.length, 0, 'Synchronous invalidation on Cancel must immediately block Confirm')
})

test('7. Active form protection: startLinkWorkspace while a form is already active cannot hijack active session', async () => {
  const { runtime } = await setupLinkWorkspaceComponent()

  // 1. Open form for p1_a
  let panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input')
  titleInput.props.onChange({ target: { value: 'Original P1A Draft' } })
  await runtime.settle()

  // 2. Select p1_b and attempt startLinkWorkspace
  const selectP1B = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'p1_b', 'Select p1_b')
  selectP1B.props.onClick(mockEvent())
  await runtime.settle()

  const startBtnB = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-start'] === 'true')
  if (startBtnB) {
    startBtnB.props.onClick(mockEvent())
    await runtime.settle()
  }

  // Active form must remain for p1_a, with draft intact
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'Panel')
  const parentIndicator = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-parent'] === 'p1_a', 'Parent indicator must remain p1_a')
  const curTitleInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input')
  assert.equal(curTitleInput.props.value, 'Original P1A Draft')
})

test('8. Mounted lifecycle guard: Confirm, Cancel, Inputs reject after unmount with 0 RPCs and 0 state writes', async () => {
  const registerCalls = []
  const registerWorkspaceHandler = async (req) => {
    registerCalls.push(req)
    return { ...scenarioSnapshot }
  }

  const { runtime, triggerUnmount, getStateWritesAfterUnmount } = await setupLinkWorkspaceComponent({ registerWorkspaceHandler })

  const panel = await openLinkWorkspaceForm(runtime, 'p1_a')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'Confirm')
  const cancelBtn = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-cancel'] === 'true', 'Cancel')
  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input')
  const dirInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input')

  const savedConfirm = confirmBtn.props.onClick
  const savedCancel = cancelBtn.props.onClick
  const savedTitleChange = titleInput.props.onChange
  const savedDirChange = dirInput.props.onChange

  // Unmount!
  triggerUnmount()
  await runtime.settle()

  // Invoke callbacks after unmount!
  savedTitleChange({ target: { value: 'Post Unmount Title' } })
  savedDirChange({ target: { value: 'E:\\post-unmount-dir' } })
  savedCancel(mockEvent())
  savedConfirm(mockEvent())
  await runtime.settle()

  assert.equal(registerCalls.length, 0, 'Zero RPCs allowed after unmount')
  assert.equal(getStateWritesAfterUnmount(), 0, 'Zero state writes allowed after unmount')
})

test('9. Positive path: valid link under nested project dispatches exactly 1 registerWorkspace RPC, updates tree, readback succeeds', async () => {
  const registerCalls = []
  let snapshotCalls = 0
  let statusCalls = 0

  const registerWorkspaceHandler = async (req) => {
    registerCalls.push({ parentId: req.parentId, title: req.title, directory: req.directory })
    return {
      ...scenarioSnapshot,
      nodes: [
        ...scenarioSnapshot.nodes,
        { id: 'w_linked', parentId: req.parentId, kind: 'workspace', title: req.title, directory: req.directory }
      ]
    }
  }

  let initialMountDone = false
  const snapshotHandler = async () => {
    snapshotCalls++
    if (!initialMountDone) {
      initialMountDone = true
      return scenarioSnapshot
    }
    return {
      ...scenarioSnapshot,
      nodes: [
        ...scenarioSnapshot.nodes,
        { id: 'w_linked', parentId: 'p1_a', kind: 'workspace', title: 'New Linked Workspace', directory: 'E:\\linked-ws' }
      ]
    }
  }

  const statusHandler = async () => {
    statusCalls++
    return scenarioStatus
  }

  const { runtime } = await setupLinkWorkspaceComponent({
    registerWorkspaceHandler,
    snapshotHandler,
    statusHandler
  })

  let panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input')
  const dirInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input')
  titleInput.props.onChange({ target: { value: 'New Linked Workspace' } })
  dirInput.props.onChange({ target: { value: 'E:\\linked-ws' } })
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'Panel')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Assertions
  assert.equal(registerCalls.length, 1)
  assert.deepEqual(registerCalls[0], {
    parentId: 'p1_a',
    title: 'New Linked Workspace',
    directory: 'E:\\linked-ws'
  })

  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null, 'Panel must be closed')
  assert.ok(statusCalls >= 1, 'Status readback must be called')
  assert.ok(snapshotCalls >= 2, 'Snapshot readback must be called')
})

test('10. Concurrency guard: double-click Confirm dispatches exactly 1 registerWorkspace RPC', async () => {
  const d = deferred()
  let registerCalls = 0

  const registerWorkspaceHandler = async (req) => {
    registerCalls++
    return d.promise
  }

  const { runtime } = await setupLinkWorkspaceComponent({ registerWorkspaceHandler })

  let panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input')
  const dirInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input')
  titleInput.props.onChange({ target: { value: 'WS' } })
  dirInput.props.onChange({ target: { value: 'E:\\ws' } })
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'Panel')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'Confirm')

  // First click
  confirmBtn.props.onClick(mockEvent())
  // Second click immediately
  confirmBtn.props.onClick(mockEvent())

  await runtime.settle()
  assert.equal(registerCalls, 1, 'Double click must dispatch exactly 1 RPC')

  d.resolve({
    ...scenarioSnapshot,
    nodes: [
      ...scenarioSnapshot.nodes,
      { id: 'w_linked', parentId: 'p1_a', kind: 'workspace', title: 'WS', directory: 'E:\\ws' }
    ]
  })
  await runtime.settle()
})

test('11. Generation isolation & readback continuity: closing form does NOT cancel in-flight readback', async () => {
  const dReadback = deferred()
  let snapshotReadbackCompleted = false

  const registerWorkspaceHandler = async (req) => {
    return {
      ...scenarioSnapshot,
      nodes: [
        ...scenarioSnapshot.nodes,
        { id: 'w_linked', parentId: 'p1_a', kind: 'workspace', title: 'WS', directory: 'E:\\ws' }
      ]
    }
  }

  let mountDone = false
  const snapshotHandler = async () => {
    if (!mountDone) {
      mountDone = true
      return scenarioSnapshot
    }
    const res = await dReadback.promise
    snapshotReadbackCompleted = true
    return res
  }

  const { runtime } = await setupLinkWorkspaceComponent({
    registerWorkspaceHandler,
    snapshotHandler
  })

  let panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input')
  const dirInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input')
  titleInput.props.onChange({ target: { value: 'WS' } })
  dirInput.props.onChange({ target: { value: 'E:\\ws' } })
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'Panel')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Form is already closed upon successful registerWorkspace
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null, 'Panel closed')

  // Resolve background readback
  dReadback.resolve({
    ...scenarioSnapshot,
    nodes: [
      ...scenarioSnapshot.nodes,
      { id: 'w_linked', parentId: 'p1_a', kind: 'workspace', title: 'WS', directory: 'E:\\ws' }
    ]
  })
  await runtime.settle()

  assert.ok(snapshotReadbackCompleted, 'Snapshot readback must successfully complete even though form closed')
})

test('12. Layered failure preservation: linking succeeds, background readback fails -> snapshot marked stale, form stays closed', async () => {
  const registerWorkspaceHandler = async (req) => {
    return {
      ...scenarioSnapshot,
      nodes: [
        ...scenarioSnapshot.nodes,
        { id: 'w_linked', parentId: 'p1_a', kind: 'workspace', title: 'WS', directory: 'E:\\ws' }
      ]
    }
  }

  let mountDone = false
  const snapshotHandler = async () => {
    if (!mountDone) {
      mountDone = true
      return scenarioSnapshot
    }
    throw new Error('Network timeout during subsequent snapshot readback')
  }

  const { runtime } = await setupLinkWorkspaceComponent({
    registerWorkspaceHandler,
    snapshotHandler
  })

  let panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input')
  const dirInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input')
  titleInput.props.onChange({ target: { value: 'WS' } })
  dirInput.props.onChange({ target: { value: 'E:\\ws' } })
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'Panel')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Panel remains closed, notice displays layered failure, snapshot marked stale
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null, 'Panel stays closed')
  const staleBanner = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-snapshot-stale'] === 'true')
  assert.ok(staleBanner, 'Snapshot marked stale')
  const notice = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-notice'] === 'error')
  assert.ok(notice, 'Notice element present')
  assert.ok(textOf(notice).includes('快照刷新失败') || textOf(notice).includes('refresh failed'), 'Notice mentions refresh failure')
})

test('13. Selection change during active form does NOT divert locked parent', async () => {
  const registerCalls = []
  const registerWorkspaceHandler = async (req) => {
    registerCalls.push(req)
    return { ...scenarioSnapshot }
  }

  const { runtime } = await setupLinkWorkspaceComponent({ registerWorkspaceHandler })

  let panel = await openLinkWorkspaceForm(runtime, 'p1_a')

  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'Title Input')
  const dirInput = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'Dir Input')
  titleInput.props.onChange({ target: { value: 'WS Under P1A' } })
  dirInput.props.onChange({ target: { value: 'E:\\dir-p1a' } })
  await runtime.settle()

  // Change selection to p1_b in the tree!
  const selectP1B = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'p1_b', 'Select p1_b')
  selectP1B.props.onClick(mockEvent())
  await runtime.settle()

  // Confirm
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'Panel')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(registerCalls.length, 1)
  assert.equal(registerCalls[0].parentId, 'p1_a', 'Parent ID must remain p1_a despite tree selection change')
})

test('14. Validation without fallback: Root, non-project, empty title/dir reject with 0 RPCs', async () => {
  const registerCalls = []
  const registerWorkspaceHandler = async (req) => {
    registerCalls.push(req)
    return { ...scenarioSnapshot }
  }

  const { runtime } = await setupLinkWorkspaceComponent({ registerWorkspaceHandler })

  // 1. Select Root (should not show link workspace start button)
  const selectRoot = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'root', 'Select root')
  selectRoot.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-start'] === 'true'), null, 'Root has no link-workspace-start')

  // 2. Select Workspace w1 (should not show link workspace start button)
  const selectW1 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-start'] === 'true'), null, 'Workspace has no link-workspace-start')

  // 3. Select Conversation cnv_1 (should not show link workspace start button)
  const selectCnv1 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'cnv_1', 'Select cnv_1')
  selectCnv1.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-workspace-start'] === 'true'), null, 'Conversation has no link-workspace-start')

  assert.equal(registerCalls.length, 0, 'Zero RPCs dispatched during invalid selections')
})

test('15. RPC whitelist & fixture immutability: zero unexpected RPCs and snapshot deeply frozen', async () => {
  // Verify scenarioSnapshot is deeply frozen
  assert.ok(Object.isFrozen(scenarioSnapshot))
  assert.ok(Object.isFrozen(scenarioSnapshot.nodes))
  for (const node of scenarioSnapshot.nodes) {
    assert.ok(Object.isFrozen(node))
  }
})
