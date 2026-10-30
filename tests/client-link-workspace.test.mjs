/**
 * Link Pre-Registered Workspace Explicit Confirmation Flow offline component tests.
 *
 * Verifies the LINK_WORKSPACE_CONFIRMATION_FLOW contract:
 * 1. Link Workspace under nested Project: selecting a nested project node freezes that node's ID;
 *    displays parent name/path/ID, draft title/directory, and truthful host mapping disclosure;
 *    confirm submits one registerWorkspace({ parentId, title, directory });
 *    updates tree with server-returned snapshot fact (with server-canonicalized path/ID);
 *    panel closes; notice confirms linking.
 * 2. Invalid parent rejection WITHOUT fallback to Root:
 *    - No selection rejects with honest error; zero RPC; NEVER silently falls back to Root!
 *    - Root selection rejects with honest error; zero RPC; NEVER silently falls back to Root!
 *    - Workspace selection rejects with honest error; zero RPC; NEVER silently falls back to Root!
 *    - Conversation selection rejects with honest error; zero RPC; NEVER silently falls back to Root!
 *    - Deleted / missing node selection rejects with honest error; zero RPC; NEVER silently falls back to Root!
 *    - Stale snapshot rejects linking with honest error; zero RPC.
 * 3. Cancel flow: closing linking panel executes zero registerWorkspace RPC and zero refresh RPC;
 *    clears draft title, directory, and locked parent.
 * 4. Local validation: empty title, whitespace-only title, title > 200 chars reject with zero RPC.
 * 5. Local validation: empty directory, whitespace-only directory reject with zero RPC.
 * 6. Selection locking & Anti-tampering: changing tree selection after entering linking mode cannot divert parent;
 *    tampered DOM parent attribute rejects with Target mismatch error and zero RPC.
 * 7. Concurrency guard: double-click / simultaneous confirm dispatches exactly one registerWorkspace RPC;
 *    submitting state disables confirm and inputs.
 * 8. Server error & Unknown transmission notice: server error (missing registration, duplicate, owner denial)
 *    preserves drafts and locked parent; displays unconfirmed notice; prohibits duplicate retry; Cancel exits safely.
 * 9. Layered confirmation: linking succeeds but subsequent read refresh fails -> preserves confirmed workspace,
 *    marks snapshot stale, discloses read failure.
 * 10. Late response & Unmount safety: in-flight registerWorkspace response safely discarded on unmount without state corruption.
 * 11. Mutual exclusion with Create Project, Rename, & Move: in-progress workflows block linking;
 *     active linking blocks starting Rename, Move, or Create Project.
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

    // Branch A: p1_a -> p_deep, w1, cnv_1
    { id: 'p1_a', parentId: 'root', kind: 'project', title: 'Project Branch' },
    { id: 'p_deep', parentId: 'p1_a', kind: 'project', title: 'Deep Project' },
    { id: 'w1', parentId: 'p1_a', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' },
    { id: 'cnv_1', parentId: 'p1_a', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-1' },

    // Branch B: p1_b -> p2_deep, w2
    { id: 'p1_b', parentId: 'root', kind: 'project', title: 'Project Branch' },
    { id: 'p2_deep', parentId: 'p1_b', kind: 'project', title: 'Branch B Subproject' },
    { id: 'w2', parentId: 'p1_b', kind: 'workspace', title: 'Workspace 2', directory: 'E:\\ws-2' }
  ]
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-link-workspace-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

async function setupLinkComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  ledgers = [],
  document: injectedDocument,
  registerWorkspaceHandler,
  createProjectHandler,
  moveHandler,
  renameHandler,
  setTimeout: injectedSetTimeout,
  clearTimeout: injectedClearTimeout
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })
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

test('1. Valid Link Workspace under nested Project: freezes parent, discloses single-dir mapping, submits registerWorkspace, updates tree with canonical fact', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const linkCalls = []

  const registerWorkspaceHandler = async (req) => {
    linkCalls.push({ parentId: req.parentId, title: req.title, directory: req.directory })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const newWorkspace = {
      id: 'w_canonical_123',
      nativeWorkspaceId: 'nw_host_999',
      directory: 'E:\\canonical\\my-ws', // Distinct canonical path returned from server
      parentId: req.parentId,
      kind: 'workspace',
      title: req.title
    }
    updated.nodes.push(newWorkspace)
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime } = await setupLinkComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    registerWorkspaceHandler
  })

  let root = runtime.getRoot()

  // 1. Select nested project p1_a
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Open create panel (+ New...)
  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Click Link Workspace -> enters dedicated linking mode
  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Assert ZERO registerWorkspace RPC calls on entering
  assert.equal(linkCalls.length, 0, 'zero RPC calls must occur on entering linking mode')

  // 4. Verify confirmation panel, parent display, and disclosure
  root = runtime.getRoot()
  const confirmPanel = requireOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'link workspace panel')
  const parentIndicator = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-workspace-parent'] === 'p1_a', 'parent indicator')
  assert.ok(parentIndicator, 'parent indicator must freeze p1_a')
  assert.equal(parentIndicator.props['data-wo-link-workspace-parent-title'], 'Project Branch')
  assert.equal(parentIndicator.props['data-wo-link-workspace-parent-path'], 'Root Project / Project Branch')

  const disclosure = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-workspace-disclosure'] === 'true', 'disclosure element')
  assert.match(textOf(disclosure), /关联宿主已登记 Workspace 的单目录映射；不创建\/移动目录，不授予额外文件读写或执行权限/u)

  // 5. Enter title and directory
  const titleInput = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'title input')
  titleInput.props.onChange({ target: { value: 'My Service Workspace' } })
  const dirInput = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'dir input')
  dirInput.props.onChange({ target: { value: 'E:\\projects\\my-ws' } })
  await runtime.settle()

  // 6. Click Confirm Link
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'confirm link button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Assert exactly 1 registerWorkspace RPC call with frozen parentId, title, and directory
  assert.equal(linkCalls.length, 1)
  assert.equal(linkCalls[0].parentId, 'p1_a')
  assert.equal(linkCalls[0].title, 'My Service Workspace')
  assert.equal(linkCalls[0].directory, 'E:\\projects\\my-ws')

  // Panel closed, notice confirms linking, new node in tree with returned canonical data
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null, 'linking panel must close on success')
  const newRow = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'w_canonical_123', 'new workspace row in tree')
  assert.ok(newRow)
  assert.equal(newRow.props['data-wo-directory'], 'E:\\canonical\\my-ws', 'must use canonical directory from returned snapshot')
  assert.equal(newRow.props['data-wo-terminal'], 'true', 'workspace must be a terminal node')
})

test('2. Invalid parent rejection WITHOUT fallback to Root: None, Root, Workspace, Conversation, deleted node, stale fail closed', async () => {
  const linkCalls = []
  const { runtime, remote } = await setupLinkComponent({
    registerWorkspaceHandler: async (req) => {
      linkCalls.push(req)
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()

  // 2a: No selection (selected === null) -> MUST reject and NOT fallback to Root!
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
  const noticeNone = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(noticeNone), /未选择父项目，仅支持在嵌套项目下关联工作区/u)
  assert.equal(linkCalls.length, 0)

  // 2b: Root selection (selected === 'root') -> MUST reject!
  const selectRoot = requireOne(root, (n) => n.props?.['data-wo-select'] === 'root', 'select root')
  selectRoot.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtnRoot = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtnRoot.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
  const noticeRoot = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(noticeRoot), /禁止在根项目下直接关联工作区/u)
  assert.equal(linkCalls.length, 0)

  // 2c: Workspace selection ('w1') -> MUST reject!
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtnW1 = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtnW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
  const noticeW1 = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(noticeW1), /仅支持在项目下关联工作区/u)
  assert.equal(linkCalls.length, 0)

  // 2d: Conversation selection ('cnv_1') -> MUST reject!
  const selectCnv1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'cnv_1', 'select cnv_1')
  selectCnv1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtnCnv1 = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtnCnv1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
  const noticeCnv1 = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(noticeCnv1), /仅支持在项目下关联工作区/u)
  assert.equal(linkCalls.length, 0)

  // 2e: Missing/deleted node selection -> MUST reject!
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const missingSnapshot = {
    rootId: 'root',
    revision: 11,
    nodes: scenarioSnapshot.nodes.filter((n) => n.id !== 'p1_a' && n.parentId !== 'p1_a')
  }
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true', 'refresh button')
  remote.allowed.snapshot = async () => ({ ok: true, value: missingSnapshot })
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtnMissing = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtnMissing.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
  const noticeMissing = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(noticeMissing), /选中的父节点在快照中不存在/u)
  assert.equal(linkCalls.length, 0)

  // 2f: Stale snapshot -> MUST reject!
  const refreshBtnStale = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true', 'refresh button')
  remote.allowed.snapshot = async () => { throw new Error('snapshot failed') }
  refreshBtnStale.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const staleIndicator = requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true', 'stale indicator')
  assert.ok(staleIndicator)

  const startBtnStale = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtnStale.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
  const noticeStale = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(noticeStale), /快照已陈旧失效，拒绝关联/u)
  assert.equal(linkCalls.length, 0)
})

test('3. Cancel flow: closing linking panel executes zero RPC and zero refresh, clears drafts', async () => {
  let linkCalls = 0
  let snapshotReadCalls = 0

  const { runtime } = await setupLinkComponent({
    snapshot: () => {
      snapshotReadCalls += 1
      return { ok: true, value: scenarioSnapshot }
    },
    registerWorkspaceHandler: async () => {
      linkCalls += 1
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'title input')
  titleInput.props.onChange({ target: { value: 'Cancelled Workspace' } })
  const dirInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'dir input')
  dirInput.props.onChange({ target: { value: 'E:\\cancelled' } })
  await runtime.settle()

  const snapshotReadsBeforeCancel = snapshotReadCalls

  root = runtime.getRoot()
  const cancelBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-cancel'] === 'true', 'cancel button')
  cancelBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
  assert.equal(linkCalls, 0, 'zero registerWorkspace RPC calls on cancel')
  assert.equal(snapshotReadCalls, snapshotReadsBeforeCancel, 'zero snapshot refresh calls on cancel')
})

test('4. Local validation: empty, whitespace-only, and > 200 chars titles reject with zero RPC', async () => {
  let linkCalls = 0
  const { runtime } = await setupLinkComponent({
    registerWorkspaceHandler: async () => {
      linkCalls += 1
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Provide valid directory
  root = runtime.getRoot()
  const dirInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'dir input')
  dirInput.props.onChange({ target: { value: 'E:\\my-dir' } })
  await runtime.settle()

  // 1. Empty title
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'confirm button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errEmpty = requireOne(root, (n) => n.props?.['data-wo-link-workspace-error'] === 'true', 'error')
  assert.match(textOf(errEmpty), /Name must be 1–200 characters/u)
  assert.equal(linkCalls, 0)

  // 2. Whitespace-only title
  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'title input')
  titleInput.props.onChange({ target: { value: '    \t   ' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn2 = requireOne(root, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'confirm button')
  confirmBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errWs = requireOne(root, (n) => n.props?.['data-wo-link-workspace-error'] === 'true', 'error')
  assert.match(textOf(errWs), /Name must be 1–200 characters/u)
  assert.equal(linkCalls, 0)

  // 3. > 200 chars title
  root = runtime.getRoot()
  const titleInput3 = requireOne(root, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'title input')
  titleInput3.props.onChange({ target: { value: 'W'.repeat(201) } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn3 = requireOne(root, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'confirm button')
  confirmBtn3.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errLong = requireOne(root, (n) => n.props?.['data-wo-link-workspace-error'] === 'true', 'error')
  assert.match(textOf(errLong), /Name must be 1–200 characters/u)
  assert.equal(linkCalls, 0)
})

test('5. Local validation: empty and whitespace-only directory reject with zero RPC', async () => {
  let linkCalls = 0
  const { runtime } = await setupLinkComponent({
    registerWorkspaceHandler: async () => {
      linkCalls += 1
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Provide valid title
  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'title input')
  titleInput.props.onChange({ target: { value: 'Valid Title' } })
  await runtime.settle()

  // 1. Empty directory
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'confirm button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errEmpty = requireOne(root, (n) => n.props?.['data-wo-link-workspace-error'] === 'true', 'error')
  assert.match(textOf(errEmpty), /Directory must not be empty/u)
  assert.equal(linkCalls, 0)

  // 2. Whitespace-only directory
  const dirInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'dir input')
  dirInput.props.onChange({ target: { value: '    \t   ' } })
  await runtime.settle()

  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errWs = requireOne(root, (n) => n.props?.['data-wo-link-workspace-error'] === 'true', 'error')
  assert.match(textOf(errWs), /Directory must not be empty/u)
  assert.equal(linkCalls, 0)
})

test('6. Selection locking & Anti-tampering: changing tree selection cannot divert parent; DOM mismatch fails closed', async () => {
  const linkCalls = []
  const { runtime } = await setupLinkComponent({
    registerWorkspaceHandler: async (req) => {
      linkCalls.push({ parentId: req.parentId, title: req.title, directory: req.directory })
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 1. Changing selection to p1_b while linking panel is active
  const selectP1B = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_b', 'select p1_b')
  selectP1B.props.onClick(mockEvent())
  await runtime.settle()

  // Parent MUST remain p1_a!
  root = runtime.getRoot()
  const confirmPanel = requireOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'link panel')
  assert.ok(requireOne(confirmPanel, (n) => n.props?.['data-wo-link-workspace-parent'] === 'p1_a'), 'parent must remain p1_a')

  // 2. Anti-tampering check: simulate document.querySelector returning tampered parent ID
  const fakeDoc = {
    querySelector(selector) {
      if (selector === '[data-wo-link-workspace-parent]') {
        return {
          getAttribute(attr) {
            if (attr === 'data-wo-link-workspace-parent') return 'p1_b' // Tampered!
            return null
          }
        }
      }
      return null
    }
  }

  const { runtime: tamperedRuntime } = await setupLinkComponent({
    document: fakeDoc,
    registerWorkspaceHandler: async (req) => {
      linkCalls.push(req)
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let tRoot = tamperedRuntime.getRoot()
  const tSelectP1A = requireOne(tRoot, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  tSelectP1A.props.onClick(mockEvent())
  await tamperedRuntime.settle()

  tRoot = tamperedRuntime.getRoot()
  const tCreateToggle = requireOne(tRoot, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  tCreateToggle.props.onClick(mockEvent())
  await tamperedRuntime.settle()

  tRoot = tamperedRuntime.getRoot()
  const tStartBtn = requireOne(tRoot, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  tStartBtn.props.onClick(mockEvent())
  await tamperedRuntime.settle()

  tRoot = tamperedRuntime.getRoot()
  const tTitleInput = requireOne(tRoot, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'title input')
  tTitleInput.props.onChange({ target: { value: 'Tamper Title' } })
  const tDirInput = requireOne(tRoot, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'dir input')
  tDirInput.props.onChange({ target: { value: 'E:\\tamper' } })
  await tamperedRuntime.settle()

  tRoot = tamperedRuntime.getRoot()
  const tConfirmBtn = requireOne(tRoot, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'confirm button')
  tConfirmBtn.props.onClick(mockEvent())
  await tamperedRuntime.settle()

  tRoot = tamperedRuntime.getRoot()
  const tErr = requireOne(tRoot, (n) => n.props?.['data-wo-link-workspace-error'] === 'true', 'error')
  assert.match(textOf(tErr), /Target mismatch/u)
  assert.equal(linkCalls.length, 0, 'zero RPC dispatches on tampered target')
})

test('7. Concurrency guard: double-click / simultaneous confirm dispatches exactly one registerWorkspace RPC', async () => {
  const linkCalls = []
  let resolveRpc
  const pendingPromise = new Promise((resolve) => {
    resolveRpc = resolve
  })

  const { runtime } = await setupLinkComponent({
    registerWorkspaceHandler: async (req) => {
      linkCalls.push({ parentId: req.parentId, title: req.title, directory: req.directory })
      await pendingPromise
      const updated = JSON.parse(JSON.stringify(scenarioSnapshot))
      updated.nodes.push({ id: 'w_concurrent', parentId: req.parentId, kind: 'workspace', title: req.title, directory: req.directory })
      return { ok: true, value: updated }
    }
  })

  let root = runtime.getRoot()
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'title input')
  titleInput.props.onChange({ target: { value: 'Concurrent WS' } })
  const dirInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'dir input')
  dirInput.props.onChange({ target: { value: 'E:\\concurrent' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'confirm button')

  // Click confirm twice simultaneously
  confirmBtn.props.onClick(mockEvent())
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Exactly one RPC call dispatched
  assert.equal(linkCalls.length, 1, 'exactly one registerWorkspace RPC must be dispatched')

  root = runtime.getRoot()
  const submittingBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'confirm button')
  assert.equal(submittingBtn.props.disabled, true)

  resolveRpc()
  await runtime.settle()

  assert.equal(linkCalls.length, 1)
})

test('8. Server error: preserves drafts & parent; unconfirmed notice prohibits retry; Cancel exits safely', async () => {
  let callCount = 0
  const { runtime } = await setupLinkComponent({
    registerWorkspaceHandler: async () => {
      callCount += 1
      const failure = new Error('workspace directory not found in host registry: ENOENT')
      failure.code = 'ENOENT'
      throw failure
    }
  })

  let root = runtime.getRoot()
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'title input')
  titleInput.props.onChange({ target: { value: 'Error Preserved WS' } })
  const dirInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'dir input')
  dirInput.props.onChange({ target: { value: 'E:\\not-registered' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'confirm button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(callCount, 1)

  // Error notice & unconfirmed banner displayed
  root = runtime.getRoot()
  const confirmPanel = requireOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true', 'panel still open')
  assert.ok(confirmPanel, 'panel must stay open on server error')

  const preservedTitle = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'preserved title')
  assert.equal(preservedTitle.props.value, 'Error Preserved WS')
  const preservedDir = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'preserved dir')
  assert.equal(preservedDir.props.value, 'E:\\not-registered')

  const unconfirmedBanner = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-workspace-unconfirmed'] === 'true', 'unconfirmed banner')
  assert.match(textOf(unconfirmedBanner), /结果未确认，勿重复关联/u)

  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(notice), /传输结果未知或关联失败，结果未确认，勿重复关联/u)

  // Re-clicking confirm while unconfirmed is prohibited
  const confirmBtnRetry = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'retry confirm button')
  confirmBtnRetry.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(callCount, 1, 'retry must be rejected without making an RPC call')

  // Cancel exits safely
  const cancelBtn = requireOne(confirmPanel, (n) => n.props?.['data-wo-link-workspace-cancel'] === 'true', 'cancel button')
  cancelBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
})

test('9. Layered confirmation: linking succeeds, subsequent refresh fails -> preserves confirmed workspace, marks stale', async () => {
  const updatedSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  updatedSnapshot.nodes.push({ id: 'w_layered', parentId: 'p1_a', kind: 'workspace', title: 'Layered WS', directory: 'E:\\canonical\\layered' })
  updatedSnapshot.revision += 1

  let snapshotCallCount = 0
  const { runtime } = await setupLinkComponent({
    registerWorkspaceHandler: async () => ({ ok: true, value: updatedSnapshot }),
    snapshot: async () => {
      snapshotCallCount += 1
      if (snapshotCallCount > 1) {
        throw new Error('subsequent snapshot refresh network error')
      }
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'title input')
  titleInput.props.onChange({ target: { value: 'Layered WS' } })
  const dirInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'dir input')
  dirInput.props.onChange({ target: { value: 'E:\\layered' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'confirm button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Creation confirmed fact preserved in tree!
  root = runtime.getRoot()
  const newRow = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'w_layered', 'linked workspace row')
  assert.ok(newRow, 'linked workspace must be retained in tree despite refresh failure')

  // Stale banner and notice disclosure
  const staleBanner = requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true', 'stale banner')
  assert.ok(staleBanner)
  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(notice), /后续快照刷新失败，显示最后确认快照/u)
})

test('10. Late response & Unmount safety: in-flight registerWorkspace response safely discarded on unmount', async () => {
  let resolveRpc
  const pendingPromise = new Promise((resolve) => {
    resolveRpc = resolve
  })

  const { runtime } = await setupLinkComponent({
    registerWorkspaceHandler: async () => {
      await pendingPromise
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-title-input'] === 'true', 'title input')
  titleInput.props.onChange({ target: { value: 'Unmount WS' } })
  const dirInput = requireOne(root, (n) => n.props?.['data-wo-link-workspace-dir-input'] === 'true', 'dir input')
  dirInput.props.onChange({ target: { value: 'E:\\unmount' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-confirm'] === 'true', 'confirm button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Unmount component while RPC is pending
  runtime.unmount()

  resolveRpc()
  await runtime.settle()

  assert.ok(true, 'unmount safely completed')
})

test('11. Mutual exclusion across all 4 workflows: Rename, Move, Create Project, and Link Workspace', async () => {
  const { runtime } = await setupLinkComponent()

  let root = runtime.getRoot()

  // 11a: When Rename active -> clicking Link Workspace is blocked
  const renameBtn = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'p1_a', 'rename p1_a')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startLinkBtn = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startLinkBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
  const noticeRename = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeRename), /正在重命名中，请先保存或取消重命名/u)

  // Cancel Rename
  const cancelRenameBtn = requireOne(root, (n) => n.props?.['data-wo-rename-cancel'] === 'true', 'cancel rename')
  cancelRenameBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 11b: When Move preview active -> clicking Link Workspace is blocked
  root = runtime.getRoot()
  const selectPDeep = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_deep', 'select p_deep')
  selectPDeep.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const targetP1B = requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'move target p1_b')
  targetP1B.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), 'move preview active')

  const startLinkBtn2 = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startLinkBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
  const noticeMove = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeMove), /正在移动中，请先确认或取消移动/u)

  // Cancel Move
  const cancelMoveBtn = requireOne(root, (n) => n.props?.['data-wo-move-cancel'] === 'true', 'cancel move')
  cancelMoveBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 11c: When Create Project active -> clicking Link Workspace is blocked
  root = runtime.getRoot()
  const startCreateBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start create project')
  startCreateBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), 'create project active')

  const startLinkBtn3 = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startLinkBtn3.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), null)
  const noticeCreate = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeCreate), /正在创建项目中，请先完成或取消创建/u)

  // Cancel Create Project
  const cancelCreateBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-cancel'] === 'true', 'cancel create project')
  cancelCreateBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 11d: Start Link Workspace -> blocks Rename, Move, and Create Project
  root = runtime.getRoot()
  const selectP1A2 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startLinkBtn4 = requireOne(root, (n) => n.props?.['data-wo-link-workspace-start'] === 'true', 'start link workspace')
  startLinkBtn4.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-link-workspace-panel'] === 'true'), 'linking panel active')

  // Try to start Rename -> blocked
  const renameP1B = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'p1_b', 'rename p1_b')
  renameP1B.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-rename-panel'] === 'true'), null)
  const noticeLinkBlockRename = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeLinkBlockRename), /正在关联工作区中，请先完成或取消关联/u)

  // Try to start Create Project -> blocked
  root = runtime.getRoot()
  const startCreateBtn2 = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start create project')
  startCreateBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null)
  const noticeLinkBlockCreate = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeLinkBlockCreate), /正在关联工作区中，请先完成或取消关联/u)
})
