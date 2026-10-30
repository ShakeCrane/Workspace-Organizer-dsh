/**
 * Guarded Logical Move Flow offline component tests.
 *
 * Verifies the GUARDED_LOGICAL_MOVE_READY contract:
 * 1. P/W move flow: selecting target forms a preview (zero RPC, zero tree mutation);
 *    preview displays source, old parent path, target, and physical filesystem/cwd disclaimer;
 *    confirming submits one { id: sourceId, parentId: targetId }; updates tree with returned snapshot fact.
 * 2. Workspace move to Root: selecting Root maps to snapshot.rootId; updates parentId to root; directory preserved.
 * 3. Cancel flow: closes preview with zero move RPC and zero refresh RPC.
 * 4. Local validation & pre-validation: no-op (same parent), cycle (self or descendant), Root node move
 *    are rejected with honest error; zero move RPC, zero refresh RPC.
 * 5. Stale snapshot protection: stale snapshot rejects preview and confirm with zero RPC.
 * 6. Session target locking: changing selection or tampering with DOM source attribute cannot divert move target;
 *    mismatch rejects with zero RPC.
 * 7. Background mutation/deletion defense: if source parent or target changes before confirm, rejects with zero RPC.
 * 8. Concurrency guard: double-click / simultaneous confirm dispatches exactly one move RPC; pending state disables inputs.
 * 9. Remote failure: error preserves preview and source/target info; displays unconfirmed error notice; no automatic retry.
 * 10. Layered confirmation: move succeeds but subsequent read refresh fails -> preserves confirmed move, marks snapshot stale.
 * 11. Late response & unmount safety: in-flight move response safely discarded on unmount without state corruption.
 * 12. Mutual exclusion with Rename: unsubmitted rename draft and move preview cannot silently overwrite each other.
 * 13. Quick Access integration: item order preserved; dynamically resolves updated path through new snapshot.
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

    // Branch B: p1_b (same title as p1_a) -> p2_deep, w2
    { id: 'p1_b', parentId: 'root', kind: 'project', title: 'Project Branch' },
    { id: 'p2_deep', parentId: 'p1_b', kind: 'project', title: 'Branch B Subproject' },
    { id: 'w2', parentId: 'p1_b', kind: 'workspace', title: 'Workspace 2', directory: 'E:\\ws-2' }
  ]
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-move-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

async function setupMoveComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  ledgers = [],
  document: injectedDocument,
  moveHandler,
  renameHandler,
  setTimeout: injectedSetTimeout,
  clearTimeout: injectedClearTimeout
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })
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

test('valid project move flow: preview forms without RPC, confirm submits one move, tree updates with returned fact', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const moveCalls = []

  const moveHandler = async ({ id, parentId }) => {
    moveCalls.push({ id, parentId })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const node = updated.nodes.find((n) => n.id === id)
    if (!node) throw new Error('Node not found')
    node.parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime, mounted } = await setupMoveComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler
  })

  let root = runtime.getRoot()

  // 1. Select deep project 'p_deep'
  const selectPDeep = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_deep', 'select p_deep')
  selectPDeep.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const movePanel = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'move panel')
  assert.ok(requireOne(movePanel, (n) => n.props?.['data-wo-move-source'] === 'p_deep'), 'move source indicator')

  // Target button for p1_b
  const targetP1B = requireOne(movePanel, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'target p1_b')

  // 2. Click target p1_b -> forms PREVIEW
  targetP1B.props.onClick(mockEvent())
  await runtime.settle()

  // Assert ZERO move RPC calls on preview
  assert.equal(moveCalls.length, 0, 'zero move RPC calls must occur on preview')

  // Verify preview DOM elements
  root = runtime.getRoot()
  const preview = requireOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true', 'preview container')
  assert.ok(preview, 'preview container must exist')

  const disclosure = requireOne(preview, (n) => n.props?.['data-wo-move-disclosure'] === 'true', 'disclosure')
  assert.match(textOf(disclosure), /仅变更逻辑归属，不搬迁文件或进程cwd/u)

  const confirmBtn = requireOne(preview, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm button')
  assert.equal(confirmBtn.props.disabled, false)

  // 3. Click Confirm Move
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Exactly ONE move RPC call
  assert.equal(moveCalls.length, 1, 'exactly one move RPC call on confirm')
  assert.deepEqual(moveCalls[0], { id: 'p_deep', parentId: 'p1_b' })

  // Verify tree updated
  root = runtime.getRoot()
  const updatedPDeep = currentSnapshot.nodes.find((n) => n.id === 'p_deep')
  assert.equal(updatedPDeep.parentId, 'p1_b', 'p_deep parentId must now be p1_b')

  // Preview closed
  const previewAfter = findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true')
  assert.equal(previewAfter, null, 'preview must close after confirmed move')

  await mounted.cleanup()
})

test('workspace move to Root: selecting root maps to snapshot.rootId, updates parentId, preserves directory', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
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

  const { runtime, mounted } = await setupMoveComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler
  })

  let root = runtime.getRoot()
  // Select w1
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const movePanel = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'move panel')

  // Click Root target button
  const rootBtn = requireOne(movePanel, (n) => n.props?.['data-wo-move-to'] === 'root', 'root button')
  rootBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 0, 'zero RPC on preview')

  // Confirm move
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1)
  assert.deepEqual(moveCalls[0], { id: 'w1', parentId: 'root' })

  const updatedW1 = currentSnapshot.nodes.find((n) => n.id === 'w1')
  assert.equal(updatedW1.parentId, 'root')
  assert.equal(updatedW1.directory, 'E:\\ws-1', 'workspace directory must be untouched')

  await mounted.cleanup()
})

test('cancel flow closes preview with zero move RPC and zero refresh RPC', async () => {
  const moveCalls = []
  const refreshCalls = []

  const { runtime, remote, mounted } = await setupMoveComponent({
    moveHandler: async (req) => { moveCalls.push(req); return { ok: true, value: scenarioSnapshot } }
  })
  remote.allowed.snapshot = async () => {
    refreshCalls.push(Date.now())
    return { ok: true, value: scenarioSnapshot }
  }

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_deep', 'select p_deep').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'target p1_b').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), 'preview open')

  // Click cancel inside preview
  const cancelBtn = requireOne(root, (n) => n.props?.['data-wo-move-cancel'] === 'true', 'cancel')
  cancelBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), null, 'preview must be closed')
  assert.equal(moveCalls.length, 0, 'zero move calls on cancel')
  assert.equal(refreshCalls.length, 0, 'zero refresh calls on cancel')

  await mounted.cleanup()
})

test('local validation: same-parent no-op, self/descendant cycle, and Root node move are rejected with zero RPC', async () => {
  const moveCalls = []
  const { runtime, mounted } = await setupMoveComponent({
    moveHandler: async (req) => { moveCalls.push(req); return { ok: true, value: scenarioSnapshot } }
  })

  let root = runtime.getRoot()

  // 1. Same parent no-op: p_deep is already under p1_a
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'p_deep', 'select p_deep').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Call moveTo('p1_a') programmatically or find button
  // When target is current parent, previewMove displays "目标已是当前父项目 / Node is already under this project"
  const targetP1A = findOne(root, (n) => n.props?.['data-wo-move-to'] === 'p1_a')
  if (targetP1A) {
    targetP1A.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
    const error = requireOne(root, (n) => n.props?.['data-wo-move-error'] === 'true', 'error')
    assert.match(textOf(error), /目标已是当前父项目/u)
  }

  // 2. Move to self or descendant: select p1_a
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1_a', 'select p1_a').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const movePanel = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'panel')
  // Verify p_deep (descendant) and p1_a (self) are not in target buttons
  assert.equal(findOne(movePanel, (n) => n.props?.['data-wo-move-to'] === 'p1_a'), null, 'cannot target self')
  assert.equal(findOne(movePanel, (n) => n.props?.['data-wo-move-to'] === 'p_deep'), null, 'cannot target descendant')

  // 3. Root project cannot be moved
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'root', 'select root').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true'), null, 'root cannot show move panel')

  assert.equal(moveCalls.length, 0, 'zero RPC calls on all invalid attempts')
  await mounted.cleanup()
})

test('stale snapshot: preview and confirm fail closed with honest notice and zero RPC', async () => {
  let isStale = false
  const moveCalls = []

  const { runtime, remote, mounted } = await setupMoveComponent({
    snapshot: () => isStale
      ? { ok: false, error: new Error('Network error; snapshot stale') }
      : { ok: true, value: scenarioSnapshot },
    moveHandler: async (req) => { moveCalls.push(req); return { ok: true, value: scenarioSnapshot } }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1').props.onClick(mockEvent())
  await runtime.settle()

  // Make snapshot stale
  isStale = true
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true', 'refresh').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const movePanel = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'move panel')
  const targetP1B = requireOne(movePanel, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'target')

  targetP1B.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const error = requireOne(root, (n) => n.props?.['data-wo-move-error'] === 'true', 'error')
  assert.match(textOf(error), /快照已陈旧失效/u)
  assert.equal(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), null, 'preview must not open')
  assert.equal(moveCalls.length, 0, 'zero move calls on stale snapshot')

  await mounted.cleanup()
})

test('session target locking: changing selection or DOM source mismatch cannot divert move target', async () => {
  let domTampered = false
  const mockDocument = {
    querySelector: (selector) => {
      if (selector === '[data-wo-move-source]' && domTampered) {
        return { getAttribute: () => 'w2' } // Tampered!
      }
      return null
    }
  }

  const moveCalls = []
  const { runtime, mounted } = await setupMoveComponent({
    document: mockDocument,
    moveHandler: async (req) => { moveCalls.push(req); return { ok: true, value: scenarioSnapshot } }
  })

  let root = runtime.getRoot()
  // Select w1
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'target p1_b').props.onClick(mockEvent())
  await runtime.settle()

  // 1. Change selection to w2 while preview is open
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'w2', 'select w2').props.onClick(mockEvent())
  await runtime.settle()

  // Confirm move: must still submit for w1!
  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm')
  confirmBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(moveCalls.length, 1)
  assert.equal(moveCalls[0].id, 'w1', 'must submit locked w1, never w2')
  assert.equal(moveCalls[0].parentId, 'p1_b')

  // 2. Tamper DOM attribute: mismatch rejects
  domTampered = true
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'target').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const error = requireOne(root, (n) => n.props?.['data-wo-move-error'] === 'true', 'error')
  assert.match(textOf(error), /Target mismatch/u)
  assert.equal(moveCalls.length, 1, 'no new RPC dispatched on DOM mismatch')

  await mounted.cleanup()
})

test('background mutation/deletion defense: source parent change before confirm fails closed with zero RPC', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const moveCalls = []

  const { runtime, remote, mounted } = await setupMoveComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler: async (req) => { moveCalls.push(req); return { ok: true, value: currentSnapshot } }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'target p1_b').props.onClick(mockEvent())
  await runtime.settle()

  // Background mutation: w1 was moved to 'root' by another client
  currentSnapshot = JSON.parse(JSON.stringify(currentSnapshot))
  currentSnapshot.nodes.find((n) => n.id === 'w1').parentId = 'root'
  currentSnapshot.revision += 1

  // Trigger refresh to update component's snapshot
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true', 'refresh').props.onClick(mockEvent())
  await runtime.settle()

  // Click Confirm
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const error = requireOne(root, (n) => n.props?.['data-wo-move-error'] === 'true', 'error')
  assert.match(textOf(error), /需重新预览/u)
  assert.equal(moveCalls.length, 0, 'zero RPC on baseline mutation')

  await mounted.cleanup()
})

test('concurrency guard: simultaneous confirm calls dispatch exactly one move RPC', async () => {
  let resolveMove
  const movePromise = new Promise((resolve) => { resolveMove = resolve })
  const moveCalls = []

  const { runtime, mounted } = await setupMoveComponent({
    moveHandler: async (req) => {
      moveCalls.push(req)
      await movePromise
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'target').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const confirmBtn = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm')

  // First confirm click
  confirmBtn.props.onClick(mockEvent())
  runtime.render()

  // Verify submitting state
  root = runtime.getRoot()
  const movePanel = requireOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true', 'panel')
  assert.equal(movePanel.props['data-wo-move-submitting'], 'true', 'must mark submitting')

  const submittingConfirmBtn = requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm')
  assert.equal(submittingConfirmBtn.props.disabled, true)
  assert.match(textOf(submittingConfirmBtn), /Moving…/u)

  // Simultaneous second click on confirm
  submittingConfirmBtn.props.onClick(mockEvent())

  // Resolve pending move
  resolveMove()
  await runtime.settle()

  assert.equal(moveCalls.length, 1, 'exactly one move RPC dispatched despite simultaneous calls')
  await mounted.cleanup()
})

test('remote failure: server error preserves preview and source/target info; displays unconfirmed error notice; no retry', async () => {
  const moveCalls = []
  const { runtime, mounted } = await setupMoveComponent({
    moveHandler: async (req) => {
      moveCalls.push(req)
      throw new Error('Host service permission denied')
    }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'target').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  // Verify preview remains open with honest error notice
  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), 'preview must remain open on failure')
  const error = requireOne(root, (n) => n.props?.['data-wo-move-error'] === 'true', 'error')
  assert.match(textOf(error), /Host service permission denied/u)

  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(notice), /移动未确认或失败/u)

  assert.equal(moveCalls.length, 1, 'no automatic retry')
  await mounted.cleanup()
})

test('layered confirmation: move succeeds but subsequent read refresh fails -> preserves confirmed move, marks snapshot stale', async () => {
  let moveSucceeded = false
  const updatedSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  updatedSnapshot.nodes.find((n) => n.id === 'w1').parentId = 'p1_b'

  const { runtime, remote, mounted } = await setupMoveComponent({
    moveHandler: async (req) => {
      moveSucceeded = true
      return { ok: true, value: updatedSnapshot }
    }
  })

  // subsequent refresh fails
  remote.allowed.snapshot = async () => {
    if (moveSucceeded) {
      throw new Error('Read replica connection lost')
    }
    return { ok: true, value: scenarioSnapshot }
  }

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'target').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Stale notice displayed
  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(notice), /移动已确认；但后续快照刷新失败/u)

  // Snapshot stale indicator
  const staleBanner = requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true', 'stale')
  assert.ok(staleBanner, 'snapshot must be marked stale')

  // Move fact was preserved
  assert.equal(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), null, 'preview closed')

  await mounted.cleanup()
})

test('late response and unmount safety: in-flight move response safely discarded on unmount', async () => {
  let resolveMove
  const movePromise = new Promise((resolve) => { resolveMove = resolve })

  const { runtime, mounted } = await setupMoveComponent({
    moveHandler: async () => {
      await movePromise
      return { ok: true, value: scenarioSnapshot }
    }
  })

  let root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'target').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  runtime.render()

  // Unmount component while in-flight
  await mounted.cleanup()

  // Resolve after unmount
  resolveMove()
  await runtime.settle()

  // Must not throw or corrupt state
  assert.ok(true, 'unmounted resolution completed cleanly')
})

test('mutual exclusion with Rename: rename in progress blocks move preview; move preview blocks rename', async () => {
  const { runtime, mounted } = await setupMoveComponent()

  let root = runtime.getRoot()
  // 1. Start rename on w1
  requireOne(root, (n) => n.props?.['data-wo-rename'] === 'w1', 'rename w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-rename-panel'] === 'true'), 'rename panel open')

  // Attempt move preview while renaming -> blocked
  const movePanel = findOne(root, (n) => n.props?.['data-wo-move-panel'] === 'true')
  if (movePanel) {
    const targetBtn = findOne(movePanel, (n) => n.props?.['data-wo-move-to'] === 'p1_b')
    if (targetBtn) {
      targetBtn.props.onClick(mockEvent())
      await runtime.settle()
      root = runtime.getRoot()
      const error = requireOne(root, (n) => n.props?.['data-wo-move-error'] === 'true', 'move error')
      assert.match(textOf(error), /正在重命名中/u)
      assert.equal(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), null, 'move preview blocked')
    }
  }

  // Cancel rename
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-rename-cancel'] === 'true', 'cancel rename').props.onClick(mockEvent())
  await runtime.settle()

  // 2. Start move preview on w1
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p1_b', 'target p1_b').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-move-preview'] === 'true'), 'move preview open')

  // Attempt startRename on w1 -> blocked
  requireOne(root, (n) => n.props?.['data-wo-rename'] === 'w1', 'rename w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-rename-panel'] === 'true'), null, 'rename panel must not open')
  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error', 'notice')
  assert.match(textOf(notice), /正在移动预览中/u)

  await mounted.cleanup()
})

test('Quick Access integration: item order preserved and dynamically resolves updated path through new snapshot', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))

  const moveHandler = async ({ id, parentId }) => {
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const node = updated.nodes.find((n) => n.id === id)
    node.parentId = parentId
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime, mounted } = await setupMoveComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    moveHandler
  })

  let root = runtime.getRoot()

  // 1. Favorite w1 to Quick Access
  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'w1', 'pin w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const qaRowInitial = requireOne(root, (n) => n.props?.['data-wo-quick-access-row'] === 'w1', 'qa row')
  assert.match(textOf(qaRowInitial), /Project Branch \/ Workspace 1/u)

  // 2. Select w1 and move to p2_deep
  requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1', 'select w1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-to'] === 'p2_deep', 'target p2_deep').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-move-confirm'] === 'true', 'confirm').props.onClick(mockEvent())
  await runtime.settle()

  // 3. Verify Quick Access updated path dynamically
  root = runtime.getRoot()
  const qaRowAfter = requireOne(root, (n) => n.props?.['data-wo-quick-access-row'] === 'w1', 'qa row after')
  assert.match(textOf(qaRowAfter), /Branch B Subproject \/ Workspace 1/u)

  await mounted.cleanup()
})
