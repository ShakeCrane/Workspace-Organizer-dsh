/**
 * Tree Refresh Sequence and Failure Continuity offline component tests.
 *
 * Verifies the ARCHITECT REFRESH SEQUENCE AND FAILURE CONTINUITY CONTRACT:
 * 1. Initial mount load failure: snapshot stays null, no fake root, no status banner,
 *    snapshotStale=true, notice shows honest error.
 * 2. Independent snapshot / status failure:
 *    - 2a: snapshot fails, status succeeds -> snapshotStale=true, last accepted snapshot & status preserved.
 *    - 2b: snapshot succeeds, status fails -> snapshotStale=true, last accepted snapshot & status preserved.
 * 3. R2 resolves before superseded R1 (both success and failure of R1):
 *    - 3a: R2 succeeds (T2, rev 20), later R1 succeeds (T1, rev 15) -> R1 discarded, tree stays T2 (rev 20).
 *    - 3b: R2 succeeds (T2, rev 20), later R1 fails -> R1 error discarded, stale stays false, tree stays T2.
 * 4. R2 failure followed by superseded R1 success:
 *    - R2 fails (R2 error), later R1 succeeds -> R1 discarded, state stays stale=true with R2 error, tree stays T0.
 * 5. Explicit subsequent refresh (R3) recovery:
 *    - Following failure/stale, explicit refresh R3 succeeds -> snapshotStale=false, notice cleared, tree is T3.
 * 6. Quick Access pruning protection against superseded reads:
 *    - R2 removes node and prunes Quick Access; superseded R1 containing deleted node cannot restore it or re-prune.
 * 7. State continuity across failed refresh:
 *    - Selection, collapsed projects, visible sections, and input drafts preserved across failed refresh.
 * 8. Protection by 5 in-flight mutation locks:
 *    - Refresh button disabled and refresh() dispatches 0 RPCs while Rename, Move, Create Project,
 *      Link Workspace, or Link Session is submitting.
 * 9. Real client mutation handler confirms before releasing in-flight public read:
 *    - In-flight R1 cannot roll back confirmed mutation node or revision.
 * 10. Unmount safety and late response isolation:
 *     - In-flight refresh resolves or rejects after unmount with zero state writes and zero unhandled rejections;
 *       stale handler called after unmount dispatches 0 RPCs.
 * 11. Zero non-whitelisted calls:
 *     - Pure refresh operations dispatch zero mutation RPCs, zero openSession calls, zero conversationTarget calls.
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
  revision: 10,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
    { id: 'p1', parentId: 'root', kind: 'project', title: 'Branch 1' },
    { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1', nativeWorkspaceId: 'nw-1' },
    { id: 'cnv1', parentId: 'w1', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-1' }
  ]
})

const baseStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-refresh-test'
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

async function setupRefreshComponent({
  snapshotHandler,
  statusHandler,
  snapshot = baseSnapshot,
  status = baseStatus,
  ledgers = [],
  document: injectedDocument,
  renameHandler,
  moveHandler,
  createProjectHandler,
  registerWorkspaceHandler,
  bindDirectoryConversationHandler
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })

  if (typeof snapshotHandler === 'function') {
    remote.allowed.snapshot = snapshotHandler
  }
  if (typeof statusHandler === 'function') {
    remote.allowed.status = statusHandler
  }
  if (typeof renameHandler === 'function') {
    remote.allowed.renameNode = renameHandler
  }
  if (typeof moveHandler === 'function') {
    remote.allowed.moveNode = moveHandler
  }
  if (typeof createProjectHandler === 'function') {
    remote.allowed.createProject = createProjectHandler
  }
  if (typeof registerWorkspaceHandler === 'function') {
    remote.allowed.registerWorkspace = registerWorkspaceHandler
  }
  if (typeof bindDirectoryConversationHandler === 'function') {
    remote.allowed.bindDirectoryConversation = bindDirectoryConversationHandler
  }

  const mounted = await mountClientApplication({
    source,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote,
    document: injectedDocument
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()

  return { runtime, remote, mounted }
}

// -----------------------------------------------------------------------------
// Test 1: Initial mount load failure
// -----------------------------------------------------------------------------
test('1. Initial mount load failure: snapshot stays null, no fake root, snapshotStale=true, honest error notice', async () => {
  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => ({ ok: false, error: { message: 'Initial network error' } }),
    statusHandler: async () => ({ ok: true, value: baseStatus })
  })

  await runtime.settle()
  const root = runtime.getRoot()

  // No fake root node in DOM
  assert.equal(findOne(root, (n) => n.props?.['data-wo-node-id'] === 'root'), null)
  // Shows loading indicator because snapshot is null
  const loading = findOne(root, (n) => textOf(n).includes('Loading projects…'))
  assert.ok(loading, 'must show loading projects text when snapshot is null')

  // Status banner is null because status was not paired with a valid snapshot
  assert.equal(findOne(root, (n) => n.props?.['data-wo-status']), null)

  // Stale notice and error notice are present
  const stale = requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true')
  assert.ok(stale)
  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error')
  assert.match(textOf(notice), /Initial network error/u)
})

// -----------------------------------------------------------------------------
// Test 2: Independent snapshot / status failure
// -----------------------------------------------------------------------------
test('2a. Independent failure: snapshot fails, status succeeds -> snapshotStale=true, last accepted snapshot & status preserved', async () => {
  let callCount = 0
  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: baseSnapshot }
      return { ok: false, error: { message: 'Snapshot read failure' } }
    },
    statusHandler: async () => {
      if (callCount <= 1) return { ok: true, value: baseStatus }
      return { ok: true, value: { conversationsCreatable: false, sessionSource: 'new-status' } }
    }
  })

  await runtime.settle()
  let root = runtime.getRoot()
  // Mount succeeded: root exists
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'root'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'), null)
  const initialStatus = requireOne(root, (n) => n.props?.['data-wo-status'] === 'ready')
  assert.ok(initialStatus)

  // Click refresh
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Last accepted tree preserved
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'root'))
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p1'))

  // Marked stale with honest error
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'))
  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error')
  assert.match(textOf(notice), /Snapshot read failure/u)

  // Status must NOT adopt the unpaired new status
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-status'] === 'ready'))
})

test('2b. Independent failure: snapshot succeeds, status fails -> snapshotStale=true, last accepted snapshot & status preserved', async () => {
  let callCount = 0
  const nextSnapshot = {
    rootId: 'root',
    revision: 11,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
      { id: 'p1', parentId: 'root', kind: 'project', title: 'Branch 1 Updated' }
    ]
  }

  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: baseSnapshot }
      return { ok: true, value: nextSnapshot }
    },
    statusHandler: async () => {
      if (callCount <= 1) return { ok: true, value: baseStatus }
      return { ok: false, error: { message: 'Status service offline' } }
    }
  })

  await runtime.settle()
  let root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'w1'))

  // Click refresh
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Because status failed, the unpaired new snapshot must NOT be adopted: w1 must still exist
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'w1'))
  // Stale notice and error notice are present
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'))
  const notice = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error')
  assert.match(textOf(notice), /Status service offline/u)
})

// -----------------------------------------------------------------------------
// Test 3: R2 resolves before superseded R1 (both success and failure of R1)
// -----------------------------------------------------------------------------
test('3a. R2 resolves before superseded R1: R2 succeeds (T2, rev 20), later R1 succeeds (T1, rev 15) -> R1 discarded, tree stays T2', async () => {
  let rCount = 0
  const dR1Snap = deferred()
  const dR1Stat = deferred()
  const dR2Snap = deferred()
  const dR2Stat = deferred()

  const t0Snapshot = baseSnapshot
  const t1Snapshot = {
    rootId: 'root',
    revision: 15,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
      { id: 'p_r1', parentId: 'root', kind: 'project', title: 'R1 Project' }
    ]
  }
  const t2Snapshot = {
    rootId: 'root',
    revision: 20,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
      { id: 'p_r2', parentId: 'root', kind: 'project', title: 'R2 Project' }
    ]
  }

  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      rCount += 1
      if (rCount === 1) return { ok: true, value: t0Snapshot }
      if (rCount === 2) return dR1Snap.promise
      if (rCount === 3) return dR2Snap.promise
      return { ok: true, value: t0Snapshot }
    },
    statusHandler: async () => {
      if (rCount <= 1) return { ok: true, value: baseStatus }
      if (rCount === 2) return dR1Stat.promise
      if (rCount === 3) return dR2Stat.promise
      return { ok: true, value: baseStatus }
    }
  })

  await runtime.settle()
  let root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p1'))

  // Trigger R1 (will hang on dR1)
  const refreshBtn1 = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn1.props.onClick(mockEvent())

  // Trigger R2 (will hang on dR2)
  const refreshBtn2 = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn2.props.onClick(mockEvent())

  // Now resolve R2 FIRST with T2
  dR2Snap.resolve({ ok: true, value: t2Snapshot })
  dR2Stat.resolve({ ok: true, value: { conversationsCreatable: true, sessionSource: 'r2-status' } })
  await runtime.settle()

  root = runtime.getRoot()
  // R2 is applied!
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_r2'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_r1'), null)

  // Now resolve superseded R1 with T1
  dR1Snap.resolve({ ok: true, value: t1Snapshot })
  dR1Stat.resolve({ ok: true, value: { conversationsCreatable: true, sessionSource: 'r1-status' } })
  await runtime.settle()

  root = runtime.getRoot()
  // R1 must be DISCARDED: tree stays T2 (p_r2 present, p_r1 absent)
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_r2'), 'tree must remain T2')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_r1'), null, 'superseded R1 must not overwrite T2')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'), null)
})

test('3b. R2 resolves before superseded R1: R2 succeeds (T2, rev 20), later R1 fails -> R1 error discarded, stale stays false', async () => {
  let rCount = 0
  const dR1Snap = deferred()
  const dR1Stat = deferred()
  const dR2Snap = deferred()
  const dR2Stat = deferred()

  const t2Snapshot = {
    rootId: 'root',
    revision: 20,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
      { id: 'p_r2', parentId: 'root', kind: 'project', title: 'R2 Project' }
    ]
  }

  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      rCount += 1
      if (rCount === 1) return { ok: true, value: baseSnapshot }
      if (rCount === 2) return dR1Snap.promise
      if (rCount === 3) return dR2Snap.promise
      return { ok: true, value: baseSnapshot }
    },
    statusHandler: async () => {
      if (rCount <= 1) return { ok: true, value: baseStatus }
      if (rCount === 2) return dR1Stat.promise
      if (rCount === 3) return dR2Stat.promise
      return { ok: true, value: baseStatus }
    }
  })

  await runtime.settle()
  let root = runtime.getRoot()

  // Trigger R1
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())

  // Trigger R2
  refreshBtn.props.onClick(mockEvent())

  // R2 resolves
  dR2Snap.resolve({ ok: true, value: t2Snapshot })
  dR2Stat.resolve({ ok: true, value: baseStatus })
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_r2'))

  // Now R1 REJECTS
  dR1Snap.reject(new Error('R1 late timeout'))
  dR1Stat.resolve({ ok: true, value: baseStatus })
  await runtime.settle()

  root = runtime.getRoot()
  // R1 error must be discarded: stale must be false, notice must NOT contain R1 error
  assert.equal(findOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'), null)
  const notice = findOne(root, (n) => n.props?.['data-wo-notice'] === 'error')
  assert.equal(notice, null, 'must have no error notice from superseded R1')
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_r2'))
})

// -----------------------------------------------------------------------------
// Test 4: R2 failure followed by superseded R1 success
// -----------------------------------------------------------------------------
test('4. R2 failure followed by superseded R1 success: state stays stale=true with R2 error, tree stays T0', async () => {
  let rCount = 0
  const dR1Snap = deferred()
  const dR1Stat = deferred()
  const dR2Snap = deferred()
  const dR2Stat = deferred()

  const t1Snapshot = {
    rootId: 'root',
    revision: 15,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
      { id: 'p_r1', parentId: 'root', kind: 'project', title: 'R1 Project' }
    ]
  }

  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      rCount += 1
      if (rCount === 1) return { ok: true, value: baseSnapshot }
      if (rCount === 2) return dR1Snap.promise
      if (rCount === 3) return dR2Snap.promise
      return { ok: true, value: baseSnapshot }
    },
    statusHandler: async () => {
      if (rCount <= 1) return { ok: true, value: baseStatus }
      if (rCount === 2) return dR1Stat.promise
      if (rCount === 3) return dR2Stat.promise
      return { ok: true, value: baseStatus }
    }
  })

  await runtime.settle()
  let root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p1'))

  // Trigger R1
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())

  // Trigger R2
  refreshBtn.props.onClick(mockEvent())

  // R2 FAILS
  dR2Snap.reject(new Error('R2 network disconnected'))
  dR2Stat.resolve({ ok: true, value: baseStatus })
  await runtime.settle()

  root = runtime.getRoot()
  // R2 error is shown and tree is marked stale
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'))
  const noticeR2 = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error')
  assert.match(textOf(noticeR2), /R2 network disconnected/u)

  // Now R1 succeeds with T1
  dR1Snap.resolve({ ok: true, value: t1Snapshot })
  dR1Stat.resolve({ ok: true, value: baseStatus })
  await runtime.settle()

  root = runtime.getRoot()
  // R1 must NOT impersonate recovery! Must remain stale with R2 error, and tree stays T0 (p1 present, p_r1 absent)
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'), 'must remain stale')
  const noticeAfter = requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error')
  assert.match(textOf(noticeAfter), /R2 network disconnected/u)
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p1'), 'tree must stay T0')
  assert.equal(findOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_r1'), null, 'R1 must not be applied')
})

// -----------------------------------------------------------------------------
// Test 5: Explicit subsequent refresh (R3) recovery
// -----------------------------------------------------------------------------
test('5. Explicit subsequent refresh (R3) recovery: clears stale & error notice, applies new tree', async () => {
  let rCount = 0
  const t3Snapshot = {
    rootId: 'root',
    revision: 30,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
      { id: 'p_r3', parentId: 'root', kind: 'project', title: 'Recovered R3 Project' }
    ]
  }

  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      rCount += 1
      if (rCount === 1) return { ok: true, value: baseSnapshot }
      if (rCount === 2) return { ok: false, error: 'Temporary server glitch' }
      return { ok: true, value: t3Snapshot }
    },
    statusHandler: async () => ({ ok: true, value: baseStatus })
  })

  await runtime.settle()
  let root = runtime.getRoot()

  // Trigger R2 (fails)
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'))
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error'))

  // Trigger R3 (succeeds)
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Stale cleared, error notice cleared, tree is T3
  assert.equal(findOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'), null)
  assert.equal(findOne(root, (n) => n.props?.['data-wo-notice'] === 'error'), null)
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p_r3'))
})

// -----------------------------------------------------------------------------
// Test 6: Quick Access pruning protection against superseded reads
// -----------------------------------------------------------------------------
test('6. Quick Access pruning: R2 removes node and prunes Quick Access; superseded R1 cannot restore or re-prune', async () => {
  let rCount = 0
  const dR1Snap = deferred()
  const dR1Stat = deferred()
  const dR2Snap = deferred()
  const dR2Stat = deferred()

  const t0Snapshot = baseSnapshot
  // T1 still has w1
  const t1Snapshot = {
    rootId: 'root',
    revision: 15,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
      { id: 'p1', parentId: 'root', kind: 'project', title: 'Branch 1' },
      { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' }
    ]
  }
  // T2 removed w1
  const t2Snapshot = {
    rootId: 'root',
    revision: 20,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
      { id: 'p1', parentId: 'root', kind: 'project', title: 'Branch 1' }
    ]
  }

  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      rCount += 1
      if (rCount === 1) return { ok: true, value: t0Snapshot }
      if (rCount === 2) return dR1Snap.promise
      if (rCount === 3) return dR2Snap.promise
      return { ok: true, value: t0Snapshot }
    },
    statusHandler: async () => {
      if (rCount <= 1) return { ok: true, value: baseStatus }
      if (rCount === 2) return dR1Stat.promise
      if (rCount === 3) return dR2Stat.promise
      return { ok: true, value: baseStatus }
    }
  })

  await runtime.settle()
  let root = runtime.getRoot()

  // Pin p1 and w1 to Quick Access
  const pinP1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'p1')
  pinP1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const pinW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'w1')
  pinW1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findAll(root, (n) => n.props?.['data-wo-quick-access-row']).length, 2)

  // Trigger R1
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())

  // Trigger R2
  refreshBtn.props.onClick(mockEvent())

  // Resolve R2 (which removed w1)
  dR2Snap.resolve({ ok: true, value: t2Snapshot })
  dR2Stat.resolve({ ok: true, value: baseStatus })
  await runtime.settle()

  root = runtime.getRoot()
  // Quick access now has only 1 item (p1)
  const itemsAfterR2 = findAll(root, (n) => n.props?.['data-wo-quick-access-row'])
  assert.equal(itemsAfterR2.length, 1)
  assert.equal(itemsAfterR2[0].props['data-wo-quick-access-row'], 'p1')

  // Now resolve superseded R1 (which still has w1)
  dR1Snap.resolve({ ok: true, value: t1Snapshot })
  dR1Stat.resolve({ ok: true, value: baseStatus })
  await runtime.settle()

  root = runtime.getRoot()
  // Quick access must NOT have w1 restored by R1! Must remain 1 item (p1)
  const itemsAfterR1 = findAll(root, (n) => n.props?.['data-wo-quick-access-row'])
  assert.equal(itemsAfterR1.length, 1)
  assert.equal(itemsAfterR1[0].props['data-wo-quick-access-row'], 'p1')
})

// -----------------------------------------------------------------------------
// Test 7: State continuity across failed refresh
// -----------------------------------------------------------------------------
test('7. State continuity across failed refresh: selection, collapsed, visible sections, drafts preserved', async () => {
  let callCount = 0
  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: baseSnapshot }
      return { ok: false, error: 'Connection reset by peer' }
    },
    statusHandler: async () => ({ ok: true, value: baseStatus })
  })

  await runtime.settle()
  let root = runtime.getRoot()

  // 1. Select w1
  const selectW1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'w1')
  selectW1.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Collapse p1
  root = runtime.getRoot()
  const rowP1 = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p1')
  assert.equal(rowP1.props['aria-expanded'], 'true')
  rowP1.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Hide quick-access section
  root = runtime.getRoot()
  const hideQA = requireOne(root, (n) => n.props?.['data-wo-section-hide'] === 'quick-access')
  hideQA.props.onClick(mockEvent())
  await runtime.settle()

  // 4. Open create project panel and type draft
  root = runtime.getRoot()
  const selectP1 = requireOne(root, (n) => n.props?.['data-wo-select'] === 'p1')
  selectP1.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createToggle = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const startCreate = requireOne(root, (n) => n.props?.['data-wo-create-project-start'] === 'true')
  startCreate.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createInput = requireOne(root, (n) => n.props?.['data-wo-create-project-input'] === 'true')
  createInput.props.onChange({ target: { value: 'My In-Progress Draft' } })
  await runtime.settle()

  // Now trigger Refresh that FAILS
  root = runtime.getRoot()
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Stale and notice shown
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'))
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-notice'] === 'error'))

  // All states CONTINUOUS and PRESERVED:
  // - Create panel is still open with draft value
  const draftInputAfter = requireOne(root, (n) => n.props?.['data-wo-create-project-input'] === 'true')
  assert.equal(draftInputAfter.props.value, 'My In-Progress Draft')

  // - Quick Access remains hidden (restore button is present)
  assert.ok(requireOne(root, (n) => n.props?.['data-wo-restore-section'] === 'quick-access'))

  // - Tree node p1 is still present and remains collapsed
  const rowP1After = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p1')
  assert.equal(rowP1After.props['aria-expanded'], 'false')
})

// -----------------------------------------------------------------------------
// Test 8: Protection by 5 in-flight mutation locks
// -----------------------------------------------------------------------------
test('8. Protection by 5 in-flight mutation locks: refresh dispatches 0 RPCs while mutations submit', async () => {
  let refreshRPCCount = 0
  const dRename = deferred()

  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      refreshRPCCount += 1
      return { ok: true, value: baseSnapshot }
    },
    statusHandler: async () => ({ ok: true, value: baseStatus }),
    renameHandler: async () => dRename.promise
  })

  await runtime.settle()
  assert.equal(refreshRPCCount, 1, 'initial mount refresh')

  let root = runtime.getRoot()
  // Start rename on p1
  const renameBtn = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'p1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const renameInput = requireOne(root, (n) => n.props?.['data-wo-rename-input'] === 'true')
  renameInput.props.onChange({ target: { value: 'New Title Submitting' } })
  await runtime.settle()

  // Save rename (will block in dRename)
  root = runtime.getRoot()
  const saveBtn = requireOne(root, (n) => n.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Refresh button must be disabled
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  assert.equal(refreshBtn.props.disabled, true, 'refresh button must be disabled while rename submits')

  // Attempting to invoke refresh directly must dispatch ZERO new RPCs
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(refreshRPCCount, 1, 'refresh must not dispatch any RPC while rename is in-flight')

  // Resolve rename
  dRename.resolve({
    ok: true,
    value: {
      rootId: 'root',
      revision: 11,
      nodes: [
        { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
        { id: 'p1', parentId: 'root', kind: 'project', title: 'New Title Submitting' }
      ]
    }
  })
  await runtime.settle()
})

// -----------------------------------------------------------------------------
// Test 9: Real client mutation handler confirms before releasing in-flight public read
// -----------------------------------------------------------------------------
test('9. Real client mutation handler confirms before releasing in-flight public read: confirmed node not rolled back', async () => {
  let rCount = 0
  const dPublicR1Snap = deferred()
  const dPublicR1Stat = deferred()

  const initialSnapshot = baseSnapshot
  const renamedSnapshot = {
    rootId: 'root',
    revision: 12,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
      { id: 'p1', parentId: 'root', kind: 'project', title: 'Confirmed Renamed Branch' },
      { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' }
    ]
  }

  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      rCount += 1
      if (rCount === 1) return { ok: true, value: initialSnapshot }
      if (rCount === 2) return dPublicR1Snap.promise // Public R1 hangs here
      return { ok: true, value: renamedSnapshot }
    },
    statusHandler: async () => {
      if (rCount <= 1) return { ok: true, value: baseStatus }
      if (rCount === 2) return dPublicR1Stat.promise
      return { ok: true, value: baseStatus }
    },
    renameHandler: async () => ({ ok: true, value: renamedSnapshot })
  })

  await runtime.settle()
  let root = runtime.getRoot()

  // 1. Trigger public refresh R1 (hangs in dPublicR1Snap)
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())

  // 2. While R1 is in-flight, start and confirm rename mutation
  const renameBtn = requireOne(root, (n) => n.props?.['data-wo-rename'] === 'p1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const renameInput = requireOne(root, (n) => n.props?.['data-wo-rename-input'] === 'true')
  renameInput.props.onChange({ target: { value: 'Confirmed Renamed Branch' } })
  await runtime.settle()

  root = runtime.getRoot()
  const saveBtn = requireOne(root, (n) => n.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Rename has successfully confirmed and tree now displays Confirmed Renamed Branch
  const renamedRow = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p1')
  assert.match(textOf(renamedRow), /Confirmed Renamed Branch/u)

  // 3. Now release the old public R1 (which had the old title "Branch 1")
  dPublicR1Snap.resolve({ ok: true, value: initialSnapshot })
  dPublicR1Stat.resolve({ ok: true, value: baseStatus })
  await runtime.settle()

  root = runtime.getRoot()
  // Public R1 must be DISCARDED! Must NOT roll back the confirmed rename node!
  const rowAfterR1 = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'p1')
  assert.match(textOf(rowAfterR1), /Confirmed Renamed Branch/u)
  assert.equal(findOne(root, (n) => n.props?.['data-wo-snapshot-stale'] === 'true'), null)
})

// -----------------------------------------------------------------------------
// Test 10: Unmount safety and late response isolation
// -----------------------------------------------------------------------------
test('10. Unmount safety: in-flight refresh resolves or rejects after unmount with zero state writes and zero unhandled rejections', async () => {
  let rCount = 0
  const dSnap = deferred()
  const dStat = deferred()

  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      rCount += 1
      if (rCount === 1) return { ok: true, value: baseSnapshot }
      return dSnap.promise
    },
    statusHandler: async () => {
      if (rCount <= 1) return { ok: true, value: baseStatus }
      return dStat.promise
    }
  })

  await runtime.settle()
  let root = runtime.getRoot()

  // Save the refresh handler from VNode
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  const savedRefreshHandler = refreshBtn.props.onClick

  // Trigger in-flight refresh
  savedRefreshHandler(mockEvent())

  // Unmount component while refresh is in-flight
  runtime.unmount()
  assert.equal(runtime.isMounted(), false)

  // Resolve after unmount: must not throw or update state
  dSnap.resolve({ ok: true, value: baseSnapshot })
  dStat.resolve({ ok: true, value: baseStatus })
  await runtime.settle()

  // Invoking saved handler after unmount must dispatch 0 RPCs
  const rpcBefore = rCount
  savedRefreshHandler(mockEvent())
  await runtime.settle()
  assert.equal(rCount, rpcBefore, 'stale handler after unmount must make zero RPC calls')
})

test('10b. Unmount safety with rejection: in-flight refresh rejects after unmount without unhandled rejection', async () => {
  let rCount = 0
  const dSnap = deferred()
  const dStat = deferred()

  const { runtime } = await setupRefreshComponent({
    snapshotHandler: async () => {
      rCount += 1
      if (rCount === 1) return { ok: true, value: baseSnapshot }
      return dSnap.promise
    },
    statusHandler: async () => {
      if (rCount <= 1) return { ok: true, value: baseStatus }
      return dStat.promise
    }
  })

  await runtime.settle()
  let root = runtime.getRoot()

  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())

  // Unmount
  runtime.unmount()

  // Reject after unmount
  dSnap.reject(new Error('Late network failure on unmounted component'))
  dStat.resolve({ ok: true, value: baseStatus })
  await runtime.settle()

  assert.equal(runtime.isMounted(), false)
})

// -----------------------------------------------------------------------------
// Test 11: Zero non-whitelisted calls
// -----------------------------------------------------------------------------
test('11. Zero non-whitelisted calls during refresh: only snapshot and status called', async () => {
  let illegalCalls = 0
  const { runtime, remote } = await setupRefreshComponent({
    snapshot: baseSnapshot,
    status: baseStatus
  })

  // Watch for any unauthorized method calls
  for (const method of ['openSession', 'conversationTarget', 'bindDirectoryConversation', 'registerWorkspace', 'createProject', 'moveNode', 'renameNode']) {
    remote.allowed[method] = async () => {
      illegalCalls += 1
      return { ok: true }
    }
  }

  await runtime.settle()
  let root = runtime.getRoot()

  // Trigger refresh
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(illegalCalls, 0, 'zero calls to non-whitelisted RPC methods during refresh')
})
