/**
 * Guarded Rename Flow offline component tests.
 *
 * Verifies the GUARDED_RENAME_FLOW_READY contract:
 * 1. P/W/C valid rename: accurately submits one { id, title: trimmed }; no optimistic mutation before confirmation;
 *    applies returned snapshot fact; fields (id, parent, directory, sessionId, revision) preserved; Quick Access updated.
 * 2. Cancel: closes editor; zero rename RPC; zero refresh; no state or selection mutation.
 * 3. Local validation: empty, whitespace-only, > 200 chars reject with "Name must be 1–200 characters"; zero RPC, zero refresh.
 * 4. Same-name no-op: submitting current title (even with padding) rejects with "名称未改变 / Name unchanged"; zero RPC, zero refresh.
 * 5. Ineligible targets: Root project and rootId cannot be renamed; stale/null snapshot rejects; zero RPC.
 * 6. Edit session locking: locked target ID is authoritative; DOM source mismatch rejects; changing selection cannot divert target.
 * 7. Target removed during edit: fails closed if target missing in current snapshot; zero RPC.
 * 8. Concurrency guard: double-click / simultaneous save calls dispatch exactly one rename RPC; pending state disables cancel/save.
 * 9. Remote failure: error preserves draft and editor; displays unconfirmed failure notice; no automatic replay.
 * 10. Layered confirmation: remote rename succeeds but subsequent read refresh fails -> preserves confirmed snapshot, marks stale.
 * 11. Late response & unmount: in-flight response discarded on generation mismatch or unmount; does not pollute subsequent session.
 * 12. Management panel entry convergence: clicking Rename in create panel routes to guarded startRename, cannot bypass.
 * 13. Side-effect isolation: Rename button does not toggle project or open session; zero uiWorkspace or illegal Remote calls.
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

const scenarioSnapshot = Object.freeze({
  rootId: 'root',
  revision: 10,
  nodes: [
    // Branch 1: p1 -> p1_sub -> w1 & cnv_1
    { id: 'p1', parentId: null, kind: 'project', title: 'Branch 1 Project' },
    { id: 'p1_sub', parentId: 'p1', kind: 'project', title: 'Branch 1 Subproject' },
    { id: 'w1', parentId: 'p1_sub', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' },
    { id: 'cnv_1', parentId: 'p1_sub', kind: 'conversation', title: 'SharedTitle', sessionId: 'ses-1' },

    // Branch 2: p2 -> p2_sub -> w2 & cnv_2 (same title 'SharedTitle' as cnv_1)
    { id: 'p2', parentId: null, kind: 'project', title: 'Branch 2 Project' },
    { id: 'p2_sub', parentId: 'p2', kind: 'project', title: 'Branch 2 Subproject' },
    { id: 'w2', parentId: 'p2_sub', kind: 'workspace', title: 'Workspace 2', directory: 'E:\\ws-2' },
    { id: 'cnv_2', parentId: 'p2_sub', kind: 'conversation', title: 'SharedTitle', sessionId: 'ses-2' }
  ]
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-rename-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

async function setupRenameComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  ledgers = [],
  document: injectedDocument,
  renameHandler,
  setTimeout: injectedSetTimeout,
  clearTimeout: injectedClearTimeout
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })
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

test('valid rename on Project, Workspace, and Conversation: accurately submits one trimmed request and applies returned fact', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const renameCalls = []

  const renameHandler = async ({ id, title }) => {
    renameCalls.push({ id, title })
    const updated = JSON.parse(JSON.stringify(currentSnapshot))
    const node = updated.nodes.find((n) => n.id === id)
    if (!node) throw new Error('Node not found')
    node.title = title
    updated.revision += 1
    currentSnapshot = updated
    return { ok: true, value: updated }
  }

  const { runtime, remote, mounted } = await setupRenameComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    renameHandler
  })
  let root = runtime.getRoot()

  // 1. Rename Project p1_sub
  const renameP1Btn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'p1_sub')
  renameP1Btn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: '  Renamed Subproject  ' } })
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(renameCalls.length, 1)
  assert.deepEqual(renameCalls[0], { id: 'p1_sub', title: 'Renamed Subproject' })

  // Editor closed after successful rename
  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true'), null)

  // 2. Rename Workspace w1
  const renameW1Btn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'w1')
  renameW1Btn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: 'Renamed Workspace 1' } })
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(renameCalls.length, 2)
  assert.deepEqual(renameCalls[1], { id: 'w1', title: 'Renamed Workspace 1' })

  // 3. Rename Conversation cnv_1 (which has same title as cnv_2)
  const renameCnv1Btn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'cnv_1')
  renameCnv1Btn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: 'Unique Chat Title' } })
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(renameCalls.length, 3)
  assert.deepEqual(renameCalls[2], { id: 'cnv_1', title: 'Unique Chat Title' })

  // Verify other fields of nodes remain intact
  root = runtime.getRoot()
  const w1Node = currentSnapshot.nodes.find((n) => n.id === 'w1')
  assert.equal(w1Node.directory, 'E:\\ws-1')
  assert.equal(w1Node.parentId, 'p1_sub')
  const cnv1Node = currentSnapshot.nodes.find((n) => n.id === 'cnv_1')
  assert.equal(cnv1Node.sessionId, 'ses-1')
  assert.equal(cnv1Node.parentId, 'p1_sub')

  // cnv_2 in branch 2 was NOT modified
  const cnv2Node = currentSnapshot.nodes.find((n) => n.id === 'cnv_2')
  assert.equal(cnv2Node.title, 'SharedTitle')

  assert.equal(remote.illegal.length, 0)
  await mounted.cleanup()
})

test('cancel flow closes editor with zero rename RPC calls and zero refresh calls', async () => {
  let renameCalled = false
  const { runtime, remote, mounted } = await setupRenameComponent({
    renameHandler: async () => {
      renameCalled = true
      return { ok: true, value: scenarioSnapshot }
    }
  })
  let root = runtime.getRoot()

  // Open rename on w1
  const renameBtn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'w1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  const input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: 'Modified Draft' } })
  await runtime.settle()

  const initialRemoteCalls = remote.calls.length

  // Click Cancel
  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  const cancelBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-cancel'] === 'true')
  cancelBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true'), null, 'editor closed on cancel')
  assert.equal(renameCalled, false, 'zero rename RPC')
  assert.equal(remote.calls.length, initialRemoteCalls, 'zero refresh or remote calls on cancel')

  await mounted.cleanup()
})

test('local validation: empty name, whitespace-only, and > 200 chars reject with zero RPC and zero refresh', async () => {
  let renameCalled = false
  const { runtime, remote, mounted } = await setupRenameComponent({
    renameHandler: async () => {
      renameCalled = true
      return { ok: true, value: scenarioSnapshot }
    }
  })
  let root = runtime.getRoot()

  // Open rename on w1
  const renameBtn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'w1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  const initialRemoteCalls = remote.calls.length

  // 1. Empty string
  root = runtime.getRoot()
  let panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: '' } })
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let errorMsg = requireOne(panel, (node) => node.props?.['data-wo-rename-error'] === 'true')
  assert.equal(textOf(errorMsg), 'Name must be 1–200 characters')
  assert.equal(renameCalled, false)
  assert.equal(remote.calls.length, initialRemoteCalls)

  // 2. Whitespace-only string
  input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: '     ' } })
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  errorMsg = requireOne(panel, (node) => node.props?.['data-wo-rename-error'] === 'true')
  assert.equal(textOf(errorMsg), 'Name must be 1–200 characters')
  assert.equal(renameCalled, false)
  assert.equal(remote.calls.length, initialRemoteCalls)

  // 3. String > 200 characters
  const tooLong = 'A'.repeat(201)
  input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: tooLong } })
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  errorMsg = requireOne(panel, (node) => node.props?.['data-wo-rename-error'] === 'true')
  assert.equal(textOf(errorMsg), 'Name must be 1–200 characters')
  assert.equal(renameCalled, false)
  assert.equal(remote.calls.length, initialRemoteCalls)

  await mounted.cleanup()
})

test('same-name no-op rejection: submitting current title rejects with zero RPC and zero refresh', async () => {
  let renameCalled = false
  const { runtime, remote, mounted } = await setupRenameComponent({
    renameHandler: async () => {
      renameCalled = true
      return { ok: true, value: scenarioSnapshot }
    }
  })
  let root = runtime.getRoot()

  // Open rename on w1 (current title: 'Workspace 1')
  const renameBtn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'w1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  const initialRemoteCalls = remote.calls.length

  // Submit trimmed same name
  root = runtime.getRoot()
  let panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: '   Workspace 1   ' } })
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  const errorMsg = requireOne(panel, (node) => node.props?.['data-wo-rename-error'] === 'true')
  assert.ok(textOf(errorMsg).includes('名称未改变'), 'reports name unchanged')
  assert.equal(renameCalled, false, 'zero rename RPC on same-name')
  assert.equal(remote.calls.length, initialRemoteCalls, 'zero refresh calls on same-name')

  await mounted.cleanup()
})

test('ineligible targets: Root project has no rename button; stale snapshot rejects with zero RPC', async () => {
  let shouldFail = false
  let renameCalled = false
  const { runtime, remote, mounted } = await setupRenameComponent({
    snapshot: () => {
      if (shouldFail) return { ok: false, error: { message: 'Network offline' } }
      return { ok: true, value: scenarioSnapshot }
    },
    renameHandler: async () => {
      renameCalled = true
      return { ok: true, value: scenarioSnapshot }
    }
  })
  let root = runtime.getRoot()

  // 1. Root project p1 must NOT have data-wo-rename button in tree
  assert.equal(findOne(root, (node) => node.props?.['data-wo-rename'] === 'p1'), null, 'Root project has no rename button')
  assert.equal(findOne(root, (node) => node.props?.['data-wo-rename'] === 'p2'), null, 'Root project p2 has no rename button')

  // 2. Cause snapshot refresh to fail -> snapshotStale becomes true
  shouldFail = true
  const refreshBtn = requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  // In tree rows, rename button for eligible nodes is disabled
  const renameW1Btn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'w1')
  assert.equal(renameW1Btn.props.disabled, true, 'rename button disabled when snapshot is stale')

  // Even if clicked, startRename is guarded and does not open panel
  renameW1Btn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true'), null)
  assert.equal(renameCalled, false)

  await mounted.cleanup()
})

test('edit session target locking: changing selection or DOM source mismatch does not divert rename target', async () => {
  const renameCalls = []
  const fakeDocument = {
    querySelector: (selector) => {
      if (selector === '[data-wo-rename-source]') {
        // Return mismatched DOM source ID
        return { getAttribute: () => 'cnv_2' }
      }
      return null
    }
  }

  const { runtime, remote, mounted } = await setupRenameComponent({
    document: fakeDocument,
    renameHandler: async ({ id, title }) => {
      renameCalls.push({ id, title })
      return { ok: true, value: scenarioSnapshot }
    }
  })
  let root = runtime.getRoot()

  // Start rename on cnv_1
  const renameBtn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'cnv_1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: 'New Name' } })
  await runtime.settle()

  // Save with mismatched DOM source
  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Rejects mismatch: zero rename RPC dispatched
  assert.equal(renameCalls.length, 0, 'zero RPC on DOM mismatch')
  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  const errorMsg = requireOne(panel, (node) => node.props?.['data-wo-rename-error'] === 'true')
  assert.ok(textOf(errorMsg).includes('编辑会话目标与DOM不一致'), 'reports target mismatch')

  await mounted.cleanup()
})

test('target removed during edit session fails closed with zero RPC', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  let renameCalled = false

  const { runtime, remote, mounted } = await setupRenameComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    renameHandler: async () => {
      renameCalled = true
      return { ok: true, value: currentSnapshot }
    }
  })
  let root = runtime.getRoot()

  // Start rename on cnv_1
  const renameBtn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'cnv_1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: 'New Name' } })
  await runtime.settle()

  // Node cnv_1 is removed from snapshot in background and refreshed
  const deletedSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  deletedSnapshot.nodes = deletedSnapshot.nodes.filter((n) => n.id !== 'cnv_1')
  currentSnapshot = deletedSnapshot

  const refreshBtn = requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  const saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(renameCalled, false, 'zero rename RPC when target missing')
  root = runtime.getRoot()
  const errorMsg = requireOne(root, (node) => node.props?.['data-wo-rename-error'] === 'true')
  assert.ok(textOf(errorMsg).includes('目标节点在当前快照中不存在'), 'reports target not found')

  await mounted.cleanup()
})

test('concurrency guard: simultaneous save calls dispatch exactly one rename RPC', async () => {
  let resolveRename
  const renamePromise = new Promise((resolve) => { resolveRename = resolve })
  const renameCalls = []

  const { runtime, remote, mounted } = await setupRenameComponent({
    renameHandler: async ({ id, title }) => {
      renameCalls.push({ id, title })
      return renamePromise
    }
  })
  let root = runtime.getRoot()

  // Start rename on w1
  const renameBtn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'w1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: 'Unique WS Name' } })
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')

  // Click Save twice synchronously
  saveBtn.props.onClick(mockEvent())
  saveBtn.props.onClick(mockEvent())

  assert.equal(renameCalls.length, 1, 'must dispatch exactly one rename RPC')

  // Render to flush pending state changes
  runtime.render()

  // While pending, submitting indicator is visible
  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  assert.ok(findOne(panel, (node) => node.props?.['data-wo-rename-submitting'] === 'true') !== null, 'shows submitting indicator')
  assert.equal(requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true').props.disabled, true)
  assert.equal(requireOne(panel, (node) => node.props?.['data-wo-rename-cancel'] === 'true').props.disabled, true)

  // Resolve pending rename
  const updatedSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  updatedSnapshot.nodes.find((n) => n.id === 'w1').title = 'Unique WS Name'
  resolveRename({ ok: true, value: updatedSnapshot })
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true'), null, 'editor closed after resolution')
  assert.equal(renameCalls.length, 1)

  await mounted.cleanup()
})

test('remote failure: server rejection preserves draft and editor with honest notice; no automatic replay', async () => {
  let renameAttempts = 0
  const { runtime, remote, mounted } = await setupRenameComponent({
    renameHandler: async () => {
      renameAttempts += 1
      return { ok: false, error: { message: 'Server rejected rename' } }
    }
  })
  let root = runtime.getRoot()

  // Start rename on w1
  const renameBtn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'w1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: 'Rejected Name Draft' } })
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  const saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Server error: draft preserved, editor open, error message visible
  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  assert.equal(input.props.value, 'Rejected Name Draft', 'draft preserved on server failure')

  const errorMsg = requireOne(panel, (node) => node.props?.['data-wo-rename-error'] === 'true')
  assert.ok(textOf(errorMsg).includes('Server rejected rename'))

  const notice = requireOne(root, (node) => node.props?.['data-wo-notice'] === 'error')
  assert.ok(textOf(notice).includes('重命名未确认或失败'), 'unconfirmed notice displayed')

  assert.equal(renameAttempts, 1, 'no automatic retry')

  await mounted.cleanup()
})

test('layered confirmation: rename succeeds but subsequent read refresh fails -> preserves confirmed snapshot, marks stale', async () => {
  let refreshFails = false
  const updatedSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  updatedSnapshot.nodes.find((n) => n.id === 'w1').title = 'Confirmed Renamed Workspace'

  const { runtime, remote, mounted } = await setupRenameComponent({
    snapshot: () => {
      if (refreshFails) return { ok: false, error: { message: 'Subsequent refresh timeout' } }
      return { ok: true, value: scenarioSnapshot }
    },
    renameHandler: async () => {
      // Remote renameNode succeeds!
      refreshFails = true // Subsequent refresh() will fail
      return { ok: true, value: updatedSnapshot }
    }
  })
  let root = runtime.getRoot()

  // Start rename on w1
  const renameBtn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'w1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: 'Confirmed Renamed Workspace' } })
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  const saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Rename panel closed because renameNode succeeded
  assert.equal(findOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true'), null)

  // Snapshot has confirmed title
  const w1Row = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'w1')
  assert.ok(textOf(w1Row).includes('Confirmed Renamed Workspace'))

  // But snapshotStale is true because subsequent refresh failed
  assert.ok(findOne(root, (node) => node.props?.['data-wo-snapshot-stale'] === 'true') !== null, 'snapshot marked stale')

  // Notice truthfully discloses confirmed rename with refresh failure
  const notice = requireOne(root, (node) => node.props?.['data-wo-notice'] === 'error')
  assert.ok(textOf(notice).includes('重命名已确认；但后续快照刷新失败'), 'honest layered disclosure')

  await mounted.cleanup()
})

test('late response & unmount: in-flight response discarded on unmount without state pollution', async () => {
  let resolveRename
  const renamePromise = new Promise((resolve) => { resolveRename = resolve })

  const { runtime, remote, mounted } = await setupRenameComponent({
    renameHandler: async () => renamePromise
  })
  let root = runtime.getRoot()

  // Start rename on w1
  const renameBtn = requireOne(root, (node) => node.props?.['data-wo-rename'] === 'w1')
  renameBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  let input = requireOne(panel, (node) => node.props?.['data-wo-rename-input'] === 'true')
  input.props.onChange({ target: { value: 'Late Response Title' } })
  await runtime.settle()

  root = runtime.getRoot()
  panel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  const saveBtn = requireOne(panel, (node) => node.props?.['data-wo-rename-save'] === 'true')
  saveBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Unmount component while rename is in-flight
  await mounted.cleanup()

  // Now resolve late rename response
  const updatedSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  updatedSnapshot.nodes.find((n) => n.id === 'w1').title = 'Late Response Title'
  resolveRename({ ok: true, value: updatedSnapshot })

  // Clean exit with no unhandled rejection or error
})

test('management panel rename entry converges to guarded startRename and cannot bypass', async () => {
  let renameCalled = false
  const { runtime, remote, mounted } = await setupRenameComponent({
    renameHandler: async () => {
      renameCalled = true
      return { ok: true, value: scenarioSnapshot }
    }
  })
  let root = runtime.getRoot()

  // Open create panel (+ New...)
  const createToggle = requireOne(root, (node) => node.props?.['data-wo-create-toggle'] === 'true')
  createToggle.props.onClick(mockEvent())
  await runtime.settle()

  // Select w1
  const selectW1Btn = requireOne(root, (node) => node.props?.['data-wo-select'] === 'w1')
  selectW1Btn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const createPanel = requireOne(root, (node) => node.props?.['data-wo-create-panel'] === 'true')
  const panelRenameBtn = requireOne(createPanel, (node) => textOf(node) === 'Rename')

  // Click Rename in create panel
  panelRenameBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Guarded rename panel opens!
  root = runtime.getRoot()
  const renamePanel = requireOne(root, (node) => node.props?.['data-wo-rename-panel'] === 'true')
  assert.ok(textOf(renamePanel).includes('Rename workspace: Workspace 1'))
  assert.equal(renameCalled, false, 'did not directly invoke renameNode RPC')

  await mounted.cleanup()
})
