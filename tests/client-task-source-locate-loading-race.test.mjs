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

const sourceId = 'source-S'
const taskT = {
  taskId: 'task-T', label: 'Task T', childSessionId: 'child-T', sourceConversationId: sourceId,
  parent: { kind: 'conversation', conversationId: sourceId }, depth: 1, mode: 'one-shot',
  executionState: 'UNKNOWN', executionEligibility: 'eligible', observedAt: '2026-10-30T00:00:00.000Z'
}
const taskU = { ...taskT, taskId: 'task-U', label: 'Task U', childSessionId: 'child-U' }

const snapshot = {
  rootId: 'root',
  revision: 1,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root' },
    { id: 'project', parentId: 'root', kind: 'project', title: 'Project' },
    { id: 'workspace', parentId: 'project', kind: 'workspace', title: 'Workspace' },
    { id: sourceId, parentId: 'workspace', kind: 'conversation', title: 'Source S', sessionId: 'session-S' }
  ]
}

function makeLedger(revision, { archived = false, tasks = [taskT] } = {}) {
  return {
    revision,
    sources: [{
      conversationId: sourceId, sessionId: 'session-S', workspaceLogicalId: 'workspace',
      nativeWorkspaceId: 'native-workspace', directory: 'D:\\synthetic\\fp132',
      verifiedAt: '2026-10-30T00:00:00.000Z', verificationState: 'verified', hostVersion: 'synthetic',
      ...(archived ? { blockedReason: 'source-archived' } : {})
    }],
    tasks: tasks.map((task) => ({ ...task, parent: { ...task.parent } }))
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeTimerQueue() {
  let nextId = 0
  const pending = new Map()
  const events = []
  return {
    pending,
    events,
    setTimeout(fn, delay) {
      const id = ++nextId
      pending.set(id, fn)
      events.push({ action: 'schedule', id, delay })
      return id
    },
    clearTimeout(id) {
      const existed = pending.delete(id)
      events.push({ action: 'cancel', id, existed })
      return existed
    },
    flush() {
      const callbacks = [...pending.entries()]
      pending.clear()
      for (const [id, callback] of callbacks) {
        events.push({ action: 'fire', id })
        callback()
      }
    }
  }
}

function countUseStateSetterCalls(runtime) {
  let calls = 0
  const originalUseState = runtime.React.useState.bind(runtime.React)
  runtime.React.useState = (initialValue) => {
    const [value, setState] = originalUseState(initialValue)
    return [value, (...args) => {
      calls += 1
      return setState(...args)
    }]
  }
  return { get count() { return calls } }
}

function readStatus(root) {
  const node = requireOne(root, (entry) => Object.hasOwn(entry.props ?? {}, 'data-wo-task-center-status'), 'Task Center status')
  return {
    value: node.props['data-wo-task-center-status'],
    text: textOf(node)
  }
}

function readFeedback(root) {
  const node = findOne(root, (entry) => entry.props?.['data-wo-task-center-locate-feedback'] === 'true')
  return node === null ? null : {
    state: node.props['data-wo-task-center-locate-state'],
    text: textOf(node)
  }
}

function isTaskCenterPanelOpen(root) {
  return findOne(root, (entry) => entry.props?.['data-wo-task-center-panel'] === 'true') !== null
}

async function setup({ tasks = [taskT] } = {}) {
  const sourceCode = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const L1 = makeLedger(1, { tasks })
  const reload = deferred()
  const timeline = []
  const timerQueue = makeTimerQueue()
  const selectors = []
  const scrolls = []
  const runtime = createHooksRuntime()
  const stateWrites = countUseStateSetterCalls(runtime)
  const remote = createRemoteProxy({ snapshot, status: { conversationsCreatable: true }, ledgers: [] })
  let taskLedgerCalls = 0
  remote.allowed.taskLedger = (...args) => {
    remote.calls.push({ method: 'taskLedger', args })
    taskLedgerCalls += 1
    if (taskLedgerCalls === 1) return { ok: true, value: L1 }
    if (taskLedgerCalls === 2) return reload.promise
    throw new Error(`unexpected taskLedger request ${taskLedgerCalls}`)
  }

  const mounted = await mountClientApplication({
    source: sourceCode,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote,
    document: {
      querySelector(selector) {
        selectors.push(selector)
        return { scrollIntoView(options) { scrolls.push({ selector, options }) } }
      }
    },
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()

  function record(phase) {
    const root = runtime.getRoot()
    const panelOpen = isTaskCenterPanelOpen(root)
    const detail = findOne(root, (node) => node.props?.['data-wo-task-center-detail'] !== undefined)
    const source = findOne(root, (node) => node.props?.['data-wo-node-id'] === sourceId)
    const feedback = readFeedback(root)
    const entry = {
      at: new Date().toISOString(),
      phase,
      panelOpen,
      status: panelOpen ? readStatus(root) : null,
      taskDetail: detail === null ? null : {
        taskId: detail.props['data-wo-task-center-detail'],
        text: textOf(detail)
      },
      source: source === null ? null : {
        id: source.props['data-wo-node-id'],
        selected: source.props['data-wo-selected'] ?? null,
        kind: source.props['data-wo-kind']
      },
      feedback,
      feedbackPresent: feedback !== null,
      stateSetterCalls: stateWrites.count,
      taskLedgerCalls,
      remoteCalls: [...remote.calls],
      illegalRemoteCalls: [...remote.illegal],
      timerEvents: [...timerQueue.events],
      pendingTimerIds: [...timerQueue.pending.keys()],
      selectors: [...selectors],
      scrolls: [...scrolls]
    }
    timeline.push(entry)
    return entry
  }

  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center'] === 'true', 'rendered All Tasks button').props.onClick()
  await runtime.settle()
  assert.equal(readStatus(runtime.getRoot()).value, 'ready', 'initial Task Center read reaches ready')
  assert.match(readStatus(runtime.getRoot()).text, /rev 1/u)
  record('All-Tasks-ready-L1')

  return {
    L1,
    reload,
    runtime,
    mounted,
    remote,
    timerQueue,
    selectors,
    scrolls,
    stateWrites,
    timeline,
    record,
    get taskLedgerCalls() { return taskLedgerCalls },
    async selectTask(taskId) {
      requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === taskId, `rendered ${taskId} row`).props.onClick()
      await runtime.settle()
      record(`selected-${taskId}`)
    },
    async dispatchLocate(taskId) {
      requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate'] === taskId, `rendered Locate ${taskId}`).props.onClick({ stopPropagation() {}, preventDefault() {} })
      await runtime.settle()
      record(`rendered-Locate-${taskId}-dispatched`)
    },
    async dispatchReload() {
      requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'rendered Reload button').props.onClick({ stopPropagation() {}, preventDefault() {} })
      await runtime.settle()
      const loading = record('Reload-loading-committed')
      assert.equal(loading.status.value, 'loading', 'Reload loading must render while its controlled taskLedger promise is pending')
      assert.equal(taskLedgerCalls, 2, 'Reload starts exactly one additional taskLedger read')
      return loading
    },
    async flushTimers(phase) {
      timerQueue.flush()
      await runtime.settle()
      return record(phase)
    }
  }
}

function assertNoLocateSideEffects(env, entry, callsBefore) {
  assert.deepEqual(env.selectors, [], 'loading cancellation must not query a DOM row')
  assert.deepEqual(env.scrolls, [], 'loading cancellation must not scroll')
  assert.deepEqual(env.remote.calls, callsBefore, 'Locate timer must add no RPC')
  assert.equal(env.taskLedgerCalls, 2, 'Locate timer must not retry taskLedger')
  assert.deepEqual(env.remote.illegal, [], 'no mutation, reconcile, openSession, or execution RPC is allowed')
  assert.deepEqual(entry.timerEvents.map((event) => event.action), ['schedule', 'fire'], 'the pending Locate timer fires once without cancellation or rescheduling')
  assert.deepEqual(entry.pendingTimerIds, [], 'the one-shot Locate timer is drained')
}

function assertExactSourceScroll(scrolls) {
  assert.equal(scrolls.length, 1, 'the fresh Locate scrolls once')
  assert.equal(scrolls[0].selector, '[data-wo-node-id="source-S"]')
  assert.equal(Object.hasOwn(scrolls[0].options, 'block'), true)
  assert.equal(scrolls[0].options.block, 'center')
  assert.deepEqual(Object.keys(scrolls[0].options), ['block'])
}

test('queued Locate cancels during Reload loading; fresh Locate works after a ready result', async (t) => {
  const env = await setup()
  t.after(() => env.mounted.cleanup())
  await env.selectTask('task-T')
  await env.dispatchLocate('task-T')
  assert.equal(env.timerQueue.pending.size, 1, 'the rendered Locate callback queues one timer')
  assert.deepEqual(env.remote.calls.filter((call) => call.method === 'taskLedger').length, 1, 'Locate itself adds no taskLedger read')

  const loading = await env.dispatchReload()
  assert.equal(loading.taskDetail?.taskId, 'task-T')
  assert.match(loading.status.text, /rev 1/u, 'loading keeps the last confirmed ledger visible')
  assert.deepEqual(loading.pendingTimerIds, [1])
  const callsBeforeTimer = [...env.remote.calls]
  const settersBeforeTimer = env.stateWrites.count

  const afterTimer = await env.flushTimers('old-Locate-flushed-during-loading')
  const evidence = JSON.stringify({ timeline: env.timeline, finalTimerEvents: env.timerQueue.events }, null, 2)
  t.diagnostic(evidence)
  assert.equal(afterTimer.status.value, 'loading', `Reload remains unsettled while the old Locate timer fires; evidence=${evidence}`)
  assert.equal(afterTimer.taskDetail?.taskId, 'task-T', `current Task T remains selected; evidence=${evidence}`)
  assert.equal(afterTimer.feedback?.state, 'cancelled', `the deferred Locate reports cancelled while loading; evidence=${evidence}`)
  assert.match(afterTimer.feedback?.text ?? '', /source read unconfirmed/u, `loading is not described as archived or failed; evidence=${evidence}`)
  assert.ok(env.stateWrites.count > settersBeforeTimer, `current Task T receives the cancellation notice; evidence=${evidence}`)
  assertNoLocateSideEffects(env, afterTimer, callsBeforeTimer)

  env.reload.resolve({ ok: true, value: makeLedger(2) })
  await env.runtime.settle()
  const ready = env.record('Reload-resolved-ready-L2')
  assert.equal(ready.status.value, 'ready')
  assert.match(ready.status.text, /rev 2/u)
  assert.equal(ready.taskDetail?.taskId, 'task-T')
  assert.deepEqual(env.selectors, [], 'settling the read does not auto-retry the cancelled Locate')
  assert.deepEqual(env.scrolls, [], 'settling the read does not auto-scroll')

  await env.dispatchLocate('task-T')
  assert.equal(env.timerQueue.pending.size, 1, 'a new user click schedules a new Locate timer')
  await env.flushTimers('fresh-Locate-after-ready')
  assertExactSourceScroll(env.scrolls)
  assert.equal(readFeedback(env.runtime.getRoot())?.state, 'located')
  assert.deepEqual(env.timerQueue.events.map((event) => event.action), ['schedule', 'fire', 'schedule', 'fire'])
  assert.equal(env.taskLedgerCalls, 2, 'the fresh Locate still performs no extra ledger read')
  assert.equal(env.remote.illegal.length, 0)
})

test('loading cancellation does not predict an archived outcome; the settled archived ledger keeps its refusal behavior', async (t) => {
  const env = await setup()
  t.after(() => env.mounted.cleanup())
  await env.selectTask('task-T')
  await env.dispatchLocate('task-T')
  const loading = await env.dispatchReload()
  assert.equal(loading.status.value, 'loading')
  const callsBeforeTimer = [...env.remote.calls]
  const afterTimer = await env.flushTimers('old-Locate-flushed-before-archived-settlement')
  t.diagnostic(JSON.stringify({ timeline: env.timeline, selectors: env.selectors, scrolls: env.scrolls, timerEvents: env.timerQueue.events }, null, 2))
  assert.equal(afterTimer.feedback?.state, 'cancelled')
  assert.match(afterTimer.feedback?.text ?? '', /source read unconfirmed/u)
  assert.doesNotMatch(afterTimer.feedback?.text ?? '', /archived/u, 'pending read is not treated as proof of archive')
  assertNoLocateSideEffects(env, afterTimer, callsBeforeTimer)

  env.reload.resolve({ ok: true, value: makeLedger(2, { archived: true }) })
  await env.runtime.settle()
  const readyArchived = env.record('Reload-resolved-ready-archived-L2')
  assert.equal(readyArchived.status.value, 'ready')
  assert.match(readyArchived.status.text, /rev 2/u)
  assert.deepEqual(env.scrolls, [], 'archived settlement does not revive the old timer')
  await env.dispatchLocate('task-T')
  const feedback = readFeedback(env.runtime.getRoot())
  assert.equal(feedback?.state, 'error', 'a fresh Locate retains the existing archive refusal')
  assert.match(feedback?.text ?? '', /archived/u)
  assert.deepEqual(env.scrolls, [])
  assert.deepEqual(env.selectors, [])
  assert.equal(env.taskLedgerCalls, 2)
  assert.equal(env.remote.illegal.length, 0)
})

test('loading cancellation remains distinct from a later taskLedger rejection and error render', async (t) => {
  const env = await setup()
  t.after(() => env.mounted.cleanup())
  await env.selectTask('task-T')
  await env.dispatchLocate('task-T')
  const loading = await env.dispatchReload()
  assert.equal(loading.status.value, 'loading')
  const callsBeforeTimer = [...env.remote.calls]
  const afterTimer = await env.flushTimers('old-Locate-flushed-before-rejection')
  assert.equal(afterTimer.feedback?.state, 'cancelled')
  assert.match(afterTimer.feedback?.text ?? '', /source read unconfirmed/u)
  assertNoLocateSideEffects(env, afterTimer, callsBeforeTimer)

  env.reload.reject(new Error('synthetic FP-132 Reload rejection'))
  await env.runtime.settle()
  const error = env.record('Reload-rejected-error-render')
  const evidence = JSON.stringify({ timeline: env.timeline, rpcCalls: env.remote.calls, timerEvents: env.timerQueue.events }, null, 2)
  t.diagnostic(evidence)
  assert.equal(error.status.value, 'error', `the rejection still commits the existing error state; evidence=${evidence}`)
  assert.match(error.status.text, /rev 1/u, `the error view retains its previous confirmed ledger; evidence=${evidence}`)
  assert.match(textOf(requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-error'] === 'true', 'Task Center error')), /synthetic FP-132 Reload rejection/u)
  assert.equal(error.taskDetail?.taskId, 'task-T')
  assert.equal(env.taskLedgerCalls, 2)
  assert.equal(env.selectors.length, 0)
  assert.equal(env.scrolls.length, 0)
  assert.deepEqual(env.remote.illegal, [])
})

test('old T timer does not write to U while Reload is loading', async (t) => {
  const env = await setup({ tasks: [taskT, taskU] })
  t.after(() => env.mounted.cleanup())
  await env.selectTask('task-T')
  await env.dispatchLocate('task-T')
  assert.equal(env.timerQueue.pending.size, 1)
  await env.selectTask('task-U')
  const loading = await env.dispatchReload()
  assert.equal(loading.status.value, 'loading')
  assert.equal(loading.taskDetail?.taskId, 'task-U')
  const before = env.record('U-baseline-before-old-T-timer')
  const callsBefore = [...env.remote.calls]
  const after = await env.flushTimers('old-T-timer-flushed-while-U-selected-and-loading')
  const evidence = JSON.stringify({ before, after, timeline: env.timeline, timerEvents: env.timerQueue.events }, null, 2)
  t.diagnostic(evidence)
  assert.equal(after.taskDetail?.taskId, 'task-U', `old T timer cannot retarget U; evidence=${evidence}`)
  assert.equal(after.taskDetail?.text, before.taskDetail?.text, `U detail text is unchanged; evidence=${evidence}`)
  assert.equal(after.feedbackPresent, before.feedbackPresent, `nullable feedback presence is unchanged; evidence=${evidence}`)
  assert.equal(after.feedback?.state ?? null, before.feedback?.state ?? null, `nullable feedback state is unchanged; evidence=${evidence}`)
  assert.equal(after.feedback?.text ?? null, before.feedback?.text ?? null, `nullable feedback text is unchanged; evidence=${evidence}`)
  assert.equal(env.stateWrites.count, before.stateSetterCalls, `old T timer performs zero state writes to U; evidence=${evidence}`)
  assertNoLocateSideEffects(env, after, callsBefore)
})

test('saved Locate timer callback is inert after Task Center Close', async (t) => {
  const env = await setup()
  t.after(() => env.mounted.cleanup())
  await env.selectTask('task-T')
  await env.dispatchLocate('task-T')
  const savedTimer = [...env.timerQueue.pending.values()][0]
  assert.equal(typeof savedTimer, 'function')
  requireOne(env.runtime.getRoot(), (node) => node.props?.['data-wo-task-center-close'] === 'true', 'rendered Task Center Close').props.onClick()
  await env.runtime.settle()
  const before = env.record('panel-closed-before-saved-callback')
  const beforeCallbackEvidence = JSON.stringify({ before, timeline: env.timeline, timerEvents: env.timerQueue.events }, null, 2)
  t.diagnostic(`State captured after Close render and before invoking the saved callback:\n${beforeCallbackEvidence}`)
  assert.equal(before.panelOpen, false, `rendered Close must leave the panel closed before invoking the saved callback; evidence=${beforeCallbackEvidence}`)
  assert.equal(before.status, null, `closed panel has no status node; evidence=${beforeCallbackEvidence}`)
  assert.equal(before.taskDetail, null, `closed panel has no detail node; evidence=${beforeCallbackEvidence}`)
  assert.equal(before.feedback, null, `closed panel has no feedback node; evidence=${beforeCallbackEvidence}`)
  const callsBefore = [...env.remote.calls]
  const settersBefore = env.stateWrites.count
  const selectorsBefore = [...env.selectors]
  const scrollsBefore = [...env.scrolls]
  const timerEventsBefore = [...env.timerQueue.events]
  const pendingTimerIdsBefore = [...env.timerQueue.pending.keys()]
  savedTimer()
  await env.runtime.settle()
  const after = env.record('saved-callback-invoked-after-close')
  const evidence = JSON.stringify({ before, after, timeline: env.timeline, timerEvents: env.timerQueue.events }, null, 2)
  t.diagnostic(evidence)
  assert.equal(after.panelOpen, before.panelOpen, `saved callback does not reopen the closed panel; evidence=${evidence}`)
  assert.deepEqual(after.status, before.status, `saved callback leaves nullable status unchanged; evidence=${evidence}`)
  assert.deepEqual(after.taskDetail, before.taskDetail, `saved callback leaves nullable detail unchanged; evidence=${evidence}`)
  assert.equal(after.feedbackPresent, before.feedbackPresent, `saved callback leaves feedback presence unchanged; evidence=${evidence}`)
  assert.deepEqual(after.feedback, before.feedback, `saved callback leaves nullable feedback fields unchanged; evidence=${evidence}`)
  assert.equal(env.stateWrites.count, settersBefore, `saved callback performs zero state writes after Close; evidence=${evidence}`)
  assert.deepEqual(env.remote.calls, callsBefore, `saved callback adds no RPC after Close; evidence=${evidence}`)
  assert.deepEqual(env.selectors, selectorsBefore, `saved callback adds no selector query after Close; evidence=${evidence}`)
  assert.deepEqual(env.scrolls, scrollsBefore, `saved callback adds no scroll after Close; evidence=${evidence}`)
  assert.deepEqual(env.timerQueue.events, timerEventsBefore, `saved callback adds no timer event after Close; evidence=${evidence}`)
  assert.deepEqual([...env.timerQueue.pending.keys()], pendingTimerIdsBefore, `saved callback does not change pending timers after Close; evidence=${evidence}`)
  assert.deepEqual(env.timerQueue.events.map((event) => event.action), ['schedule', 'cancel'])
  assert.equal(env.taskLedgerCalls, 1)
  assert.deepEqual(env.remote.illegal, [])
})
