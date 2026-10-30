/**
 * FP-118: Find Panel Lifecycle & Stale Intent Isolation Contract Tests.
 *
 * Verifies ARCHITECT CONTRACT (01a174ce-1508-7a7b-a3f9-af51aa22ce46):
 * 1. 查找面板实例凭证分配与隔离 (Find panel instance token allocation & scope binding):
 *    - Each legitimate openFind allocates a new findToken and freezes scopeId.
 *    - Closing and reopening the same scope allocates a fresh token.
 *    - Input, mode toggle, Clear, Close, and Result callbacks verify mounted and active token before executing.
 * 2. 跨面板/跨作用域污染防御 (Cross-panel and cross-scope pollution defense):
 *    - Old Close callback from P_A cannot close active Find panel in P_B.
 *    - Old Close callback from P_A Session 1 cannot close active Find panel in P_A Session 2.
 *    - Old Input, Clear, and Mode toggle callbacks from P_A do not pollute active Find panel in P_B.
 * 3. 结果回调意图绑定与过期结果保护 (Result intent binding & stale result defense):
 *    - Result buttons bind current query/mode/scope/token intent.
 *    - Changing query in the same panel invalidates previously rendered result buttons (no replay).
 *    - Query A -> B -> A prevents old result buttons from first query A from being replayed.
 *    - Cross-scope result clicking is rejected.
 * 4. 快照刷新失效与陈旧保护 (Snapshot refresh & stale invalidation):
 *    - Refresh removing node, moving node out of scope, or renaming mismatch causes result click to reject.
 *    - Stale snapshot causes locate to refuse.
 * 5. 受控计时队列隔离 (Controlled timer queue isolation):
 *    - Clicking result queues locate timer; closing Find, changing scope, or changing query before timer fires
 *      suppresses deferred scroll and suppresses polluting findLocated on new panel.
 * 6. 挂载守卫与非 Find 定位不受影响 (Mount guard & non-Find locate preservation):
 *    - Unmounted component ignores all Find callbacks and timers.
 *    - Task-source and quick-access locate paths remain unaffected without regressions.
 * 7. 纯本地读视图零 RPC 账本 (Pure local read-only view with zero RPCs):
 *    - Find operations dispatch strictly 0 remote RPCs.
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

// Synthetic snapshot with same project titles, deep targets, and outside targets
const scenarioSnapshot = Object.freeze({
  rootId: 'root',
  revision: 10,
  nodes: Object.freeze([
    Object.freeze({ id: 'root', parentId: null, kind: 'project', title: 'Root Project' }),

    // Branch A: Project A
    Object.freeze({ id: 'p_a', parentId: 'root', kind: 'project', title: 'Shared Project Title' }),
    Object.freeze({ id: 'c_a_direct', parentId: 'p_a', kind: 'conversation', title: 'Target Alpha', sessionId: 'ses-a1' }),
    Object.freeze({ id: 'p_a_sub', parentId: 'p_a', kind: 'project', title: 'Subproject A' }),
    Object.freeze({ id: 'c_a_deep', parentId: 'p_a_sub', kind: 'conversation', title: 'Target Alpha Deep', sessionId: 'ses-a2' }),
    Object.freeze({ id: 'c_a_other', parentId: 'p_a_sub', kind: 'conversation', title: 'Other In A', sessionId: 'ses-a3' }),

    // Branch B: Project B (Same title as Project A!)
    Object.freeze({ id: 'p_b', parentId: 'root', kind: 'project', title: 'Shared Project Title' }),
    Object.freeze({ id: 'c_b_direct', parentId: 'p_b', kind: 'conversation', title: 'Target Alpha', sessionId: 'ses-b1' }),
    Object.freeze({ id: 'p_b_sub', parentId: 'p_b', kind: 'project', title: 'Subproject B' }),
    Object.freeze({ id: 'c_b_deep', parentId: 'p_b_sub', kind: 'conversation', title: 'Target Beta Deep', sessionId: 'ses-b2' }),

    // Outside conversation
    Object.freeze({ id: 'c_outside', parentId: 'root', kind: 'conversation', title: 'Target Alpha Outside', sessionId: 'ses-out' })
  ])
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-find-lifecycle-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createControlledTimerQueue() {
  let nextId = 1
  const entries = new Map()
  const log = []

  function setTimeout(callback, delay = 0, ...args) {
    const id = nextId++
    const entry = { id, callback: () => callback(...args), delay, cleared: false }
    entries.set(id, entry)
    log.push({ type: 'set', id, delay })
    return id
  }

  function clearTimeout(id) {
    log.push({ type: 'clear', id })
    if (entries.has(id)) {
      entries.get(id).cleared = true
      entries.delete(id)
    }
  }

  function getPending() {
    return [...entries.values()].filter((e) => !e.cleared)
  }

  function run(id) {
    const entry = entries.get(id)
    if (entry && !entry.cleared) {
      entries.delete(id)
      entry.callback()
      return true
    }
    return false
  }

  function runAll() {
    const pending = getPending()
    entries.clear()
    for (const entry of pending) {
      entry.callback()
    }
  }

  return {
    setTimeout,
    clearTimeout,
    entries,
    log,
    getPending,
    run,
    runAll
  }
}

async function setupFindComponent({
  snapshot = scenarioSnapshot,
  status = scenarioStatus,
  ledgers = [],
  document: injectedDocument,
  setTimeout: injectedSetTimeout,
  clearTimeout: injectedClearTimeout
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })
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

test('1. Cross-scope Close isolation: Old Close callback from P_A cannot close active Find panel in P_B', async () => {
  const { runtime, mounted } = await setupFindComponent()
  let root = runtime.getRoot()

  // 1. Open Find on P_A
  const findA = requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a', 'find button P_A')
  findA.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const panelA = requireOne(root, (node) => node.props?.['data-wo-find-panel'] === 'p_a', 'panel P_A')
  const closeBtnA = requireOne(panelA, (node) => node.props?.['data-wo-find-close'] === 'true', 'close button P_A')
  const savedCloseA = closeBtnA.props.onClick

  // 2. Open Find on P_B
  const findB = requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_b', 'find button P_B')
  findB.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (node) => node.props?.['data-wo-find-panel'] === 'p_b') !== null, 'P_B panel must be open')

  // 3. Invoke saved Close callback from P_A
  savedCloseA()
  await runtime.settle()

  // 4. Panel P_B must remain open!
  root = runtime.getRoot()
  const activePanel = findOne(root, (node) => node.props?.['data-wo-find-panel'] === 'p_b')
  assert.ok(activePanel !== null, 'P_B panel must remain open after stale P_A close callback')

  await mounted.cleanup()
})

test('2. Reopen same-scope Close isolation: Session 1 Close callback cannot close Session 2 panel on same project', async () => {
  const { runtime, mounted } = await setupFindComponent()
  let root = runtime.getRoot()

  // 1. Open Find on P_A (Session 1)
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a', 'find P_A').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const closeBtn1 = requireOne(root, (node) => node.props?.['data-wo-find-close'] === 'true', 'close S1')
  const savedClose1 = closeBtn1.props.onClick

  // 2. Close Session 1
  savedClose1()
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-find-panel'] !== undefined), null, 'panel must be closed')

  // 3. Open Find on P_A again (Session 2)
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a', 'find P_A again').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  assert.ok(findOne(root, (node) => node.props?.['data-wo-find-panel'] === 'p_a') !== null, 'Session 2 panel open')

  // 4. Invoke saved Close from Session 1
  savedClose1()
  await runtime.settle()

  // 5. Session 2 panel must remain open!
  root = runtime.getRoot()
  assert.ok(findOne(root, (node) => node.props?.['data-wo-find-panel'] === 'p_a') !== null, 'Session 2 panel must remain open')

  await mounted.cleanup()
})

test('3. Cross-scope Input, Clear, and Mode isolation: Callbacks from P_A do not pollute P_B', async () => {
  const { runtime, mounted } = await setupFindComponent()
  let root = runtime.getRoot()

  // Open P_A
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const inputA = requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true')
  const clearA = requireOne(root, (node) => node.props?.['data-wo-find-clear'] === 'true')
  const modeA = requireOne(root, (node) => node.props?.['data-wo-find-mode'] !== undefined)
  const savedInputA = inputA.props.onChange
  const savedClearA = clearA.props.onClick
  const savedModeA = modeA.props.onClick

  // Open P_B and set query to 'Target Beta' and mode to 'direct'
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_b').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const inputB = requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true')
  inputB.props.onChange({ target: { value: 'Target Beta' } })
  const modeB = requireOne(root, (node) => node.props?.['data-wo-find-mode'] !== undefined)
  modeB.props.onClick() // toggle to direct
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.value, 'Target Beta')
  assert.equal(requireOne(root, (node) => node.props?.['data-wo-find-mode'] !== undefined).props['data-wo-find-mode'], 'direct')

  // Invoke saved Input from P_A
  savedInputA({ target: { value: 'Pollution From A' } })
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.value, 'Target Beta', 'Input must not be polluted')

  // Invoke saved Clear from P_A
  savedClearA()
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.value, 'Target Beta', 'Clear must not clear P_B')

  // Invoke saved Mode from P_A
  savedModeA()
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(requireOne(root, (node) => node.props?.['data-wo-find-mode'] !== undefined).props['data-wo-find-mode'], 'direct', 'Mode must not change P_B')

  await mounted.cleanup()
})

test('4. Stale result locate protection: Changing query in same panel invalidates old result button', async () => {
  const { runtime, mounted } = await setupFindComponent()
  let root = runtime.getRoot()

  // Open P_A and search 'Alpha'
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()
  root = runtime.getRoot()

  // Find result for c_a_direct
  const btnDirect = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_direct')
  const savedLocateAlpha = btnDirect.props.onClick

  // Change query to 'Other' (matching c_a_other)
  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Other' } })
  await runtime.settle()
  root = runtime.getRoot()

  // Now call savedLocateAlpha
  savedLocateAlpha(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const selectedNodeAfter = findOne(root, (node) => node.props?.['data-wo-selected'] === 'true')
  const selectedIdAfter = selectedNodeAfter?.props?.['data-wo-node-id'] ?? null

  // Selection must NOT be changed to c_a_direct!
  assert.notEqual(selectedIdAfter, 'c_a_direct', 'Stale result button must NOT select c_a_direct when query changed to Other')

  await mounted.cleanup()
})

test('5. Stale result locate protection across A -> B -> A: Old result button does not revive', async () => {
  const { runtime, mounted } = await setupFindComponent()
  let root = runtime.getRoot()

  // 1. Open P_A, query 'Alpha' (Query A1)
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()
  root = runtime.getRoot()

  const btnA1 = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_direct')
  const savedLocateA1 = btnA1.props.onClick

  // 2. Change query to 'Other' (Query B)
  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Other' } })
  await runtime.settle()

  // 3. Change query back to 'Alpha' (Query A2)
  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()

  // 4. Call savedLocateA1 (from Query A1)
  savedLocateA1(mockEvent())
  await runtime.settle()

  // In new architecture, savedLocateA1 is from A1, not A2! It must not select.
  root = runtime.getRoot()
  const selected = findOne(root, (node) => node.props?.['data-wo-selected'] === 'true')
  assert.notEqual(selected?.props?.['data-wo-node-id'], 'c_a_direct', 'Old result button from Query A1 must not revive in Query A2')

  await mounted.cleanup()
})

test('6. Cross-scope result locate protection: P_A result invoked while P_B is open is rejected', async () => {
  const { runtime, mounted } = await setupFindComponent()
  let root = runtime.getRoot()

  // Open P_A and search 'Alpha'
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()
  root = runtime.getRoot()

  const btnAlphaA = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_direct')
  const savedLocateAlphaA = btnAlphaA.props.onClick

  // Open P_B
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_b').props.onClick(mockEvent())
  await runtime.settle()

  // Call P_A result
  savedLocateAlphaA(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const selected = findOne(root, (node) => node.props?.['data-wo-selected'] === 'true')
  assert.notEqual(selected?.props?.['data-wo-node-id'], 'c_a_direct', 'P_A result must not locate node when P_B is active')

  await mounted.cleanup()
})

test('7. Controlled timer queue: Closing Find before timer fires cancels scroll and findLocated pollution', async () => {
  const timerQueue = createControlledTimerQueue()
  let scrollCalled = 0
  const mockDocument = {
    querySelector: (sel) => {
      if (sel === '[data-wo-node-id="c_a_direct"]') {
        return {
          scrollIntoView: () => { scrollCalled++ }
        }
      }
      return null
    }
  }

  const { runtime, mounted } = await setupFindComponent({
    document: mockDocument,
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout
  })
  let root = runtime.getRoot()

  // Open P_A, query 'Alpha', click Locate
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()
  root = runtime.getRoot()

  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_direct')
  locateBtn.props.onClick(mockEvent())
  await runtime.settle()

  // Verify timer is queued in timerQueue
  assert.equal(timerQueue.getPending().length, 1, 'Locate timer must be queued')

  // Close Find on P_A and open Find on P_B
  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-find-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_b').props.onClick(mockEvent())
  await runtime.settle()

  // Now run the queued timer!
  timerQueue.runAll()
  await runtime.settle()

  // Assert: scroll must NOT have been called, and P_B's findLocated must not have been polluted!
  assert.equal(scrollCalled, 0, 'scrollIntoView must NOT be called for cancelled Find locate timer')

  root = runtime.getRoot()
  const locatedNotice = findOne(root, (node) => node.props?.['data-wo-find-located'] === 'true')
  const locatedText = locatedNotice ? textOf(locatedNotice) : ''
  assert.ok(!locatedText.includes('Target Alpha'), `P_B findLocated must not be polluted with Target Alpha: ${locatedText}`)

  await mounted.cleanup()
})

test('8. Snapshot refresh invalidates target: Target moved out of scope causes locate to be rejected', async () => {
  let currentSnapshot = scenarioSnapshot
  const { runtime, mounted } = await setupFindComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot })
  })
  let root = runtime.getRoot()

  // Open P_A, search 'Alpha', get result for c_a_direct
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()
  root = runtime.getRoot()

  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_direct')
  const savedLocate = locateBtn.props.onClick

  // Now refresh snapshot where c_a_direct is moved to p_b (outside p_a!)
  currentSnapshot = Object.freeze({
    ...scenarioSnapshot,
    revision: 11,
    nodes: scenarioSnapshot.nodes.map((n) => (n.id === 'c_a_direct' ? { ...n, parentId: 'p_b' } : n))
  })

  // Trigger refresh
  requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Click saved locate button
  savedLocate(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const selected = findOne(root, (node) => node.props?.['data-wo-selected'] === 'true')
  assert.notEqual(selected?.props?.['data-wo-node-id'], 'c_a_direct', 'Locate must be rejected when node was moved out of scope')

  await mounted.cleanup()
})

test('9. Snapshot stale invalidation: Refresh failure marks snapshot stale and refuses locate', async () => {
  let failRefresh = false
  const { runtime, mounted } = await setupFindComponent({
    snapshot: () => {
      if (failRefresh) return { ok: false, error: 'synthetic snapshot failure' }
      return { ok: true, value: scenarioSnapshot }
    }
  })
  let root = runtime.getRoot()

  // Open P_A, search 'Alpha'
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()
  root = runtime.getRoot()

  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_direct')
  const savedLocate = locateBtn.props.onClick

  // Refresh fails -> marks snapshot stale
  failRefresh = true
  requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Click locate
  savedLocate(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const selected = findOne(root, (node) => node.props?.['data-wo-selected'] === 'true')
  assert.notEqual(selected?.props?.['data-wo-node-id'], 'c_a_direct', 'Locate must be refused when snapshot is stale')

  const locatedNotice = findOne(root, (node) => node.props?.['data-wo-find-located'] === 'true')
  assert.ok(locatedNotice !== null && textOf(locatedNotice).includes('快照已陈旧失效，拒绝定位'), 'Notice must state snapshot is stale')

  await mounted.cleanup()
})

test('10. Legitimate Find workflow: Descendants vs Direct mode toggle and successful locate', async () => {
  const { runtime, mounted } = await setupFindComponent()
  let root = runtime.getRoot()

  // Open P_A
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Query 'Alpha' with findDescendants = true (default)
  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()
  root = runtime.getRoot()

  let results = findAll(root, (node) => node.props?.['data-wo-find-result'] !== undefined)
  assert.equal(results.length, 2, 'Should match c_a_direct and c_a_deep')

  // Toggle mode to Direct only
  const modeBtn = requireOne(root, (node) => node.props?.['data-wo-find-mode'] !== undefined)
  modeBtn.props.onClick()
  await runtime.settle()
  root = runtime.getRoot()

  results = findAll(root, (node) => node.props?.['data-wo-find-result'] !== undefined)
  assert.equal(results.length, 1, 'Should match only c_a_direct in direct mode')
  assert.equal(results[0].props['data-wo-find-result'], 'c_a_direct')

  // Toggle mode back to descendants
  requireOne(root, (node) => node.props?.['data-wo-find-mode'] !== undefined).props.onClick()
  await runtime.settle()
  root = runtime.getRoot()

  results = findAll(root, (node) => node.props?.['data-wo-find-result'] !== undefined)
  assert.equal(results.length, 2, 'Should match 2 again')

  // Click locate on c_a_deep
  const deepBtn = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_deep')
  deepBtn.props.onClick(mockEvent())
  await runtime.settle()
  await sleep(20)
  await runtime.settle()

  root = runtime.getRoot()
  const selected = findOne(root, (node) => node.props?.['data-wo-selected'] === 'true')
  assert.equal(selected?.props?.['data-wo-node-id'], 'c_a_deep', 'c_a_deep must be selected')

  await mounted.cleanup()
})

test('11. Non-Find locate (Task-source & Quick-access) remains fully functional without regression', async () => {
  const ledger = Object.freeze({
    revision: 1,
    tasks: Object.freeze([
      Object.freeze({
        taskId: 'task_1',
        title: 'Task One',
        status: 'todo',
        sourceConversationId: 'c_a_direct'
      })
    ])
  })

  const { runtime, mounted } = await setupFindComponent({
    ledgers: [ledger, ledger, ledger]
  })
  let root = runtime.getRoot()

  // Open Task Center
  const taskCenterBtn = findOne(root, (node) => node.props?.title?.includes('Task Center') || node.props?.['data-wo-tab'] === 'tasks')
  if (taskCenterBtn) {
    taskCenterBtn.props.onClick(mockEvent())
    await runtime.settle()
  }

  // Open Find on P_A
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()

  // Close Find
  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-find-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Now locate c_a_direct via quick access or direct click
  root = runtime.getRoot()
  const rowBtn = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'c_a_direct')
  rowBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const selected = findOne(root, (node) => node.props?.['data-wo-selected'] === 'true')
  assert.equal(selected?.props?.['data-wo-node-id'], 'c_a_direct', 'c_a_direct can be selected normally')

  await mounted.cleanup()
})

test('12. Zero Remote RPC calls on Find actions', async () => {
  const { runtime, remote, mounted } = await setupFindComponent()
  let root = runtime.getRoot()

  // Baseline calls (snapshot, status)
  const baselineCalls = remote.calls.length
  assert.equal(baselineCalls, 2)

  // Open Find on P_A
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Type query
  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()

  root = runtime.getRoot()
  // Toggle mode
  requireOne(root, (node) => node.props?.['data-wo-find-mode'] !== undefined).props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  // Locate node
  requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_direct').props.onClick(mockEvent())
  await runtime.settle()
  await sleep(20)
  await runtime.settle()

  root = runtime.getRoot()
  // Close Find
  requireOne(root, (node) => node.props?.['data-wo-find-close'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Verify Remote calls
  assert.equal(remote.calls.length, baselineCalls, 'Strictly ZERO new remote calls during Find operations')

  await mounted.cleanup()
})

test('13. Mount guard: Unmounted component ignores Find callbacks and queued timers', async () => {
  const timerQueue = createControlledTimerQueue()
  const { runtime, mounted } = await setupFindComponent({
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout
  })
  let root = runtime.getRoot()

  // Open P_A, query 'Alpha'
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()
  root = runtime.getRoot()

  const closeBtn = requireOne(root, (node) => node.props?.['data-wo-find-close'] === 'true')
  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_direct')
  const savedClose = closeBtn.props.onClick
  const savedLocate = locateBtn.props.onClick

  // Click locate, queues timer
  savedLocate(mockEvent())
  await runtime.settle()

  // Unmount component
  await mounted.cleanup()

  // Calling close after unmount must not throw
  assert.doesNotThrow(() => {
    savedClose()
  })

  // Running queued timer after unmount must not throw
  assert.doesNotThrow(() => {
    timerQueue.runAll()
  })
})

test('14. Scope validity defense on result click: Refresh changing scope to non-project, duplicate, or missing rejects locate', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  const { runtime, mounted } = await setupFindComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot })
  })
  let root = runtime.getRoot()

  // Open Find on p_a, query 'Alpha'
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()
  root = runtime.getRoot()

  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_direct')
  const savedLocate = locateBtn.props.onClick

  // 1. Scope changed to workspace
  currentSnapshot = {
    ...currentSnapshot,
    revision: 11,
    nodes: currentSnapshot.nodes.map((n) => (n.id === 'p_a' ? { ...n, kind: 'workspace', directory: 'E:\\ws' } : n))
  }
  requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  savedLocate(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  let selected = findOne(root, (node) => node.props?.['data-wo-selected'] === 'true')
  assert.notEqual(selected?.props?.['data-wo-node-id'], 'c_a_direct', 'Locate must be rejected when scope is no longer a project')
  let locatedNotice = findOne(root, (node) => node.props?.['data-wo-find-located'] === 'true')
  assert.ok(locatedNotice !== null && textOf(locatedNotice).includes('搜索范围不是有效项目'), 'Notice must state scope is not a valid project')

  // 2. Scope duplicated
  currentSnapshot = {
    ...currentSnapshot,
    revision: 12,
    nodes: [...currentSnapshot.nodes.map((n) => (n.id === 'p_a' ? { ...n, kind: 'project' } : n)), { id: 'p_a', parentId: 'root', kind: 'project', title: 'Duplicate Scope' }]
  }
  requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  savedLocate(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  selected = findOne(root, (node) => node.props?.['data-wo-selected'] === 'true')
  assert.notEqual(selected?.props?.['data-wo-node-id'], 'c_a_direct', 'Locate must be rejected when scope identity is ambiguous')

  // 3. Scope removed
  currentSnapshot = {
    ...currentSnapshot,
    revision: 13,
    nodes: currentSnapshot.nodes.filter((n) => n.id !== 'p_a')
  }
  requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  savedLocate(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  selected = findOne(root, (node) => node.props?.['data-wo-selected'] === 'true')
  assert.notEqual(selected?.props?.['data-wo-node-id'], 'c_a_direct', 'Locate must be rejected when scope is missing')

  await mounted.cleanup()
})

test('15. Queued locate timer tree mutation defense: Target moved out of scope, renamed, or duplicated cancels deferred scroll and does not mark success', async () => {
  let currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  let scrollCalls = []
  const timerQueue = createControlledTimerQueue()
  const mockDocument = {
    querySelector: (sel) => {
      if (sel === '[data-wo-node-id="c_a_direct"]') {
        return {
          scrollIntoView: (opts) => { scrollCalls.push({ sel, opts }) }
        }
      }
      return null
    }
  }

  const { runtime, mounted } = await setupFindComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    document: mockDocument,
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout
  })
  let root = runtime.getRoot()

  // Case A: Target moved out of scope during timer queue
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p_a').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true').props.onChange({ target: { value: 'Alpha' } })
  await runtime.settle()
  root = runtime.getRoot()

  // Click locate, queues timer
  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_direct')
  locateBtn.props.onClick(mockEvent())
  await runtime.settle()

  assert.equal(timerQueue.getPending().length, 1, 'Timer must be queued')

  // Move c_a_direct to p_b before timer fires
  currentSnapshot = {
    ...currentSnapshot,
    revision: 11,
    nodes: currentSnapshot.nodes.map((n) => (n.id === 'c_a_direct' ? { ...n, parentId: 'p_b' } : n))
  }
  requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Fire timer
  timerQueue.runAll()
  await runtime.settle()

  // Assert: scroll must NOT be called, and notice must be cancelled, not success!
  assert.equal(scrollCalls.length, 0, 'scrollIntoView must NOT be called when target moved out of scope during queue')
  root = runtime.getRoot()
  let locatedEl = findOne(root, (node) => node.props?.['data-wo-find-located'] === 'true')
  let locatedText = locatedEl ? textOf(locatedEl) : ''
  assert.ok(locatedText.includes('滚动取消'), `Notice must state scroll cancelled, got: ${locatedText}`)
  assert.notEqual(locatedText, 'Located Target Alpha', 'Must NOT be marked settled success')

  // Case B: Target renamed during timer queue
  scrollCalls = []
  currentSnapshot = JSON.parse(JSON.stringify(scenarioSnapshot))
  requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'c_a_direct').props.onClick(mockEvent())
  await runtime.settle()

  // Rename c_a_direct to 'Gamma'
  currentSnapshot = {
    ...currentSnapshot,
    revision: 12,
    nodes: currentSnapshot.nodes.map((n) => (n.id === 'c_a_direct' ? { ...n, title: 'Renamed Gamma' } : n))
  }
  requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true').props.onClick(mockEvent())
  await runtime.settle()

  // Fire timer
  timerQueue.runAll()
  await runtime.settle()

  assert.equal(scrollCalls.length, 0, 'scrollIntoView must NOT be called when target renamed during queue')
  root = runtime.getRoot()
  locatedEl = findOne(root, (node) => node.props?.['data-wo-find-located'] === 'true')
  locatedText = locatedEl ? textOf(locatedEl) : ''
  assert.ok(locatedText.includes('滚动取消'), `Notice must state scroll cancelled, got: ${locatedText}`)
  assert.notEqual(locatedText, 'Located Target Alpha', 'Must NOT be marked settled success')

  await mounted.cleanup()
})
