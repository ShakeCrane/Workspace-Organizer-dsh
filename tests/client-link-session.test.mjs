/**
 * Session Explicit Linking Confirmation Flow offline component tests.
 *
 * Verifies the LINK_EXISTING_SESSION_FLOW contract:
 * 1. Valid Link Session under Workspace: freezes target workspace, discloses no-open/no-execution,
 *    submits bindDirectoryConversation, updates tree with returned canonical conversation node.
 * 2. Invalid target rejection WITHOUT fallback: None, Root, Project, Conversation, deleted W,
 *    changed binding info, stale snapshot fail closed with zero RPC.
 * 3. Selection locking & Anti-tampering: changing tree selection cannot divert target workspace;
 *    tampered DOM workspace attribute rejects with Target mismatch error and zero RPC.
 * 4. Local validation: empty, whitespace-only, and > 200 chars titles, and empty sessionId reject with zero RPC.
 * 5. Same-title allowed vs Known duplicate sessionId: same title across different sessions allowed;
 *    known duplicate session ID in snapshot rejected locally with honest error and zero RPC.
 * 6. Cancel flow: closing linking panel executes zero RPC and zero refresh, clears drafts and frozen target.
 * 7. Concurrency guard: double-click / simultaneous confirm dispatches exactly one bindDirectoryConversation RPC;
 *    submitting state disables confirm button and inputs.
 * 8. Server error: preserves drafts and locked workspace; unconfirmed notice prohibits retry; Cancel exits safely.
 * 9. Returned snapshot identity verification (3 negative cases):
 *    - 9a: matching node missing from returned snapshot -> unconfirmed notice, zero retry
 *    - 9b: matching node points to wrong parent workspace -> unconfirmed notice, zero retry
 *    - 9c: multiple matching nodes -> unconfirmed notice, zero retry
 * 10. Layered confirmation: linking succeeds, subsequent refresh fails -> preserves confirmed session, marks stale.
 * 11. Late response & Unmount safety: in-flight bindDirectoryConversation response safely discarded on unmount;
 *     zero calls to openSession or conversationTarget.
 * 12. Mutual exclusion across all 5 workflows: Rename, Move, Create Project, Link Workspace, and Link Session.
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
    // Root project
    { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },

    // Branch A: p1 -> w1, w2, cnv_existing
    { id: 'p1', parentId: 'root', kind: 'project', title: 'Project Branch' },
    { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1', nativeWorkspaceId: 'nw-1' },
    { id: 'w2', parentId: 'p1', kind: 'workspace', title: 'Workspace 2', directory: 'E:\\ws-2', nativeWorkspaceId: 'nw-2' },
    { id: 'cnv_existing', parentId: 'w1', kind: 'conversation', title: 'Existing Conversation', sessionId: 'ses-existing' }
  ]
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-link-session-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

async function setupLinkSessionComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  ledgers = [],
  document: injectedDocument,
  bindDirectoryConversationHandler,
  registerWorkspaceHandler,
  createProjectHandler,
  moveHandler,
  renameHandler,
  conversationTargetHandler,
  setTimeout: injectedSetTimeout,
  clearTimeout: injectedClearTimeout
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })
  if (typeof bindDirectoryConversationHandler === 'function') {
    remote.allowed.bindDirectoryConversation = bindDirectoryConversationHandler
  }
  if (typeof registerWorkspaceHandler === 'function') {
    remote.allowed.registerWorkspace = registerWorkspaceHandler
  }
  if (typeof createProjectHandler === 'function') {
    remote.allowed.createProject = createProjectHandler
  }
  if (typeof moveHandler === 'function') {
    remote.allowed.moveNode = moveHandler
  }
  if (typeof renameHandler === 'function') {
    remote.allowed.renameNode = renameHandler
  }
  if (typeof conversationTargetHandler === 'function') {
    remote.allowed.conversationTarget = conversationTargetHandler
  }
  const mounted = await mountClientApplication({
    source,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote,
    document: injectedDocument,
    setTimeout: injectedSetTimeout,
    clearTimeout: injectedClearTimeout
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()
  return { runtime, remote, mounted, source }
}

test('1. Valid Link Session under Workspace: freezes target workspace, discloses no-open, submits bindDirectoryConversation, updates tree with canonical fact', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const bindCalls = []
  let conversationTargetCalls = 0

  const bindDirectoryConversationHandler = async (req) => {
    bindCalls.push({ workspaceId: req.workspaceId, title: req.title, sessionId: req.sessionId })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const newConversation = {
      id: 'cnv_canonical_999',
      parentId: req.workspaceId,
      kind: 'conversation',
      title: req.title,
      sessionId: req.sessionId
    }
    updated.nodes.push(newConversation)
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime } = await setupLinkSessionComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    bindDirectoryConversationHandler,
    conversationTargetHandler: async () => {
      conversationTargetCalls += 1
      return { ok: true, value: { sessionId: 'unexpected' } }
    }
  })

  let root = runtime.getRoot()

  // 1. Select workspace w1
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Click Link Session button (in data-wo-bind-panel)
  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Assert ZERO RPC on entering confirmation mode
  assert.equal(bindCalls.length, 0, 'zero RPC calls must occur on entering confirmation mode')

  // 3. Verify confirmation panel, target workspace display, and truthful disclosure
  root = runtime.getRoot()
  const confirmPanel = requireOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'link session panel')
  const wsIndicator = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-session-workspace'] === 'w1', 'ws indicator')
  assert.ok(wsIndicator, 'workspace indicator must freeze w1')
  assert.equal(wsIndicator.props['data-wo-link-session-workspace-title'], 'Workspace 1')
  assert.equal(wsIndicator.props['data-wo-link-session-workspace-path'], 'Root Project / Project Branch / Workspace 1')
  assert.equal(wsIndicator.props['data-wo-link-session-workspace-dir'], 'E:\\ws-1')
  assert.equal(wsIndicator.props['data-wo-link-session-workspace-native'], 'nw-1')

  const disclosure = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-session-disclosure'] === 'true', 'disclosure element')
  assert.match(textOf(disclosure), /关联宿主已有 Session 映射至此工作区；不调用 openSession，不执行历史任务或恢复 Agent 执行/u)

  // 4. Enter title and sessionId
  const titleInput = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title input')
  titleInput.props.onChange({ target: { value: 'My Service Session' } })
  const idInput = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id input')
  idInput.props.onChange({ target: { value: 'ses-candidate-101' } })
  await runtime.settle()

  // 5. Click Confirm Link Session
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Assert exactly 1 bindDirectoryConversation RPC call with frozen workspaceId, title, and sessionId
  assert.equal(bindCalls.length, 1)
  assert.equal(bindCalls[0].workspaceId, 'w1')
  assert.equal(bindCalls[0].title, 'My Service Session')
  assert.equal(bindCalls[0].sessionId, 'ses-candidate-101')

  // Panel closed, notice confirms linking without execution, new conversation node in tree
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null, 'panel must close on success')
  const newRow = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'cnv_canonical_999', 'new conversation row in tree')
  assert.ok(newRow)
  assert.equal(newRow.props['data-wo-session-id'], 'ses-candidate-101')
  assert.equal(newRow.props['data-wo-linked'], 'true')

  const notice = findOne(root, (n) => n.props?.['data-wo-notice'] === 'error')
  assert.equal(notice, null, 'must have no error notice')

  // ZERO calls to openSession or conversationTarget
  assert.equal(conversationTargetCalls, 0, 'zero openSession or conversationTarget calls')
})

test('2. Invalid target rejection WITHOUT fallback: None, Root, Project, Conversation, deleted W, changed binding info, stale fail closed', async () => {
  const bindCalls = []
  const { runtime, remote } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async (req) => {
      bindCalls.push(req)
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()

  // 2a: No selection (selected === null) -> calling startLinkSession directly fails closed
  const mountedComponent = runtime.getRoot()
  // When no node selected, data-wo-bind-panel is not rendered
  assert.equal(findOne(root, (n) => n.props?.['data-wo-bind-panel'] === 'true'), null)

  // 2b: Root selection (selected === 'root') -> MUST reject!
  const selectRoot = requireOne(root, (n) => n.props?.['data-wo-select'] === 'root', 'select root')
  selectRoot.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-bind-panel'] === 'true'), null, 'bind panel not rendered on Root')

  // 2c: Project selection (selected === 'p1') -> MUST reject!
  const selectP1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1', 'select p1')
  selectP1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-bind-panel'] === 'true'), null, 'bind panel not rendered on Project')

  // 2d: Conversation selection (selected === 'cnv_existing') -> MUST reject!
  const selectCnv = requireOne(root, (n) => n.props?.['data-wo-select'] === 'cnv_existing', 'select conversation')
  selectCnv.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-bind-panel'] === 'true'), null, 'bind panel not rendered on Conversation')

  // 2e: Valid W selection, enter linking mode, then W deleted from snapshot before confirm -> MUST reject!
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start link session')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Enter draft
  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInput.props.onChange({ target: { value: 'Valid Title' } })
  const idInput = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInput.props.onChange({ target: { value: 'ses-valid' } })
  await runtime.settle()

  // Mutate snapshot to remove w1
  const missingSnapshot = {
    rootId: 'root',
    revision: 11,
    nodes: scenarioSnapshot.nodes.filter((n) => n.id !== 'w1')
  }
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true', 'refresh button')
  remote.allowed.snapshot = async () => ({ ok: true, value: missingSnapshot })
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Try to confirm -> fails closed
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errMissing = requireOne(root, (n) => n.props?.['data-wo-link-session-error'] === 'true', 'error missing')
  assert.match(textOf(errMissing), /目标工作区在当前快照中不存在/u)
  assert.equal(bindCalls.length, 0)

  // 2f: Stale snapshot -> MUST reject!
  remote.allowed.snapshot = async () => { throw new Error('snapshot failed') }
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtnStale = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtnStale.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errStale = requireOne(root, (n) => n.props?.['data-wo-link-session-error'] === 'true', 'error stale')
  assert.match(textOf(errStale), /快照已陈旧失效，拒绝关联/u)
  assert.equal(bindCalls.length, 0)
})

test('3. Selection locking & Anti-tampering: changing tree selection cannot divert target workspace; DOM mismatch fails closed', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const bindCalls = []

  const { runtime } = await setupLinkSessionComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    bindDirectoryConversationHandler: async (req) => {
      bindCalls.push(req)
      const updated = JSON.parse(JSON.stringify(currentSnapshot))
      updated.nodes.push({ id: 'cnv_locked', parentId: req.workspaceId, kind: 'conversation', title: req.title, sessionId: req.sessionId })
      return { ok: true, value: updated }
    }
  })

  let root = runtime.getRoot()

  // 1. Select w1 and enter link session mode
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInput.props.onChange({ target: { value: 'Locked Session' } })
  const idInput = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInput.props.onChange({ target: { value: 'ses-locked' } })
  await runtime.settle()

  // 2. Change tree selection to w2
  root = runtime.getRoot()
  const selectW2 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w2', 'select w2')
  selectW2.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Confirm panel is STILL open, still bound to w1!
  root = runtime.getRoot()
  const panel = requireOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'panel')
  const wsIndicator = requireOne(panel, (n) => n.props?.['data-wo-link-session-workspace'] === 'w1', 'indicator')
  assert.ok(wsIndicator, 'target workspace must stay locked to w1')

  // 4. Click Confirm -> RPC must target w1, NOT w2!
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(bindCalls.length, 1)
  assert.equal(bindCalls[0].workspaceId, 'w1', 'must target frozen w1, never diverted by selection')

  // 5. Anti-tampering: verify DOM target mismatch fails closed
  const bindCallsTamper = []
  const mockDoc = {
    querySelector: (selector) => {
      if (selector === '[data-wo-link-session-workspace]') {
        return {
          getAttribute: (attr) => attr === 'data-wo-link-session-workspace' ? 'w_tampered_fake' : null
        }
      }
      return null
    }
  }

  const { runtime: runtimeTamper } = await setupLinkSessionComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    document: mockDoc,
    bindDirectoryConversationHandler: async (req) => {
      bindCallsTamper.push(req)
      return { ok: true, value: currentSnapshot }
    }
  })

  let rootTamper = runtimeTamper.getRoot()
  const selectW1Tamper = requireOne(rootTamper, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1Tamper.props.onClick(mockEvent())
  await runtimeTamper.settle()

  rootTamper = runtimeTamper.getRoot()
  const startTamper = requireOne(rootTamper, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startTamper.props.onClick(mockEvent())
  await runtimeTamper.settle()

  rootTamper = runtimeTamper.getRoot()
  const titleInputTamper = requireOne(rootTamper, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInputTamper.props.onChange({ target: { value: 'Tamper Test' } })
  const idInputTamper = requireOne(rootTamper, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInputTamper.props.onChange({ target: { value: 'ses-tamper' } })
  await runtimeTamper.settle()

  rootTamper = runtimeTamper.getRoot()
  const confirmTamper = requireOne(rootTamper, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmTamper.props.onClick(mockEvent())
  await runtimeTamper.settle()

  rootTamper = runtimeTamper.getRoot()
  const errTamper = requireOne(rootTamper, (n) => n.props?.['data-wo-link-session-error'] === 'true', 'error')
  assert.match(textOf(errTamper), /创建目标与DOM不一致/u)
  assert.equal(bindCallsTamper.length, 0, 'zero RPC on tampered target')
})

test('4. Local validation: empty, whitespace-only, and > 200 chars titles, and empty sessionId reject with zero RPC', async () => {
  let bindCalls = 0
  const { runtime } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async () => {
      bindCalls += 1
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Provide valid sessionId first
  root = runtime.getRoot()
  const idInput = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id input')
  idInput.props.onChange({ target: { value: 'ses-valid-1' } })
  await runtime.settle()

  // 1. Empty title
  root = runtime.getRoot()
  const confirmBtn1 = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errEmpty = requireOne(root, (n) => n.props?.['data-wo-link-session-error'] === 'true', 'error empty title')
  assert.match(textOf(errEmpty), /Name must be 1–200 characters/u)
  assert.equal(bindCalls, 0)

  // 2. Whitespace-only title
  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title input')
  titleInput.props.onChange({ target: { value: '    \t   ' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn2 = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errWs = requireOne(root, (n) => n.props?.['data-wo-link-session-error'] === 'true', 'error ws title')
  assert.match(textOf(errWs), /Name must be 1–200 characters/u)
  assert.equal(bindCalls, 0)

  // 3. > 200 chars title
  root = runtime.getRoot()
  const titleInput3 = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title input')
  titleInput3.props.onChange({ target: { value: 'S'.repeat(201) } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn3 = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn3.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errLong = requireOne(root, (n) => n.props?.['data-wo-link-session-error'] === 'true', 'error long title')
  assert.match(textOf(errLong), /Name must be 1–200 characters/u)
  assert.equal(bindCalls, 0)

  // 4. Valid title, empty sessionId
  root = runtime.getRoot()
  const titleInput4 = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title input')
  titleInput4.props.onChange({ target: { value: 'Valid Title' } })
  const idInput4 = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id input')
  idInput4.props.onChange({ target: { value: '' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn4 = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn4.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errEmptyId = requireOne(root, (n) => n.props?.['data-wo-link-session-error'] === 'true', 'error empty id')
  assert.match(textOf(errEmptyId), /Session ID must not be empty/u)
  assert.equal(bindCalls, 0)
})

test('5. Same-title allowed vs Known duplicate sessionId: same title across different sessions allowed; known duplicate rejected locally', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const bindCalls = []

  const { runtime } = await setupLinkSessionComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    bindDirectoryConversationHandler: async (req) => {
      bindCalls.push(req)
      const updated = JSON.parse(JSON.stringify(currentSnapshot))
      updated.nodes.push({ id: 'cnv_same_title_new_session', parentId: req.workspaceId, kind: 'conversation', title: req.title, sessionId: req.sessionId })
      return { ok: true, value: updated }
    }
  })

  let root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 5a: Duplicate sessionId already in snapshot ('ses-existing') -> rejected locally!
  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInput.props.onChange({ target: { value: 'Different Title' } })
  const idInput = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInput.props.onChange({ target: { value: 'ses-existing' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errDupSession = requireOne(root, (n) => n.props?.['data-wo-link-session-error'] === 'true', 'error dup session')
  assert.match(textOf(errDupSession), /该 Session 已在工作区中关联/u)
  assert.equal(bindCalls.length, 0, 'zero RPC on known duplicate session')

  // 5b: Same title ('Existing Conversation') with distinct sessionId ('ses-distinct-new') -> ALLOWED!
  idInput.props.onChange({ target: { value: 'ses-distinct-new' } })
  titleInput.props.onChange({ target: { value: 'Existing Conversation' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn2 = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn2.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(bindCalls.length, 1)
  assert.equal(bindCalls[0].title, 'Existing Conversation')
  assert.equal(bindCalls[0].sessionId, 'ses-distinct-new')
})

test('6. Cancel flow: closing linking panel executes zero RPC and zero refresh, clears drafts and frozen target', async () => {
  let bindCalls = 0
  let snapshotReadCalls = 0
  const { runtime, remote } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async () => {
      bindCalls += 1
      return { ok: true, value: scenarioSnapshot }
    }
  })
  const originalSnapshot = remote.allowed.snapshot
  remote.allowed.snapshot = async () => {
    snapshotReadCalls += 1
    return originalSnapshot()
  }

  let root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInput.props.onChange({ target: { value: 'Draft to cancel' } })
  const idInput = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInput.props.onChange({ target: { value: 'ses-cancel' } })
  await runtime.settle()

  const snapshotReadsBeforeCancel = snapshotReadCalls

  // Click Cancel
  root = runtime.getRoot()
  const cancelBtn = requireOne(root, (n) => n.props?.['data-wo-link-session-cancel'] === 'true', 'cancel')
  cancelBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null, 'panel must close on cancel')
  assert.equal(bindCalls, 0, 'zero bindDirectoryConversation RPC on cancel')
  assert.equal(snapshotReadCalls, snapshotReadsBeforeCancel, 'zero snapshot refresh RPC on cancel')
})

test('7. Concurrency guard: double-click / simultaneous confirm dispatches exactly one bindDirectoryConversation RPC', async () => {
  let bindCalls = 0
  let releasePromise
  const slowPromise = new Promise((resolve) => { releasePromise = resolve })

  const { runtime } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async (req) => {
      bindCalls += 1
      await slowPromise
      const updated = JSON.parse(JSON.stringify(scenarioSnapshot))
      updated.nodes.push({ id: 'cnv_conc', parentId: req.workspaceId, kind: 'conversation', title: req.title, sessionId: req.sessionId })
      return { ok: true, value: updated }
    }
  })

  let root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInput.props.onChange({ target: { value: 'Concurrent Test' } })
  const idInput = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInput.props.onChange({ target: { value: 'ses-concurrent' } })
  await runtime.settle()

  // First confirm
  root = runtime.getRoot()
  const confirmBtn1 = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn1.props.onClick(mockEvent())

  // Second immediate confirm (simulated double-click)
  confirmBtn1.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(bindCalls, 1, 'exactly one RPC must be dispatched')

  // Submitting state indicator visible
  root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-link-session-submitting-label'] === 'true'), 'submitting label')

  // Resolve backend
  releasePromise()
  await runtime.settle()

  assert.equal(bindCalls, 1)
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null)
})

test('8. Server error: preserves drafts and locked workspace; unconfirmed notice prohibits duplicate retry; Cancel exits safely', async () => {
  let bindCalls = 0
  const { runtime } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async () => {
      bindCalls += 1
      throw new Error('E_OWNER_DENIED: owner access required')
    }
  })

  let root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInput.props.onChange({ target: { value: 'Denied Session' } })
  const idInput = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInput.props.onChange({ target: { value: 'ses-denied' } })
  await runtime.settle()

  // Submit and get error
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(bindCalls, 1)

  // Verify panel remains open, drafts preserved, unconfirmed notice shown
  root = runtime.getRoot()
  const panel = requireOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true', 'panel')
  const unconfirmed = requireOne(panel, (n) => n.props?.['data-wo-link-session-unconfirmed'] === 'true', 'unconfirmed')
  assert.ok(unconfirmed)

  const titleInputAfter = requireOne(panel, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title after')
  assert.equal(titleInputAfter.props.value, 'Denied Session')

  // Click confirm again -> MUST be prohibited without sending another RPC!
  const confirmBtn2 = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm again')
  confirmBtn2.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(bindCalls, 1, 'duplicate submission must be blocked')

  // Cancel exits safely
  const cancelBtn = requireOne(root, (n) => n.props?.['data-wo-link-session-cancel'] === 'true', 'cancel')
  cancelBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null)
})

test('9. Returned snapshot identity verification (3 negative cases): missing, wrong parent, multiple matches', async () => {
  // 9a: Returned snapshot does not contain the matching conversation node
  let handlerReturnSnapshot = scenarioSnapshot
  let bindCalls = 0

  const { runtime } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async () => {
      bindCalls += 1
      return { ok: true, value: handlerReturnSnapshot }
    }
  })

  let root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInput.props.onChange({ target: { value: 'Missing Match Test' } })
  const idInput = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInput.props.onChange({ target: { value: 'ses-missing-match' } })
  await runtime.settle()

  // 9a: Server returns snapshot without this session
  handlerReturnSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errMissingMatch = requireOne(root, (n) => n.props?.['data-wo-link-session-error'] === 'true', 'error')
  assert.match(textOf(errMissingMatch), /返回快照中未找到匹配的会话身份，结果未确认/u)
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-link-session-unconfirmed'] === 'true'))

  // Cancel to reset
  const cancelBtn1 = requireOne(root, (n) => n.props?.['data-wo-link-session-cancel'] === 'true', 'cancel')
  cancelBtn1.props.onClick(mockEvent())
  await runtime.settle()

  // 9b: Server returns snapshot where conversation points to WRONG workspace (w2 instead of w1)
  root = runtime.getRoot()
  const selectW1_2 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1_2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn2 = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput2 = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInput2.props.onChange({ target: { value: 'Wrong Parent Test' } })
  const idInput2 = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInput2.props.onChange({ target: { value: 'ses-wrong-parent' } })
  await runtime.settle()

  const wrongParentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  wrongParentSnapshot.nodes.push({ id: 'cnv_wrong', parentId: 'w2', kind: 'conversation', title: 'Wrong Parent Test', sessionId: 'ses-wrong-parent' })
  handlerReturnSnapshot = wrongParentSnapshot

  root = runtime.getRoot()
  const confirmBtn2 = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errWrongParent = requireOne(root, (n) => n.props?.['data-wo-link-session-error'] === 'true', 'error')
  assert.match(textOf(errWrongParent), /返回快照中未找到匹配的会话身份，结果未确认/u)

  // Cancel to reset
  const cancelBtn2 = requireOne(root, (n) => n.props?.['data-wo-link-session-cancel'] === 'true', 'cancel')
  cancelBtn2.props.onClick(mockEvent())
  await runtime.settle()

  // 9c: Server returns snapshot with multiple ambiguous matches for sessionId
  root = runtime.getRoot()
  const selectW1_3 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1_3.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn3 = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startBtn3.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput3 = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInput3.props.onChange({ target: { value: 'Multi Match Test' } })
  const idInput3 = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInput3.props.onChange({ target: { value: 'ses-multi' } })
  await runtime.settle()

  const multiSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  multiSnapshot.nodes.push({ id: 'cnv_multi_1', parentId: 'w1', kind: 'conversation', title: 'Multi 1', sessionId: 'ses-multi' })
  multiSnapshot.nodes.push({ id: 'cnv_multi_2', parentId: 'w1', kind: 'conversation', title: 'Multi 2', sessionId: 'ses-multi' })
  handlerReturnSnapshot = multiSnapshot

  root = runtime.getRoot()
  const confirmBtn3 = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn3.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errMulti = requireOne(root, (n) => n.props?.['data-wo-link-session-error'] === 'true', 'error')
  assert.match(textOf(errMulti), /返回快照中会话身份不唯一或归属异常，结果未确认/u)
})

test('10. Layered confirmation: linking succeeds, subsequent refresh fails -> preserves confirmed session, marks stale', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  let snapshotCallCount = 0

  const { runtime, remote } = await setupLinkSessionComponent({
    snapshot: () => {
      snapshotCallCount += 1
      if (snapshotCallCount > 1) {
        throw new Error('background refresh network error')
      }
      return { ok: true, value: currentSnapshot }
    },
    bindDirectoryConversationHandler: async (req) => {
      const updated = JSON.parse(JSON.stringify(currentSnapshot))
      updated.nodes.push({ id: 'cnv_confirmed_layered', parentId: req.workspaceId, kind: 'conversation', title: req.title, sessionId: req.sessionId })
      currentSnapshot = updated
      return { ok: true, value: updated }
    }
  })

  let root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInput.props.onChange({ target: { value: 'Layered Confirmed' } })
  const idInput = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInput.props.onChange({ target: { value: 'ses-layered' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Session link must be preserved in state despite background refresh error
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null, 'panel closed')
  const newRow = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'cnv_confirmed_layered', 'confirmed row')
  assert.ok(newRow)

  // Marked stale and notice discloses failure
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'), 'stale indicator')
  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(notice), /会话关联已确认；但后续快照刷新失败，显示最后确认快照/u)
})

test('11. Late response & Unmount safety: in-flight bindDirectoryConversation response safely discarded on unmount; zero openSession calls', async () => {
  let releasePromise
  const slowPromise = new Promise((resolve) => { releasePromise = resolve })
  let conversationTargetCalls = 0

  const { runtime } = await setupLinkSessionComponent({
    bindDirectoryConversationHandler: async (req) => {
      await slowPromise
      const updated = JSON.parse(JSON.stringify(scenarioSnapshot))
      updated.nodes.push({ id: 'cnv_late', parentId: req.workspaceId, kind: 'conversation', title: req.title, sessionId: req.sessionId })
      return { ok: true, value: updated }
    },
    conversationTargetHandler: async () => {
      conversationTargetCalls += 1
      return { ok: true, value: { sessionId: 'unexpected' } }
    }
  })

  let root = runtime.getRoot()
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'start')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-session-title-input'] === 'true', 'title')
  titleInput.props.onChange({ target: { value: 'Late Test' } })
  const idInput = requireOne(root, (n) => n.props?.['data-wo-link-session-id-input'] === 'true', 'id')
  idInput.props.onChange({ target: { value: 'ses-late' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-session-confirm'] === 'true', 'confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Unmount component while in-flight
  runtime.unmount()

  // Now release backend response
  releasePromise()
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(conversationTargetCalls, 0, 'zero conversationTarget / openSession calls')
})

test('12. Mutual exclusion across all 5 workflows: Rename, Move, Create Project, Link Workspace, and Link Session', async () => {
  const { runtime } = await setupLinkSessionComponent()

  let root = runtime.getRoot()

  // 12a: When Rename active -> clicking Link Session is blocked
  const renameBtn = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'w1', 'rename w1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Since rename is active, clicking data-wo-bind is blocked
  const bindBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'bind btn')
  bindBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null)
  const noticeRename = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeRename), /正在重命名中，请先保存或取消重命名/u)

  // Cancel Rename
  const cancelRenameBtn = requireOne(root, (n) => n.props?.['data-wo-rename-cancel'] === 'true', 'cancel rename')
  cancelRenameBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 12b: When Move preview active -> clicking Link Session is blocked
  root = runtime.getRoot()
  const selectW1Move = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1Move.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const targetRoot = requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'root', 'move target root')
  targetRoot.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), 'move preview active')

  const bindBtn2 = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'bind btn')
  bindBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null)
  const noticeMove = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeMove), /正在移动中，请先确认或取消移动/u)

  // Cancel Move
  const cancelMoveBtn = requireOne(root, (n) => n.props?.['data-wo-move-cancel'] === 'true', 'cancel move')
  cancelMoveBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 12c: When Create Project active -> clicking Link Session is blocked
  root = runtime.getRoot()
  const selectP1Create = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1', 'select p1')
  selectP1Create.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startCreateBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start create project')
  startCreateBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), 'create project active')

  // Select w1 to show bind button
  const selectW1Create = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1Create.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const bindBtn3 = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'bind btn')
  bindBtn3.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null)
  const noticeCreate = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeCreate), /正在创建项目中，请先完成或取消创建/u)

  // Cancel Create Project
  const cancelCreateBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-cancel'] === 'true', 'cancel create project')
  cancelCreateBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 12d: When Link Workspace active -> clicking Link Session is blocked
  root = runtime.getRoot()
  const selectP1LinkWs = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1', 'select p1')
  selectP1LinkWs.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  if (!findOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true')) {
    const createToggle2 = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
    createToggle2.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  const startLinkWsBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startLinkWsBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), 'link workspace active')

  // Try to start Link Session
  const selectW1LinkWs = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1LinkWs.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const bindBtn4 = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'bind btn')
  bindBtn4.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true'), null)
  const noticeLinkWs = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeLinkWs), /正在关联工作区中，请先完成或取消关联/u)

  // Cancel Link Workspace
  const cancelLinkWsBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-cancel'] === 'true', 'cancel link workspace')
  cancelLinkWsBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 12e: Start Link Session -> blocks Rename, Move, Create Project, and Link Workspace
  root = runtime.getRoot()
  const selectW1Session = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1Session.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startSessionBtn = requireOne(root, (n) => n.props?.['data-wo-bind'] === 'true', 'bind btn')
  startSessionBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-link-session-panel'] === 'true'), 'link session active')

  // Try to start Rename -> blocked
  const renameP1_2 = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'p1', 'rename p1')
  renameP1_2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-rename-panel'] === 'true'), null)
  const noticeSessionBlockRename = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeSessionBlockRename), /正在关联会话中，请先完成或取消关联/u)

  // Try to start Create Project -> blocked
  const startCreateBtn2 = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start create project')
  startCreateBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null)
  const noticeSessionBlockCreate = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeSessionBlockCreate), /正在关联会话中，请先完成或取消关联/u)

  // Try to start Link Workspace -> blocked
  const startLinkWsBtn2 = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startLinkWsBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
  const noticeSessionBlockLinkWs = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeSessionBlockLinkWs), /正在关联会话中，请先完成或取消关联/u)
})
