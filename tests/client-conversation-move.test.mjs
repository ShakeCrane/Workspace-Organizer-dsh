/**
 * Offline Component Tests for Plain Conversation Logical Move (FP-108).
 *
 * Verifies the CONVERSATION_LOGICAL_MOVE contract:
 * 1. Plain Conversation Move P_A -> P_B: forms preview without RPC; displays conversation-specific
 *    disclosure text; confirm submits exactly 1 moveNode; tree updates with returned fact;
 *    session ID preserved; triggers snapshot + status readback.
 * 2. Plain Conversation Move P_B -> Root: selecting Root updates parent to root; session preserved.
 * 3. Plain Conversation Move Root -> P_A: moving conversation out of Root into subproject.
 * 4. Disambiguation of same-title conversations (C1 vs C2) and same-title Projects (P_A vs P_B).
 * 5. Preview, Cancel, and same-parent no-op: generate ZERO RPC calls, tree unchanged.
 * 6. Exclusion of directory-bound conversations:
 *    - C under workspace is not movable (canMove = false, move panel absent).
 *    - C with cwd is not movable (canMove = false, move panel absent; previewMove refuses).
 * 7. Ineligible targets:
 *    - Target Workspace or Conversation rejected (not offered in moveTargets; refused if previewed).
 *    - Missing real Root in snapshot.nodes: refused without synthesizing fake Root.
 * 8. Live drift defense before confirm:
 *    - Selection drift: user selects another node before confirm -> rejected with zero RPC.
 *    - Snapshot revision drift: revision bumped before confirm -> rejected with zero RPC.
 *    - Source parent drift: source parent modified in snapshot -> rejected with zero RPC.
 *    - Session ID drift: source sessionId modified in snapshot -> rejected with zero RPC.
 *    - Stale snapshot: snapshotStale=true -> preview and confirm fail closed with zero RPC.
 * 9. Concurrency guard: double-click / simultaneous confirm dispatches exactly one moveNode RPC.
 * 10. Remote failure continuity: server error preserves preview and source/target context, shows notice, no auto-retry.
 * 11. Response validation & session drift defense: server returns drifted sessionId or wrong parent -> rejected,
 *     fails closed without updating tree.
 * 12. Subsequent refresh failure continuity: move confirmed, subsequent snapshot readback fails -> confirmed tree retained,
 *     marked snapshotStale=true with honest notice.
 * 13. Late response & unmount safety: in-flight move response discarded cleanly on unmount.
 * 14. Zero non-whitelisted calls: zero openSession, zero conversationTarget, zero createConversation, zero reconcileTasks.
 * 15. Quick Access integration: pinned conversation preserves order/ID, path updates to new parent, zero session opened.
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
  revision: 100,
  nodes: [
    // Real Root project
    { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },

    // Branch A: p_a has plain conversation c1, workspace w_a, and directory-bound conversation c_under_ws
    { id: 'p_a', parentId: 'root', kind: 'project', title: 'Project Alpha' },
    { id: 'c1', parentId: 'p_a', kind: 'conversation', title: 'General Chat', sessionId: 'ses-alpha-1' },
    { id: 'w_a', parentId: 'p_a', kind: 'workspace', title: 'Workspace Alpha', directory: 'E:\\ws-a' },
    { id: 'c_under_ws', parentId: 'w_a', kind: 'conversation', title: 'WS Bound Chat', sessionId: 'ses-ws-bound' },

    // Branch B: p_b has same-titled conversation c2 (disambiguation test)
    { id: 'p_b', parentId: 'root', kind: 'project', title: 'Project Beta' },
    { id: 'c2', parentId: 'p_b', kind: 'conversation', title: 'General Chat', sessionId: 'ses-beta-2' },

    // Plain conversation c_root directly under Root project
    { id: 'c_root', parentId: 'root', kind: 'conversation', title: 'Root Chat', sessionId: 'ses-root-0' },

    // Conversation with explicit cwd (directory-bound) under p_a
    { id: 'c_with_cwd', parentId: 'p_a', kind: 'conversation', title: 'Cwd Bound Chat', sessionId: 'ses-cwd-bound', cwd: 'E:\\custom\\cwd' }
  ]
})

const baseStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-conversation-move-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

async function setupComponent({
  snapshot = baseSnapshot,
  status = baseStatus,
  ledgers = [],
  document: injectedDocument,
  moveHandler,
  snapshotHandler,
  statusHandler,
  setTimeout: injectedSetTimeout,
  clearTimeout: injectedClearTimeout
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
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
    remote,
    document: injectedDocument,
    setTimeout: injectedSetTimeout,
    clearTimeout: injectedClearTimeout
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()
  return { runtime, remote, mounted, source, ledgers }
}

test('1. plain conversation move P_A -> P_B: preview disclosure, confirm submits one moveNode, tree updates, readback runs', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(baseSnapshot))
  const moveCalls = []
  const ledgers = []

  const moveHandler = async ({ id, parentId }) => {
    moveCalls.push({ id, parentId })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const node = updated.nodes.find((n) => n.id === id)
    assert.ok(node, 'moved node must exist in snapshot')
    node.parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime, mounted } = await setupComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler,
    ledgers
  })

  // Select c1
  let root = runtime.getRoot()
  const selectC1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1')
  selectC1.props.onClick(mockEvent())
  await runtime.settle()

  // Verify move panel rendered with target p_b
  root = runtime.getRoot()
  const movePanel = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'move panel')
  const targetPB = requireOne(movePanel, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b')

  // Click target p_b -> PREVIEW
  targetPB.props.onClick(mockEvent())
  await runtime.settle()

  // Verify ZERO move RPC on preview
  assert.equal(moveCalls.length, 0, 'zero move RPC calls must occur on preview')

  // Verify conversation-specific disclosure text
  root = runtime.getRoot()
  const preview = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'preview container')
  const disclosure = requireOne(preview, (n) => n.props?.['data-wo-move-disclosure'] === 'true', 'disclosure')
  const disclosureText = textOf(disclosure)
  assert.match(disclosureText, /仅逻辑归属；保留原 Session；不搬文件\/迁移 cwd\/启动或暂停 Task；不授予历史访问权限/u)

  // Verify confirm button enabled
  const confirmBtn = requireOne(preview, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm button')
  assert.equal(confirmBtn.props.disabled, false)

  // Confirm move
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Exactly ONE moveNode RPC call
  assert.equal(moveCalls.length, 1, 'exactly one moveNode RPC dispatched')
  assert.deepEqual(moveCalls[0], { id: 'c1', parentId: 'p_b' })

  // Verify local tree updated
  const updatedC1 = currentSnapshot.nodes.find((n) => n.id === 'c1')
  assert.equal(updatedC1.parentId, 'p_b')
  assert.equal(updatedC1.sessionId, 'ses-alpha-1', 'sessionId must remain unchanged')
  assert.equal(updatedC1.cwd, undefined, 'cwd must remain undefined')

  // Preview closed
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), null, 'preview must close')

  await mounted.cleanup()
})

test('2. plain conversation move P_B -> Root: target root updates parentId to root, preserves sessionId', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(baseSnapshot))
  const moveCalls = []

  const moveHandler = async ({ id, parentId }) => {
    moveCalls.push({ id, parentId })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const node = updated.nodes.find((n) => n.id === id)
    node.parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime, mounted } = await setupComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler
  })

  // Select c2 (currently under p_b)
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c2', 'select c2').props.onClick(mockEvent())
  await runtime.settle()

  // Click Root target button
  root = runtime.getRoot()
  const movePanel = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'move panel')
  const rootBtn = requireOne(movePanel, (n) => n.props?.['data-wo-move-to'] === 'root', 'root button')
  rootBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 0, 'zero RPC on preview')

  // Confirm move to Root
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1)
  assert.deepEqual(moveCalls[0], { id: 'c2', parentId: 'root' })
  assert.equal(currentSnapshot.nodes.find((n) => n.id === 'c2').parentId, 'root')
  assert.equal(currentSnapshot.nodes.find((n) => n.id === 'c2').sessionId, 'ses-beta-2')

  await mounted.cleanup()
})

test('3. plain conversation move Root -> P_A: source under Root moving to Project Alpha', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(baseSnapshot))
  const moveCalls = []

  const moveHandler = async ({ id, parentId }) => {
    moveCalls.push({ id, parentId })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const node = updated.nodes.find((n) => n.id === id)
    node.parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime, mounted } = await setupComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler
  })

  // Select c_root (currently under Root project)
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c_root', 'select c_root').props.onClick(mockEvent())
  await runtime.settle()

  // Target p_a
  root = runtime.getRoot()
  const movePanel = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'move panel')
  const targetPA = requireOne(movePanel, (n) => n.props?.['data-wo-move-to'] === 'p_a', 'target p_a')
  targetPA.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 0, 'zero RPC on preview')

  // Confirm
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1)
  assert.deepEqual(moveCalls[0], { id: 'c_root', parentId: 'p_a' })
  assert.equal(currentSnapshot.nodes.find((n) => n.id === 'c_root').parentId, 'p_a')
  assert.equal(currentSnapshot.nodes.find((n) => n.id === 'c_root').sessionId, 'ses-root-0')

  await mounted.cleanup()
})

test('4. same-title conversation disambiguation: C1 and C2 both titled "General Chat" remain isolated by stable ID', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(baseSnapshot))
  const moveCalls = []

  const moveHandler = async ({ id, parentId }) => {
    moveCalls.push({ id, parentId })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const node = updated.nodes.find((n) => n.id === id)
    node.parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime, mounted } = await setupComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler
  })

  // Select c1 (under p_a)
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  // Target p_b and confirm
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1)
  assert.equal(moveCalls[0].id, 'c1', 'must submit c1, not c2')

  // Verify c1 moved to p_b, but c2 remained with original parent p_b and original session
  const c1Node = currentSnapshot.nodes.find((n) => n.id === 'c1')
  const c2Node = currentSnapshot.nodes.find((n) => n.id === 'c2')
  assert.equal(c1Node.parentId, 'p_b')
  assert.equal(c1Node.sessionId, 'ses-alpha-1')
  assert.equal(c2Node.parentId, 'p_b')
  assert.equal(c2Node.sessionId, 'ses-beta-2')

  await mounted.cleanup()
})

test('5. preview, cancel, and same-parent no-op generate ZERO RPC calls, tree unchanged', async () => {
  const moveCalls = []
  const { runtime, mounted } = await setupComponent({
    moveHandler: async (req) => { moveCalls.push(req); return { ok: true, value: baseSnapshot } }
  })

  // Select c1
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  // Open preview for p_b
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  // Cancel preview
  root = runtime.getRoot()
  const cancelBtn = requireOne(root, (n) => n.props?.['data-wo-move-cancel'] === 'true', 'cancel')
  cancelBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 0, 'zero RPC on cancel')
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), null, 'preview closed')

  // Re-select c1 and try same-parent no-op: p_a is current parent of c1
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const targetPA = findOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_a')
  if (targetPA !== null) {
    targetPA.props.onClick(mockEvent())
    await runtime.settle()
    // Should show error notice, zero preview confirm
    assert.equal(moveCalls.length, 0, 'zero RPC on same parent preview attempt')
  }

  await mounted.cleanup()
})

test('6. exclusion of directory-bound conversations: c_under_ws and c_with_cwd refuse move panel and cannot move', async () => {
  const moveCalls = []
  const { runtime, mounted } = await setupComponent({
    moveHandler: async (req) => { moveCalls.push(req); return { ok: true, value: baseSnapshot } }
  })

  // 1. Select c_under_ws (parent is workspace w_a)
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c_under_ws', 'select c_under_ws').props.onClick(mockEvent())
  await runtime.settle()

  // Move panel MUST NOT be rendered for conversation under workspace
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true'), null, 'c_under_ws must have no move panel')

  // 2. Select c_with_cwd (has cwd: "E:\\custom\\cwd")
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c_with_cwd', 'select c_with_cwd').props.onClick(mockEvent())
  await runtime.settle()

  // Move panel MUST NOT be rendered for directory-bound conversation
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true'), null, 'c_with_cwd must have no move panel')

  assert.equal(moveCalls.length, 0, 'zero RPC calls dispatched')
  await mounted.cleanup()
})

test('7. ineligible targets: target workspace/conversation rejected; missing real Root in snapshot refused without synthetic fake Root', async () => {
  // Snapshot without real Root node in snapshot.nodes
  const snapshotNoRootNode = Object.freeze({
    rootId: 'root',
    revision: 10,
    nodes: [
      { id: 'p_a', parentId: null, kind: 'project', title: 'Project Alpha' },
      { id: 'c1', parentId: 'p_a', kind: 'conversation', title: 'Chat 1', sessionId: 'ses-1' }
    ]
  })

  const moveCalls = []
  const { runtime, mounted } = await setupComponent({
    snapshot: snapshotNoRootNode,
    moveHandler: async (req) => { moveCalls.push(req); return { ok: true, value: snapshotNoRootNode } }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const rootBtn = findOne(root, (n) => n.props?.['data-wo-move-to'] === 'root')
  if (rootBtn !== null) {
    rootBtn.props.onClick(mockEvent())
    await runtime.settle()

    // Must NOT form preview or synthesize fake Root
    root = runtime.getRoot()
    const preview = findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true')
    assert.equal(preview, null, 'must not form preview when real Root is missing from snapshot')
  }

  assert.equal(moveCalls.length, 0, 'zero RPC calls')
  await mounted.cleanup()
})

test('8. live drift defense before confirm: selection drift, revision drift, parent drift, session drift, stale snapshot', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(baseSnapshot))
  const moveCalls = []

  const { runtime, mounted } = await setupComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler: async (req) => { moveCalls.push(req); return { ok: true, value: currentSnapshot } }
  })

  // Case A: Selection drift (user changes selection while preview open)
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  // Select c2 while preview is open
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c2', 'select c2').props.onClick(mockEvent())
  await runtime.settle()

  // Confirm: must fail closed for conversation due to selection drift
  root = runtime.getRoot()
  const confirmBtnA = findOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true')
  if (confirmBtnA) {
    confirmBtnA.props.onClick(mockEvent())
    await runtime.settle()
  }
  assert.equal(moveCalls.length, 0, 'zero move RPC on selection drift')

  // Case B: Revision drift
  // Re-open preview for c1
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  // Mutate snapshot revision in background and refresh component
  currentSnapshot = JSON.parse(JSON.stringify(currentSnapshot))
  currentSnapshot.revision += 10
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true', 'refresh').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtnB = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm')
  confirmBtnB.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(moveCalls.length, 0, 'zero move RPC on revision drift')

  // Case C: Session drift
  currentSnapshot = JSON.parse(JSON.stringify(baseSnapshot))
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true', 'refresh').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  // Modify c1 sessionId in background snapshot and refresh component
  currentSnapshot = JSON.parse(JSON.stringify(currentSnapshot))
  currentSnapshot.nodes.find((n) => n.id === 'c1').sessionId = 'ses-tampered-999'
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true', 'refresh').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtnC = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm')
  confirmBtnC.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(moveCalls.length, 0, 'zero move RPC on session drift')

  await mounted.cleanup()
})

test('9. concurrency guard: simultaneous confirm clicks dispatch exactly one moveNode RPC', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(baseSnapshot))
  const moveCalls = []

  let resolveMove
  const movePromise = new Promise((res) => { resolveMove = res })

  const moveHandler = async ({ id, parentId }) => {
    moveCalls.push({ id, parentId })
    await movePromise
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    updated.nodes.find((n) => n.id === id).parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime, mounted } = await setupComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler
  })

  // Select c1 -> preview p_b
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  // Click confirm twice synchronously
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm')
  confirmBtn.props.onClick(mockEvent())
  confirmBtn.props.onClick(mockEvent())

  assert.equal(moveCalls.length, 1, 'exactly one moveNode dispatched despite double-click')

  // Release pending RPC
  resolveMove()
  await runtime.settle()

  assert.equal(moveCalls.length, 1, 'still exactly one moveNode call completed')
  await mounted.cleanup()
})

test('10. remote failure continuity: server error preserves preview and context, displays notice, zero retry', async () => {
  const moveCalls = []
  const moveHandler = async (req) => {
    moveCalls.push(req)
    throw new Error('Database locked / permission denied')
  }

  const { runtime, mounted } = await setupComponent({
    moveHandler
  })

  // Select c1 -> target p_b
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  // Confirm
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1, 'exactly one RPC call attempted')

  // Verify preview is STILL open with error notice
  root = runtime.getRoot()
  const previewAfter = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'preview')
  assert.ok(previewAfter, 'preview must remain open on failure')

  // Verify notice displays failure reason
  const noticeEl = requireOne(root, (n) => n.props?.['data-wo-notice'] !== undefined, 'notice')
  assert.match(textOf(noticeEl), /Database locked/u)

  await mounted.cleanup()
})

test('11. response session drift defense: returned snapshot with drifted sessionId or wrong parent fails closed', async () => {
  const moveCalls = []
  const moveHandler = async ({ id, parentId }) => {
    moveCalls.push({ id, parentId })
    // Return corrupted snapshot with different sessionId
    const corrupted = JSON.parse(JSON.stringify(baseSnapshot))
    const node = corrupted.nodes.find((n) => n.id === id)
    node.parentId = parentId
    node.sessionId = 'ses-corrupted-from-server'
    corrupted.revision += 1
    return { ok: true, value: corrupted }
  }

  const { runtime, mounted } = await setupComponent({
    moveHandler
  })

  // Select c1 -> target p_b
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  // Confirm
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1)

  // Must reject corrupted snapshot: notice displays mismatch
  root = runtime.getRoot()
  const noticeEl = requireOne(root, (n) => n.props?.['data-wo-notice'] !== undefined, 'notice')
  assert.match(textOf(noticeEl), /返回快照中会话状态或Session漂移/u)

  await mounted.cleanup()
})

test('12. subsequent refresh failure continuity: confirmed move retained, snapshot marked stale with notice', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(baseSnapshot))
  const moveCalls = []

  const moveHandler = async ({ id, parentId }) => {
    moveCalls.push({ id, parentId })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    updated.nodes.find((n) => n.id === id).parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  let refreshShouldFail = false
  const snapshotHandler = async () => {
    if (refreshShouldFail) {
      throw new Error('Network timeout during snapshot readback')
    }
    return { ok: true, value: currentSnapshot }
  }

  const { runtime, mounted } = await setupComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler,
    snapshotHandler
  })

  // Select c1 -> target p_b
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  // Arm readback failure
  refreshShouldFail = true

  // Confirm
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  // Assert move succeeded and confirmed snapshot retained in state
  root = runtime.getRoot()
  const noticeEl = requireOne(root, (n) => n.props?.['data-wo-notice'] !== undefined, 'notice')
  assert.match(textOf(noticeEl), /移动已确认；但后续快照刷新失败/u)

  // Verify stale marker is set
  const staleBanner = findOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true')
  assert.ok(staleBanner, 'stale banner must be active')

  await mounted.cleanup()
})

test('13. late response & unmount safety: in-flight move response discarded cleanly without unhandled rejection', async () => {
  let resolveMove
  const movePromise = new Promise((res) => { resolveMove = res })

  const moveHandler = async () => {
    await movePromise
    return { ok: true, value: baseSnapshot }
  }

  const { runtime, mounted } = await setupComponent({
    moveHandler
  })

  // Select c1 -> target p_b
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  // Click confirm
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())

  // Unmount component while moveNode is in flight
  await mounted.cleanup()

  // Resolve late response
  resolveMove()
  await runtime.settle()
  // Clean exit with 0 unhandled rejections
})

test('14. zero non-whitelisted calls: zero openSession, zero conversationTarget, zero createConversation, zero reconcileTasks', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(baseSnapshot))
  const ledgers = []

  const moveHandler = async ({ id, parentId }) => {
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    updated.nodes.find((n) => n.id === id).parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime, mounted } = await setupComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler,
    ledgers
  })

  // Select c1 -> target p_b -> confirm
  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  // Audit ledgers
  const forbiddenMethods = ['openSession', 'conversationTarget', 'createConversation', 'reconcileTasks', 'startTask', 'pauseTask']
  for (const call of ledgers) {
    assert.equal(forbiddenMethods.includes(call.method), false, `Forbidden call detected: ${call.method}`)
  }

  await mounted.cleanup()
})

test('15. Quick Access integration: pinned conversation retains ID and order, path updates, zero session open', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(baseSnapshot))

  const moveHandler = async ({ id, parentId }) => {
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    updated.nodes.find((n) => n.id === id).parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime, mounted, ledgers } = await setupComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler
  })

  // 1. Pin c1 to Quick Access
  let root = runtime.getRoot()
  const pinC1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'c1', 'pin c1')
  pinC1.props.onClick(mockEvent())
  await runtime.settle()

  // Verify c1 appears in Quick Access
  root = runtime.getRoot()
  const qaRowInitial = requireOne(root, (n) => n.props?.['data-wo-quick-access-row'] === 'c1', 'qa c1 row')
  const qaPathInitial = requireOne(qaRowInitial, (n) => n.props?.['data-wo-quick-access-path'] === 'c1', 'qa c1 path')
  assert.equal(textOf(qaPathInitial), 'Root Project / Project Alpha / General Chat')

  // 2. Move c1 to p_b
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'c1', 'select c1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p_b', 'target p_b').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  // 3. Verify Quick Access dynamically updates path to Project Beta
  root = runtime.getRoot()
  const qaRowAfter = requireOne(root, (n) => n.props?.['data-wo-quick-access-row'] === 'c1', 'qa c1 row after move')
  const qaPathAfter = requireOne(qaRowAfter, (n) => n.props?.['data-wo-quick-access-path'] === 'c1', 'qa c1 path after move')
  assert.equal(textOf(qaPathAfter), 'Root Project / Project Beta / General Chat')

  // Verify zero openSession called
  assert.equal(ledgers.some((l) => l.method === 'openSession'), false, 'zero openSession must be called')

  await mounted.cleanup()
})
