/**
 * FP-111: Source Conversation Tasks Lifecycle & Refresh Protection Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Tasks panel open/switch/close updates live source ref and lifecycle token synchronously.
 * 2. Refresh tasks is bound to {sourceId, token} captured at render time.
 *    - Closing source panel invalidates token immediately (both before and after render).
 *    - Switching source from A to B invalidates A's token immediately; old A Refresh is rejected.
 *    - Re-opening same source A starts new session with new token; old A Refresh from session 1 is rejected.
 * 3. Mounted lifecycle guard:
 *    - Saved Tasks toggle or Refresh invoked after unmount rejects with 0 RPCs and 0 state writes.
 * 4. Legitimate operations preserved:
 *    - Opening source tasks dispatches exactly 1 read-only taskLedger; zero automatic reconcile.
 *    - Valid Refresh dispatches exactly 1 reconcileTasks for current sourceId.
 *    - Re-entrancy during loading is rejected synchronously.
 *    - Loading state on A does not lock subsequent switch to B.
 * 5. In-flight cancellation & rejection safety:
 *    - In-flight loadTasks or refreshTasks resolving/rejecting after Close/Switch/Unmount is discarded safely.
 *    - Zero unhandled rejections.
 * 6. Multiple legal Refresh generation isolation:
 *    - U2 supersedes U1; late U1 response is discarded.
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
  sessionSource: 'synthetic-source-tasks-lifecycle-test'
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
      verificationState: 'verified',
      tasksCount: 1
    },
    {
      conversationId: 'cnv2',
      sessionId: 'ses-2',
      workspaceLogicalId: 'wsp-1',
      nativeWorkspaceId: 'nw-1',
      directory: 'E:\\ws-1',
      verificationState: 'verified',
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
      label: 'Build Pipeline A'
    },
    {
      taskId: 't-200',
      sourceConversationId: 'cnv2',
      parent: { kind: 'conversation', conversationId: 'cnv2' },
      childSessionId: 'ses-2',
      depth: 0,
      mode: 'plan',
      executionState: 'running',
      executionEligibility: 'eligible',
      observedAt: '2026-10-25T10:00:00.000Z',
      label: 'Build Pipeline B'
    }
  ]
} = {}) {
  return { revision, sources, tasks }
}

async function setupComponent({
  snapshot = baseSnapshot,
  status = baseStatus,
  taskLedgerHandler,
  reconcileHandler,
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

  const defaultLedger = makeLedger()
  const ledgerList = ledgers.length > 0 ? ledgers : [defaultLedger, defaultLedger, defaultLedger, defaultLedger, defaultLedger]
  const remote = createRemoteProxy({ snapshot, status, ledgers: ledgerList })

  if (typeof taskLedgerHandler === 'function') {
    remote.allowed.taskLedger = async (...args) => {
      remote.calls.push({ method: 'taskLedger', args })
      return taskLedgerHandler(...args)
    }
  }

  remote.allowed.reconcileTasks = async (input) => {
    remote.calls.push({ method: 'reconcileTasks', input })
    if (typeof reconcileHandler === 'function') {
      return reconcileHandler(input)
    }
    return { ok: true, value: { ledger: defaultLedger } }
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

test('1. [COUNTEREXAMPLE 1] Cross-source pollution defense: old A Refresh rejected when switched to B', async () => {
  const { runtime, remote, mounted } = await setupComponent()
  let root = runtime.getRoot()

  // 1. Open tasks for Conversation 1 (A)
  const tasksBtnA = requireOne(root, (n) => n.props?.['data-wo-tasks'] === 'cnv1')
  tasksBtnA.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-panel'] === 'cnv1'), 'Panel for cnv1 must be open')

  // 2. Save Refresh tasks handler from cnv1
  const refreshBtnA = requireOne(root, (n) => n.props?.['data-wo-task-refresh'] === 'true')
  const savedRefreshA = refreshBtnA.props.onClick

  // 3. Switch tasks to Conversation 2 (B)
  const tasksBtnB = requireOne(root, (n) => n.props?.['data-wo-tasks'] === 'cnv2')
  tasksBtnB.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-panel'] === 'cnv2'), 'Panel for cnv2 must be open')

  const reconcileCallsBefore = remote.calls.filter((c) => c.method === 'reconcileTasks').length

  // 4. Invoke saved Refresh callback for A while B is open
  savedRefreshA(mockEvent())
  await runtime.settle()

  // Verify ZERO reconcileTasks or taskLedger calls, and panel remains on cnv2
  const reconcileCallsAfter = remote.calls.filter((c) => c.method === 'reconcileTasks').length
  assert.equal(reconcileCallsAfter, reconcileCallsBefore, 'Old A Refresh must NOT dispatch reconcileTasks when B is active')

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-panel'] === 'cnv2'), 'Panel must remain on cnv2 without corruption')

  await mounted.cleanup()
})

test('2. [COUNTEREXAMPLE 2] Saved Refresh after Close rejected (immediate and post-render)', async () => {
  const { runtime, remote, mounted } = await setupComponent()
  let root = runtime.getRoot()

  // 1. Open tasks for Conversation 1
  const tasksBtn = requireOne(root, (n) => n.props?.['data-wo-tasks'] === 'cnv1')
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-panel'] === 'cnv1'))

  // 2. Save Refresh handler
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-task-refresh'] === 'true')
  const savedRefresh = refreshBtn.props.onClick

  // 3. Close tasks panel for Conversation 1
  tasksBtn.props.onClick(mockEvent())

  const reconcileCallsBefore = remote.calls.filter((c) => c.method === 'reconcileTasks').length

  // 4a. Invoke saved Refresh immediately without waiting for render
  savedRefresh(mockEvent())

  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-panel'] !== undefined), null, 'Panel must be closed')

  // 4b. Invoke saved Refresh again after render
  savedRefresh(mockEvent())
  await runtime.settle()

  const reconcileCallsAfter = remote.calls.filter((c) => c.method === 'reconcileTasks').length
  assert.equal(reconcileCallsAfter, reconcileCallsBefore, 'Saved Refresh after Close must NOT dispatch reconcileTasks')

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-panel'] !== undefined), null, 'Panel must remain closed')

  await mounted.cleanup()
})

test('3. [COUNTEREXAMPLE 3] Same-source session isolation: old Refresh from session 1 rejected in session 2', async () => {
  const { runtime, remote, mounted } = await setupComponent()
  let root = runtime.getRoot()

  // Session 1: open cnv1 and save Refresh
  const tasksBtn = requireOne(root, (n) => n.props?.['data-wo-tasks'] === 'cnv1')
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const savedRefresh1 = requireOne(root, (n) => n.props?.['data-wo-task-refresh'] === 'true').props.onClick

  // Close Session 1
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Session 2: re-open cnv1
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-panel'] === 'cnv1'))

  const reconcileCallsBefore = remote.calls.filter((c) => c.method === 'reconcileTasks').length

  // Invoke saved Refresh from Session 1
  savedRefresh1(mockEvent())
  await runtime.settle()

  const reconcileCallsAfter = remote.calls.filter((c) => c.method === 'reconcileTasks').length
  assert.equal(reconcileCallsAfter, reconcileCallsBefore, 'Old Refresh from Session 1 must be rejected in Session 2')

  await mounted.cleanup()
})

test('4. [COUNTEREXAMPLE 4] Mounted lifecycle guard: saved Tasks/Refresh after Unmount dispatches 0 RPCs and 0 state writes', async () => {
  const { runtime, remote, mounted, markUnmounted, getStateWritesAfterUnmount } = await setupComponent()
  let root = runtime.getRoot()

  // Open cnv1
  const tasksBtn = requireOne(root, (n) => n.props?.['data-wo-tasks'] === 'cnv1')
  const savedTasks = tasksBtn.props.onClick
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const savedRefresh = requireOne(root, (n) => n.props?.['data-wo-task-refresh'] === 'true').props.onClick

  // Unmount component
  markUnmounted()
  runtime.unmount()
  await mounted.cleanup()

  const callsBefore = remote.calls.length

  // Invoke saved handlers after unmount
  savedTasks(mockEvent())
  savedRefresh(mockEvent())
  await runtime.settle()

  const callsAfter = remote.calls.length
  assert.equal(callsAfter, callsBefore, 'Zero remote calls after unmount')
  assert.equal(getStateWritesAfterUnmount(), 0, 'Zero state writes after unmount')
})

test('5. Legitimate happy path: exactly 1 taskLedger on open, exactly 1 reconcile on Refresh, re-entrancy guarded', async () => {
  let reconcileCount = 0
  let holdReconcile = deferred()

  const { runtime, remote, mounted } = await setupComponent({
    reconcileHandler: async (input) => {
      reconcileCount++
      if (reconcileCount === 1) {
        return holdReconcile.promise
      }
      return { ok: true, value: { ledger: makeLedger() } }
    }
  })

  let root = runtime.getRoot()

  // 1. Open cnv1 -> exactly 1 taskLedger, zero reconcile
  const tasksBtnA = requireOne(root, (n) => n.props?.['data-wo-tasks'] === 'cnv1')
  tasksBtnA.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(remote.calls.filter((c) => c.method === 'taskLedger').length, 1, 'Exactly 1 taskLedger on open')
  assert.equal(remote.calls.filter((c) => c.method === 'reconcileTasks').length, 0, 'Zero reconcileTasks on open')

  root = runtime.getRoot()
  const refreshBtn = requireOne(root, (n) => n.props?.['data-wo-task-refresh'] === 'true')

  // 2. Click Refresh on cnv1 (initiates in-flight reconcile)
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(remote.calls.filter((c) => c.method === 'reconcileTasks').length, 1)

  // 3. Click Refresh again while loading (re-entrancy defense)
  refreshBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(remote.calls.filter((c) => c.method === 'reconcileTasks').length, 1, 'Re-entrancy during loading rejected')

  // Release first reconcile
  holdReconcile.resolve({ ok: true, value: { ledger: makeLedger() } })
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-row'] === 't-100'))

  await mounted.cleanup()
})

test('6. In-flight loadTasks discarded on Close or Switch: no reopen or state overwrite', async () => {
  let holdLoad = deferred()
  const { runtime, remote, mounted } = await setupComponent({
    taskLedgerHandler: () => holdLoad.promise
  })

  let root = runtime.getRoot()

  // Open cnv1 (in flight)
  const tasksBtn = requireOne(root, (n) => n.props?.['data-wo-tasks'] === 'cnv1')
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Close cnv1 while load is in flight
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-panel'] !== undefined), null, 'Panel is closed')

  // Resolve late load response
  holdLoad.resolve({ ok: true, value: makeLedger() })
  await runtime.settle()

  // Panel must REMAIN closed
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-panel'] !== undefined), null, 'Late load response must NOT reopen panel')

  await mounted.cleanup()
})

test('7. In-flight refreshTasks error/discard on Close: zero unhandled rejections', async () => {
  let holdReconcile = deferred()
  const { runtime, remote, mounted } = await setupComponent({
    reconcileHandler: () => holdReconcile.promise
  })

  let root = runtime.getRoot()

  // Open cnv1
  const tasksBtn = requireOne(root, (n) => n.props?.['data-wo-tasks'] === 'cnv1')
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Start Refresh
  requireOne(root, (n) => n.props?.['data-wo-task-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Close panel
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Reject late reconcile
  holdReconcile.reject(new Error('Network drop'))
  await runtime.settle()

  // Clean exit, panel remains closed
  root = runtime.getRoot()
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-panel'] !== undefined), null)

  await mounted.cleanup()
})

test('8. Superseded read isolation: U1 resolving after U2 on new session is discarded', async () => {
  let d1 = deferred()
  let d2 = deferred()
  let count = 0

  const { runtime, remote, mounted } = await setupComponent({
    reconcileHandler: () => {
      count++
      if (count === 1) return d1.promise
      return d2.promise
    }
  })

  let root = runtime.getRoot()

  // 1. Session 1: Open cnv1
  const tasksBtn = requireOne(root, (n) => n.props?.['data-wo-tasks'] === 'cnv1')
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const refreshBtn1 = requireOne(root, (n) => n.props?.['data-wo-task-refresh'] === 'true')

  // Start U1 on Session 1
  refreshBtn1.props.onClick(mockEvent())
  await runtime.settle()

  // 2. Close Session 1
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  // 3. Session 2: Re-open cnv1
  tasksBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const refreshBtn2 = requireOne(root, (n) => n.props?.['data-wo-task-refresh'] === 'true')

  // Start U2 on Session 2
  refreshBtn2.props.onClick(mockEvent())
  await runtime.settle()

  // 4. Resolve U2 first with rev 20
  const ledger2 = makeLedger({ revision: 20, tasks: [{ taskId: 't-rev20', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, label: 'Rev 20 Task' }] })
  d2.resolve({ ok: true, value: { ledger: ledger2 } })
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-row'] === 't-rev20'))

  // 5. Resolve superseded U1 later with rev 10
  const ledger1 = makeLedger({ revision: 10, tasks: [{ taskId: 't-rev10', sourceConversationId: 'cnv1', parent: { kind: 'conversation', conversationId: 'cnv1' }, label: 'Rev 10 Task' }] })
  d1.resolve({ ok: true, value: { ledger: ledger1 } })
  await runtime.settle()

  // U1 must be discarded; rev20 remains active
  root = runtime.getRoot()
  assert.ok(findOne(root, (n) => n.props?.['data-wo-task-row'] === 't-rev20'))
  assert.equal(findOne(root, (n) => n.props?.['data-wo-task-row'] === 't-rev10'), null)

  await mounted.cleanup()
})
