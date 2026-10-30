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

const snapshot = {
  rootId: 'root',
  revision: 10,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
    { id: 'p1', parentId: 'root', kind: 'project', title: 'Branch 1' },
    { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1', nativeWorkspaceId: 'nw-1' },
    { id: 'cnv_A', parentId: 'w1', kind: 'conversation', title: 'Conversation A', sessionId: 'ses-A' },
    { id: 'cnv_B', parentId: 'w1', kind: 'conversation', title: 'Conversation B', sessionId: 'ses-B' }
  ]
}

const makeSource = (conversationId, sessionId) => ({
  conversationId,
  sessionId,
  workspaceLogicalId: 'w1',
  nativeWorkspaceId: 'nw-1',
  directory: 'E:\\ws-1',
  verifiedAt: '2026-10-25T10:00:00.000Z',
  verificationState: 'verified',
  hostVersion: '0.2.1-rc.2'
})

const makeTask = (taskId, sourceConversationId) => ({
  taskId,
  label: 'Same visible label',
  childSessionId: `child-${taskId}`,
  sourceConversationId,
  parent: { kind: 'conversation', conversationId: sourceConversationId },
  depth: 1,
  mode: 'one-shot',
  executionState: 'COMPLETED',
  executionEligibility: 'eligible',
  observedAt: '2026-10-25T10:00:01.000Z'
})

function makeTimerQueue() {
  let nextId = 0
  const pending = new Map()
  const events = []
  return {
    pending,
    events,
    fakeSetTimeout(fn, delay) {
      const id = ++nextId
      pending.set(id, fn)
      events.push({ action: 'schedule', id, delay })
      return id
    },
    fakeClearTimeout(id) {
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
  let setterCalls = 0
  const originalUseState = runtime.React.useState.bind(runtime.React)
  runtime.React.useState = (initialValue) => {
    const [value, setState] = originalUseState(initialValue)
    return [value, (...args) => {
      setterCalls += 1
      return setState(...args)
    }]
  }
  return { get count() { return setterCalls } }
}

async function setup({ ledger, timerQueue, scrolled }) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const stateWrites = countUseStateSetterCalls(runtime)
  const remote = createRemoteProxy({
    snapshot,
    status: { conversationsCreatable: true },
    ledgers: [ledger]
  })
  const mounted = await mountClientApplication({
    source,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote,
    document: {
      querySelector(selector) {
        return { scrollIntoView(options) { scrolled.push({ selector, options }) } }
      }
    },
    setTimeout: timerQueue.fakeSetTimeout,
    clearTimeout: timerQueue.fakeClearTimeout
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()
  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center'] === 'true', 'All Tasks button').props.onClick()
  await runtime.settle()
  return { runtime, remote, stateWrites }
}

const selectedTreeIds = (root) => findAll(root, (node) => node.props?.['data-wo-selected'] === 'true')
  .map((node) => node.props['data-wo-node-id'])
const selectedTaskIds = (root) => findAll(root, (node) => node.props?.['data-wo-task-center-detail'] !== undefined)
  .map((node) => node.props['data-wo-task-center-detail'])
function feedback(root) {
  const node = findOne(root, (entry) => entry.props?.['data-wo-task-center-locate-feedback'] === 'true')
  return node === null ? null : {
    state: node.props['data-wo-task-center-locate-state'],
    text: textOf(node)
  }
}

test('A rendered Locate callback cannot retarget B or cancel B pending intent; current B still locates by ID', async () => {
  const timerQueue = makeTimerQueue()
  const scrolled = []
  const ledger = {
    revision: 1,
    sources: [makeSource('cnv_A', 'ses-A'), makeSource('cnv_B', 'ses-B')],
    tasks: [makeTask('tsk_A', 'cnv_A'), makeTask('tsk_B', 'cnv_B')]
  }
  const { runtime, remote, stateWrites } = await setup({ ledger, timerQueue, scrolled })

  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === 'tsk_A', 'A row').props.onClick()
  await runtime.settle()
  const savedALocate = requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate'] === 'tsk_A', 'rendered A Locate').props.onClick

  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === 'tsk_B', 'B row').props.onClick()
  await runtime.settle()
  const currentBLocate = requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate'] === 'tsk_B', 'rendered B Locate').props.onClick
  const setupCalls = [...remote.calls]

  currentBLocate()
  await runtime.settle()
  const afterBDispatch = {
    selectedTree: selectedTreeIds(runtime.getRoot()),
    selectedTasks: selectedTaskIds(runtime.getRoot()),
    feedback: feedback(runtime.getRoot()),
    rpcSignature: JSON.stringify(remote.calls),
    timerEventsSignature: JSON.stringify(timerQueue.events),
    pendingTimerIds: [...timerQueue.pending.keys()],
    stateSetterCalls: stateWrites.count,
    renders: runtime.stats.renders
  }
  assert.deepEqual(afterBDispatch.selectedTree, ['cnv_B'])
  assert.deepEqual(afterBDispatch.selectedTasks, ['tsk_B'])
  assert.equal(afterBDispatch.feedback.state, 'locating')
  assert.match(afterBDispatch.feedback.text, /Conversation B/)
  assert.equal(afterBDispatch.rpcSignature, JSON.stringify(setupCalls), 'Locate is local and dispatches no RPC')
  assert.deepEqual(afterBDispatch.pendingTimerIds, [1], 'current B Locate schedules one controlled scroll')

  savedALocate()
  await runtime.settle()
  const afterSavedA = {
    selectedTree: selectedTreeIds(runtime.getRoot()),
    selectedTasks: selectedTaskIds(runtime.getRoot()),
    feedback: feedback(runtime.getRoot()),
    rpcSignature: JSON.stringify(remote.calls),
    timerEventsSignature: JSON.stringify(timerQueue.events),
    pendingTimerIds: [...timerQueue.pending.keys()],
    stateSetterCalls: stateWrites.count,
    renders: runtime.stats.renders
  }
  assert.equal(afterSavedA.stateSetterCalls, afterBDispatch.stateSetterCalls, 'stale A invokes zero useState setters')
  assert.deepEqual(afterSavedA.selectedTree, afterBDispatch.selectedTree, 'stale A leaves tree selection unchanged')
  assert.deepEqual(afterSavedA.selectedTasks, afterBDispatch.selectedTasks, 'stale A leaves Task Center selection unchanged')
  assert.equal(afterSavedA.feedback.state, afterBDispatch.feedback.state, 'stale A leaves feedback state unchanged')
  assert.equal(afterSavedA.feedback.text, afterBDispatch.feedback.text, 'stale A leaves feedback text unchanged')
  assert.equal(afterSavedA.rpcSignature, afterBDispatch.rpcSignature, 'stale A dispatches no RPC')
  assert.equal(afterSavedA.timerEventsSignature, afterBDispatch.timerEventsSignature, 'stale A does not schedule or cancel a timer')
  assert.deepEqual(afterSavedA.pendingTimerIds, afterBDispatch.pendingTimerIds, 'B pending timer remains pending')
  assert.equal(afterSavedA.renders, afterBDispatch.renders, 'stale A does not request a state render')

  timerQueue.flush()
  await runtime.settle()
  assert.equal(scrolled.length, 1, 'current B intent scrolls exactly once')
  assert.equal(scrolled[0].selector, '[data-wo-node-id="cnv_B"]', 'current B intent uses the exact conversation selector')
  assert.equal(Object.hasOwn(scrolled[0].options, 'block'), true, 'scroll options own the required block key')
  assert.equal(scrolled[0].options.block, 'center', 'current B intent centers the exact target')
  assert.deepEqual(Object.keys(scrolled[0].options).sort(), ['block'], 'scroll options contain only the required own key')
  assert.equal(feedback(runtime.getRoot()).state, 'located')
  assert.deepEqual(timerQueue.events.map((event) => event.action), ['schedule', 'fire'])
})

test('saved Locate is rejected when the same task ID has drifted to another live source', async () => {
  const timerQueue = makeTimerQueue()
  const scrolled = []
  const ledger = {
    revision: 1,
    sources: [makeSource('cnv_A', 'ses-A'), makeSource('cnv_B', 'ses-B')],
    tasks: [makeTask('tsk_A', 'cnv_A'), makeTask('tsk_B', 'cnv_B')]
  }
  const { runtime, remote, stateWrites } = await setup({ ledger, timerQueue, scrolled })

  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === 'tsk_A', 'A row').props.onClick()
  await runtime.settle()
  const savedOriginalLocate = requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate'] === 'tsk_A', 'rendered original A Locate').props.onClick

  // Replace the live ledger record while retaining its task ID, simulating a source-identity drift.
  ledger.tasks = [makeTask('tsk_A', 'cnv_B'), ledger.tasks[1]]
  runtime.render()
  await runtime.settle()
  const before = {
    selectedTree: selectedTreeIds(runtime.getRoot()),
    selectedTasks: selectedTaskIds(runtime.getRoot()),
    feedback: feedback(runtime.getRoot()),
    rpcSignature: JSON.stringify(remote.calls),
    timerEventsSignature: JSON.stringify(timerQueue.events),
    pendingTimerIds: [...timerQueue.pending.keys()],
    stateSetterCalls: stateWrites.count,
    renders: runtime.stats.renders
  }

  savedOriginalLocate()
  await runtime.settle()
  const after = {
    selectedTree: selectedTreeIds(runtime.getRoot()),
    selectedTasks: selectedTaskIds(runtime.getRoot()),
    feedback: feedback(runtime.getRoot()),
    rpcSignature: JSON.stringify(remote.calls),
    timerEventsSignature: JSON.stringify(timerQueue.events),
    pendingTimerIds: [...timerQueue.pending.keys()],
    stateSetterCalls: stateWrites.count,
    renders: runtime.stats.renders
  }
  assert.deepEqual(after, before, 'source-drifted saved callback is rejected before side effects')
  assert.deepEqual(scrolled, [])
})
