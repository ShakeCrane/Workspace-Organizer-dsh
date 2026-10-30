/**
 * Quick Access Reference Management offline component tests.
 *
 * Verifies the QUICK_ACCESS_REFERENCE_MANAGEMENT_READY contract:
 * 1. Initial state has 0 items; displays honest disclosure, truthful drag/resize/persistence unfulfilled notices.
 * 2. Loading state (snapshot === null) displays loading state, not fake "0 items".
 * 3. Eligible nodes (project, workspace, conversation; parentId !== null) can be favorited/unfavorited via tree row toggle button.
 * 4. Root project (parentId === null) and invalid/external IDs cannot be favorited.
 * 5. Same-title nodes in different branches with different IDs are favorited and managed independently.
 * 6. Quick Access rows render in exact array order with dedicated selector data-wo-quick-access-row (never data-wo-node-id).
 * 7. Manual reordering (Up/Down) swaps array items; boundary buttons are disabled; snapshot/nodes/parent/revision are unmodified.
 * 8. Removal via Quick Access row remove button (✕) purges item and updates tree row toggle button.
 * 9. Dynamic resolution: node title/path rename/move in snapshot is reflected automatically without losing Quick Access position.
 * 10. Stale snapshot (snapshotStale === true): displays stale banner; disables toggle, up, down, locate; allows removal.
 * 11. Garbage collection: deleted nodes purged only on new successful snapshot; stale/error refresh does not purge; purged IDs do not auto-revive.
 * 12. Locate integration: explicit locate button reveals projects tree, uncollapses ancestors, selects target (FP-92); ordinary row click has no side-effects.
 * 13. Section hide and restore preserves Quick Access items and user ordering.
 * 14. Zero Remote RPC calls and zero uiWorkspace calls on favorite, reorder, remove, or row click.
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
  textOf,
  canonicalJson
} from '../scripts/lib/c3a-synthetic-component-runtime.mjs'

// Two unrelated project branches with same-title conversations
const scenarioSnapshot = Object.freeze({
  rootId: 'root',
  revision: 10,
  nodes: [
    // Branch 1: p1 -> p1_sub -> w1 & cnv_1
    { id: 'p1', parentId: null, kind: 'project', title: 'Branch 1 Project' },
    { id: 'p1_sub', parentId: 'p1', kind: 'project', title: 'Branch 1 Subproject' },
    { id: 'w1', parentId: 'p1_sub', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' },
    { id: 'cnv_1', parentId: 'p1_sub', kind: 'conversation', title: 'SharedTitle', sessionId: 'ses-1' },

    // Branch 2: p2 -> p2_sub -> w2 & cnv_2 (cnv_2 has same title 'SharedTitle' as cnv_1)
    { id: 'p2', parentId: null, kind: 'project', title: 'Branch 2 Project' },
    { id: 'p2_sub', parentId: 'p2', kind: 'project', title: 'Branch 2 Subproject' },
    { id: 'w2', parentId: 'p2_sub', kind: 'workspace', title: 'Workspace 2', directory: 'E:\\ws-2' },
    { id: 'cnv_2', parentId: 'p2_sub', kind: 'conversation', title: 'SharedTitle', sessionId: 'ses-2' }
  ]
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-qa-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function setupQuickAccessComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  ledgers = [],
  document: injectedDocument,
  setTimeout: injectedSetTimeout,
  clearTimeout: injectedClearTimeout
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })
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

test('initial and empty state: displays 0 items, truthful disclosures, and eligible tree toggle buttons', async () => {
  const { runtime, remote, mounted } = await setupQuickAccessComponent()
  const root = runtime.getRoot()

  const quickAccess = requireOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access', 'quick-access section')
  const qaText = textOf(quickAccess)

  // Disclosures
  assert.ok(qaText.includes('(0)'), 'Quick Access header shows (0) items')
  assert.ok(findOne(quickAccess, (node) => node.props?.['data-wo-quick-access-empty'] === 'true') !== null, 'empty container present')
  assert.ok(qaText.includes('暂无快捷访问项（可在项目树中点击“☆ Pin”收藏）'), 'empty explanation present')
  assert.ok(qaText.includes('本次挂载收藏；刷新/重新挂载后重置；快捷打开尚未接线'), 'mount-only and unhooked notice present')
  assert.ok(qaText.includes('分区拖动排序 / 自由调高：未实现'), 'drag/resize notice present')

  // Root project p1 must NOT have quick-access toggle
  assert.equal(findOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === 'p1'), null, 'p1 root has no toggle')
  assert.equal(findOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === 'p2'), null, 'p2 root has no toggle')

  // Eligible nodes (p1_sub, w1, cnv_1, p2_sub, w2, cnv_2) must have toggle button with "☆ Pin"
  for (const id of ['p1_sub', 'w1', 'cnv_1', 'p2_sub', 'w2', 'cnv_2']) {
    const btn = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === id, `toggle for ${id}`)
    assert.equal(textOf(btn), '☆ Pin')
  }

  assert.equal(remote.illegal.length, 0)
  await mounted.cleanup()
})

test('loading state when snapshot is null: displays loading indicator, not fake 0 items', async () => {
  // Pass snapshot promise that does not resolve synchronously to test loading state
  let resolveSnapshot
  const pendingSnapshotPromise = new Promise((resolve) => { resolveSnapshot = resolve })
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot: () => pendingSnapshotPromise, status: scenarioStatus, ledgers: [] })
  const mounted = await mountClientApplication({
    source,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  // Before settle, snapshot is null
  const root = runtime.getRoot()
  const quickAccess = requireOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access', 'quick-access section')
  const qaText = textOf(quickAccess)

  assert.ok(qaText.includes('(Loading…)'), 'header discloses (Loading…)')
  assert.ok(!qaText.includes('(0)'), 'must not show fake (0)')
  assert.ok(findOne(quickAccess, (node) => node.props?.['data-wo-quick-access-loading'] === 'true') !== null, 'loading container present')

  // Clean up promise
  resolveSnapshot({ ok: true, value: scenarioSnapshot })
  await runtime.settle()
  await mounted.cleanup()
})

test('favorite project, workspace, and conversation; idempotent toggle; same-title nodes independent', async () => {
  const { runtime, remote, mounted } = await setupQuickAccessComponent()
  let root = runtime.getRoot()

  // 1. Favorite p1_sub (project)
  const toggleP1Sub = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === 'p1_sub', 'toggle p1_sub')
  toggleP1Sub.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Favorite w1 (workspace)
  root = runtime.getRoot()
  const toggleW1 = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === 'w1', 'toggle w1')
  toggleW1.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Favorite cnv_1 (conversation with SharedTitle)
  root = runtime.getRoot()
  const toggleCnv1 = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === 'cnv_1', 'toggle cnv_1')
  toggleCnv1.props.onClick(mockEvent())
  await runtime.settle()

  // 4. Favorite cnv_2 (conversation with same SharedTitle in Branch 2)
  root = runtime.getRoot()
  const toggleCnv2 = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === 'cnv_2', 'toggle cnv_2')
  toggleCnv2.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const quickAccess = requireOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access', 'quick-access section')
  assert.ok(textOf(quickAccess).includes('(4)'), 'header shows (4) items')

  // Check rows in order
  const rows = findAll(quickAccess, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1_sub', 'w1', 'cnv_1', 'cnv_2'])

  // Verify same-title conversations are independent and display distinct paths
  const title1 = requireOne(rows[2], (node) => node.props?.['data-wo-quick-access-title'] === 'cnv_1')
  const path1 = requireOne(rows[2], (node) => node.props?.['data-wo-quick-access-path'] === 'cnv_1')
  const title2 = requireOne(rows[3], (node) => node.props?.['data-wo-quick-access-title'] === 'cnv_2')
  const path2 = requireOne(rows[3], (node) => node.props?.['data-wo-quick-access-path'] === 'cnv_2')

  assert.equal(textOf(title1), 'SharedTitle')
  assert.equal(textOf(title2), 'SharedTitle')
  assert.equal(textOf(path1), 'Branch 1 Project / Branch 1 Subproject / SharedTitle')
  assert.equal(textOf(path2), 'Branch 2 Project / Branch 2 Subproject / SharedTitle')

  // Verify tree button labels updated to "★ Pin"
  for (const id of ['p1_sub', 'w1', 'cnv_1', 'cnv_2']) {
    const btn = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === id, `toggle for ${id}`)
    assert.equal(textOf(btn), '★ Pin')
  }

  // Idempotent unfavorite: clicking toggle on w1 removes it
  const toggleW1Again = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === 'w1', 'toggle w1 again')
  toggleW1Again.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const remainingRows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(remainingRows.map((r) => r.props['data-wo-quick-access-row']), ['p1_sub', 'cnv_1', 'cnv_2'])

  // w1 button in tree is back to "☆ Pin"
  const toggleW1After = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === 'w1')
  assert.equal(textOf(toggleW1After), '☆ Pin')

  assert.equal(remote.illegal.length, 0)
  await mounted.cleanup()
})

test('manual reordering (Up/Down) and boundary disablement without mutating snapshot or calling remote', async () => {
  const { runtime, remote, mounted } = await setupQuickAccessComponent()
  let root = runtime.getRoot()

  // Add 3 items: p1_sub, w1, cnv_1
  for (const id of ['p1_sub', 'w1', 'cnv_1']) {
    const btn = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === id)
    btn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  const snapshotBeforeJson = canonicalJson(scenarioSnapshot)

  // Current order: ['p1_sub', 'w1', 'cnv_1']
  // Check boundaries:
  // p1_sub (index 0): up is disabled, down is enabled
  const up0 = requireOne(root, (node) => node.props?.['data-wo-quick-access-up'] === 'p1_sub')
  const down0 = requireOne(root, (node) => node.props?.['data-wo-quick-access-down'] === 'p1_sub')
  assert.equal(up0.props.disabled, true, 'index 0 up must be disabled')
  assert.equal(down0.props.disabled, false, 'index 0 down must be enabled')

  // cnv_1 (index 2): up is enabled, down is disabled
  const up2 = requireOne(root, (node) => node.props?.['data-wo-quick-access-up'] === 'cnv_1')
  const down2 = requireOne(root, (node) => node.props?.['data-wo-quick-access-down'] === 'cnv_1')
  assert.equal(up2.props.disabled, false, 'last index up must be enabled')
  assert.equal(down2.props.disabled, true, 'last index down must be disabled')

  // Move w1 (index 1) UP: swaps with p1_sub
  const up1 = requireOne(root, (node) => node.props?.['data-wo-quick-access-up'] === 'w1')
  up1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let rows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['w1', 'p1_sub', 'cnv_1'])

  // Move cnv_1 (index 2) UP: swaps with p1_sub
  const upCnv1 = requireOne(root, (node) => node.props?.['data-wo-quick-access-up'] === 'cnv_1')
  upCnv1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  rows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['w1', 'cnv_1', 'p1_sub'])

  // Move w1 (index 0) DOWN: swaps with cnv_1
  const downW1 = requireOne(root, (node) => node.props?.['data-wo-quick-access-down'] === 'w1')
  downW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  rows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['cnv_1', 'w1', 'p1_sub'])

  // Verify snapshot immutability: deep check that original snapshot is untouched
  const snapshotAfterJson = canonicalJson(scenarioSnapshot)
  assert.equal(snapshotBeforeJson, snapshotAfterJson, 'snapshot must be strictly unmodified')

  // Verify zero Remote RPC calls (no moveNode, no sync)
  assert.equal(remote.illegal.length, 0)
  assert.equal(remote.calls.filter((c) => c.method !== 'snapshot' && c.method !== 'status').length, 0)

  await mounted.cleanup()
})

test('removal via Quick Access row remove button purges item and restores tree toggle button', async () => {
  const { runtime, remote, mounted } = await setupQuickAccessComponent()
  let root = runtime.getRoot()

  // Add 3 items
  for (const id of ['p1_sub', 'w1', 'cnv_1']) {
    const btn = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === id)
    btn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  // Remove middle item: w1
  const removeW1 = requireOne(root, (node) => node.props?.['data-wo-quick-access-remove'] === 'w1')
  removeW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let rows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1_sub', 'cnv_1'])

  // w1 toggle in tree is "☆ Pin"
  assert.equal(textOf(requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === 'w1')), '☆ Pin')

  // Remove head item: p1_sub
  const removeHead = requireOne(root, (node) => node.props?.['data-wo-quick-access-remove'] === 'p1_sub')
  removeHead.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  rows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['cnv_1'])

  // Remove last item: cnv_1
  const removeLast = requireOne(root, (node) => node.props?.['data-wo-quick-access-remove'] === 'cnv_1')
  removeLast.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Now empty
  assert.ok(findOne(root, (node) => node.props?.['data-wo-quick-access-empty'] === 'true') !== null)

  assert.equal(remote.illegal.length, 0)
  await mounted.cleanup()
})

test('dynamic resolution reflects snapshot rename and move without losing position', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const { runtime, remote, mounted } = await setupQuickAccessComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot })
  })
  let root = runtime.getRoot()

  // Favorite cnv_1 and w1
  for (const id of ['cnv_1', 'w1']) {
    const btn = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === id)
    btn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  // Update snapshot: rename cnv_1 and move w1 under p2_sub
  const updatedSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const cnvNode = updatedSnapshot.nodes.find((n) => n.id === 'cnv_1')
  cnvNode.title = 'RenamedConversation'
  const w1Node = updatedSnapshot.nodes.find((n) => n.id === 'w1')
  w1Node.parentId = 'p2_sub'
  currentSnapshot = updatedSnapshot

  // Trigger refresh
  const refreshBtn = requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  const rows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['cnv_1', 'w1'])

  const cnvTitle = requireOne(rows[0], (node) => node.props?.['data-wo-quick-access-title'] === 'cnv_1')
  const w1Path = requireOne(rows[1], (node) => node.props?.['data-wo-quick-access-path'] === 'w1')

  assert.equal(textOf(cnvTitle), 'RenamedConversation')
  assert.equal(textOf(w1Path), 'Branch 2 Project / Branch 2 Subproject / Workspace 1')

  assert.equal(remote.illegal.length, 0)
  await mounted.cleanup()
})

test('stale snapshot: displays stale banner, disables toggle/up/down/locate, but permits remove', async () => {
  let shouldFail = false
  const { runtime, remote, mounted } = await setupQuickAccessComponent({
    snapshot: () => {
      if (shouldFail) {
        return { ok: false, error: { message: 'Network disconnected' } }
      }
      return { ok: true, value: scenarioSnapshot }
    }
  })
  let root = runtime.getRoot()

  // Favorite p1_sub and w1
  for (const id of ['p1_sub', 'w1']) {
    const btn = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === id)
    btn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  // Cause refresh failure -> snapshotStale becomes true
  shouldFail = true
  const refreshBtn = requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  // Stale banner in quick-access
  const staleBanner = requireOne(root, (node) => node.props?.['data-wo-quick-access-stale'] === 'true')
  assert.ok(textOf(staleBanner).includes('快照已陈旧'), 'stale banner visible')

  // Up/down buttons are disabled
  const down0 = requireOne(root, (node) => node.props?.['data-wo-quick-access-down'] === 'p1_sub')
  assert.equal(down0.props.disabled, true, 'down disabled when stale')

  // Locate button is disabled
  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-quick-access-locate'] === 'p1_sub')
  assert.equal(locateBtn.props.disabled, true, 'locate disabled when stale')

  // Tree toggle is disabled
  const treeToggle = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === 'cnv_1')
  assert.equal(treeToggle.props.disabled, true, 'tree toggle disabled when stale')

  // BUT Remove button is NOT disabled
  const removeBtn = requireOne(root, (node) => node.props?.['data-wo-quick-access-remove'] === 'w1')
  assert.equal(removeBtn.props.disabled ?? false, false, 'remove allowed when stale')

  // Clicking remove successfully removes w1 even while stale
  removeBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const rows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1_sub'])

  assert.equal(remote.illegal.length, 0)
  await mounted.cleanup()
})

test('garbage collection: deleted nodes purged only on new successful snapshot; stale refresh does not purge; no auto-revival', async () => {
  let mode = 'normal' // 'normal' | 'error' | 'deleted' | 'readded'
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))

  const { runtime, remote, mounted } = await setupQuickAccessComponent({
    snapshot: () => {
      if (mode === 'error') return { ok: false, error: { message: 'RPC failure' } }
      return { ok: true, value: currentSnapshot }
    }
  })
  let root = runtime.getRoot()

  // Favorite p1_sub and cnv_1
  for (const id of ['p1_sub', 'cnv_1']) {
    const btn = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === id)
    btn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  // 1. Refresh fails with error -> stale -> items MUST NOT be purged
  mode = 'error'
  const refreshBtn = requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  let rows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1_sub', 'cnv_1'], 'stale does not purge')

  // 2. Successful snapshot where cnv_1 is physically removed from nodes
  mode = 'deleted'
  const deletedSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  deletedSnapshot.nodes = deletedSnapshot.nodes.filter((n) => n.id !== 'cnv_1')
  currentSnapshot = deletedSnapshot

  refreshBtn.props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  rows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1_sub'], 'cnv_1 purged on successful snapshot')

  // 3. cnv_1 reappears in a subsequent snapshot -> MUST NOT auto-revive
  mode = 'readded'
  currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))

  refreshBtn.props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  rows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1_sub'], 'cnv_1 must not auto-revive from old closure')

  assert.equal(remote.illegal.length, 0)
  await mounted.cleanup()
})

test('locate tree node integration (FP-92): reveals projects tree, selects target, zero session open or new RPC', async () => {
  const querySelectorCalls = []
  const scrollIntoViewCalls = []
  const fakeDocument = {
    querySelector: (selector) => {
      querySelectorCalls.push(selector)
      if (selector === '[data-wo-node-id="cnv_1"]') {
        return {
          scrollIntoView: (options) => {
            scrollIntoViewCalls.push({ selector, options })
          }
        }
      }
      return null
    }
  }

  const { runtime, remote, mounted } = await setupQuickAccessComponent({
    document: fakeDocument
  })
  let root = runtime.getRoot()

  // Favorite cnv_1
  const toggleBtn = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === 'cnv_1')
  toggleBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Hide projects section
  root = runtime.getRoot()
  const hideProjectsBtn = requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'projects')
  hideProjectsBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Collapse p1
  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects'), null, 'projects hidden')

  // In Quick Access, click Locate on cnv_1
  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-quick-access-locate'] === 'cnv_1')
  locateBtn.props.onClick(mockEvent())
  await runtime.settle()
  await sleep(20)
  await runtime.settle()

  root = runtime.getRoot()
  // Projects section is revealed!
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects') !== null, 'projects section revealed')

  // cnv_1 is selected
  const cnvRow = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'cnv_1')
  assert.equal(cnvRow.props['data-wo-selected'], 'true', 'cnv_1 selected')

  // Ancestors p1 and p1_sub are uncollapsed
  assert.equal(requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'p1').props['aria-expanded'], 'true')
  assert.equal(requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'p1_sub').props['aria-expanded'], 'true')

  // DOM scroll was called on tree row
  assert.ok(querySelectorCalls.includes('[data-wo-node-id="cnv_1"]'))
  assert.equal(scrollIntoViewCalls.length, 1)

  // Zero illegal RPC
  assert.equal(remote.illegal.length, 0)

  // Ordinary click on Quick Access row does not open session or scroll
  const initialScrolls = scrollIntoViewCalls.length
  const qaRow = requireOne(root, (node) => node.props?.['data-wo-quick-access-row'] === 'cnv_1')
  qaRow.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(scrollIntoViewCalls.length, initialScrolls, 'ordinary click must not trigger scroll')

  await mounted.cleanup()
})

test('selector isolation: Quick Access rows use data-wo-quick-access-row and do NOT have data-wo-node-id', async () => {
  const { runtime, remote, mounted } = await setupQuickAccessComponent()
  let root = runtime.getRoot()

  // Favorite p1_sub and w1
  for (const id of ['p1_sub', 'w1']) {
    const btn = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === id)
    btn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  const quickAccess = requireOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access')
  const qaRows = findAll(quickAccess, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.equal(qaRows.length, 2)

  // None of the Quick Access rows or their descendants must possess data-wo-node-id
  for (const row of qaRows) {
    assert.equal(row.props['data-wo-node-id'], undefined, 'QA row must NOT have data-wo-node-id')
    const contaminated = findOne(row, (node) => node.props?.['data-wo-node-id'] !== undefined)
    assert.equal(contaminated, null, 'no descendant of QA row can have data-wo-node-id')
  }

  // Projects section still has data-wo-node-id
  const projects = requireOne(root, (node) => node.props?.['data-wo-section'] === 'projects')
  const treeRows = findAll(projects, (node) => node.props?.['data-wo-node-id'] !== undefined)
  assert.ok(treeRows.length > 0, 'tree rows have data-wo-node-id')

  await mounted.cleanup()
})

test('section hide and restore preserves Quick Access items and user ordering', async () => {
  const { runtime, remote, mounted } = await setupQuickAccessComponent()
  let root = runtime.getRoot()

  // Add 3 items in order
  for (const id of ['p1_sub', 'w1', 'cnv_1']) {
    const btn = requireOne(root, (node) => node.props?.['data-wo-quick-access-toggle'] === id)
    btn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  // Reorder: move cnv_1 UP
  const upCnv1 = requireOne(root, (node) => node.props?.['data-wo-quick-access-up'] === 'cnv_1')
  upCnv1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let rows = findAll(root, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1_sub', 'cnv_1', 'w1'])

  // Hide Quick Access section
  const hideBtn = requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'quick-access')
  hideBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access'), null, 'section hidden')

  // Restore Quick Access section
  const restoreBtn = requireOne(root, (node) => node.props?.['data-wo-restore-section'] === 'quick-access')
  restoreBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const restoredQA = requireOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access')
  rows = findAll(restoredQA, (node) => node.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1_sub', 'cnv_1', 'w1'], 'order preserved after restore')

  assert.equal(remote.illegal.length, 0)
  await mounted.cleanup()
})
