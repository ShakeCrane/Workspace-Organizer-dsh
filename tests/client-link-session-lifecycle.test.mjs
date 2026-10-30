/**
 * FP-115: Link Session Form Session Lifecycle & Resubmission Blocking Contract Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. 表单会话凭证分配与显式绑定 (Link Session token allocation & binding):
 *    - Each startLinkSession allocates a new token and locks target workspace ID.
 *    - Confirm, Cancel, Title Input, and Session ID Input capture { workspaceId, token } at render time.
 *    - Pre-execution validation checks mounted, token match, and locked workspace match before
 *      reading draft, changing state/refs, or dispatching RPCs.
 * 2. 跨工作区与跨会话污染防御 (Cross-workspace & cross-session pollution defense):
 *    - Saved Confirm from Workspace A invoked while Workspace B is active is rejected with 0 RPCs.
 *    - Saved Confirm from Workspace A Session 1 invoked in Workspace A Session 2 is rejected with 0 RPCs.
 *    - Saved Cancel from Workspace A cannot close active form of Workspace B.
 *    - Saved Input from Workspace A cannot overwrite draft of active form of Workspace B.
 * 3. 关闭点同步失效 (Synchronous session invalidation on closure):
 *    - Cancel, successful link, and unmount immediately invalidate session token.
 *    - Saved callbacks after Cancel (even without awaiting next render) are immediately rejected.
 * 4. 结果未确认同步 live 锁存 (Live unconfirmed latching):
 *    - On failure or identity mismatch/ambiguity, unconfirmed state is synchronously latched before releasing submission lock.
 *    - Resubmission via stale callback is blocked even if closure captured false or draft is modified.
 * 5. 世代与已确认请求连续性 (Generation isolation & readback continuity):
 *    - Token invalidation on success does NOT cancel confirmed request's subsequent readback.
 *    - Double-click Confirm dispatches exactly 1 bindDirectoryConversation RPC.
 * 6. 挂载守卫 (Mounted lifecycle guard):
 *    - Confirm, Cancel, and Inputs reject after unmount with 0 RPCs and 0 state writes.
 * 7. 零非法调用与快照不可变性 (RPC boundaries & fixture immutability):
 *    - Strictly zero unexpected Remote RPCs (no conversationTarget, openSession, etc.).
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
    Object.freeze({ id: 'p1', parentId: 'root', kind: 'project', title: 'Project Branch' }),
    Object.freeze({ id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1', nativeWorkspaceId: 'nw-1' }),
    Object.freeze({ id: 'w2', parentId: 'p1', kind: 'workspace', title: 'Workspace 2', directory: 'E:\\ws-2', nativeWorkspaceId: 'nw-2' }),
    Object.freeze({ id: 'cnv_existing', parentId: 'w1', kind: 'conversation', title: 'Existing Conversation', sessionId: 'ses-existing' })
  ])
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-link-session-lifecycle-test'
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

async function setupLinkSessionComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  bindDirectoryConversationHandler,
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
  if (typeof bindDirectoryConversationHandler === 'function') {
    remote.allowed.bindDirectoryConversation = bindDirectoryConversationHandler
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

test('1. [COUNTEREXAMPLE 1] Cross-target session pollution: saved Confirm from Workspace 1 invoked while Workspace 2 is active is rejected', async () => {
  const bindCalls = []
  const bindDirectoryConversationHandler = async (req) => {
    bindCalls.push({ workspaceId: req.workspaceId, title: req.title, sessionId: req.sessionId })
    return {
      ...scenarioSnapshot,
      nodes: [
        ...scenarioSnapshot.nodes,
        { id: 'cnv_new', parentId: req.workspaceId, kind: 'conversation', title: req.title, sessionId: req.sessionId }
      ]
    }
  }

  const { runtime } = await setupLinkSessionComponent({ bindDirectoryConversationHandler })
  const root = runtime.getRoot()

  // 1. Select w1 and open Link Session form
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Capture Confirm callback of Form W1
  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel W1')
  const confirmBtnW1 = requireOne(panel, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'Confirm W1')
  const savedConfirmW1 = confirmBtnW1.props.onClick

  // 2. Cancel Form W1
  const cancelBtnW1 = requireOne(panel, (n) => n.props?.['data-wo-link-session-cancel'] === 'true', 'Cancel W1')
  cancelBtnW1.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null, 'Panel W1 closed')

  // 3. Select w2 and open Link Session form
  const selectW2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'w2', 'Select w2')
  selectW2.props.onClick(mockEvent())
  await runtime.settle()

  const startBtnW2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session W2')
  startBtnW2.props.onClick(mockEvent())
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel W2')
  const titleInputW2 = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input W2')
  const idInputW2 = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input W2')
  titleInputW2.props.onChange({ target: { value: 'Conversation For W2' } })
  idInputW2.props.onChange({ target: { value: 'ses-w2-unique' } })
  await runtime.settle()

  // 4. Invoke the saved old Confirm callback from Workspace W1!
  savedConfirmW1(mockEvent())
  await runtime.settle()

  // Contract requirement:
  // Must be rejected! ZERO bindDirectoryConversation calls dispatched!
  // On baseline, savedConfirmW1() reads live linkSessionWorkspaceRef.current (w2) and drafts
  // and dispatches bindDirectoryConversation({ workspaceId: 'w2', title: 'Conversation For W2', sessionId: 'ses-w2-unique' })!
  assert.equal(
    bindCalls.length,
    0,
    `Saved Confirm from W1 must be rejected and dispatch 0 RPCs, but dispatched: ${JSON.stringify(bindCalls)}`
  )
})

test('2. [COUNTEREXAMPLE 2] Cross-session pollution on same workspace: saved Confirm from Session 1 rejected in Session 2', async () => {
  const bindCalls = []
  const bindDirectoryConversationHandler = async (req) => {
    bindCalls.push({ workspaceId: req.workspaceId, title: req.title, sessionId: req.sessionId })
    return {
      ...scenarioSnapshot,
      nodes: [
        ...scenarioSnapshot.nodes,
        { id: 'cnv_new', parentId: req.workspaceId, kind: 'conversation', title: req.title, sessionId: req.sessionId }
      ]
    }
  }

  const { runtime } = await setupLinkSessionComponent({ bindDirectoryConversationHandler })
  const root = runtime.getRoot()

  // 1. Select w1 and open Link Session form in Session 1
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel S1')
  const confirmBtnS1 = requireOne(panel, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'Confirm S1')
  const savedConfirmS1 = confirmBtnS1.props.onClick

  // 2. Cancel Session 1
  const cancelBtnS1 = requireOne(panel, (n) => n.props?.['data-wo-link-session-cancel'] === 'true', 'Cancel S1')
  cancelBtnS1.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Open Link Session form on same Workspace w1 again (Session 2)
  const startBtn2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session S2')
  startBtn2.props.onClick(mockEvent())
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel S2')
  const titleInputS2 = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input S2')
  const idInputS2 = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input S2')
  titleInputS2.props.onChange({ target: { value: 'Session 2 Conversation Title' } })
  idInputS2.props.onChange({ target: { value: 'ses-s2-unique' } })
  await runtime.settle()

  // 4. Invoke saved Confirm callback from Session 1
  savedConfirmS1(mockEvent())
  await runtime.settle()

  // Contract requirement:
  // Workspace ID match (both are w1) is NOT enough. Session token changed, so Session 1 callback must be rejected!
  assert.equal(
    bindCalls.length,
    0,
    `Saved Confirm from Session 1 must be rejected by token mismatch, but dispatched: ${JSON.stringify(bindCalls)}`
  )
})

test('3. [COUNTEREXAMPLE 3] Saved Cancel from Workspace 1 cannot close active form Workspace 2', async () => {
  const { runtime } = await setupLinkSessionComponent()
  const root = runtime.getRoot()

  // 1. Select w1 and open Link Session form
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel W1')
  const cancelBtnW1 = requireOne(panel, (n) => n.props?.['data-wo-link-session-cancel'] === 'true', 'Cancel W1')
  const savedCancelW1 = cancelBtnW1.props.onClick

  // Cancel W1
  cancelBtnW1.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Select w2 and open Link Session form
  const selectW2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'w2', 'Select w2')
  selectW2.props.onClick(mockEvent())
  await runtime.settle()

  const startBtnW2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session W2')
  startBtnW2.props.onClick(mockEvent())
  await runtime.settle()

  // Form W2 is active
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel W2')
  const wsIndicator = requireOne(panel, (n) => n.props?.['data-wo-link-session-workspace'] === 'w2', 'Workspace W2 indicator')
  assert.ok(wsIndicator)

  // 3. Invoke saved Cancel from Workspace W1!
  savedCancelW1(mockEvent())
  await runtime.settle()

  // Form W2 must NOT be closed!
  const panelAfter = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true')
  assert.ok(
    panelAfter !== null,
    'Active Form W2 must NOT be closed by stale Cancel callback from Form W1'
  )
  const wsAfter = requireOne(panelAfter, (n) => n.props?.['data-wo-link-session-workspace'] === 'w2')
  assert.ok(wsAfter)
})

test('4. [COUNTEREXAMPLE 4] Saved Input onChange from Form W1 cannot overwrite draft of active Form W2', async () => {
  const { runtime } = await setupLinkSessionComponent()
  const root = runtime.getRoot()

  // 1. Open form under w1
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel W1')
  const titleInputW1 = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input W1')
  const idInputW1 = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input W1')
  const savedTitleInputW1 = titleInputW1.props.onChange
  const savedIdInputW1 = idInputW1.props.onChange

  // Cancel W1
  const cancelBtnW1 = requireOne(panel, (n) => n.props?.['data-wo-link-session-cancel'] === 'true', 'Cancel W1')
  cancelBtnW1.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Open form under w2
  const selectW2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'w2', 'Select w2')
  selectW2.props.onClick(mockEvent())
  await runtime.settle()

  const startBtnW2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session W2')
  startBtnW2.props.onClick(mockEvent())
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel W2')
  const titleInputW2 = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input W2')
  const idInputW2 = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input W2')
  titleInputW2.props.onChange({ target: { value: 'Original W2 Title' } })
  idInputW2.props.onChange({ target: { value: 'ses-original-w2' } })
  await runtime.settle()

  // 3. Invoke saved old Input callbacks from Form W1
  savedTitleInputW1({ target: { value: 'Polluted Title From W1' } })
  savedIdInputW1({ target: { value: 'ses-polluted-w1' } })
  await runtime.settle()

  // Form W2 drafts must NOT be overwritten!
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel W2')
  const titleInputAfter = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true')
  const idInputAfter = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true')
  assert.equal(
    titleInputAfter.props.value,
    'Original W2 Title',
    `Form W2 title draft must remain intact, but was changed to: ${titleInputAfter.props.value}`
  )
  assert.equal(
    idInputAfter.props.value,
    'ses-original-w2',
    `Form W2 session ID draft must remain intact, but was changed to: ${idInputAfter.props.value}`
  )
})

test('5. [COUNTEREXAMPLE 5] Post-failure resubmission blocking: saved Confirm callback cannot re-submit after remote failure', async () => {
  let callCount = 0
  const bindDirectoryConversationHandler = async (req) => {
    callCount += 1
    const err = new Error('Remote link connection failure')
    err.code = 'ECONNRESET'
    throw err
  }

  const { runtime } = await setupLinkSessionComponent({ bindDirectoryConversationHandler })
  const root = runtime.getRoot()

  // 1. Open form under w1
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input')
  const idInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input')
  titleInput.props.onChange({ target: { value: 'Failure Retry Session' } })
  idInput.props.onChange({ target: { value: 'ses-fail-retry' } })
  await runtime.settle()

  // Capture Confirm callback BEFORE failure
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'Confirm')
  const savedConfirmPreFailure = confirmBtn.props.onClick

  // 2. Click confirm -> fails and latches unconfirmed
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(callCount, 1, 'First bindDirectoryConversation attempt occurred')

  // Unconfirmed message displayed
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  const unconfirmedNotice = requireOne(panel, (n) => n.props?.['data-wo-link-session-unconfirmed'] === 'true', 'Unconfirmed notice')
  assert.ok(unconfirmedNotice)

  // 3. Invoke the saved Confirm callback (which was captured when linkSessionUnconfirmed was false)!
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

test('6. [COUNTEREXAMPLE 6] Post-failure resubmission blocking on returned identity mismatch/ambiguity', async () => {
  let callCount = 0
  const bindDirectoryConversationHandler = async (req) => {
    callCount += 1
    // Return snapshot with NO matching conversation node!
    return scenarioSnapshot
  }

  const { runtime } = await setupLinkSessionComponent({ bindDirectoryConversationHandler })
  const root = runtime.getRoot()

  // Open form under w1
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input')
  const idInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input')
  titleInput.props.onChange({ target: { value: 'Missing Identity Session' } })
  idInput.props.onChange({ target: { value: 'ses-missing-id' } })
  await runtime.settle()

  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-session-confirm'] === 'true')
  const savedConfirmPreCall = confirmBtn.props.onClick

  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(callCount, 1)

  // Unconfirmed message displayed
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true')
  const unconfirmedNotice = requireOne(panel, (n) => n.props?.['data-wo-link-session-unconfirmed'] === 'true')
  assert.ok(unconfirmedNotice)

  // Calling saved confirm again must NOT dispatch a 2nd call
  savedConfirmPreCall(mockEvent())
  await runtime.settle()

  assert.equal(
    callCount,
    1,
    `Resubmission after identity mismatch must be rejected by live unconfirmed latch, but called ${callCount} times`
  )
})

// ============================================================================
// Lifecycle, Concurrency & Positive Path Contracts
// ============================================================================

test('7. Synchronous invalidation on Cancel: callbacks invoked immediately after Cancel reject without waiting for render', async () => {
  const bindCalls = []
  const bindDirectoryConversationHandler = async (req) => {
    bindCalls.push(req)
    return scenarioSnapshot
  }

  const { runtime } = await setupLinkSessionComponent({ bindDirectoryConversationHandler })
  const root = runtime.getRoot()

  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input')
  const idInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input')
  titleInput.props.onChange({ target: { value: 'Immediate Cancel Title' } })
  idInput.props.onChange({ target: { value: 'ses-immediate' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'Confirm')
  const cancelBtn = requireOne(panel, (n) => n.props?.['data-wo-link-session-cancel'] === 'true', 'Cancel')
  const savedConfirm = confirmBtn.props.onClick

  // Cancel synchronously
  cancelBtn.props.onClick(mockEvent())

  // Invoke savedConfirm immediately without runtime.settle()
  savedConfirm(mockEvent())
  await runtime.settle()

  assert.equal(bindCalls.length, 0, 'Synchronous token invalidation must block immediate confirm call')
})

test('8. Mounted lifecycle guard: Confirm, Cancel, Inputs reject after unmount with 0 RPCs and 0 state writes', async () => {
  const bindCalls = []
  const { runtime, markUnmounted, getStateWritesAfterUnmount } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async (req) => {
      bindCalls.push(req)
      return scenarioSnapshot
    }
  })

  const root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input')
  const idInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input')
  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'Confirm')
  const cancelBtn = requireOne(panel, (n) => n.props?.['data-wo-link-session-cancel'] === 'true', 'Cancel')

  const savedTitleInput = titleInput.props.onChange
  const savedIdInput = idInput.props.onChange
  const savedConfirm = confirmBtn.props.onClick
  const savedCancel = cancelBtn.props.onClick

  // Unmount component
  runtime.unmount()
  markUnmounted()
  const initialWrites = getStateWritesAfterUnmount()

  // Invoke callbacks after unmount
  savedTitleInput({ target: { value: 'Post Unmount Title' } })
  savedIdInput({ target: { value: 'ses-post-unmount' } })
  savedConfirm(mockEvent())
  savedCancel(mockEvent())
  await runtime.settle()

  assert.equal(bindCalls.length, 0, 'No RPCs dispatched after unmount')
  assert.equal(
    getStateWritesAfterUnmount(),
    initialWrites,
    'No state writes permitted after unmount'
  )
})

test('9. Positive path: valid link under Workspace dispatches exactly 1 bindDirectoryConversation RPC, updates tree, readback succeeds', async () => {
  const bindCalls = []
  let snapshotReadbackCalls = 0
  let initialMountDone = false

  const createdSnapshot = {
    rootId: 'root',
    revision: 11,
    nodes: [
      ...scenarioSnapshot.nodes,
      { id: 'cnv_linked_new', parentId: 'w1', kind: 'conversation', title: 'New Linked Session', sessionId: 'ses-link-positive' }
    ]
  }

  const { runtime } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async (req) => {
      bindCalls.push({ workspaceId: req.workspaceId, title: req.title, sessionId: req.sessionId })
      return createdSnapshot
    },
    snapshotHandler: async () => {
      if (!initialMountDone) {
        return { ok: true, value: scenarioSnapshot }
      }
      snapshotReadbackCalls += 1
      return { ok: true, value: createdSnapshot }
    }
  })
  initialMountDone = true

  const root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input')
  const idInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input')
  titleInput.props.onChange({ target: { value: 'New Linked Session' } })
  idInput.props.onChange({ target: { value: 'ses-link-positive' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Asserts
  assert.equal(bindCalls.length, 1)
  assert.deepEqual(bindCalls[0], { workspaceId: 'w1', title: 'New Linked Session', sessionId: 'ses-link-positive' })
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null, 'Panel closed')
  assert.equal(snapshotReadbackCalls, 1, 'Readback snapshot called')

  // Tree contains new linked conversation node
  const linkedNode = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'cnv_linked_new')
  assert.ok(linkedNode, 'Linked conversation node rendered in tree')
})

test('10. Concurrency guard: double-click Confirm dispatches exactly 1 bindDirectoryConversation RPC', async () => {
  const bindCalls = []
  const gate = deferred()

  const { runtime } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async (req) => {
      bindCalls.push(req)
      await gate.promise
      return {
        ...scenarioSnapshot,
        nodes: [
          ...scenarioSnapshot.nodes,
          { id: 'cnv_concurrent', parentId: req.workspaceId, kind: 'conversation', title: req.title, sessionId: req.sessionId }
        ]
      }
    }
  })

  const root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input')
  const idInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input')
  titleInput.props.onChange({ target: { value: 'Concurrent Test Title' } })
  idInput.props.onChange({ target: { value: 'ses-concurrent' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'Confirm')

  // Double-click
  confirmBtn.props.onClick(mockEvent())
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(bindCalls.length, 1, 'Only 1 RPC dispatched on simultaneous click')

  gate.resolve()
  await runtime.settle()
  assert.equal(bindCalls.length, 1)
})

test('11. Generation isolation & readback continuity: closing form does NOT cancel in-flight readback', async () => {
  let readbackFinished = false
  const updatedSnapshot = {
    rootId: 'root',
    revision: 15,
    nodes: [
      ...scenarioSnapshot.nodes,
      { id: 'cnv_gen', parentId: 'w1', kind: 'conversation', title: 'Gen Conversation', sessionId: 'ses-gen' }
    ]
  }

  const { runtime } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async (req) => {
      return updatedSnapshot
    },
    snapshotHandler: async () => {
      readbackFinished = true
      return { ok: true, value: updatedSnapshot }
    }
  })

  const root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input')
  const idInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input')
  titleInput.props.onChange({ target: { value: 'Gen Conversation' } })
  idInput.props.onChange({ target: { value: 'ses-gen' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(readbackFinished, true, 'Subsequent snapshot readback finished cleanly')
  const staleIndicator = findOne(runtime.getRoot(), (n) => n.props?.['data-wo-snapshot-stale'] === 'true')
  assert.equal(staleIndicator, null, 'Snapshot should not be stale')
})

test('12. Layered failure preservation: linking succeeds, background readback fails -> snapshot marked stale, form stays closed', async () => {
  let initialMountDone = false
  const updatedSnapshot = {
    rootId: 'root',
    revision: 16,
    nodes: [
      ...scenarioSnapshot.nodes,
      { id: 'cnv_stale_test', parentId: 'w1', kind: 'conversation', title: 'Layered Conversation', sessionId: 'ses-stale' }
    ]
  }

  const { runtime } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async (req) => {
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
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input')
  const idInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input')
  titleInput.props.onChange({ target: { value: 'Layered Conversation' } })
  idInput.props.onChange({ target: { value: 'ses-stale' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null, 'Form remains closed')
  const staleIndicator = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-snapshot-stale'] === 'true', 'Stale indicator')
  assert.ok(staleIndicator, 'Snapshot must be marked stale on readback error')
})

test('13. Selection change during active form does NOT divert locked workspace', async () => {
  const bindCalls = []
  const { runtime } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async (req) => {
      bindCalls.push(req)
      return {
        ...scenarioSnapshot,
        nodes: [
          ...scenarioSnapshot.nodes,
          { id: 'cnv_locked', parentId: req.workspaceId, kind: 'conversation', title: req.title, sessionId: req.sessionId }
        ]
      }
    }
  })

  const root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'Select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  const startBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-start'] === 'true', 'Start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  let panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  assert.ok(requireOne(panel, (n) => n.props?.['data-wo-link-session-workspace'] === 'w1'))

  // Select another node (w2)
  const selectW2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-select'] === 'w2', 'Select w2')
  selectW2.props.onClick(mockEvent())
  await runtime.settle()

  // Locked workspace must still be w1!
  panel = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'Link session panel')
  assert.ok(requireOne(panel, (n) => n.props?.['data-wo-link-session-workspace'] === 'w1'), 'Locked workspace must stay w1')

  const titleInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'Title Input')
  const idInput = requireOne(panel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'ID Input')
  titleInput.props.onChange({ target: { value: 'Locked Test' } })
  idInput.props.onChange({ target: { value: 'ses-locked' } })
  await runtime.settle()

  const confirmBtn = requireOne(panel, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'Confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(bindCalls.length, 1)
  assert.equal(bindCalls[0].workspaceId, 'w1', 'Must submit to locked workspace w1')
})

test('14. RPC whitelist & fixture immutability: zero unexpected RPCs and snapshot deeply frozen', async () => {
  const { remote } = await setupLinkSessionComponent()
  const nonInitialCalls = remote.calls.filter(c => c.method !== 'snapshot' && c.method !== 'status')
  assert.deepEqual(nonInitialCalls, [], 'Zero unexpected RPCs beyond initial mount')
  assert.ok(Object.isFrozen(scenarioSnapshot))
  assert.ok(Object.isFrozen(scenarioSnapshot.nodes))
  for (const node of scenarioSnapshot.nodes) {
    assert.ok(Object.isFrozen(node))
  }
})
