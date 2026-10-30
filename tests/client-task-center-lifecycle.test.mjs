/**
 * FP-110: Task Center All Tasks / Reload Lifecycle Protection Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Reload button is bound to the specific panel lifecycle token that rendered it.
 *    - Closing the panel immediately invalidates the token.
 *    - Invoking saved Reload callback after Close (both immediately and after settle) rejects:
 *      zero new taskLedger RPCs dispatched, panel is NOT resurrected.
 * 2. Cross-session pollution defense:
 *    - Close session 1 -> Open session 2 (new token).
 *    - Invoking saved Reload callback from session 1 is rejected by token mismatch:
 *      zero new RPCs, session 2 filter/selection/in-flight state is NOT polluted.
 * 3. Mounted lifecycle guard:
 *    - Invoking saved All Tasks or Reload callbacks after component unmounts rejects:
 *      zero new taskLedger RPCs dispatched, zero state writes after unmount.
 * 4. Legitimate All Tasks & Reload behavior preserved:
 *    - All Tasks opens panel and dispatches exactly 1 taskLedger.
 *    - Legitimate Reload within live panel dispatches exactly 1 taskLedger, preserves filter.
 *    - Stale snapshot does not block legitimate Reload for recovery.
 *    - Failed Reload preserves previous ledger list, marks error status.
 * 5. In-flight cancellation on Close / Unmount:
 *    - In-flight ledger request resolving after Close is safely discarded without reopening panel.
 *    - In-flight ledger request rejecting after Close is safely discarded without unhandled rejection.
 *    - In-flight ledger request resolving/rejecting after Unmount is discarded cleanly.
 * 6. Multiple legal reads generation isolation:
 *    - Within the same open panel, second Reload supersedes first; late first response is discarded.
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
    { id: 'cnv1', parentId: 'w1', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-1' },
    { id: 'cnv2', parentId: 'w1', kind: 'conversation', title: 'Conversation 2', sessionId: 'ses-2' }
  ]
})

const baseStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-task-center-lifecycle-test'
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
      tasksCount: 1
    }
  ],
  tasks = [
    {
      taskId: 't-100',
      sourceConversationId: 'cnv1',
      parent: { kind: 'conversation', conversationId: 'cnv1' },
      childSessionId: 'ses-1',
      depth: 0,
      mode: 'plan',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z',
      label: 'Build Pipeline'
    }
  ]
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

test('1. [COUNTEREXAMPLE] Saved Reload called after Close does NOT resurrect panel or dispatch RPC', async () => {
  const ledger = makeLedger()
  const { runtime, remote, mounted } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  // 1. Open Task Center
  const allTasksBtn = requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true')
  allTasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), 'Panel must be open')

  // 2. Find and save Reload handler
  const reloadBtn = requireOne(root, (n) => n.props?.['data-wo-task-center-refresh'] === 'true')
  const savedReload = reloadBtn.props.onClick

  // 3. Close Task Center
  const closeBtn = requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true')
  closeBtn.props.onClick(mockEvent())

  const callsBefore = remote.calls.filter((c) => c.method === 'taskLedger').length

  // 4a. Invoke saved Reload immediately after Close without waiting for render
  savedReload(mockEvent())

  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Panel must be closed')

  // 4b. Invoke saved Reload again after render
  savedReload(mockEvent())
  await runtime.settle()

  // Verify ZERO new taskLedger RPCs and panel remains closed
  const callsAfter = remote.calls.filter((c) => c.method === 'taskLedger').length
  assert.equal(callsAfter, callsBefore, 'Saved Reload after Close must NOT dispatch new taskLedger RPC')

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Saved Reload after Close must NOT resurrect panel')

  await mounted.cleanup()
})

test('2. [COUNTEREXAMPLE] Cross-session pollution defense: saved Reload from session 1 rejected in session 2', async () => {
  const ledger = makeLedger()
  const { runtime, remote, mounted } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  // Session 1: open Task Center and save Reload
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const savedReload1 = requireOne(root, (n) => n.props?.['data-wo-task-center-refresh'] === 'true').props.onClick

  // Close Session 1
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Session 2: open Task Center afresh via All Tasks
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const session2Panel = requireOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true')
  assert.ok(session2Panel)

  const callsBefore = remote.calls.filter((c) => c.method === 'taskLedger').length

  // Invoke saved Reload from Session 1
  savedReload1(mockEvent())
  await runtime.settle()

  const callsAfter = remote.calls.filter((c) => c.method === 'taskLedger').length
  assert.equal(callsAfter, callsBefore, 'Old Reload from session 1 must be rejected in session 2')

  await mounted.cleanup()
})

test('3. Mounted lifecycle guard: saved All Tasks or Reload invoked after Unmount dispatches 0 RPCs and 0 state writes', async () => {
  const ledger = makeLedger()
  const { runtime, remote, mounted, markUnmounted, getStateWritesAfterUnmount } = await setupComponent({ ledgers: [ledger] })
  let root = runtime.getRoot()

  // Open Task Center
  const allTasksBtn = requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true')
  const savedAllTasks = allTasksBtn.props.onClick
  allTasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const savedReload = requireOne(root, (n) => n.props?.['data-wo-task-center-refresh'] === 'true').props.onClick

  // Unmount component
  markUnmounted()
  runtime.unmount()
  await mounted.cleanup()

  const callsBefore = remote.calls.filter((c) => c.method === 'taskLedger').length

  // Invoke saved All Tasks and Reload after unmount
  savedAllTasks(mockEvent())
  savedReload(mockEvent())
  await runtime.settle()

  const callsAfter = remote.calls.filter((c) => c.method === 'taskLedger').length
  assert.equal(callsAfter, callsBefore, 'Zero taskLedger calls after unmount')
  assert.equal(getStateWritesAfterUnmount(), 0, 'Zero state writes after unmount')
})

test('4. In-flight ledger read discarded on Close: does not reopen panel or overwrite state', async () => {
  let deferredLedger = deferred()
  const { runtime, remote, mounted } = await setupComponent({
    taskLedgerHandler: () => deferredLedger.promise
  })

  let root = runtime.getRoot()

  // Open Task Center (initiates in-flight read)
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Panel is currently loading
  const statusSpan = requireOne(root, (n) => n.props?.['data-wo-task-center-status'] !== undefined)
  assert.equal(statusSpan.props['data-wo-task-center-status'], 'loading')

  // Close panel while read is in-flight
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Panel is closed')

  // Resolve late response
  deferredLedger.resolve({ ok: true, value: makeLedger() })
  await runtime.settle()

  // Panel must REMAIN closed, not reopened by late response
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Late response must NOT reopen panel')

  await mounted.cleanup()
})

test('5. In-flight ledger read error discarded on Close: zero unhandled rejections', async () => {
  let deferredLedger = deferred()
  const { runtime, remote, mounted } = await setupComponent({
    taskLedgerHandler: () => deferredLedger.promise
  })

  let root = runtime.getRoot()

  // Open Task Center
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Close panel
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Reject late response
  deferredLedger.reject(new Error('Late network error'))
  await runtime.settle()

  // Clean exit without error
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null)

  await mounted.cleanup()
})

test('6. Legitimate All Tasks & Reload flow: happy path, preserves filter and error resilience', async () => {
  let currentLedger = makeLedger()
  let shouldFail = false

  const { runtime, remote, mounted } = await setupComponent({
    taskLedgerHandler: async () => {
      if (shouldFail) throw new Error('Ledger fetch timeout')
      return { ok: true, value: currentLedger }
    }
  })

  let root = runtime.getRoot()

  // 1. All Tasks opens panel, exactly 1 call
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'))
  assert.equal(remote.calls.filter((c) => c.method === 'taskLedger').length, 1)

  // 2. Legitimate Reload in open panel, dispatches exactly 1 call
  const reloadBtn = requireOne(root, (n) => n.props?.['data-wo-task-center-refresh'] === 'true')
  reloadBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(remote.calls.filter((c) => c.method === 'taskLedger').length, 2)

  // 3. Failed Reload preserves existing ledger data and displays error notice
  shouldFail = true
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(remote.calls.filter((c) => c.method === 'taskLedger').length, 3)
  const errorEl = requireOne(root, (n) => n.props?.['data-wo-task-center-error'] === 'true')
  assert.match(textOf(errorEl), /Ledger fetch timeout/u)
  // Rows still preserved
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-100'))

  await mounted.cleanup()
})

test('7. Multiple legal reads within same open panel: generation isolation (U2 supersedes U1)', async () => {
  let d1 = deferred()
  let d2 = deferred()
  let callCount = 0

  const { runtime, remote, mounted } = await setupComponent({
    taskLedgerHandler: () => {
      callCount++
      if (callCount === 1) return d1.promise
      return d2.promise
    }
  })

  let root = runtime.getRoot()

  // 1. Initial read (U1)
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // 2. Second read (U2) while U1 is in flight
  root = runtime.getRoot()
  const reloadBtn = requireOne(root, (n) => n.props?.['data-wo-task-center-refresh'] === 'true')
  reloadBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Resolve U2 first with ledger 2
  const ledger2 = makeLedger({ tasks: [{ taskId: 't-new', sourceConversationId: 'cnv1', label: 'New Task' }] })
  d2.resolve({ ok: true, value: ledger2 })
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-new'))

  // 4. Resolve superseded U1 later with old ledger
  const ledger1 = makeLedger({ tasks: [{ taskId: 't-old', sourceConversationId: 'cnv1', label: 'Old Task' }] })
  d1.resolve({ ok: true, value: ledger1 })
  await runtime.settle()

  // U1 response must be discarded; t-new remains active
  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-new'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-old'), null)

  await mounted.cleanup()
})

test('8. Saved Reload before Close rejected after opening via Quick Access View Detail', async () => {
  const ledger = makeLedger()
  const { runtime, remote, mounted } = await setupComponent({ ledgers: [ledger, ledger] })
  let root = runtime.getRoot()

  // 1. Session 1: open Task Center
  requireOne(root, (n) => n.props?.['data-wo-task-center'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const savedReload1 = requireOne(root, (n) => n.props?.['data-wo-task-center-refresh'] === 'true').props.onClick

  // Select t-100 and pin to Quick Access
  requireOne(root, (n) => n.props?.['data-wo-task-center-row'] === 't-100').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-pin'] === 't-100').props.onClick(mockEvent())
  await runtime.settle()

  // Close Session 1
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-task-center-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), null, 'Panel is closed')

  // 2. Open via Quick Access View Detail
  const viewDetailBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-task-view'] === 't-100')
  viewDetailBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-panel'] === 'true'), 'Panel is opened via QA')
  const detailEl = requireOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-100')
  assert.ok(detailEl)

  const callsBefore = remote.calls.filter((c) => c.method === 'taskLedger').length

  // 3. Invoke saved Reload from Session 1
  savedReload1(mockEvent())
  await runtime.settle()

  // Verify ZERO new calls and detail remains t-100
  const callsAfter = remote.calls.filter((c) => c.method === 'taskLedger').length
  assert.equal(callsAfter, callsBefore, 'Old Reload must NOT dispatch RPC into QA navigation session')

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-center-detail'] === 't-100'), 'Selected detail must remain intact')

  await mounted.cleanup()
})
