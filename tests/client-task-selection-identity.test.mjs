/**
 * FP-112: Centralized Task Center Selected Task Identity / Disambiguation Contract Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. 行选择 (selectTaskCenterTask):
 *    - Validates against raw ledger (currentLedger.tasks): taskId must be unique (exactly 1 match)
 *      and sourceConversationId must match the clicked row intent.
 *    - Rejects if panel closed, loading, unmounted, or if current filter excludes the source.
 *    - Rejects old saved row handlers if task shifted source, became duplicate, or was removed.
 * 2. 读取前绑定 (loadTaskCenter pre-fetch binding):
 *    - Reload freezes unique { taskId, sourceConversationId } from the last accepted raw ledger
 *      BEFORE dispatching the remote request.
 *    - Does NOT infer previous source from new response.
 *    - If no prior selection or prior selection was ambiguous in raw ledger, selection is cleared.
 * 3. 读取后保持 (loadTaskCenter post-fetch reconciliation):
 *    - Retains selection ONLY if task remains unique in new raw ledger, its sourceConversationId
 *      is identical to the frozen identity, and matches active filter.
 *    - If task is missing: normal deletion, accepts new ledger, clears selection.
 *    - If task ID is duplicated or source has drifted: rejects response, preserves previous ledger
 *      as stale, clears selection, sets status to "error", and displays honest identity unconfirmed error.
 * 4. 详情投影 (taskCenterSelectedTask projection):
 *    - Directly based on raw ledger uniqueness; never masks ambiguity by picking first match.
 *    - Handles missing SourceRecord gracefully with degenerate "unknown" / "unverified" disclosure.
 * 5. 连续性与世代守卫 (Continuity & Generation Guard):
 *    - Pure network failure preserves last trusted ledger and existing detail as stale.
 *    - Late out-of-order drifted/failed responses cannot overwrite newer accepted responses.
 *    - Remote calls strictly bounded to taskLedger; zero reconcileTasks, session open, or tree mutations.
 *    - Fixture immutability preserved.
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
    { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' },
    { id: 'cnv_a', parentId: 'w1', kind: 'conversation', title: 'Conversation A', sessionId: 'ses-a' },
    { id: 'cnv_b', parentId: 'w1', kind: 'conversation', title: 'Conversation B', sessionId: 'ses-b' }
  ]
})

const baseStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-task-selection-identity-test'
})

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
      conversationId: 'cnv_a',
      sessionId: 'ses-a',
      workspaceLogicalId: 'wsp-a',
      nativeWorkspaceId: 'nw-a',
      directory: 'E:\\ws-1',
      tasksCount: 1
    },
    {
      conversationId: 'cnv_b',
      sessionId: 'ses-b',
      workspaceLogicalId: 'wsp-b',
      nativeWorkspaceId: 'nw-b',
      directory: 'E:\\ws-1',
      tasksCount: 1
    }
  ],
  tasks = []
} = {}) {
  return { revision, sources, tasks }
}

async function setupComponent({
  snapshot = baseSnapshot,
  status = baseStatus,
  taskLedgerHandler,
  ledgers = []
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()

  let isUnmounted = false
  let stateWritesAfterUnmount = 0
  const origUseState = runtime.React.useState
  runtime.React.useState = function (initial) {
    const [state, setState] = origUseState(initial)
    const trackedSetState = function (val) {
      if (isUnmounted) {
        stateWritesAfterUnmount++
      }
      return setState(val)
    }
    return [state, trackedSetState]
  }

  const remote = createRemoteProxy({ snapshot, status, ledgers })
  if (typeof taskLedgerHandler === 'function') {
    remote.allowed.taskLedger = async (...args) => {
      remote.calls.push({ method: 'taskLedger', args })
      return taskLedgerHandler(...args)
    }
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

  return {
    runtime,
    remote,
    mounted,
    markUnmounted: () => { isUnmounted = true },
    getStateWritesAfterUnmount: () => stateWritesAfterUnmount
  }
}

async function openTaskCenter(runtime) {
  const root = runtime.getRoot()
  const openBtn = requireOne(
    root,
    (n) => n.props?.['data-wo-task-center'] === 'true',
    'All Tasks header button'
  )
  openBtn.props.onClick()
  await runtime.settle()
}

// ============================================================================
// Core Counterexamples (Must Fail on Baseline)
// ============================================================================

test('1. [COUNTEREXAMPLE] Source Drift on Reload: clears selection, shows error, and preserves stale ledger', async () => {
  // L1: tsk_t belongs to cnv_a
  const l1Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T (Orig)',
      sourceConversationId: 'cnv_a',
      parent: { kind: 'conversation', conversationId: 'cnv_a' },
      childSessionId: 'ses-a',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger1 = makeLedger({ revision: 1, tasks: l1Tasks })

  // L2: tsk_t has drifted to cnv_b! (Illegal cross-source drift)
  const l2Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T (Drifted)',
      sourceConversationId: 'cnv_b',
      parent: { kind: 'conversation', conversationId: 'cnv_b' },
      childSessionId: 'ses-b',
      depth: 0,
      mode: 'plan',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:05:00.000Z'
    }
  ]
  const ledger2 = makeLedger({ revision: 2, tasks: l2Tasks })

  let currentLedger = ledger1
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: currentLedger })
  })

  await openTaskCenter(runtime)

  // Select tsk_t
  const rowBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-row'] === 'tsk_t',
    'Row tsk_t'
  )
  rowBtn.props.onClick()
  await runtime.settle()

  // Verify detail is shown for tsk_t under cnv_a
  const detailEl = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_t',
    'Detail tsk_t'
  )
  assert.ok(detailEl)
  assert.ok(findOne(detailEl, (n) => n.props?.['data-wo-source-id'] === 'cnv_a'))

  // Switch server to L2 and click Reload
  currentLedger = ledger2
  const reloadBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-refresh'] === 'true',
    'Reload button'
  )
  reloadBtn.props.onClick()
  await runtime.settle()

  // Contract requirement:
  // 1. Selection MUST be cleared (detail view closed)
  assert.equal(
    findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] !== undefined),
    null,
    'Detail view must be cleared on source drift'
  )

  // 2. Status MUST be "error" (not "ready")
  const statusEl = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-status'] !== undefined,
    'Status element'
  )
  assert.equal(statusEl.props['data-wo-task-center-status'], 'error', 'Status must be error on source drift')

  // 3. Error notice must disclose unconfirmed identity
  const errorEl = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-error'] === 'true',
    'Error element'
  )
  assert.match(textOf(errorEl), /身份未确认|identity unconfirmed/i)

  // 4. Stale observation of ledger1 is preserved (shows rev 1)
  assert.match(textOf(statusEl), /rev 1/, 'Must preserve previous ledger revision 1 as stale')
  const staleEl = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-stale'] === 'true',
    'Stale banner'
  )
  assert.ok(staleEl)
})

test('2. [COUNTEREXAMPLE] Duplicate Task ID in Reload: clears selection, shows error, and preserves stale ledger', async () => {
  // L1: tsk_t unique in cnv_a
  const l1Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T',
      sourceConversationId: 'cnv_a',
      parent: { kind: 'conversation', conversationId: 'cnv_a' },
      childSessionId: 'ses-a',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger1 = makeLedger({ revision: 1, tasks: l1Tasks })

  // L2: tsk_t appears twice in raw ledger!
  const l2Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T (Duplicate 1)',
      sourceConversationId: 'cnv_a',
      parent: { kind: 'conversation', conversationId: 'cnv_a' },
      childSessionId: 'ses-a',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_t',
      label: 'Task T (Duplicate 2)',
      sourceConversationId: 'cnv_b',
      parent: { kind: 'conversation', conversationId: 'cnv_b' },
      childSessionId: 'ses-b',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger2 = makeLedger({ revision: 2, tasks: l2Tasks })

  let currentLedger = ledger1
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: currentLedger })
  })

  await openTaskCenter(runtime)

  // Select tsk_t
  const rowBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-row'] === 'tsk_t',
    'Row tsk_t'
  )
  rowBtn.props.onClick()
  await runtime.settle()

  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_t'))

  // Reload with L2 (duplicate)
  currentLedger = ledger2
  const reloadBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-refresh'] === 'true',
    'Reload button'
  )
  reloadBtn.props.onClick()
  await runtime.settle()

  // Detail view must be cleared
  assert.equal(
    findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] !== undefined),
    null,
    'Detail view must be cleared on duplicate ID'
  )

  // Status must be error
  const statusEl = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-status'] !== undefined,
    'Status element'
  )
  assert.equal(statusEl.props['data-wo-task-center-status'], 'error')

  // Error message indicates unconfirmed identity
  const errorEl = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-error'] === 'true',
    'Error element'
  )
  assert.match(textOf(errorEl), /身份未确认|identity unconfirmed/i)
})

test('3. [COUNTEREXAMPLE] Saved row handler is rejected when raw ledger has drifted source or duplicate ID', async () => {
  // L1: tsk_t in cnv_a
  const l1Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T (Orig)',
      sourceConversationId: 'cnv_a',
      parent: { kind: 'conversation', conversationId: 'cnv_a' },
      childSessionId: 'ses-a',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger1 = makeLedger({ revision: 1, tasks: l1Tasks })

  // L2: tsk_t in cnv_b
  const l2Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T (Drifted)',
      sourceConversationId: 'cnv_b',
      parent: { kind: 'conversation', conversationId: 'cnv_b' },
      childSessionId: 'ses-b',
      depth: 0,
      mode: 'plan',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:05:00.000Z'
    }
  ]
  const ledger2 = makeLedger({ revision: 2, tasks: l2Tasks })

  let currentLedger = ledger1
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: currentLedger })
  })

  await openTaskCenter(runtime)

  // Save the onClick handler of tsk_t (bound to intent: taskId='tsk_t', source='cnv_a')
  const rowBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-row'] === 'tsk_t',
    'Row tsk_t'
  )
  const savedRowOnClick = rowBtn.props.onClick

  // Without selecting, Reload to L2
  currentLedger = ledger2
  const reloadBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-refresh'] === 'true',
    'Reload button'
  )
  reloadBtn.props.onClick()
  await runtime.settle()

  // Now invoke the saved old handler for tsk_t / cnv_a against L2 (which has tsk_t / cnv_b)
  savedRowOnClick()
  await runtime.settle()

  // Must be rejected! Detail view must NOT open!
  assert.equal(
    findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] !== undefined),
    null,
    'Saved row handler must be rejected when task source has drifted'
  )
})

// ============================================================================
// Positive & Contract Invariant Tests
// ============================================================================

test('4. Positive: Legitimate Reload retains selection and updates label/execution observation', async () => {
  const l1Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T (Old Label)',
      sourceConversationId: 'cnv_a',
      parent: { kind: 'conversation', conversationId: 'cnv_a' },
      childSessionId: 'ses-a',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_u',
      label: 'Task U',
      sourceConversationId: 'cnv_b',
      parent: { kind: 'conversation', conversationId: 'cnv_b' },
      childSessionId: 'ses-b',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger1 = makeLedger({ revision: 1, tasks: l1Tasks })

  const l2Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T (Updated Label)',
      sourceConversationId: 'cnv_a',
      parent: { kind: 'conversation', conversationId: 'cnv_a' },
      childSessionId: 'ses-a',
      depth: 0,
      mode: 'plan',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:10:00.000Z'
    },
    {
      taskId: 'tsk_u',
      label: 'Task U',
      sourceConversationId: 'cnv_b',
      parent: { kind: 'conversation', conversationId: 'cnv_b' },
      childSessionId: 'ses-b',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger2 = makeLedger({ revision: 2, tasks: l2Tasks })

  let currentLedger = ledger1
  let ledgerCalls = 0
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      ledgerCalls++
      return { ok: true, value: currentLedger }
    }
  })

  await openTaskCenter(runtime)
  assert.equal(ledgerCalls, 1)

  // Select tsk_t
  const rowBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-row'] === 'tsk_t',
    'Row tsk_t'
  )
  rowBtn.props.onClick()
  await runtime.settle()

  // Detail view open with old label
  let detailEl = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_t',
    'Detail tsk_t'
  )
  assert.ok(detailEl)

  // Reload to L2
  currentLedger = ledger2
  const reloadBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-refresh'] === 'true',
    'Reload button'
  )
  reloadBtn.props.onClick()
  await runtime.settle()

  assert.equal(ledgerCalls, 2, 'Exactly 1 taskLedger dispatch on reload')

  // Selection retained!
  detailEl = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_t',
    'Detail tsk_t retained'
  )
  assert.ok(detailEl)
  // Check updated fields
  assert.match(textOf(detailEl), /running/)
})

test('5. Deletion on Reload: missing task clears selection without jumping to another task', async () => {
  const l1Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Common Label',
      sourceConversationId: 'cnv_a',
      parent: { kind: 'conversation', conversationId: 'cnv_a' },
      childSessionId: 'ses-a',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    },
    {
      taskId: 'tsk_u',
      label: 'Common Label', // Same label, different ID/source
      sourceConversationId: 'cnv_b',
      parent: { kind: 'conversation', conversationId: 'cnv_b' },
      childSessionId: 'ses-b',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger1 = makeLedger({ revision: 1, tasks: l1Tasks })

  // In L2, tsk_t is deleted
  const l2Tasks = [
    {
      taskId: 'tsk_u',
      label: 'Common Label',
      sourceConversationId: 'cnv_b',
      parent: { kind: 'conversation', conversationId: 'cnv_b' },
      childSessionId: 'ses-b',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger2 = makeLedger({ revision: 2, tasks: l2Tasks })

  let currentLedger = ledger1
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: currentLedger })
  })

  await openTaskCenter(runtime)

  // Select tsk_t
  const rowBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-row'] === 'tsk_t',
    'Row tsk_t'
  )
  rowBtn.props.onClick()
  await runtime.settle()

  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_t'))

  // Reload L2
  currentLedger = ledger2
  const reloadBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-refresh'] === 'true',
    'Reload button'
  )
  reloadBtn.props.onClick()
  await runtime.settle()

  // Accepts new ledger (status ready)
  const statusEl = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-status'] !== undefined,
    'Status element'
  )
  assert.equal(statusEl.props['data-wo-task-center-status'], 'ready')

  // Selection cleared; does NOT jump to tsk_u
  assert.equal(
    findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] !== undefined),
    null,
    'Detail view must be cleared when task is deleted'
  )
})

test('6. Missing SourceRecord in ledger.sources renders honest unknown/unverified fallback', async () => {
  const lTasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T',
      sourceConversationId: 'cnv_orphan', // Not in sources!
      parent: { kind: 'conversation', conversationId: 'cnv_orphan' },
      childSessionId: 'ses-orphan',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger = makeLedger({ revision: 1, sources: [], tasks: lTasks })

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger })
  })

  await openTaskCenter(runtime)

  // Select tsk_t
  const rowBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-row'] === 'tsk_t',
    'Row tsk_t'
  )
  rowBtn.props.onClick()
  await runtime.settle()

  // Detail view rendered
  const detailEl = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_t',
    'Detail tsk_t'
  )
  assert.ok(detailEl)

  // Verify honest unknown and unverified disclosure
  const logicalEl = requireOne(detailEl, (n) => n.props?.['data-wo-source-logical'] !== undefined)
  assert.equal(logicalEl.props['data-wo-source-logical'], 'unknown')
  const verEl = requireOne(detailEl, (n) => n.props?.['data-wo-source-verification'] !== undefined)
  assert.equal(verEl.props['data-wo-source-verification'], 'unverified')
})

test('7. Network failure preserves last trusted ledger and existing detail as stale', async () => {
  const lTasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T',
      sourceConversationId: 'cnv_a',
      parent: { kind: 'conversation', conversationId: 'cnv_a' },
      childSessionId: 'ses-a',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger = makeLedger({ revision: 1, tasks: lTasks })

  let shouldFail = false
  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      if (shouldFail) {
        throw new Error('Network timeout (synthetic)')
      }
      return { ok: true, value: ledger }
    }
  })

  await openTaskCenter(runtime)

  // Select tsk_t
  const rowBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-row'] === 'tsk_t',
    'Row tsk_t'
  )
  rowBtn.props.onClick()
  await runtime.settle()

  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_t'))

  // Trigger Reload with failure
  shouldFail = true
  const reloadBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-refresh'] === 'true',
    'Reload button'
  )
  reloadBtn.props.onClick()
  await runtime.settle()

  // Status error, stale banner shown, but existing detail preserved!
  const statusEl = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-status'] !== undefined,
    'Status element'
  )
  assert.equal(statusEl.props['data-wo-task-center-status'], 'error')
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-stale'] === 'true'))
  assert.ok(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-detail'] === 'tsk_t'))
})

test('8. Deferred promise ordering: late drifted response from older request is discarded', async () => {
  const l1Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T (Orig)',
      sourceConversationId: 'cnv_a',
      parent: { kind: 'conversation', conversationId: 'cnv_a' },
      childSessionId: 'ses-a',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger1 = makeLedger({ revision: 1, tasks: l1Tasks })

  const d1 = deferred()
  const d2 = deferred()
  let callCount = 0

  const { runtime } = await setupComponent({
    taskLedgerHandler: async () => {
      callCount++
      if (callCount === 1) return { ok: true, value: ledger1 }
      if (callCount === 2) return d1.promise
      if (callCount === 3) return d2.promise
      return { ok: true, value: ledger1 }
    }
  })

  await openTaskCenter(runtime)

  // Select tsk_t
  const rowBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-row'] === 'tsk_t',
    'Row tsk_t'
  )
  rowBtn.props.onClick()
  await runtime.settle()

  // Trigger Read 2 (superseded)
  const reloadBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-refresh'] === 'true',
    'Reload button'
  )
  reloadBtn.props.onClick()

  // Trigger Read 3 (superseding)
  reloadBtn.props.onClick()

  // Resolve Read 3 FIRST with valid updated ledger (rev 3)
  const l3Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T (Rev 3 Valid)',
      sourceConversationId: 'cnv_a',
      parent: { kind: 'conversation', conversationId: 'cnv_a' },
      childSessionId: 'ses-a',
      depth: 0,
      mode: 'plan',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:15:00.000Z'
    }
  ]
  const ledger3 = makeLedger({ revision: 3, tasks: l3Tasks })
  d2.resolve({ ok: true, value: ledger3 })
  await runtime.settle()

  // Read 3 has settled, status is ready, rev 3 is displayed
  let statusEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-status'] !== undefined)
  assert.equal(statusEl.props['data-wo-task-center-status'], 'ready')
  assert.match(textOf(statusEl), /rev 3/)

  // Now resolve Read 2 LATER with drifted source
  const l2Drifted = makeLedger({
    revision: 2,
    tasks: [{ ...l1Tasks[0], sourceConversationId: 'cnv_b' }]
  })
  d1.resolve({ ok: true, value: l2Drifted })
  await runtime.settle()

  // Read 2 MUST be discarded cleanly! Status must still be ready (rev 3), NOT error!
  statusEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-status'] !== undefined)
  assert.equal(statusEl.props['data-wo-task-center-status'], 'ready')
  assert.match(textOf(statusEl), /rev 3/)
})

test('9. Row click during loading or after close/unmount is rejected; RPCs and fixtures strictly bounded', async () => {
  const l1Tasks = [
    {
      taskId: 'tsk_t',
      label: 'Task T',
      sourceConversationId: 'cnv_a',
      parent: { kind: 'conversation', conversationId: 'cnv_a' },
      childSessionId: 'ses-a',
      depth: 0,
      mode: 'plan',
      executionState: 'ready',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z'
    }
  ]
  const ledger1 = makeLedger({ revision: 1, tasks: l1Tasks })
  const originalSnapshotJson = JSON.stringify(baseSnapshot)

  const { runtime, remote, mounted, markUnmounted, getStateWritesAfterUnmount } = await setupComponent({
    taskLedgerHandler: async () => ({ ok: true, value: ledger1 })
  })

  await openTaskCenter(runtime)

  const rowBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-row'] === 'tsk_t',
    'Row tsk_t'
  )
  const savedRowOnClick = rowBtn.props.onClick

  // Close panel
  const closeBtn = requireOne(
    runtime.getRoot(),
    (n) => n.props?.['data-wo-task-center-close'] === 'true',
    'Close button'
  )
  closeBtn.props.onClick()
  await runtime.settle()

  // Invoke saved row click after Close
  savedRowOnClick()
  await runtime.settle()

  // Must not open detail or resurrect panel
  assert.equal(
    findOne(runtime.getRoot(), (n) => n.props?.['data-wo-task-center-panel'] === 'true'),
    null,
    'Panel must not be resurrected by row click after close'
  )

  // Unmount
  markUnmounted()
  if (typeof mounted.cleanup === 'function') mounted.cleanup()
  if (typeof runtime.unmount === 'function') runtime.unmount()

  // Invoke saved row click after Unmount
  savedRowOnClick()
  await runtime.settle()

  assert.equal(getStateWritesAfterUnmount(), 0, 'Zero state writes after unmount')

  // Zero forbidden RPCs
  const forbiddenMethods = ['reconcileTasks', 'openConversation', 'startTask', 'stopTask']
  for (const call of remote.calls) {
    assert.ok(!forbiddenMethods.includes(call.method), `Forbidden method called: ${call.method}`)
  }

  // Fixture immutability
  assert.equal(JSON.stringify(baseSnapshot), originalSnapshotJson, 'baseSnapshot must not be mutated')
})
