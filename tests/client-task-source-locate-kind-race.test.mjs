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

function makeSnapshot(revision, sourceKind, sourceTitle) {
  return {
    rootId: 'root', revision,
    nodes: [
      { id: 'root', parentId: null, kind: 'project', title: 'Root' },
      { id: 'project', parentId: 'root', kind: 'project', title: 'Project' },
      { id: 'workspace', parentId: 'project', kind: 'workspace', title: 'Workspace' },
      { id: sourceId, parentId: 'workspace', kind: sourceKind, title: sourceTitle, ...(sourceKind === 'conversation' ? { sessionId: 'session-S' } : {}) }
    ]
  }
}

function makeLedger(tasks = [taskT]) {
  return {
    revision: 1,
    sources: [{
      conversationId: sourceId, sessionId: 'session-S', workspaceLogicalId: 'workspace',
      nativeWorkspaceId: 'native-workspace', directory: 'D:\\synthetic\\fp131',
      verifiedAt: '2026-10-30T00:00:00.000Z', verificationState: 'verified', hostVersion: 'synthetic'
    }],
    tasks: tasks.map((task) => ({ ...task, parent: { ...task.parent } }))
  }
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

function requireRenderedSource(root) {
  return requireOne(root, (node) => node.props?.['data-wo-node-id'] === sourceId, 'rendered source row')
}

function requireFeedback(root) {
  return requireOne(root, (node) => node.props?.['data-wo-task-center-locate-feedback'] === 'true', 'Task Center Locate feedback')
}

async function setup({ l2Kind = 'workspace', l2Title = 'Reclassified Source S', tasks = [taskT] } = {}) {
  const clientSource = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const L1 = makeSnapshot(1, 'conversation', 'Source S')
  const L2 = makeSnapshot(2, l2Kind, l2Title)
  let snapshotCalls = 0
  const remote = createRemoteProxy({
    snapshot: () => ({ ok: true, value: [L1, L2][Math.min(snapshotCalls++, 1)] }),
    status: { conversationsCreatable: true },
    ledgers: [makeLedger(tasks)]
  })
  const timerQueue = makeTimerQueue()
  const scrolls = []
  const selectors = []
  const document = {
    querySelector(selector) {
      selectors.push(selector)
      return { scrollIntoView(options) { scrolls.push({ selector, options }) } }
    }
  }
  const runtime = createHooksRuntime()
  const stateWrites = countUseStateSetterCalls(runtime)
  const mounted = await mountClientApplication({
    source: clientSource,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote,
    document,
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()
  const timeline = []
  const record = (phase) => {
    const sourceRow = findOne(runtime.getRoot(), (node) => node.props?.['data-wo-node-id'] === sourceId)
    const feedback = findOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate-feedback'] === 'true')
    const selectedDetail = findOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-detail'] !== undefined)
    const entry = {
      at: new Date().toISOString(),
      phase,
      sourceRow: sourceRow === null ? null : {
        id: sourceRow.props['data-wo-node-id'],
        kind: sourceRow.props['data-wo-kind'],
        title: textOf(sourceRow),
        selected: sourceRow.props['data-wo-selected'] ?? null
      },
      selectedDetail: selectedDetail === null ? null : {
        taskId: selectedDetail.props['data-wo-task-center-detail'],
        text: textOf(selectedDetail)
      },
      feedback: {
        present: feedback !== null,
        state: feedback === null ? null : feedback.props['data-wo-task-center-locate-state'],
        text: feedback === null ? null : textOf(feedback)
      },
      stateSetterCalls: stateWrites.count,
      remoteCalls: [...remote.calls],
      timerEvents: [...timerQueue.events],
      pendingTimerIds: [...timerQueue.pending.keys()],
      selectors: [...selectors],
      scrolls: [...scrolls]
    }
    timeline.push(entry)
    return entry
  }
  record('mounted-L1')
  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center'] === 'true', 'All Tasks').props.onClick()
  await runtime.settle()
  const loaded = requireOne(runtime.getRoot(), (node) => Object.hasOwn(node.props ?? {}, 'data-wo-task-center-status'), 'Task Center status')
  assert.equal(loaded.props['data-wo-task-center-status'], 'ready')
  assert.match(textOf(loaded), /rev 1/)
  record('All-Tasks-loaded-on-L1')

  return {
    L1, L2, runtime, remote, timerQueue, scrolls, selectors, stateWrites, timeline, record,
    async selectTask(taskId) {
      requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === taskId, `Task row ${taskId}`).props.onClick()
      await runtime.settle()
      record(`selected-${taskId}`)
    },
    async dispatchRenderedLocate(taskId) {
      const button = requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate'] === taskId, `rendered Locate ${taskId}`)
      button.props.onClick({ stopPropagation() {}, preventDefault() {} })
      await runtime.settle()
      record(`rendered-Locate-${taskId}-dispatched`)
    },
    async refreshTree() {
      requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-refresh'] === 'true', 'visible tree Refresh').props.onClick()
      await runtime.settle()
      record('visible-tree-Refresh-accepted-L2')
    },
    async flushTimers() {
      timerQueue.flush()
      await runtime.settle()
      return record('controlled-timer-flushed')
    }
  }
}

function assertExactSourceScroll(env) {
  assert.equal(env.selectors.length, 1, 'one DOM lookup occurred')
  assert.equal(env.selectors[0], '[data-wo-node-id="source-S"]', 'Locate uses the exact source selector')
  assert.equal(env.scrolls.length, 1, 'the source row scrolled exactly once')
  assert.equal(env.scrolls[0].selector, '[data-wo-node-id="source-S"]')
  assert.equal(Object.hasOwn(env.scrolls[0].options, 'block'), true)
  assert.equal(env.scrolls[0].options.block, 'center')
  assert.deepEqual(Object.keys(env.scrolls[0].options), ['block'], 'scroll options contain only the expected own key')
}

test('queued Task-source Locate cancels when accepted tree Refresh changes the same ID to workspace', async (t) => {
  const env = await setup()
  assert.equal(requireRenderedSource(env.runtime.getRoot()).props['data-wo-kind'], 'conversation')
  await env.selectTask('task-T')
  const callsBeforeLocate = [...env.remote.calls]
  await env.dispatchRenderedLocate('task-T')
  assert.equal(env.timerQueue.pending.size, 1, 'the real rendered Locate callback queued a timer')
  assert.deepEqual(env.remote.calls, callsBeforeLocate, 'Locate dispatch added no RPC')
  assert.equal(requireFeedback(env.runtime.getRoot()).props['data-wo-task-center-locate-state'], 'locating')

  await env.refreshTree()
  const liveSource = requireRenderedSource(env.runtime.getRoot())
  assert.equal(liveSource.props['data-wo-kind'], 'workspace', 'the visible Refresh committed the same ID as a workspace')
  assert.match(textOf(liveSource), /Reclassified Source S/)
  assert.equal(env.timerQueue.pending.size, 1, 'accepted L2 leaves the queued timer pending')
  const callsBeforeTimer = [...env.remote.calls]
  const writesBeforeTimer = env.stateWrites.count

  await env.flushTimers()
  const feedback = requireFeedback(env.runtime.getRoot())
  assert.equal(env.selectors.length, 0, 'wrong-kind live target is rejected before DOM lookup')
  assert.equal(env.scrolls.length, 0, 'wrong-kind live target is never scrolled')
  assert.equal(feedback.props['data-wo-task-center-locate-state'], 'cancelled')
  assert.match(textOf(feedback), /cancelled/i)
  assert.deepEqual(env.remote.calls, callsBeforeTimer, 'timer settlement adds no RPC')
  assert.ok(env.stateWrites.count > writesBeforeTimer, 'cancellation feedback is written to the current Task detail')
  assert.deepEqual(env.timerQueue.events.map((event) => event.action), ['schedule', 'fire'])
  assert.equal(env.timerQueue.pending.size, 0)
  assert.equal(env.remote.illegal.length, 0)
  t.diagnostic(JSON.stringify({ timeline: env.timeline, finalRemoteCalls: env.remote.calls, finalTimerEvents: env.timerQueue.events, finalSetterCalls: env.stateWrites.count, selectors: env.selectors, scrolls: env.scrolls }, null, 2))
})

test('queued Task-source Locate still scrolls once when the same ID remains a conversation', async (t) => {
  const env = await setup({ l2Kind: 'conversation', l2Title: 'Refreshed Source S' })
  await env.selectTask('task-T')
  await env.dispatchRenderedLocate('task-T')
  assert.equal(env.timerQueue.pending.size, 1)
  await env.refreshTree()
  const liveSource = requireRenderedSource(env.runtime.getRoot())
  assert.equal(liveSource.props['data-wo-kind'], 'conversation')
  assert.match(textOf(liveSource), /Refreshed Source S/)
  const callsBeforeTimer = [...env.remote.calls]

  await env.flushTimers()
  assertExactSourceScroll(env)
  assert.equal(requireFeedback(env.runtime.getRoot()).props['data-wo-task-center-locate-state'], 'located')
  assert.deepEqual(env.remote.calls, callsBeforeTimer, 'timer settlement adds no RPC')
  assert.deepEqual(env.timerQueue.events.map((event) => event.action), ['schedule', 'fire'])
  assert.equal(env.remote.illegal.length, 0)
  t.diagnostic(JSON.stringify({ timeline: env.timeline, finalRemoteCalls: env.remote.calls, finalTimerEvents: env.timerQueue.events, finalSetterCalls: env.stateWrites.count, selectors: env.selectors, scrolls: env.scrolls }, null, 2))
})

test('queued Locate for a no-longer-selected Task leaves current detail state untouched', async (t) => {
  const taskU = { ...taskT, taskId: 'task-U', childSessionId: 'child-U', label: 'Task U' }
  const env = await setup({ tasks: [taskT, taskU] })
  await env.selectTask('task-T')
  await env.dispatchRenderedLocate('task-T')
  assert.equal(env.timerQueue.pending.size, 1)
  await env.selectTask('task-U')
  const beforeStaleTimer = env.record('before-stale-T-timer')
  const beforeDiagnostic = JSON.stringify({ beforeStaleTimer, remoteCalls: env.remote.calls, timerEvents: env.timerQueue.events }, null, 2)
  assert.equal(beforeStaleTimer.selectedDetail?.taskId, 'task-U', `pre-flush current detail must be U; evidence=${beforeDiagnostic}`)
  assert.equal(typeof beforeStaleTimer.feedback.present, 'boolean', `pre-flush feedback presence must be recorded; evidence=${beforeDiagnostic}`)
  if (beforeStaleTimer.feedback.present) {
    assert.equal(typeof beforeStaleTimer.feedback.state, 'string', `present pre-flush feedback must record its state; evidence=${beforeDiagnostic}`)
    assert.equal(typeof beforeStaleTimer.feedback.text, 'string', `present pre-flush feedback must record its text; evidence=${beforeDiagnostic}`)
  } else {
    assert.equal(beforeStaleTimer.feedback.state, null, `absent pre-flush feedback has null state; evidence=${beforeDiagnostic}`)
    assert.equal(beforeStaleTimer.feedback.text, null, `absent pre-flush feedback has null text; evidence=${beforeDiagnostic}`)
  }
  const callsBeforeTimer = [...env.remote.calls]

  const afterStaleTimer = await env.flushTimers()
  const staleTimerEvidence = JSON.stringify({ beforeStaleTimer, afterStaleTimer, finalRemoteCalls: env.remote.calls, finalTimerEvents: env.timerQueue.events, finalSetterCalls: env.stateWrites.count, selectors: env.selectors, scrolls: env.scrolls }, null, 2)
  t.diagnostic(staleTimerEvidence)
  assert.equal(afterStaleTimer.selectedDetail?.taskId, beforeStaleTimer.selectedDetail.taskId, `stale T timer must preserve current detail identity; evidence=${staleTimerEvidence}`)
  assert.equal(afterStaleTimer.selectedDetail?.text, beforeStaleTimer.selectedDetail.text, `stale T timer must preserve current detail text; evidence=${staleTimerEvidence}`)
  assert.equal(afterStaleTimer.feedback.present, beforeStaleTimer.feedback.present, `stale T timer must preserve feedback node presence; evidence=${staleTimerEvidence}`)
  assert.equal(afterStaleTimer.feedback.state, beforeStaleTimer.feedback.state, `stale T timer must preserve feedback state; evidence=${staleTimerEvidence}`)
  assert.equal(afterStaleTimer.feedback.text, beforeStaleTimer.feedback.text, `stale T timer must preserve feedback text; evidence=${staleTimerEvidence}`)
  assert.equal(env.scrolls.length, 0, `stale T timer must not scroll; evidence=${staleTimerEvidence}`)
  assert.equal(env.selectors.length, 0, `stale T timer must not query a DOM row; evidence=${staleTimerEvidence}`)
  assert.equal(env.stateWrites.count, beforeStaleTimer.stateSetterCalls, `stale T timer performs zero state writes to U detail; evidence=${staleTimerEvidence}`)
  assert.deepEqual(env.remote.calls, callsBeforeTimer, `stale T timer adds no RPC; evidence=${staleTimerEvidence}`)
  assert.deepEqual(env.timerQueue.events.map((event) => event.action), ['schedule', 'fire'], `stale T timer timeline must remain schedule then fire; evidence=${staleTimerEvidence}`)
  assert.equal(env.timerQueue.pending.size, 0, `stale T timer flush leaves no pending timer; evidence=${staleTimerEvidence}`)
  assert.equal(env.remote.illegal.length, 0, `stale T timer must not call an execution or mutation API; evidence=${staleTimerEvidence}`)
})
