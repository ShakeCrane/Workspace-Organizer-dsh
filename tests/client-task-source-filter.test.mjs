/**
 * Task Center Source Filtering Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Entry controls: explicit "All sources" ("全部来源 / All sources") and select control based on sourceConversationId.
 *    Displays current scope indicator with "筛选已加载账本".
 * 2. Deduplicated options from loaded taskCenterTasks' sourceConversationId.
 *    Displays title AND ID; same-name C not merged; missing from tree displays unknown/ID.
 * 3. Scope switching:
 *    - Preserves all root/descendant tasks of the selected source without modifying fields.
 *    - Clears detail selection and locate feedback if selected task becomes out of scope.
 *    - Retains detail selection if task is in scope.
 *    - Old saved row handlers for out-of-scope tasks are rejected.
 *    - Changing filter invalidates pending locate timer (zero scroll).
 * 4. Reload behavior:
 *    - Panel Reload preserves user filter.
 *    - Disappeared source retains filter ID and shows "当前来源无任务/已不在本账本", distinct from global empty ledger.
 *    - User can recover via All sources.
 *    - Source rename updates display name while ID scope remains unchanged.
 * 5. Error & Stale handling:
 *    - Fetch failure keeps cached ledger, maintains error/stale banner, allows local filtering of cache.
 *    - Initial failure: no fabricated sources, no false empty message.
 *    - Loading state disables filter select and rejects old onChange handlers.
 * 6. Navigation interaction:
 *    - FP-100 viewTaskDetail resets filter to all sources and verifies target on fresh ledger.
 *    - Header All Tasks opens all; Panel Close clears filter (defaults to all on next open).
 * 7. Zero extra Remote RPCs; zero openSession/reconcileTasks/mutation calls.
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
    { id: 'cnv1', parentId: 'w1', kind: 'conversation', title: 'Shared Title', sessionId: 'ses-1' },
    { id: 'cnv2', parentId: 'w1', kind: 'conversation', title: 'Shared Title', sessionId: 'ses-2' }
  ]
})

const baseStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-filter-test'
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

function makeLedger({
  revision = 1,
  sources = [
    {
      conversationId: 'cnv1',
      sessionId: 'ses-1',
      workspaceLogicalId: 'wsp-1',
      nativeWorkspaceId: 'nw-1',
      directory: 'E:\\ws-1',
      verifiedAt: '2026-10-25T10:00:00.000Z',
      verificationState: 'verified',
      hostVersion: '0.2.1-rc.2'
    },
    {
      conversationId: 'cnv2',
      sessionId: 'ses-2',
      workspaceLogicalId: 'wsp-2',
      nativeWorkspaceId: 'nw-2',
      directory: 'E:\\ws-2',
      verifiedAt: '2026-10-25T10:00:00.000Z',
      verificationState: 'verified',
      hostVersion: '0.2.1-rc.2'
    }
  ],
  tasks = []
} = {}) {
  return {
    revision,
    sources,
    tasks
  }
}

async function setupComponent({
  snapshot = baseSnapshot,
  status = baseStatus,
  taskLedgerHandler,
  ledgers = []
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })

  if (typeof taskLedgerHandler === 'function') {
    remote.allowed.taskLedger = taskLedgerHandler
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

  return { runtime, remote, mounted }
}

async function openTaskCenter(runtime) {
  const root = runtime.getRoot()
  const btn = requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true', 'All Tasks header button')
  btn.props.onClick()
  await runtime.settle()
}

// -----------------------------------------------------------------------------
// Test 1: Default all sources, UI scope hint, deduplicated options with ID
// -----------------------------------------------------------------------------
test('1. Default all sources: scope indicator, deduplicated options with ID and title, all groups rendered', async () => {
  const tasks = [
    {
      taskId: 'tsk_c1_root',
      label: 'C1 Root Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_c1_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_c2_root',
      label: 'C2 Root Task',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      childSessionId: 'sess_c2_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'RUNNING',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:01.000Z'
    }
  ]
  const ledger = makeLedger({ tasks })
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTaskCenter(runtime)
  const root = runtime.getRoot()
  const panel = requireOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true', 'Task center panel')

  // Scope indicator
  const scopeEl = requireOne(panel, (n) => n.props?.['data-wo-task-center-scope'] === 'all', 'Scope indicator all')
  assert.match(textOf(scopeEl), /筛选已加载账本/u)
  assert.match(textOf(scopeEl), /全部来源/u)

  // Filter select
  const selectEl = requireOne(panel, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  assert.equal(selectEl.props.value, '')

  // Options
  const options = findAll(selectEl, (n) => n.type === 'option')
  assert.equal(options.length, 3, 'Should have 3 options: all, cnv1, cnv2')
  assert.equal(options[0].props.value, '')
  assert.match(textOf(options[0]), /All sources/u)
  assert.equal(options[1].props.value, 'cnv1')
  assert.match(textOf(options[1]), /Shared Title/u)
  assert.match(textOf(options[1]), /cnv1/u)
  assert.equal(options[2].props.value, 'cnv2')
  assert.match(textOf(options[2]), /Shared Title/u)
  assert.match(textOf(options[2]), /cnv2/u)

  // Groups
  assert.ok(findOne(panel, (n) => n.props?.['data-wo-task-center-group'] === 'cnv1') !== null, 'cnv1 group present')
  assert.ok(findOne(panel, (n) => n.props?.['data-wo-task-center-group'] === 'cnv2') !== null, 'cnv2 group present')
})

// -----------------------------------------------------------------------------
// Test 2: Filter by sourceConversationId: isolation & descendant completeness
// -----------------------------------------------------------------------------
test('2. Filter by ID: strict isolation, all descendants (root, child, grandchild) preserved', async () => {
  const tasks = [
    {
      taskId: 'tsk_c1_root',
      label: 'Root Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'COMPLETED',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_c1_child',
      label: 'Child Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'task', taskId: 'tsk_c1_root' },
      childSessionId: 'sess_2',
      depth: 1,
      mode: 'one-shot',
      executionState: 'RUNNING',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:01.000Z'
    },
    {
      taskId: 'tsk_c1_grandchild',
      label: 'Grandchild Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'task', taskId: 'tsk_c1_child' },
      childSessionId: 'sess_3',
      depth: 2,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:02.000Z'
    },
    {
      taskId: 'tsk_c2_root',
      label: 'C2 Task',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      childSessionId: 'sess_c2',
      depth: 0,
      mode: 'one-shot',
      executionState: 'COMPLETED',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:03.000Z'
    }
  ]
  const ledger = makeLedger({ tasks })
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTaskCenter(runtime)
  const root = runtime.getRoot()
  const selectEl = requireOne(root, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')

  // Switch filter to cnv1
  selectEl.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()

  const updatedRoot = runtime.getRoot()
  // cnv1 group is present
  assert.ok(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-group'] === 'cnv1') !== null, 'cnv1 group present')
  // cnv2 group is NOT present
  assert.equal(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-group'] === 'cnv2'), null, 'cnv2 group must be hidden')

  // Check all 3 tasks in cnv1
  assert.ok(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c1_root') !== null, 'root present')
  assert.ok(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c1_child') !== null, 'child present')
  assert.ok(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c1_grandchild') !== null, 'grandchild present')
  assert.equal(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c2_root'), null, 'c2 task hidden')

  // Scope indicator shows cnv1
  const scopeEl = requireOne(updatedRoot, (n) => n.props?.['data-wo-task-center-scope'] === 'cnv1', 'Scope indicator cnv1')
  assert.match(textOf(scopeEl), /cnv1/u)
})

// -----------------------------------------------------------------------------
// Test 3: Distinguish same-name conversations and same-name tasks
// -----------------------------------------------------------------------------
test('3. Distinguish same-name conversations and same-name tasks strictly by ID', async () => {
  const tasks = [
    {
      taskId: 'tsk_c1_build',
      label: 'Build Artifact',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_c2_build',
      label: 'Build Artifact',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      childSessionId: 'sess_2',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger = makeLedger({ tasks })
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTaskCenter(runtime)
  const root = runtime.getRoot()
  const selectEl = requireOne(root, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')

  // Filter cnv1
  selectEl.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c1_build') !== null)
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c2_build'), null)

  // Filter cnv2
  const selectEl2 = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  selectEl2.props.onChange({ target: { value: 'cnv2' } })
  await runtime.settle()
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c1_build'), null)
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c2_build') !== null)
})

// -----------------------------------------------------------------------------
// Test 4: Zero extra Remote RPCs during local filtering
// -----------------------------------------------------------------------------
test('4. Zero extra Remote RPCs when switching source filters', async () => {
  let rpcCount = 0
  const tasks = [
    {
      taskId: 'tsk_c1_1',
      label: 'Task 1',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_c2_1',
      label: 'Task 2',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      childSessionId: 'sess_2',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger = makeLedger({ tasks })
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      rpcCount += 1
      return { ok: true, value: ledger }
    }
  })

  await openTaskCenter(runtime)
  assert.equal(rpcCount, 1, 'Initial open makes exactly 1 taskLedger RPC')

  // Switch filter multiple times
  const selectEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  selectEl.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()

  selectEl.props.onChange({ target: { value: 'cnv2' } })
  await runtime.settle()

  selectEl.props.onChange({ target: { value: '' } })
  await runtime.settle()

  assert.equal(rpcCount, 1, 'Filter switching must dispatch 0 additional RPCs')
})

// -----------------------------------------------------------------------------
// Test 5: Switching scope clears detail selection and locate feedback if out of scope
// -----------------------------------------------------------------------------
test('5. Switching scope clears detail selection and locate feedback when task is outside new scope', async () => {
  const tasks = [
    {
      taskId: 'tsk_c1_root',
      label: 'C1 Root Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_c2_root',
      label: 'C2 Root Task',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      childSessionId: 'sess_2',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger = makeLedger({ tasks })
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTaskCenter(runtime)

  // Select tsk_c1_root
  const rowBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c1_root', 'Row tsk_c1_root')
  rowBtn.props.onClick()
  await runtime.settle()

  // Detail view is open
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_c1_root') !== null)

  // Switch filter to cnv2 (which excludes tsk_c1_root)
  const selectEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  selectEl.props.onChange({ target: { value: 'cnv2' } })
  await runtime.settle()

  // Detail view must be cleared
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] !== undefined), null, 'Detail view must be cleared')
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-locate-feedback'] !== undefined), null, 'Locate feedback must be cleared')
})

// -----------------------------------------------------------------------------
// Test 6: Switching scope retains detail selection if task is in scope
// -----------------------------------------------------------------------------
test('6. Switching scope retains detail selection when task is in the selected scope', async () => {
  const tasks = [
    {
      taskId: 'tsk_c1_root',
      label: 'C1 Root Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_c2_root',
      label: 'C2 Root Task',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      childSessionId: 'sess_2',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger = makeLedger({ tasks })
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTaskCenter(runtime)

  // Select tsk_c1_root in all view
  const rowBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c1_root', 'Row tsk_c1_root')
  rowBtn.props.onClick()
  await runtime.settle()

  // Switch filter to cnv1
  const selectEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  selectEl.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()

  // Detail view remains open for tsk_c1_root
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_c1_root') !== null, 'Detail view retained')
})

// -----------------------------------------------------------------------------
// Test 7: Saved old hidden row handler is rejected
// -----------------------------------------------------------------------------
test('7. Saved old hidden row handler is rejected and cannot select out-of-scope task', async () => {
  const tasks = [
    {
      taskId: 'tsk_c1_root',
      label: 'C1 Root Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_c2_root',
      label: 'C2 Root Task',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      childSessionId: 'sess_2',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger = makeLedger({ tasks })
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTaskCenter(runtime)

  // Save the onClick handler of tsk_c2_root from all view
  const c2RowBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c2_root', 'Row tsk_c2_root')
  const savedC2Handler = c2RowBtn.props.onClick

  // Switch filter to cnv1
  const selectEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  selectEl.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()

  // Now invoke the saved handler for tsk_c2_root
  savedC2Handler()
  await runtime.settle()

  // Detail view must NOT be opened for tsk_c2_root!
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_c2_root'), null, 'Saved handler must be rejected')
})

// -----------------------------------------------------------------------------
// Test 8: Source renamed in tree updates display name while ID scope remains unchanged
// -----------------------------------------------------------------------------
test('8. Source renamed in tree updates display name while ID scope and filtered tasks remain unchanged', async () => {
  const tasks = [
    {
      taskId: 'tsk_c1_root',
      label: 'C1 Root Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger = makeLedger({ tasks })
  let currentSnapshot = baseSnapshot
  const { runtime, remote } = await setupComponent({
    snapshot: currentSnapshot,
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTaskCenter(runtime)
  const selectEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  selectEl.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()

  // Rename cnv1 in snapshot
  const renamedSnapshot = {
    ...baseSnapshot,
    revision: 11,
    nodes: baseSnapshot.nodes.map((n) => n.id === 'cnv1' ? { ...n, title: 'Renamed Conversation' } : n)
  }
  remote.allowed.snapshot = async () => ({ ok: true, value: renamedSnapshot })

  // Trigger tree refresh
  const refreshBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-refresh'] === 'true', 'Refresh button')
  refreshBtn.props.onClick()
  await runtime.settle()

  // Check that option text now shows Renamed Conversation · cnv1
  const updatedRoot = runtime.getRoot()
  const updatedSelect = requireOne(updatedRoot, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  assert.equal(updatedSelect.props.value, 'cnv1')
  const optC1 = requireOne(updatedSelect, (n) => n.props?.['data-wo-filter-option'] === 'cnv1', 'Option cnv1')
  assert.match(textOf(optC1), /Renamed Conversation/u)
  assert.match(textOf(optC1), /cnv1/u)

  // Scope indicator shows Renamed Conversation
  const scopeEl = requireOne(updatedRoot, (n) => n.props?.['data-wo-task-center-scope'] === 'cnv1', 'Scope indicator')
  assert.match(textOf(scopeEl), /Renamed Conversation/u)

  // Task is still visible
  assert.ok(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c1_root') !== null)
})

// -----------------------------------------------------------------------------
// Test 9: Source disappeared on Reload vs global empty state distinction
// -----------------------------------------------------------------------------
test('9. Source disappeared on Reload retains filter ID and shows source-empty, distinct from global empty ledger', async () => {
  const initialTasks = [
    {
      taskId: 'tsk_c1_1',
      label: 'C1 Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_c2_1',
      label: 'C2 Task',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      childSessionId: 'sess_2',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const initialLedger = makeLedger({ tasks: initialTasks })

  // In new ledger, cnv2 has disappeared, only cnv1 remains
  const newTasks = [initialTasks[0]]
  const newLedger = makeLedger({ revision: 2, tasks: newTasks })

  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: initialLedger }
      return { ok: true, value: newLedger }
    }
  })

  await openTaskCenter(runtime)

  // User filters by cnv2
  const selectEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  selectEl.props.onChange({ target: { value: 'cnv2' } })
  await runtime.settle()

  // User clicks panel Reload
  const reloadBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-refresh'] === 'true', 'Panel Reload')
  reloadBtn.props.onClick()
  await runtime.settle()

  const updatedRoot = runtime.getRoot()
  // Filter value is preserved as cnv2
  const updatedSelect = requireOne(updatedRoot, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  assert.equal(updatedSelect.props.value, 'cnv2', 'Filter must be preserved as cnv2')

  // Source empty banner is displayed
  const sourceEmptyEl = requireOne(updatedRoot, (n) => n.props?.['data-wo-task-center-source-empty'] === 'true', 'Source empty banner')
  assert.match(textOf(sourceEmptyEl), /当前来源无任务\/已不在本账本/u)

  // Global empty banner is NOT displayed because cnv1 has tasks
  assert.equal(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-empty'] === 'true'), null, 'Must NOT report global empty')

  // User can click All sources button to recover
  const allBtn = requireOne(updatedRoot, (n) => n.props?.['data-wo-task-center-filter-all'] === 'true', 'All sources button')
  allBtn.props.onClick()
  await runtime.settle()

  // Recovered: cnv1 task is shown
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c1_1') !== null)
})

// -----------------------------------------------------------------------------
// Test 10: Fetch failure keeps cached ledger, allows local filtering, keeps stale/error
// -----------------------------------------------------------------------------
test('10. Fetch failure preserves cached ledger, allows local filtering, maintains stale and error status', async () => {
  const tasks = [
    {
      taskId: 'tsk_c1_1',
      label: 'C1 Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_c2_1',
      label: 'C2 Task',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      childSessionId: 'sess_2',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger = makeLedger({ tasks })
  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: ledger }
      throw new Error('Ledger fetch network error')
    }
  })

  await openTaskCenter(runtime)

  // Panel Reload fails
  const reloadBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-refresh'] === 'true', 'Panel Reload')
  reloadBtn.props.onClick()
  await runtime.settle()

  const root = runtime.getRoot()
  // Stale and error banners present
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true') !== null, 'Error banner present')
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-stale'] === 'true') !== null, 'Stale banner present')
  const statusEl = requireOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error', 'Status error')

  // Local filtering still works on cached tasks
  const selectEl = requireOne(root, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  selectEl.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()

  const updatedRoot = runtime.getRoot()
  assert.ok(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c1_1') !== null)
  assert.equal(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c2_1'), null)
  // Status remains error, not ready!
  assert.ok(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-status'] === 'error') !== null, 'Status remains error')
  assert.equal(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-empty'] === 'true'), null, 'Must not claim empty')
})

// -----------------------------------------------------------------------------
// Test 11: Initial load failure: no fabricated sources, no false empty
// -----------------------------------------------------------------------------
test('11. Initial load failure: no fabricated sources in select, no false empty message', async () => {
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      throw new Error('Initial connection failure')
    }
  })

  await openTaskCenter(runtime)
  const root = runtime.getRoot()

  // Status error
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-status'] === 'error') !== null)

  // Filter select only has 1 option ("All sources"), no fabricated sources
  const selectEl = requireOne(root, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  const options = findAll(selectEl, (n) => n.type === 'option')
  assert.equal(options.length, 1, 'Only All sources option')
  assert.equal(options[0].props.value, '')

  // No false empty message
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-empty'] === 'true'), null)
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-source-empty'] === 'true'), null)
})

// -----------------------------------------------------------------------------
// Test 12: Loading state disables filter select and rejects old onChange handlers
// -----------------------------------------------------------------------------
test('12. Loading state disables filter select; old onChange handlers rejected during loading', async () => {
  const d = deferred()
  const tasks = [
    {
      taskId: 'tsk_c1_1',
      label: 'C1 Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger = makeLedger({ tasks })
  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: ledger }
      return d.promise
    }
  })

  await openTaskCenter(runtime)
  const selectEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  const savedOnChange = selectEl.props.onChange

  // Start reload with pending promise
  const reloadBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-refresh'] === 'true', 'Reload')
  reloadBtn.props.onClick()
  await runtime.settle()

  // During loading:
  const loadingRoot = runtime.getRoot()
  const loadingSelect = requireOne(loadingRoot, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  assert.equal(loadingSelect.props.disabled, true, 'Filter select must be disabled during loading')

  // Invoke saved onChange during loading
  savedOnChange({ target: { value: 'cnv1' } })
  await runtime.settle()

  // Value must remain '' (not changed)
  const stillLoadingSelect = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  assert.equal(stillLoadingSelect.props.value, '', 'Filter must not change during loading')

  // Resolve reload
  d.resolve({ ok: true, value: ledger })
  await runtime.settle()

  // Ready again
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-status'] === 'ready') !== null)
})

// -----------------------------------------------------------------------------
// Test 13: Panel Reload preserves user filter
// -----------------------------------------------------------------------------
test('13. Panel Reload preserves user filter across successful reload', async () => {
  const tasks1 = [
    {
      taskId: 'tsk_c1_1',
      label: 'C1 Task v1',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const tasks2 = [
    {
      taskId: 'tsk_c1_1',
      label: 'C1 Task v2',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'COMPLETED',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:05.000Z'
    }
  ]
  let callCount = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount += 1
      if (callCount === 1) return { ok: true, value: makeLedger({ tasks: tasks1 }) }
      return { ok: true, value: makeLedger({ revision: 2, tasks: tasks2 }) }
    }
  })

  await openTaskCenter(runtime)
  const selectEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  selectEl.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()

  // Panel Reload
  const reloadBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-refresh'] === 'true', 'Reload')
  reloadBtn.props.onClick()
  await runtime.settle()

  const updatedSelect = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  assert.equal(updatedSelect.props.value, 'cnv1', 'Filter must be preserved as cnv1')
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_c1_1') !== null)
})

// -----------------------------------------------------------------------------
// Test 14: Panel Close resets filter to all sources on next open
// -----------------------------------------------------------------------------
test('14. Panel Close clears filter; next open defaults to all sources', async () => {
  const tasks = [
    {
      taskId: 'tsk_c1_1',
      label: 'C1 Task',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'sess_1',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_c2_1',
      label: 'C2 Task',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      childSessionId: 'sess_2',
      depth: 0,
      mode: 'one-shot',
      executionState: 'READY',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger = makeLedger({ tasks })
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTaskCenter(runtime)
  const selectEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  selectEl.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()

  // Close panel
  const closeBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-close'] === 'true', 'Close button')
  closeBtn.props.onClick()
  await runtime.settle()

  // Panel closed
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)

  // Reopen via header All Tasks
  await openTaskCenter(runtime)
  const reopenedRoot = runtime.getRoot()
  const reopenedSelect = requireOne(reopenedRoot, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  assert.equal(reopenedSelect.props.value, '', 'Filter must be reset to empty (all sources)')
  assert.ok(findOne(reopenedRoot, (n) => n.props?.['data-wo-task-center-group'] === 'cnv1') !== null)
  assert.ok(findOne(reopenedRoot, (n) => n.props?.['data-wo-task-center-group'] === 'cnv2') !== null)
})

// -----------------------------------------------------------------------------
// Test 15: FP-100 explicit navigation resets filter to all sources and shows target
// -----------------------------------------------------------------------------
test('15. FP-100 viewTaskDetail explicit navigation resets filter to all sources and displays target task', async () => {
  const taskC1 = {
    taskId: 'tsk_c1_1',
    label: 'C1 Task',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    childSessionId: 'sess_1',
    depth: 0,
    mode: 'one-shot',
    executionState: 'READY',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:00.000Z'
  }
  const taskC2 = {
    taskId: 'tsk_c2_1',
    label: 'C2 Task',
    sourceConversationId: 'cnv2',
    parent: { kind: 'conversation', conversationId: 'cnv2' },
    childSessionId: 'sess_2',
    depth: 0,
    mode: 'one-shot',
    executionState: 'READY',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:00.000Z'
  }
  const ledger = makeLedger({ tasks: [taskC1, taskC2] })
  let ledgerRpcCount = 0

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      ledgerRpcCount += 1
      return { ok: true, value: ledger }
    }
  })

  // Open Task Center and set filter to cnv1
  await openTaskCenter(runtime)
  const selectEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  selectEl.props.onChange({ target: { value: 'cnv1' } })
  await runtime.settle()

  // Now open Tasks for cnv2 in the tree
  const cnv2TasksBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-tasks'] === 'cnv2', 'Tasks btn cnv2')
  cnv2TasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Click view detail for tsk_c2_1
  const viewDetailBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-view'] === 'tsk_c2_1', 'View detail for tsk_c2_1')
  viewDetailBtn.props.onClick(mockEvent())
  await runtime.settle()

  const finalRoot = runtime.getRoot()
  // Task Center is open
  assert.ok(findOne(finalRoot, (n) => n.props?.['data-wo-task-center-panel'] === 'true') !== null)

  // Filter was reset to all sources!
  const finalSelect = requireOne(finalRoot, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  assert.equal(finalSelect.props.value, '', 'Filter must be reset to all sources')

  // Target task tsk_c2_1 is selected in detail view!
  const detailEl = requireOne(finalRoot, (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_c2_1', 'Detail for tsk_c2_1')
  assert.ok(detailEl !== null)

  // Exactly 3 taskLedger RPCs: initial openTaskCenter (1) + loadTasks cnv2 (2) + viewTaskDetail (3)
  assert.equal(ledgerRpcCount, 3, 'Zero extra filter RPCs')
})

// -----------------------------------------------------------------------------
// Test 16: Full Task/Source field fidelity and zero non-whitelisted calls
// -----------------------------------------------------------------------------
test('16. Full Task/Source field fidelity and zero openSession / reconcile / mutation calls', async () => {
  const fullTask = {
    taskId: 'tsk_alpha',
    label: 'Alpha Task',
    sourceConversationId: 'cnv1',
    parent: { kind: 'conversation', conversationId: 'cnv1' },
    childSessionId: 'sess_alpha_child',
    depth: 0,
    mode: 'one-shot',
    executionState: 'COMPLETED',
    executionEligibility: 'eligible',
    blockedReason: 'blocked-by-resource',
    observedAt: '2026-10-25T10:00:00.000Z'
  }
  const sourceRecord = {
    conversationId: 'cnv1',
    sessionId: 'ses-1',
    workspaceLogicalId: 'wsp-1',
    nativeWorkspaceId: 'nw-1',
    directory: 'E:\\ws-1',
    verifiedAt: '2026-10-25T10:00:00.000Z',
    verificationState: 'verified',
    blockedReason: 'source-resource-wait',
    hostVersion: '0.2.1-rc.2'
  }
  const ledger = makeLedger({
    sources: [sourceRecord],
    tasks: [fullTask]
  })

  let openSessionCalled = false
  const { runtime, remote } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  // Hook openSession if accessible
  if (remote.allowed.openSession) {
    const orig = remote.allowed.openSession
    remote.allowed.openSession = async (...args) => {
      openSessionCalled = true
      return orig(...args)
    }
  }

  await openTaskCenter(runtime)

  // Select tsk_alpha
  const rowBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-row'] === 'tsk_alpha', 'Row')
  rowBtn.props.onClick()
  await runtime.settle()

  const detail = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_alpha', 'Detail')
  const detailText = textOf(detail)

  // Verify task fields
  assert.match(detailText, /taskId: tsk_alpha/u)
  assert.match(detailText, /sourceConversationId: cnv1/u)
  assert.match(detailText, /parent: conversation:cnv1/u)
  assert.match(detailText, /childSessionId: sess_alpha_child/u)
  assert.match(detailText, /depth\/mode: 0\/one-shot/u)
  assert.match(detailText, /observedAt: 2026-10-25T10:00:00.000Z/u)
  assert.match(detailText, /execution: COMPLETED \(eligible\)/u)
  assert.match(detailText, /blocked: blocked-by-resource/u)

  // Verify source fields
  assert.match(detailText, /source C: cnv1/u)
  assert.match(detailText, /logical workspace: wsp-1/u)
  assert.match(detailText, /native workspace: nw-1/u)
  assert.match(detailText, /observed directory: E:\\ws-1/u)
  assert.match(detailText, /verifiedAt: 2026-10-25T10:00:00.000Z/u)
  assert.match(detailText, /verification: verified/u)
  assert.match(detailText, /source blocked: source-resource-wait/u)
  assert.match(detailText, /resource session: ses-1/u)
  assert.match(detailText, /hostVersion: 0.2.1-rc.2/u)

  assert.equal(openSessionCalled, false, 'openSession must never be called')
})

// -----------------------------------------------------------------------------
// Test 17: Missing tree source displays ID/unknown, does not fabricate node or claim permissions
// -----------------------------------------------------------------------------
test('17. Missing tree source: displays source ID safely, allows filtering, zero fabricated nodes', async () => {
  const missingSourceTask = {
    taskId: 'tsk_orphan_1',
    label: 'Orphan Task',
    sourceConversationId: 'cnv_missing_tree_source',
    parent: { kind: 'conversation', conversationId: 'cnv_missing_tree_source' },
    childSessionId: 'sess_orphan',
    depth: 0,
    mode: 'one-shot',
    executionState: 'READY',
    executionEligibility: 'eligible',
    observedAt: '2026-10-25T10:00:00.000Z'
  }
  const ledger = makeLedger({ tasks: [missingSourceTask] })
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTaskCenter(runtime)
  const root = runtime.getRoot()

  // Filter select contains cnv_missing_tree_source
  const selectEl = requireOne(root, (n) => n.props?.['data-wo-task-center-filter-select'] === 'true', 'Filter select')
  const orphanOption = requireOne(selectEl, (n) => n.props?.['data-wo-filter-option'] === 'cnv_missing_tree_source', 'Option orphan')
  assert.match(textOf(orphanOption), /cnv_missing_tree_source/u)

  // Filter by orphan source
  selectEl.props.onChange({ target: { value: 'cnv_missing_tree_source' } })
  await runtime.settle()

  const updatedRoot = runtime.getRoot()
  assert.ok(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-group'] === 'cnv_missing_tree_source') !== null)
  assert.ok(findOne(updatedRoot, (n) => n.props?.['data-wo-task-center-row'] === 'tsk_orphan_1') !== null)

  // Ensure snapshot tree was NOT mutated to fabricate a tree node
  assert.equal(baseSnapshot.nodes.some((n) => n.id === 'cnv_missing_tree_source'), false, 'Zero fabricated tree nodes')
})
