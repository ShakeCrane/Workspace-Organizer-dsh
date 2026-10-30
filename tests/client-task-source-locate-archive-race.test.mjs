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
    { id: 'cnv_archive_race', parentId: 'workspace', kind: 'conversation', title: 'Archive Race Source', sessionId: 'session-archive-race' }
  ]
})

const baseTask = Object.freeze({
  taskId: 'task_archive_race',
  label: 'Archive Race Task',
  childSessionId: 'child-archive-race',
  sourceConversationId: 'cnv_archive_race',
  parent: Object.freeze({ kind: 'conversation', conversationId: 'cnv_archive_race' }),
  depth: 1,
  mode: 'one-shot',
  executionState: 'UNKNOWN',
  executionEligibility: 'eligible',
  observedAt: '2026-10-29T00:00:00.000Z'
})

function makeLedger(revision, { archived = false, executionEligibility = 'eligible' } = {}) {
  return {
    revision,
    sources: [{
      conversationId: 'cnv_archive_race',
      sessionId: 'session-archive-race',
      workspaceLogicalId: 'workspace',
      nativeWorkspaceId: 'native-workspace',
      directory: 'D:\\synthetic\\archive-race',
      verifiedAt: '2026-10-29T00:00:00.000Z',
      verificationState: archived ? 'blocked' : 'verified',
      ...(archived ? { blockedReason: 'source-archived' } : {}),
      hostVersion: 'synthetic'
    }],
    tasks: [{ ...baseTask, executionEligibility, parent: { ...baseTask.parent } }]
  }
}

function createControlledTimerQueue() {
  let nextId = 0
  const callbacks = new Map()
  return {
    setTimeout(fn, delay) {
      const id = ++nextId
      callbacks.set(id, { fn, delay })
      return id
    },
    clearTimeout(id) { callbacks.delete(id) },
    count() { return callbacks.size },
    flush() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      for (const entry of pending) entry.fn()
    }
  }
}

async function prepareQueuedLocate({ archivedL2, executionEligibility = 'eligible' }) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const L1 = makeLedger(1, { executionEligibility })
  const L2 = makeLedger(2, { archived: archivedL2, executionEligibility })
  assert.notEqual(L1, L2)
  assert.notEqual(L1.sources[0], L2.sources[0])
  assert.notEqual(L1.tasks[0], L2.tasks[0])
  assert.equal(L1.tasks[0].taskId, L2.tasks[0].taskId)
  assert.equal(L1.tasks[0].sourceConversationId, L2.tasks[0].sourceConversationId)
  assert.equal(L1.sources[0].blockedReason ?? null, null)
  assert.equal(L2.sources[0].blockedReason ?? null, archivedL2 ? 'source-archived' : null)

  const timerQueue = createControlledTimerQueue()
  const scrolls = []
  const document = {
    querySelector(selector) {
      return { scrollIntoView(options) { scrolls.push({ selector, options }) } }
    }
  }
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({
    snapshot,
    status: { conversationsCreatable: true },
    ledgers: [L1, L2]
  })
  const mounted = await mountClientApplication({
    source,
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

  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center'] === 'true', 'All Tasks button')
    .props.onClick({ stopPropagation() {}, preventDefault() {} })
  await runtime.settle()
  const statusAfterL1 = requireOne(runtime.getRoot(), (node) => Object.hasOwn(node.props ?? {}, 'data-wo-task-center-status'), 'Task Center status after L1')
  assert.equal(statusAfterL1.props['data-wo-task-center-status'], 'ready')
  assert.match(textOf(statusAfterL1), /rev 1/)

  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-row'] === baseTask.taskId, 'Task row')
    .props.onClick()
  await runtime.settle()
  const locateButton = () => requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate'] === baseTask.taskId, 'Locate source button')
  const feedback = () => requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate-feedback'] === 'true', 'Locate feedback')
  const taskLedgerCalls = () => remote.calls.filter((call) => call.method === 'taskLedger').length

  const rpcBeforeLocate = remote.calls.length
  locateButton().props.onClick({ stopPropagation() {}, preventDefault() {} })
  await runtime.settle()
  assert.equal(timerQueue.count(), 1)
  assert.equal(feedback().props['data-wo-task-center-locate-state'], 'locating')
  assert.equal(remote.calls.length, rpcBeforeLocate, 'Locate dispatch must not call the remote')
  assert.equal(findOne(runtime.getRoot(), (node) => node.props?.['data-wo-node-id'] === 'cnv_archive_race')?.props?.['data-wo-selected'], 'true')

  requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'Task Center Reload button')
    .props.onClick()
  await runtime.settle()
  const acceptedStatus = requireOne(runtime.getRoot(), (node) => Object.hasOwn(node.props ?? {}, 'data-wo-task-center-status'), 'Task Center status after Reload')
  const selectedTaskDetail = requireOne(runtime.getRoot(), (node) => node.props?.['data-wo-task-center-locate'] === baseTask.taskId, 'Selected task detail after Reload')
  const selectedSource = findOne(runtime.getRoot(), (node) => node.props?.['data-wo-node-id'] === 'cnv_archive_race')?.props?.['data-wo-selected'] ?? null
  assert.equal(acceptedStatus.props['data-wo-task-center-status'], 'ready')
  assert.match(textOf(acceptedStatus), /rev 2/)
  assert.equal(selectedSource, 'true')
  assert.ok(selectedTaskDetail)
  assert.equal(timerQueue.count(), 1, 'accepted Reload must leave the queued Locate timer pending')
  assert.equal(taskLedgerCalls(), 2, 'exactly one initial ledger read and one Reload read')
  assert.equal(textOf(runtime.getRoot()).includes('source blocked: source-archived'), archivedL2)

  return {
    runtime,
    remote,
    timerQueue,
    scrolls,
    feedback,
    taskLedgerCalls,
    beforeTimer: {
      status: acceptedStatus.props['data-wo-task-center-status'],
      statusText: textOf(acceptedStatus),
      selectedTaskRendered: Boolean(selectedTaskDetail),
      selectedSource,
      sourceArchived: archivedL2,
      taskLedgerCalls: taskLedgerCalls(),
      timerCount: timerQueue.count()
    },
    async flushTimer() {
      const remoteCallsBeforeTimer = remote.calls.length
      const taskLedgerCallsBefore = taskLedgerCalls()
      timerQueue.flush()
      await runtime.settle()
      const taskLedgerCallsAfter = taskLedgerCalls()
      return {
        remoteDelta: remote.calls.slice(remoteCallsBeforeTimer),
        taskLedgerCallsBefore,
        taskLedgerCallsAfter,
        selectedSourceAfter: findOne(runtime.getRoot(), (node) => node.props?.['data-wo-node-id'] === 'cnv_archive_race')?.props?.['data-wo-selected'] ?? null,
        feedbackState: feedback().props['data-wo-task-center-locate-state'],
        feedbackText: textOf(feedback()),
        timerCount: timerQueue.count()
      }
    }
  }
}

function assertExactSourceScroll(scrolls) {
  assert.equal(scrolls.length, 1)
  assert.equal(scrolls[0].selector, '[data-wo-node-id="cnv_archive_race"]')
  assert.equal(Object.hasOwn(scrolls[0].options, 'block'), true)
  assert.equal(scrolls[0].options.block, 'center')
  const optionKeys = Object.keys(scrolls[0].options)
  assert.equal(optionKeys.length, 1)
  assert.equal(optionKeys[0], 'block')
}

test('queued Locate is cancelled when an accepted Reload archives the same source', async () => {
  const scenario = await prepareQueuedLocate({ archivedL2: true })
  assert.deepEqual(scenario.beforeTimer, {
    status: 'ready',
    statusText: 'Tasks ledger: ready (rev 2)',
    selectedTaskRendered: true,
    selectedSource: 'true',
    sourceArchived: true,
    taskLedgerCalls: 2,
    timerCount: 1
  })

  const result = await scenario.flushTimer()
  assert.equal(scenario.scrolls.length, 0, 'archived source must not scroll')
  assert.equal(result.feedbackState, 'cancelled')
  assert.match(result.feedbackText, /Source is archived/)
  assert.match(result.feedbackText, /scroll cancelled/)
  assert.equal(result.selectedSourceAfter, scenario.beforeTimer.selectedSource, 'selection remains at its post-L2 baseline')
  assert.equal(result.remoteDelta.length, 0, 'timer phase must add no RPC, mutation, session, reconciliation, or execution call')
  assert.equal(result.taskLedgerCallsBefore, 2)
  assert.equal(result.taskLedgerCallsAfter, 2)
  assert.equal(result.timerCount, 0)
  assert.equal(scenario.remote.illegal.length, 0)
})

test('queued Locate still scrolls once when Reload keeps the source usable', async () => {
  const scenario = await prepareQueuedLocate({ archivedL2: false })
  const result = await scenario.flushTimer()
  assertExactSourceScroll(scenario.scrolls)
  assert.equal(result.feedbackState, 'located')
  assert.match(result.feedbackText, /Located Archive Race Source/)
  assert.equal(result.selectedSourceAfter, scenario.beforeTimer.selectedSource)
  assert.equal(result.remoteDelta.length, 0)
  assert.equal(result.taskLedgerCallsAfter, 2)
  assert.equal(scenario.remote.illegal.length, 0)
})

test('Task executionEligibility blocked alone does not cancel Locate for an unarchived source', async () => {
  const scenario = await prepareQueuedLocate({ archivedL2: false, executionEligibility: 'blocked' })
  const result = await scenario.flushTimer()
  assertExactSourceScroll(scenario.scrolls)
  assert.equal(result.feedbackState, 'located')
  assert.match(result.feedbackText, /Located Archive Race Source/)
  assert.equal(result.remoteDelta.length, 0)
  assert.equal(result.taskLedgerCallsAfter, 2)
  assert.equal(scenario.remote.illegal.length, 0)
})
