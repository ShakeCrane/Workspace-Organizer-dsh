import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createHooksRuntime,
  createRemoteProxy,
  createZodTestDouble,
  findOne,
  mountClientApplication,
  requireOne,
  textOf
} from '../scripts/lib/c3a-synthetic-component-runtime.mjs'

const snapshot = Object.freeze({
  rootId: 'root',
  revision: 41,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root' },
    { id: 'project', parentId: 'root', kind: 'project', title: 'Project' },
    { id: 'workspace', parentId: 'project', kind: 'workspace', title: 'Workspace' },
    { id: 'cnv_error_race', parentId: 'workspace', kind: 'conversation', title: 'Error Race Source', sessionId: 'session-error-race' }
  ]
})

function makeLedger(revision, executionEligibility = 'eligible') {
  return {
    revision,
    sources: [{
      conversationId: 'cnv_error_race',
      sessionId: 'session-error-race',
      workspaceLogicalId: 'workspace',
      nativeWorkspaceId: 'native-workspace',
      directory: 'D:\\synthetic\\error-race',
      verifiedAt: '2026-10-29T00:00:00.000Z',
      verificationState: 'verified',
      hostVersion: 'synthetic'
    }],
    tasks: [{
      taskId: 'task_error_race',
      label: 'Error Race Task',
      childSessionId: 'child-error-race',
      sourceConversationId: 'cnv_error_race',
      parent: { kind: 'conversation', conversationId: 'cnv_error_race' },
      depth: 1,
      mode: 'one-shot',
      executionState: 'UNKNOWN',
      executionEligibility,
      observedAt: '2026-10-29T00:00:00.000Z'
    }]
  }
}

function createControlledTimerQueue() {
  let nextId = 0
  const callbacks = new Map()
  const events = []
  return {
    events,
    setTimeout(fn, delay) {
      const id = ++nextId
      callbacks.set(id, fn)
      events.push({ action: 'schedule', id, delay })
      return id
    },
    clearTimeout(id) {
      const removed = callbacks.delete(id)
      events.push({ action: 'clear', id, removed })
    },
    count() { return callbacks.size },
    flush() {
      const pending = [...callbacks.entries()]
      callbacks.clear()
      for (const [id, callback] of pending) {
        events.push({ action: 'fire', id })
        callback()
      }
    }
  }
}

function observe(runtime) {
  const root = runtime.getRoot()
  const status = requireOne(root, node => Object.hasOwn(node.props ?? {}, 'data-wo-task-center-status'), 'Task Center status')
  const error = findOne(root, node => node.props?.['data-wo-task-center-error'] === 'true')
  const taskRow = findOne(root, node => node.props?.['data-wo-task-center-row'] === 'task_error_race')
  const taskDetail = findOne(root, node => node.props?.['data-wo-task-center-detail'] === 'task_error_race')
  const source = findOne(root, node => node.props?.['data-wo-node-id'] === 'cnv_error_race')
  const feedback = findOne(root, node => node.props?.['data-wo-task-center-locate-feedback'] === 'true')
  return {
    status: status.props['data-wo-task-center-status'],
    statusText: textOf(status),
    errorText: error === null ? null : textOf(error),
    taskRowPresent: taskRow !== null,
    taskDetailId: taskDetail?.props?.['data-wo-task-center-detail'] ?? null,
    selectedSource: source?.props?.['data-wo-selected'] ?? null,
    locateState: feedback?.props?.['data-wo-task-center-locate-state'] ?? null,
    locateText: feedback === null ? null : textOf(feedback)
  }
}

async function prepareScenario({ reloadMode, executionEligibility = 'eligible' }) {
  const sourceCode = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const L1 = makeLedger(1, executionEligibility)
  const L2 = makeLedger(2, executionEligibility)
  assert.notEqual(L1, L2)
  assert.notEqual(L1.sources[0], L2.sources[0])
  assert.notEqual(L1.tasks[0], L2.tasks[0])
  assert.equal(L1.tasks[0].taskId, L2.tasks[0].taskId)
  assert.equal(L1.tasks[0].sourceConversationId, L2.tasks[0].sourceConversationId)

  const timeline = []
  const timerQueue = createControlledTimerQueue()
  const scrolls = []
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status: { conversationsCreatable: true }, ledgers: [] })
  let taskLedgerReads = 0
  remote.allowed.taskLedger = (...args) => {
    remote.calls.push({ method: 'taskLedger', args })
    taskLedgerReads += 1
    timeline.push({ phase: 'taskLedger-call', ordinal: taskLedgerReads })
    if (taskLedgerReads === 1) return { ok: true, value: L1 }
    if (taskLedgerReads !== 2) throw new Error('unexpected additional taskLedger read')
    if (reloadMode === 'sync-throw') throw new Error('synthetic Reload taskLedger rejection')
    if (reloadMode === 'async-reject') return Promise.reject(new Error('synthetic Reload taskLedger rejection'))
    if (reloadMode === 'success') return { ok: true, value: L2 }
    throw new Error(`unsupported reload mode: ${reloadMode}`)
  }

  const mounted = await mountClientApplication({
    source: sourceCode,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote,
    document: {
      querySelector(selector) {
        return {
          scrollIntoView(options) { scrolls.push({ selector, options }) }
        }
      }
    },
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()
  requireOne(runtime.getRoot(), node => node.props?.['data-wo-task-center'] === 'true', 'All Tasks button')
    .props.onClick({ stopPropagation() {}, preventDefault() {} })
  await runtime.settle()
  const initialReady = observe(runtime)
  assert.equal(initialReady.status, 'ready')
  assert.match(initialReady.statusText, /rev 1/u)
  timeline.push({ phase: 'L1-ready-rendered', state: initialReady, remoteCalls: remote.calls.map(call => call.method) })

  requireOne(runtime.getRoot(), node => node.props?.['data-wo-task-center-row'] === 'task_error_race', 'Task T row')
    .props.onClick()
  await runtime.settle()
  const remoteCallsBeforeLocate = remote.calls.length
  requireOne(runtime.getRoot(), node => node.props?.['data-wo-task-center-locate'] === 'task_error_race', 'rendered Locate button')
    .props.onClick({ stopPropagation() {}, preventDefault() {} })
  await runtime.settle()
  assert.equal(timerQueue.count(), 1, 'Locate schedules one pending timer before Reload')
  assert.equal(remote.calls.length, remoteCallsBeforeLocate, 'Locate dispatch performs no RPC')
  assert.equal(observe(runtime).selectedSource, 'true', 'initial Locate selects source C before Reload')
  timeline.push({ phase: 'Locate-pending', state: observe(runtime), timerEvents: [...timerQueue.events], remoteCalls: remote.calls.map(call => call.method) })

  requireOne(runtime.getRoot(), node => node.props?.['data-wo-task-center-refresh'] === 'true', 'rendered Reload button')
    .props.onClick({ stopPropagation() {}, preventDefault() {} })
  timeline.push({ phase: 'Reload-clicked', timerPending: timerQueue.count(), taskLedgerReads, remoteCalls: remote.calls.map(call => call.method) })
  await runtime.settle()
  const afterReload = observe(runtime)
  assert.equal(taskLedgerReads, 2, 'Reload performs exactly one additional taskLedger read')
  assert.equal(timerQueue.count(), 1, 'Reload leaves the old Locate timer pending')
  timeline.push({ phase: 'Reload-render-settled', state: afterReload, timerPending: timerQueue.count(), taskLedgerReads, remoteCalls: remote.calls.map(call => call.method) })

  return {
    runtime,
    mounted,
    remote,
    timerQueue,
    scrolls,
    timeline,
    taskLedgerReads: () => taskLedgerReads,
    afterReload,
    async flushTimer() {
      const remoteCallsBeforeTimer = [...remote.calls]
      timeline.push({ phase: 'flush-start', state: observe(runtime), timerPending: timerQueue.count(), taskLedgerReads, remoteCalls: remote.calls.map(call => call.method) })
      timerQueue.flush()
      await runtime.settle()
      const afterTimer = observe(runtime)
      const result = {
        afterTimer,
        remoteDelta: remote.calls.slice(remoteCallsBeforeTimer.length),
        taskLedgerReadsBefore: remoteCallsBeforeTimer.filter(call => call.method === 'taskLedger').length,
        taskLedgerReadsAfter: taskLedgerReads,
        timerPending: timerQueue.count(),
        timerEvents: [...timerQueue.events],
        allRemoteCalls: [...remote.calls],
        illegalRemoteCalls: [...remote.illegal]
      }
      timeline.push({ phase: 'after-timer', ...result, scrolls: [...scrolls] })
      return result
    }
  }
}

function assertExactSourceScroll(scrolls) {
  assert.equal(scrolls.length, 1)
  assert.equal(scrolls[0].selector, '[data-wo-node-id="cnv_error_race"]')
  assert.equal(Object.hasOwn(scrolls[0].options, 'block'), true)
  assert.equal(scrolls[0].options.block, 'center')
  assert.deepEqual(Object.keys(scrolls[0].options), ['block'])
}

for (const reloadMode of ['async-reject', 'sync-throw']) {
  test(`queued Locate is cancelled after a rendered Reload error (${reloadMode})`, async (t) => {
    const scenario = await prepareScenario({ reloadMode })
    const beforeTimer = scenario.afterReload
    assert.equal(beforeTimer.status, 'error')
    assert.match(beforeTimer.statusText, /rev 1/u, 'error render retains the old ledger revision')
    assert.match(beforeTimer.errorText, /synthetic Reload taskLedger rejection/u)
    assert.equal(beforeTimer.taskRowPresent, true, 'error render retains Task T')
    assert.equal(beforeTimer.taskDetailId, 'task_error_race', 'error render retains the selected Task detail')
    assert.equal(beforeTimer.selectedSource, 'true', 'selection baseline is captured after error render')
    assert.equal(scenario.timerQueue.count(), 1, 'old Locate timer remains pending after error render')

    const result = await scenario.flushTimer()
    const afterTimer = result.afterTimer
    assert.equal(scenario.scrolls.length, 0, 'old Locate must not scroll after the error render')
    assert.equal(afterTimer.locateState, 'cancelled')
    assert.match(afterTimer.locateText, /Task Center.*error.*queued locate scroll cancelled/iu)
    assert.equal(afterTimer.status, beforeTimer.status)
    assert.equal(afterTimer.statusText, beforeTimer.statusText)
    assert.equal(afterTimer.errorText, beforeTimer.errorText)
    assert.equal(afterTimer.taskRowPresent, beforeTimer.taskRowPresent)
    assert.equal(afterTimer.taskDetailId, beforeTimer.taskDetailId)
    assert.equal(afterTimer.selectedSource, beforeTimer.selectedSource)
    assert.deepEqual(result.remoteDelta, [], 'timer phase performs no additional RPC')
    assert.equal(result.taskLedgerReadsBefore, 2)
    assert.equal(result.taskLedgerReadsAfter, 2)
    assert.equal(result.timerPending, 0)
    assert.deepEqual(result.illegalRemoteCalls, [], 'timer phase invokes no mutation, session, reconciliation, or execution RPC')
    assert.deepEqual(result.timerEvents.map(event => event.action), ['schedule', 'fire'])
    t.diagnostic(`FP127 ${reloadMode} timeline: ${JSON.stringify(scenario.timeline)}`)
    await scenario.mounted.cleanup()
  })
}

test('queued Locate scrolls once when a successful Reload keeps the source usable', async () => {
  const scenario = await prepareScenario({ reloadMode: 'success' })
  assert.equal(scenario.afterReload.status, 'ready')
  assert.match(scenario.afterReload.statusText, /rev 2/u)
  assert.equal(scenario.timerQueue.count(), 1)
  const result = await scenario.flushTimer()
  assertExactSourceScroll(scenario.scrolls)
  assert.equal(result.afterTimer.locateState, 'located')
  assert.match(result.afterTimer.locateText, /Located Error Race Source/u)
  assert.equal(result.remoteDelta.length, 0)
  assert.equal(result.taskLedgerReadsAfter, 2)
  assert.deepEqual(result.illegalRemoteCalls, [])
  await scenario.mounted.cleanup()
})

test('ordinary blocked Task remains locatable while its source stays usable', async () => {
  const scenario = await prepareScenario({ reloadMode: 'success', executionEligibility: 'blocked' })
  assert.equal(scenario.afterReload.status, 'ready')
  const result = await scenario.flushTimer()
  assertExactSourceScroll(scenario.scrolls)
  assert.equal(result.afterTimer.locateState, 'located')
  assert.match(result.afterTimer.locateText, /Located Error Race Source/u)
  assert.equal(result.remoteDelta.length, 0)
  assert.equal(result.taskLedgerReadsAfter, 2)
  assert.deepEqual(result.illegalRemoteCalls, [])
  await scenario.mounted.cleanup()
})
