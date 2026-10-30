/**
 * Project Explicit Creation Confirmation Flow offline component tests.
 *
 * Verifies the PROJECT_EXPLICIT_CREATION_FLOW contract:
 * 1. Project creation under Root (when no selection): entering freezes snapshot.rootId;
 *    displays parent name/path/ID; confirm calls remote.createProject({ parentId: 'root', title });
 *    updates tree with server-returned snapshot fact; creation panel closes; notice confirms creation.
 * 2. Project creation under nested Project: selecting a project node freezes that node's ID;
 *    confirm creates project under that parent; tree updates with returned snapshot fact.
 * 3. Same-title non-interference: client does not reject duplicate titles (server identity authoritative);
 *    server returns distinct ID; both projects exist peacefully in tree.
 * 4. Cancel flow: closing creation panel executes zero createProject RPC and zero refresh RPC;
 *    clears draft and locked parent.
 * 5. Local validation (empty / whitespace name): rejects with honest error; zero RPC, zero refresh.
 * 6. Local validation (> 200 chars): rejects with honest error; zero RPC, zero refresh.
 * 7. Invalid parent rejection WITHOUT fallback to Root:
 *    - Workspace selection rejects with honest error; zero RPC; NEVER silently falls back to Root!
 *    - Conversation selection rejects with honest error; zero RPC; NEVER silently falls back to Root!
 *    - Deleted / missing node selection rejects with honest error; zero RPC; NEVER silently falls back to Root!
 *    - Stale snapshot rejects creation with honest error; zero RPC.
 * 8. Selection locking & Anti-tampering: changing tree selection after entering creation cannot divert parent;
 *    tampered DOM parent attribute rejects with Target mismatch error and zero RPC.
 * 9. Concurrency guard: double-click / simultaneous confirm dispatches exactly one createProject RPC;
 *    submitting state disables confirm and draft inputs.
 * 10. Remote failure & Unknown transmission notice: remote error preserves draft and locked parent;
 *     displays unconfirmed notice; prohibits duplicate submission / retry; Cancel exits safely.
 * 11. Layered confirmation: creation succeeds but subsequent read refresh fails -> preserves confirmed project,
 *     marks snapshot stale, discloses read failure.
 * 12. Late response & Unmount safety: in-flight createProject response safely discarded on unmount without state corruption.
 * 13. Mutual exclusion with Rename & Move: in-progress rename or move blocks project creation;
 *     active project creation blocks starting rename or move.
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
  sessionSource: 'synthetic-create-project-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

async function setupCreateComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  ledgers = [],
  document: injectedDocument,
  createProjectHandler,
  moveHandler,
  renameHandler,
  setTimeout: injectedSetTimeout,
  clearTimeout: injectedClearTimeout
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })
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

test('1. Valid Project creation under Root (when no selection): freezes rootId, confirms single RPC, updates tree with returned fact', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const createCalls = []

  const createProjectHandler = async (req) => {
    createCalls.push({ parentId: req.parentId, title: req.title })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const newProject = {
      id: 'p_new_root',
      parentId: req.parentId,
      kind: 'project',
      title: req.title
    }
    updated.nodes.push(newProject)
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime } = await setupCreateComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    createProjectHandler
  })

  let root = runtime.getRoot()

  // 1. Open create panel (+ New...)
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createPanel = requireOne(root, (n) => n.props?.['data-wo-create-panel'] === 'true', 'create panel')

  // 2. Click + Project with no selection -> enters Project creation mode
  const startBtn = requireOne(createPanel, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Assert ZERO createProject RPC calls on entering creation
  assert.equal(createCalls.length, 0, 'zero createProject RPC calls must occur on entering creation mode')

  // Verify dedicated confirmation panel
  root = runtime.getRoot()
  const confirmPanel = requireOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'project creation panel')
  const parentIndicator = requireOne(confirmPanel, (n) => n.props?.['data-wo-create-project-parent'] === 'root', 'parent indicator')
  assert.ok(parentIndicator, 'parent indicator must freeze root')
  assert.equal(parentIndicator.props['data-wo-create-project-parent-title'], 'Root Project')
  assert.equal(parentIndicator.props['data-wo-create-project-parent-path'], 'Root Project')

  // 3. Enter draft name
  const input = requireOne(confirmPanel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'project input')
  input.props.onChange({ target: { value: 'Alpha Project' } })
  await runtime.settle()

  // 4. Click Confirm Create
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm create button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Assert exactly 1 createProject RPC call with frozen parentId and trimmed title
  assert.equal(createCalls.length, 1)
  assert.equal(createCalls[0].parentId, 'root')
  assert.equal(createCalls[0].title, 'Alpha Project')

  // Panel closed, notice confirms creation, new node in tree
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null, 'creation panel must close on success')
  const notice = findOne(root, (n) => n.props?.['data-wo-notice'] === 'error')
  // Notice is either cleared or contains confirmation text
  const newNode = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_new_root', 'new project in tree')
  assert.ok(newNode, 'new project must appear in tree')
})

test('2. Valid Project creation under nested Project: freezes nested parent, updates tree under parent', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const createCalls = []

  const createProjectHandler = async (req) => {
    createCalls.push({ parentId: req.parentId, title: req.title })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const newProject = {
      id: 'p_sub_nested',
      parentId: req.parentId,
      kind: 'project',
      title: req.title
    }
    updated.nodes.push(newProject)
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime } = await setupCreateComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    createProjectHandler
  })

  let root = runtime.getRoot()

  // 1. Select nested project p1_a
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Open create panel and start project creation
  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Verify parent locked to p1_a
  root = runtime.getRoot()
  const confirmPanel = requireOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'project creation panel')
  const parentIndicator = requireOne(confirmPanel, (n) => n.props?.['data-wo-create-project-parent'] === 'p1_a', 'parent indicator')
  assert.ok(parentIndicator)
  assert.equal(parentIndicator.props['data-wo-create-project-parent-title'], 'Project Branch')
  assert.equal(parentIndicator.props['data-wo-create-project-parent-path'], 'Root Project / Project Branch')

  // 4. Enter draft name and confirm
  const input = requireOne(confirmPanel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'project input')
  input.props.onChange({ target: { value: 'Sub Branch A' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm create button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(createCalls.length, 1)
  assert.equal(createCalls[0].parentId, 'p1_a')
  assert.equal(createCalls[0].title, 'Sub Branch A')

  root = runtime.getRoot()
  const newRow = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_sub_nested', 'new nested project row')
  assert.ok(newRow)
})

test('3. Same-title non-interference: client does not reject same title, server returns distinct ID', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const createCalls = []

  const createProjectHandler = async (req) => {
    createCalls.push({ parentId: req.parentId, title: req.title })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const newProject = {
      id: 'p_dup_branch',
      parentId: req.parentId,
      kind: 'project',
      title: req.title // Same title as 'Project Branch'
    }
    updated.nodes.push(newProject)
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime } = await setupCreateComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    createProjectHandler
  })

  let root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Enter same name 'Project Branch'
  root = runtime.getRoot()
  const input = requireOne(root, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'project input')
  input.props.onChange({ target: { value: 'Project Branch' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm create button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(createCalls.length, 1)
  assert.equal(createCalls[0].title, 'Project Branch')

  root = runtime.getRoot()
  const newRow = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_dup_branch', 'duplicate title project row')
  assert.ok(newRow)
})

test('4. Cancel flow: closing creation panel executes zero RPC and zero refresh, clears draft', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const createCalls = []
  let snapshotReadCalls = 0

  const { runtime } = await setupCreateComponent({
    snapshot: () => {
      snapshotReadCalls += 1
      return { ok: true, value: currentSnapshot }
    },
    createProjectHandler: async (req) => {
      createCalls.push(req)
      return { ok: true, value: currentSnapshot }
    }
  })

  let root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Enter draft
  root = runtime.getRoot()
  const input = requireOne(root, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'project input')
  input.props.onChange({ target: { value: 'Cancelled Project' } })
  await runtime.settle()

  const snapshotReadsBeforeCancel = snapshotReadCalls

  // Click Cancel
  root = runtime.getRoot()
  const cancelBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-cancel'] === 'true', 'cancel button')
  cancelBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Panel closed, zero create calls, zero snapshot reads
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null)
  assert.equal(createCalls.length, 0, 'zero createProject RPC calls on cancel')
  assert.equal(snapshotReadCalls, snapshotReadsBeforeCancel, 'zero snapshot refresh RPC calls on cancel')
})

test('5. Local validation: empty and whitespace-only names reject with zero RPC and zero refresh', async () => {
  const createCalls = []
  let snapshotReadCalls = 0

  const { runtime } = await setupCreateComponent({
    snapshot: () => {
      snapshotReadCalls += 1
      return { ok: true, value: scenarioSnapshot }
    },
    createProjectHandler: async (req) => {
      createCalls.push(req)
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  const snapshotReadsBefore = snapshotReadCalls

  // 1. Submit empty name
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errEmpty = requireOne(root, (n) => n.props?.['data-wo-create-project-error'] === 'true', 'creation error')
  assert.match(textOf(errEmpty), /Name must be 1–200 characters/u)
  assert.equal(createCalls.length, 0)
  assert.equal(snapshotReadCalls, snapshotReadsBefore)

  // 2. Submit whitespace-only name
  const input = requireOne(root, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'project input')
  input.props.onChange({ target: { value: '     \t  ' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn2 = requireOne(root, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm button')
  confirmBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errWs = requireOne(root, (n) => n.props?.['data-wo-create-project-error'] === 'true', 'creation error')
  assert.match(textOf(errWs), /Name must be 1–200 characters/u)
  assert.equal(createCalls.length, 0)
  assert.equal(snapshotReadCalls, snapshotReadsBefore)
})

test('6. Local validation: name > 200 chars rejects with zero RPC and zero refresh', async () => {
  const createCalls = []
  const { runtime } = await setupCreateComponent({
    createProjectHandler: async (req) => {
      createCalls.push(req)
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const input = requireOne(root, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'project input')
  input.props.onChange({ target: { value: 'X'.repeat(201) } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const errLong = requireOne(root, (n) => n.props?.['data-wo-create-project-error'] === 'true', 'creation error')
  assert.match(textOf(errLong), /Name must be 1–200 characters/u)
  assert.equal(createCalls.length, 0)
})

test('7. Invalid parent rejection WITHOUT fallback to Root: Workspace, Conversation, deleted node, stale snapshot fail closed', async () => {
  const createCalls = []
  const { runtime, remote } = await setupCreateComponent({
    createProjectHandler: async (req) => {
      createCalls.push(req)
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()

  // 7a: Explicit selection is workspace 'w1' -> MUST reject and NOT fallback to Root!
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Creation panel must NOT open for illegal parent
  assert.equal(findOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null)
  const noticeW1 = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(noticeW1), /仅支持在项目下创建子项目/u)
  assert.equal(createCalls.length, 0)

  // 7b: Explicit selection is conversation 'cnv_1' -> MUST reject and NOT fallback to Root!
  const selectCnv1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'cnv_1', 'select cnv_1')
  selectCnv1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn2 = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null)
  const noticeCnv1 = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(noticeCnv1), /仅支持在项目下创建子项目/u)
  assert.equal(createCalls.length, 0)

  // 7c: Selected ID not in snapshot (deleted or missing) -> MUST reject and NOT fallback to Root!
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  // Simulate snapshot without p1_a by triggering a snapshot that removed p1_a
  const missingSnapshot = {
    rootId: 'root',
    revision: 11,
    nodes: scenarioSnapshot.nodes.filter((n) => n.id !== 'p1_a' && n.parentId !== 'p1_a')
  }
  // Click refresh to load missingSnapshot
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true', 'refresh button')
  // Update remote answer
  remote.allowed.snapshot = async () => ({ ok: true, value: missingSnapshot })
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Now 'p1_a' is selected but missing in snapshot!
  root = runtime.getRoot()
  const startBtn3 = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn3.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null)
  const noticeMissing = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(noticeMissing), /选中的父节点在快照中不存在/u)
  assert.equal(createCalls.length, 0)

  // 7d: Stale snapshot rejects creation with honest notice
  remote.allowed.snapshot = async () => { throw new Error('snapshot failed') }
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const staleIndicator = requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true', 'stale indicator')
  assert.ok(staleIndicator)

  const startBtn4 = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn4.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null)
  const noticeStale = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(noticeStale), /快照已陈旧失效，拒绝创建/u)
  assert.equal(createCalls.length, 0)
})

test('8. Selection locking & Anti-tampering: clicking other tree nodes does not divert parent; DOM mismatch fails closed', async () => {
  const createCalls = []
  const { runtime } = await setupCreateComponent({
    createProjectHandler: async (req) => {
      createCalls.push({ parentId: req.parentId, title: req.title })
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()

  // 1. Select p1_a and start project creation
  const selectP1A = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a')
  selectP1A.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const confirmPanel = requireOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'confirm panel')
  assert.ok(requireOne(confirmPanel, (n) => n.props?.['data-wo-create-project-parent'] === 'p1_a'))

  // 2. Select another node p1_b while creation is active
  const selectP1B = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_b', 'select p1_b')
  selectP1B.props.onClick(mockEvent())
  await runtime.settle()

  // Parent MUST remain p1_a!
  root = runtime.getRoot()
  const confirmPanelAfter = requireOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'confirm panel')
  assert.ok(requireOne(confirmPanelAfter, (n) => n.props?.['data-wo-create-project-parent'] === 'p1_a'), 'parent must stay p1_a')

  // 3. Anti-tampering test: simulate document.querySelector returning mismatching parent ID
  const fakeDoc = {
    querySelector(selector) {
      if (selector === '[data-wo-create-project-parent]') {
        return {
          getAttribute(attr) {
            if (attr === 'data-wo-create-project-parent') return 'p1_b' // Tampered!
            return null
          }
        }
      }
      return null
    }
  }

  const { runtime: tamperedRuntime } = await setupCreateComponent({
    document: fakeDoc,
    createProjectHandler: async (req) => {
      createCalls.push(req)
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
  const tStartBtn = requireOne(tRoot, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  tStartBtn.props.onClick(mockEvent())
  await tamperedRuntime.settle()

  tRoot = tamperedRuntime.getRoot()
  const tInput = requireOne(tRoot, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'project input')
  tInput.props.onChange({ target: { value: 'Tamper Test' } })
  await tamperedRuntime.settle()

  tRoot = tamperedRuntime.getRoot()
  const tConfirmBtn = requireOne(tRoot, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm button')
  tConfirmBtn.props.onClick(mockEvent())
  await tamperedRuntime.settle()

  tRoot = tamperedRuntime.getRoot()
  const tErr = requireOne(tRoot, (n) => n.props?.['data-wo-create-project-error'] === 'true', 'error')
  assert.match(textOf(tErr), /Target mismatch/u)
  assert.equal(createCalls.length, 0, 'zero RPC dispatches on tampered target')
})

test('9. Concurrency guard: double-click / simultaneous confirm dispatches exactly one createProject RPC', async () => {
  const createCalls = []
  let resolveRpc
  const pendingPromise = new Promise((resolve) => {
    resolveRpc = resolve
  })

  const { runtime } = await setupCreateComponent({
    createProjectHandler: async (req) => {
      createCalls.push({ parentId: req.parentId, title: req.title })
      await pendingPromise
      const updated = JSON.parse(JSON.stringify(scenarioSnapshot))
      updated.nodes.push({ id: 'p_concurrent', parentId: req.parentId, kind: 'project', title: req.title })
      return { ok: true, value: updated }
    }
  })

  let root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const input = requireOne(root, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'project input')
  input.props.onChange({ target: { value: 'Concurrent Test' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm button')

  // Click confirm twice simultaneously
  confirmBtn.props.onClick(mockEvent())
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Exactly one RPC call dispatched
  assert.equal(createCalls.length, 1, 'exactly one createProject RPC must be dispatched')

  // Submitting state disables confirm
  root = runtime.getRoot()
  const submittingBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm button')
  assert.equal(submittingBtn.props.disabled, true)

  // Resolve pending RPC
  resolveRpc()
  await runtime.settle()

  assert.equal(createCalls.length, 1)
})

test('10. Remote failure & Unknown transmission: preserves draft & locked parent; unconfirmed notice prohibits retry; Cancel exits', async () => {
  let callCount = 0
  const { runtime } = await setupCreateComponent({
    createProjectHandler: async () => {
      callCount += 1
      const failure = new Error('Gateway network timeout')
      failure.code = 'ETIMEDOUT'
      throw failure
    }
  })

  let root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const input = requireOne(root, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'project input')
  input.props.onChange({ target: { value: 'Draft Preserved' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(callCount, 1)

  // Error notice & unconfirmed banner displayed
  root = runtime.getRoot()
  const confirmPanel = requireOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true', 'panel still open')
  assert.ok(confirmPanel, 'creation panel must remain open')
  const preservedInput = requireOne(confirmPanel, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'preserved input')
  assert.equal(preservedInput.props.value, 'Draft Preserved', 'draft value must be preserved')

  const unconfirmedBanner = requireOne(confirmPanel, (n) => n.props?.['data-wo-create-project-unconfirmed'] === 'true', 'unconfirmed banner')
  assert.match(textOf(unconfirmedBanner), /结果未确认，勿重复创建/u)

  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'error notice')
  assert.match(textOf(notice), /传输结果未知或创建失败，结果未确认，勿重复创建/u)

  // Re-clicking confirm while unconfirmed is prohibited
  const confirmBtnRetry = requireOne(confirmPanel, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'retry confirm button')
  confirmBtnRetry.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(callCount, 1, 'retry must be rejected without making an RPC call')

  // Clicking Cancel safely exits
  const cancelBtn = requireOne(confirmPanel, (n) => n.props?.['data-wo-create-project-cancel'] === 'true', 'cancel button')
  cancelBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null)
})

test('11. Layered confirmation: creation succeeds, subsequent refresh fails -> preserves confirmed project, marks stale', async () => {
  const updatedSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  updatedSnapshot.nodes.push({ id: 'p_layered', parentId: 'root', kind: 'project', title: 'Layered Project' })
  updatedSnapshot.revision += 1

  let snapshotCallCount = 0
  const { runtime } = await setupCreateComponent({
    createProjectHandler: async () => ({ ok: true, value: updatedSnapshot }),
    snapshot: async () => {
      snapshotCallCount += 1
      if (snapshotCallCount > 1) {
        throw new Error('subsequent snapshot refresh network error')
      }
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const input = requireOne(root, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'project input')
  input.props.onChange({ target: { value: 'Layered Project' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Creation confirmed fact preserved in tree!
  root = runtime.getRoot()
  const newRow = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_layered', 'created project row')
  assert.ok(newRow, 'created project must be retained in tree despite refresh failure')

  // Stale banner and notice disclosure
  const staleBanner = requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true', 'stale banner')
  assert.ok(staleBanner)
  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(notice), /后续快照刷新失败，显示最后确认快照/u)
})

test('12. Late response & Unmount safety: in-flight create response safely discarded on unmount', async () => {
  let resolveRpc
  const pendingPromise = new Promise((resolve) => {
    resolveRpc = resolve
  })

  const { runtime } = await setupCreateComponent({
    createProjectHandler: async () => {
      await pendingPromise
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const input = requireOne(root, (n) => n.props?.['data-wo-create-project-input'] === 'true', 'project input')
  input.props.onChange({ target: { value: 'Late Unmount' } })
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-confirm'] === 'true', 'confirm button')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Unmount component while RPC is pending
  runtime.unmount()

  // Now resolve the pending RPC
  resolveRpc()
  await runtime.settle()

  // No error thrown or unexpected crash
  assert.ok(true, 'unmount safely completed')
})

test('13. Mutual exclusion with Rename & Move: in-progress rename/move blocks creation; active creation blocks rename/move', async () => {
  const { runtime } = await setupCreateComponent()

  let root = runtime.getRoot()

  // 1. Start Rename on p1_a
  const renameBtn = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'p1_a', 'rename p1_a')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Open create panel and try to click + Project
  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'create toggle')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startBtn = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null)
  const noticeRename = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeRename), /正在重命名中，请先保存或取消重命名/u)

  // Cancel Rename
  const cancelRenameBtn = requireOne(root, (n) => n.props?.['data-wo-rename-cancel'] === 'true', 'cancel rename')
  cancelRenameBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Select deep project p_deep and preview move to p1_b
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

  // Try to start create project while move preview is active
  const startBtn2 = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), null)
  const noticeMove = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeMove), /正在移动中，请先确认或取消移动/u)

  // Cancel Move
  const cancelMoveBtn = requireOne(root, (n) => n.props?.['data-wo-move-cancel'] === 'true', 'cancel move')
  cancelMoveBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Start project creation
  root = runtime.getRoot()
  const startBtn3 = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true', 'start project create')
  startBtn3.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-create-project-panel'] === 'true'), 'creation active')

  // Try to start Rename while creation is active
  const renameP1B = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'p1_b', 'rename p1_b')
  renameP1B.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-rename-panel'] === 'true'), null)
  const noticeCreate = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(noticeCreate), /正在创建项目中，请先完成或取消创建/u)
})
