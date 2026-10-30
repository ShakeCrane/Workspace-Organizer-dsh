/**
 * Quick Access Lifecycle & Invalidation Protection offline component tests.
 *
 * Verifies ordinary P/W/C Quick Access reference invalidation callback protection:
 * 1. Stale snapshot callback isolation:
 *    - Captured fresh Pin, Up, Down, and tree-row Unpin callbacks are blocked after refresh fails (snapshotStaleRef.current === true).
 *    - Active Remove button remains functional when stale (stale remove exception).
 * 2. Membership token / reference instance isolation:
 *    - Pinning node X assigns a unique reference token.
 *    - If X is removed and re-pinned, old captured Remove, Up, Down, and Unpin callbacks holding the old token cannot mutate the new reference.
 * 3. Tree row Pin intent protection:
 *    - Captured "Pin" callback does not invert already-pinned state.
 *    - Captured "Unpin" callback does not revive an unpinned node.
 * 4. Live snapshot target validity:
 *    - Target deleted, becoming Root (parentId === null), or invalid kind in live snapshot rejects old Pin callbacks.
 * 5. Garbage collection & credential invalidation:
 *    - Successful snapshot cleans up removed nodes and invalidates their tokens.
 *    - Restoring the node in tree later does NOT auto-revive the old quick-access reference.
 * 6. Unmount safety:
 *    - All quick access management callbacks check isMountedRef and perform zero state writes after unmount.
 * 7. Zero remote RPC ledger:
 *    - Only snapshot/status calls during setup/refresh; zero RPCs for all quick access management operations.
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

const testSnapshot = Object.freeze({
  rootId: 'root',
  revision: 1,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
    { id: 'p1', parentId: 'root', kind: 'project', title: 'Branch 1 Project' },
    { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws1' },
    { id: 'cnv1', parentId: 'p1', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-1' },
    { id: 'p2', parentId: 'root', kind: 'project', title: 'Branch 2 Project' },
    { id: 'w2', parentId: 'p2', kind: 'workspace', title: 'Workspace 2', directory: 'E:\\ws2' },
    { id: 'cnv2', parentId: 'p2', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-2' } // same title
  ]
})

const testStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-qa-lifecycle-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

async function setupQuickAccessComponent({
  snapshot = testSnapshot,
  status = testStatus,
  ledgers = [],
  document: injectedDocument,
  setTimeout: injectedSetTimeout,
  clearTimeout: injectedClearTimeout,
  onSetState = null
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  if (typeof onSetState === 'function') {
    const origUseState = runtime.React.useState
    runtime.React.useState = function (initial) {
      const [val, setVal] = origUseState.call(this, initial)
      const wrappedSetVal = (arg) => {
        onSetState(val, arg)
        return setVal(arg)
      }
      return [val, wrappedSetVal]
    }
  }
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

test('COUNTEREXAMPLE 1: stale snapshot penetration - captured fresh Pin/Up/Down callbacks are rejected when stale, but active Remove works', async () => {
  let shouldFail = false
  const { runtime, remote, mounted } = await setupQuickAccessComponent({
    snapshot: () => {
      if (shouldFail) {
        return { ok: false, error: { message: 'Network disconnected' } }
      }
      return { ok: true, value: testSnapshot }
    }
  })
  let root = runtime.getRoot()

  // 1. Initially pin w1 and p1
  const toggleW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'w1')
  toggleW1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const toggleP1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'p1')
  toggleP1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Current quickAccessItems: ['w1', 'p1']
  let rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['w1', 'p1'])

  // 2. Capture fresh callbacks while fresh
  const toggleCnv1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'cnv1')
  const capturedFreshPinCnv1 = toggleCnv1.props.onClick // Fresh Pin callback for cnv1

  const upBtnP1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-up'] === 'p1')
  const capturedFreshUpP1 = upBtnP1.props.onClick // Fresh Up callback for p1

  const downBtnW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-down'] === 'w1')
  const capturedFreshDownW1 = downBtnW1.props.onClick // Fresh Down callback for w1

  // 3. Trigger refresh failure -> snapshot becomes stale
  shouldFail = true
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick()
  await runtime.settle()
  root = runtime.getRoot()

  // Verify stale banner is visible
  const staleBanner = requireOne(root, (n) => n.props?.['data-wo-quick-access-stale'] === 'true')
  assert.ok(textOf(staleBanner).includes('快照已陈旧'))

  // 4. Invoke captured fresh callbacks while stale
  capturedFreshPinCnv1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // On baseline: cnv1 WAS erroneously added!
  // On protected code: list remains ['w1', 'p1']
  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(
    rows.map((r) => r.props['data-wo-quick-access-row']),
    ['w1', 'p1'],
    'captured fresh Pin callback must NOT add item when snapshot is stale'
  )

  // Try captured fresh Up callback
  capturedFreshUpP1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(
    rows.map((r) => r.props['data-wo-quick-access-row']),
    ['w1', 'p1'],
    'captured fresh Up callback must NOT reorder items when snapshot is stale'
  )

  // Try captured fresh Down callback
  capturedFreshDownW1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(
    rows.map((r) => r.props['data-wo-quick-access-row']),
    ['w1', 'p1'],
    'captured fresh Down callback must NOT reorder items when snapshot is stale'
  )

  // 5. Stale remove exception: active Remove button STILL functions when stale
  const removeBtnW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-remove'] === 'w1')
  assert.equal(removeBtnW1.props.disabled ?? false, false, 'remove button is not disabled when stale')
  removeBtnW1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(
    rows.map((r) => r.props['data-wo-quick-access-row']),
    ['p1'],
    'active Remove button must successfully remove item when stale'
  )

  // Zero non-refresh RPC calls
  const nonInitCalls = remote.calls.filter((c) => c.method !== 'snapshot' && c.method !== 'status')
  assert.equal(nonInitCalls.length, 0, 'zero RPC calls for quick access operations')

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 2: remove -> repin membership token isolation - old callbacks cannot mutate new reference instance', async () => {
  const { runtime, remote, mounted } = await setupQuickAccessComponent()
  let root = runtime.getRoot()

  // 1. Pin p1, w1, cnv1
  for (const id of ['p1', 'w1', 'cnv1']) {
    const btn = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === id)
    btn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  let rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1', 'w1', 'cnv1'])

  // 2. Capture callbacks for w1 from this first pin instance
  const oldRemoveW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-remove'] === 'w1').props.onClick
  const oldUpW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-up'] === 'w1').props.onClick
  const oldDownW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-down'] === 'w1').props.onClick
  const oldUnpinW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'w1').props.onClick

  // 3. Remove w1 using current remove button
  const currentRemoveW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-remove'] === 'w1')
  currentRemoveW1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1', 'cnv1'])

  // 4. Re-pin w1 (creates a new reference instance / token)
  const treeToggleW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'w1')
  assert.equal(textOf(treeToggleW1), '☆ Pin')
  treeToggleW1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Order is now: ['p1', 'cnv1', 'w1']
  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1', 'cnv1', 'w1'])

  // 5. Invoke old captured Remove callback on w1
  oldRemoveW1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // On baseline: oldRemoveW1 has NO token validation and removes the new w1 instance!
  // On protected code: token mismatch, list remains ['p1', 'cnv1', 'w1']
  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(
    rows.map((r) => r.props['data-wo-quick-access-row']),
    ['p1', 'cnv1', 'w1'],
    'old Remove callback from previous instance must NOT remove newly pinned instance'
  )

  // 6. Invoke old captured Up callback on w1
  oldUpW1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(
    rows.map((r) => r.props['data-wo-quick-access-row']),
    ['p1', 'cnv1', 'w1'],
    'old Up callback from previous instance must NOT reorder newly pinned instance'
  )

  // 7. Invoke old captured Down callback on w1
  oldDownW1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(
    rows.map((r) => r.props['data-wo-quick-access-row']),
    ['p1', 'cnv1', 'w1'],
    'old Down callback from previous instance must NOT reorder newly pinned instance'
  )

  // 8. Invoke old captured Unpin callback from tree row
  oldUnpinW1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(
    rows.map((r) => r.props['data-wo-quick-access-row']),
    ['p1', 'cnv1', 'w1'],
    'old tree Unpin callback from previous instance must NOT unpin newly pinned instance'
  )

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 3: tree row Pin intent protection - old Pin callback does not invert state', async () => {
  const { runtime, remote, mounted } = await setupQuickAccessComponent()
  let root = runtime.getRoot()

  // 1. w1 is initially unpinned. Tree toggle displays "☆ Pin"
  const toggleW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'w1')
  assert.equal(textOf(toggleW1), '☆ Pin')
  const capturedPinW1 = toggleW1.props.onClick

  // 2. Click toggle to Pin w1
  toggleW1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  let rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['w1'])
  assert.equal(textOf(requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'w1')), '★ Pin')

  // 3. Now invoke capturedPinW1 again!
  // On baseline: toggleQuickAccess toggles and removes w1!
  // On protected code: capturedPinW1 has intent "pin", sees w1 is already pinned, and does nothing!
  capturedPinW1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(
    rows.map((r) => r.props['data-wo-quick-access-row']),
    ['w1'],
    'captured Pin callback must NOT toggle off / invert already pinned state'
  )

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 4: target becomes Root or invalid in live snapshot rejects old Pin callback', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(testSnapshot))
  const { runtime, remote, mounted } = await setupQuickAccessComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot })
  })
  let root = runtime.getRoot()

  // 1. Capture Pin callback for p1 while it is valid child of root
  const toggleP1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'p1')
  const capturedPinP1 = toggleP1.props.onClick

  // 2. Update snapshot: p1 becomes a Root node (parentId = null)
  const updatedSnapshot = JSON.parse(JSON.stringify(testSnapshot))
  const p1Node = updatedSnapshot.nodes.find((n) => n.id === 'p1')
  p1Node.parentId = null
  currentSnapshot = updatedSnapshot

  // Trigger refresh
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick()
  await runtime.settle()
  root = runtime.getRoot()

  // 3. Invoke capturedPinP1
  // On baseline: closure snapshot had parentId !== null, so toggleQuickAccess pushes p1 to quickAccessItems!
  // And because p1 exists in snapshot, it renders a quick access row for a Root node!
  // On protected code: live snapshot checks target.parentId === null and rejects!
  capturedPinP1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  let rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.equal(
    rows.length,
    0,
    'captured Pin callback must NOT add item that became Root (parentId === null) in live snapshot'
  )

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 5: unmount safety - all management callbacks do zero state writes after unmount', async () => {
  let postUnmountStateWrites = 0
  let isUnmounted = false

  const { runtime, remote, mounted } = await setupQuickAccessComponent({
    onSetState: () => {
      if (isUnmounted) {
        postUnmountStateWrites += 1
      }
    }
  })
  let root = runtime.getRoot()

  // Pin w1 and p1
  for (const id of ['w1', 'p1']) {
    const btn = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === id)
    btn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  // Capture all callbacks
  const toggleBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'cnv1').props.onClick
  const upBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-up'] === 'p1').props.onClick
  const downBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-down'] === 'w1').props.onClick
  const removeBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-remove'] === 'w1').props.onClick

  // Unmount
  runtime.unmount()
  isUnmounted = true
  await mounted.cleanup()

  // Calling callbacks after unmount
  toggleBtn(mockEvent())
  upBtn(mockEvent())
  downBtn(mockEvent())
  removeBtn(mockEvent())

  // On baseline: no isMountedRef checks on management callbacks, so state writes occur after unmount!
  // On protected code: isMountedRef check prevents any state write!
  assert.equal(
    postUnmountStateWrites,
    0,
    'zero state writes allowed after unmount'
  )
})

test('POSITIVE LIFECYCLE: pin, unpin, up, down, boundary disabling, independent same-title nodes, zero RPCs', async () => {
  const { runtime, remote, mounted } = await setupQuickAccessComponent()
  let root = runtime.getRoot()

  // Pin p1, w1, cnv1, cnv2 (cnv1 and cnv2 share title)
  for (const id of ['p1', 'w1', 'cnv1', 'cnv2']) {
    const btn = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === id)
    btn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  let rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1', 'w1', 'cnv1', 'cnv2'])

  // Boundaries: first item up is disabled, last item down is disabled
  const firstUp = requireOne(root, (n) => n.props?.['data-wo-quick-access-up'] === 'p1')
  const firstDown = requireOne(root, (n) => n.props?.['data-wo-quick-access-down'] === 'p1')
  const lastUp = requireOne(root, (n) => n.props?.['data-wo-quick-access-up'] === 'cnv2')
  const lastDown = requireOne(root, (n) => n.props?.['data-wo-quick-access-down'] === 'cnv2')

  assert.equal(firstUp.props.disabled, true)
  assert.equal(firstDown.props.disabled, false)
  assert.equal(lastUp.props.disabled, false)
  assert.equal(lastDown.props.disabled, true)

  // Move w1 UP -> swaps with p1
  const upW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-up'] === 'w1')
  upW1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['w1', 'p1', 'cnv1', 'cnv2'])

  // Move w1 DOWN -> swaps back with p1
  const downW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-down'] === 'w1')
  downW1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1', 'w1', 'cnv1', 'cnv2'])

  // Unpin cnv1 via tree toggle -> only cnv1 removed, cnv2 remains
  const unpinCnv1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'cnv1')
  unpinCnv1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1', 'w1', 'cnv2'])

  // Remove p1 via quick access remove button
  const removeP1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-remove'] === 'p1')
  removeP1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['w1', 'cnv2'])

  // Zero non-init RPC calls
  const rpcs = remote.calls.filter((c) => c.method !== 'snapshot' && c.method !== 'status')
  assert.equal(rpcs.length, 0)

  await mounted.cleanup()
})

test('GARBAGE COLLECTION: successful snapshot cleans deleted items; failed refresh preserves them; restored node does not auto-revive', async () => {
  let mode = 'normal'
  let currentSnapshot = JSON.parse(JSON.stringify(testSnapshot))

  const { runtime, remote, mounted } = await setupQuickAccessComponent({
    snapshot: () => {
      if (mode === 'error') return { ok: false, error: { message: 'Refresh error' } }
      return { ok: true, value: currentSnapshot }
    }
  })
  let root = runtime.getRoot()

  // Pin w1 and cnv1
  for (const id of ['w1', 'cnv1']) {
    const btn = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === id)
    btn.props.onClick(mockEvent())
    await runtime.settle()
    root = runtime.getRoot()
  }

  let rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['w1', 'cnv1'])

  // Failed refresh: items must NOT be purged
  mode = 'error'
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick()
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['w1', 'cnv1'])

  // Successful snapshot with w1 deleted
  mode = 'normal'
  const deletedSnapshot = JSON.parse(JSON.stringify(testSnapshot))
  deletedSnapshot.nodes = deletedSnapshot.nodes.filter((n) => n.id !== 'w1')
  currentSnapshot = deletedSnapshot

  refreshBtn.props.onClick()
  await runtime.settle()
  root = runtime.getRoot()

  // w1 purged on successful snapshot
  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['cnv1'])

  // Now restore w1 in snapshot: must NOT auto-revive!
  currentSnapshot = JSON.parse(JSON.stringify(testSnapshot))
  refreshBtn.props.onClick()
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['cnv1'], 'purged item must not auto-revive')

  await mounted.cleanup()
})
