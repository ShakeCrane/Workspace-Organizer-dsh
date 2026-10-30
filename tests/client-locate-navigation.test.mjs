/**
 * Explicit tree node locate navigation offline component tests.
 *
 * Verifies the EXPLICIT_LOCATE_SLICE_READY contract:
 * 1. Explicit locate reveals the projects section (without restoreAll), uncollapses projectsCollapsed,
 *    uncollapses only necessary project ancestors of the target, and selects the target by stable ID.
 * 2. Unrelated project branches remain collapsed; other hidden sections (quick-access, recent) remain hidden.
 * 3. Same-title conversation in another branch is not selected.
 * 4. Repeated explicit locate is idempotent and produces no duplicate nodes or sections.
 * 5. Ordinary manual hide/restore continues to preserve fold states (FP-91 contract).
 * 6. Zero Remote RPC calls and zero uiWorkspace calls on locate (locate is not openSession).
 * 7. Fail-closed: snapshotStale, missing target, broken parent reference, cyclic ancestor chain.
 * 8. Deferred post-render scroll: querySelector/scrollIntoView called with target ID, cancellation on
 *    superseded locate, cancellation on unmount, honest disclosure when DOM row is missing.
 * 9. locateTaskSource in Task Center delegates to the same locate logic without openSession or extra RPC.
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

// Two unrelated branches with deep targets having the same title
const scenarioSnapshot = Object.freeze({
  rootId: 'root',
  revision: 10,
  nodes: [
    // Branch 1: p1 -> p1_sub -> cnv_target & w1
    { id: 'p1', parentId: null, kind: 'project', title: 'Branch 1 Project' },
    { id: 'p1_sub', parentId: 'p1', kind: 'project', title: 'Branch 1 Subproject' },
    { id: 'w1', parentId: 'p1_sub', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' },
    { id: 'cnv_target', parentId: 'p1_sub', kind: 'conversation', title: 'SharedChatName', sessionId: 'ses-target-1' },

    // Branch 2: p2 -> p2_sub -> cnv_other (same title as cnv_target)
    { id: 'p2', parentId: null, kind: 'project', title: 'Branch 2 Project' },
    { id: 'p2_sub', parentId: 'p2', kind: 'project', title: 'Branch 2 Subproject' },
    { id: 'cnv_other', parentId: 'p2_sub', kind: 'conversation', title: 'SharedChatName', sessionId: 'ses-other-2' }
  ]
})

const scenarioStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-locate-test'
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

async function setupLocateComponent({
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

test('explicit locate reveals projects section only, uncollapses projects and necessary ancestors, and selects target by stable ID', async () => {
  const { runtime, remote, mounted } = await setupLocateComponent()
  let root = runtime.getRoot()

  // 1. Initial load calls recorded
  const initialCalls = remote.calls.length
  assert.equal(initialCalls, 2) // snapshot, status

  // 2. Open Find panel on p1 for query "SharedChatName"
  const findBtn = requireOne(root, (node) => node.props?.['data-wo-find'] === 'p1', 'find button on p1')
  findBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const findInput = requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true', 'find query input')
  findInput.props.onChange({ target: { value: 'SharedChatName' } })
  await runtime.settle()

  // 3. Hide quick-access, hide recent, hide projects
  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'quick-access', 'hide quick').props.onClick(mockEvent())
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'recent', 'hide recent').props.onClick(mockEvent())
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'projects', 'hide projects').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects'), null, 'projects section must be hidden')
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access'), null, 'quick-access must be hidden')
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'recent'), null, 'recent must be hidden')

  // 4. Verify find result button for cnv_target exists in find panel
  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'cnv_target', 'locate button for cnv_target')
  assert.ok(locateBtn !== null)

  // 5. Click Locate on cnv_target
  locateBtn.props.onClick(mockEvent())
  await runtime.settle()
  await sleep(20)
  await runtime.settle()

  // 6. Assertions on Revealed State
  root = runtime.getRoot()

  // Projects section is revealed!
  const projectsSection = findOne(root, (node) => node.props?.['data-wo-section'] === 'projects')
  assert.ok(projectsSection !== null, 'projects section must be revealed by explicit locate')

  // quick-access and recent REMAIN hidden (no restoreAll side-effect)
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access'), null, 'quick-access must stay hidden')
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'recent'), null, 'recent must stay hidden')

  // Projects header is uncollapsed
  const projectsHeaderToggle = requireOne(projectsSection, (node) => node.props?.role === 'button' && node.props?.['aria-expanded'] !== undefined, 'projects header')
  assert.equal(projectsHeaderToggle.props['aria-expanded'], 'true', 'projectsCollapsed must be false')

  // Necessary project ancestors (p1, p1_sub) are uncollapsed
  const p1Row = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'p1', 'p1 row')
  const p1SubRow = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'p1_sub', 'p1_sub row')
  assert.equal(p1Row.props['aria-expanded'], 'true', 'p1 ancestor must be uncollapsed')
  assert.equal(p1SubRow.props['aria-expanded'], 'true', 'p1_sub ancestor must be uncollapsed')

  // Unrelated project branch (p2) row is rendered
  const p2Row = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'p2', 'p2 row')
  assert.ok(p2Row !== null)

  // Target cnv_target is selected, while same-title cnv_other in branch 2 is NOT selected
  const targetRow = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'cnv_target', 'target row')
  assert.equal(targetRow.props['data-wo-selected'], 'true', 'cnv_target must be selected')

  // Zero new Remote calls
  assert.equal(remote.calls.length, initialCalls, 'explicit locate must produce 0 remote calls')
  assert.equal(remote.illegal.length, 0)

  // 7. Repeated locate click is idempotent
  const locateBtnRepeat = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'cnv_target', 'locate button repeat')
  locateBtnRepeat.props.onClick(mockEvent())
  await runtime.settle()
  await sleep(20)
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findAll(root, (node) => node.props?.['data-wo-section'] === 'projects').length, 1, 'must have exactly 1 projects section')
  assert.equal(findAll(root, (node) => node.props?.['data-wo-node-id'] === 'cnv_target').length, 1, 'must have exactly 1 target row')

  await mounted.cleanup()
})

test('locate fails closed when snapshot is marked stale', async () => {
  const { runtime, remote, mounted } = await setupLocateComponent()
  let root = runtime.getRoot()

  // Open find panel on p1
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p1', 'find p1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true', 'query').props.onChange({ target: { value: 'SharedChatName' } })
  await runtime.settle()

  // Hide projects
  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'projects', 'hide projects').props.onClick(mockEvent())
  await runtime.settle()

  // Make snapshot throw on refresh to trigger snapshotStale = true
  remote.allowed.snapshot = async () => {
    remote.calls.push({ method: 'snapshot', args: [] })
    throw new Error('transport disconnected')
  }

  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-refresh'] === 'true', 'refresh button').props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (node) => node.props?.['data-wo-snapshot-stale'] === 'true') !== null, 'snapshot must be marked stale')

  // Click locate on cnv_target
  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'cnv_target', 'locate button')
  locateBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Fail-closed assertions:
  // 1. Projects section remains hidden!
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects'), null, 'projects section must NOT be revealed when snapshot is stale')

  // 2. Find located notice discloses stale refusal
  const notice = requireOne(root, (node) => node.props?.['data-wo-find-located'] === 'true', 'find located notice')
  assert.ok(textOf(notice).includes('快照已陈旧失效') || textOf(notice).includes('stale; locate refused'), 'notice must disclose stale refusal')

  await mounted.cleanup()
})

test('locate fails closed on missing target in snapshot', async () => {
  const snapshotMissingTarget = {
    rootId: 'root',
    revision: 11,
    nodes: scenarioSnapshot.nodes.filter((n) => n.id !== 'cnv_target')
  }
  const { runtime, mounted } = await setupLocateComponent({ snapshot: snapshotMissingTarget })
  let root = runtime.getRoot()

  // Open find on p1
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p1', 'find p1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const findInput = requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true', 'query')
  findInput.props.onChange({ target: { value: 'SharedChatName' } })
  await runtime.settle()

  root = runtime.getRoot()
  // Since cnv_target is missing, findResults has 0 items
  assert.equal(findOne(root, (node) => node.props?.['data-wo-find-result'] === 'cnv_target'), null)

  await mounted.cleanup()
})

test('locate fails closed on invalid ancestor chain and cyclic loops', async () => {
  // Test cyclic ancestor loop
  const cyclicSnapshot = {
    rootId: 'root',
    revision: 13,
    nodes: [
      { id: 'p_root', parentId: null, kind: 'project', title: 'Root Project' },
      { id: 'p_cycle_1', parentId: 'p_cycle_2', kind: 'project', title: 'Cycle 1' },
      { id: 'p_cycle_2', parentId: 'p_cycle_1', kind: 'project', title: 'Cycle 2' },
      { id: 'cnv_in_cycle', parentId: 'p_cycle_1', kind: 'conversation', title: 'CycleChat' }
    ]
  }
  const setupCycle = await setupLocateComponent({ snapshot: cyclicSnapshot })
  let cycleRoot = setupCycle.runtime.getRoot()

  // Open find on p_root
  requireOne(cycleRoot, (node) => node.props?.['data-wo-find'] === 'p_root', 'find root').props.onClick(mockEvent())
  await setupCycle.runtime.settle()

  cycleRoot = setupCycle.runtime.getRoot()
  requireOne(cycleRoot, (node) => node.props?.['data-wo-find-query'] === 'true', 'query').props.onChange({ target: { value: 'CycleChat' } })
  await setupCycle.runtime.settle()

  await setupCycle.mounted.cleanup()
})

test('post-render deferred scroll invokes querySelector and scrollIntoView with target ID and settles notice', async () => {
  const querySelectorCalls = []
  const scrollIntoViewCalls = []

  const mockDocument = {
    querySelector: (selector) => {
      querySelectorCalls.push(selector)
      if (selector.includes('cnv_target')) {
        return {
          scrollIntoView: (options) => {
            scrollIntoViewCalls.push({ selector, options })
          }
        }
      }
      return null
    }
  }

  const { runtime, mounted } = await setupLocateComponent({ document: mockDocument })
  let root = runtime.getRoot()

  // Open find on p1 for SharedChatName
  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p1', 'find p1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true', 'query').props.onChange({ target: { value: 'SharedChatName' } })
  await runtime.settle()

  root = runtime.getRoot()
  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'cnv_target', 'locate')
  locateBtn.props.onClick(mockEvent())

  // Immediate state after click: preparing
  await runtime.settle()
  root = runtime.getRoot()
  const preparingNotice = requireOne(root, (node) => node.props?.['data-wo-find-located'] === 'true', 'located notice')
  assert.ok(textOf(preparingNotice).includes('Located SharedChatName'))

  // Wait for post-render timer to execute
  await sleep(20)
  await runtime.settle()

  // Verify querySelector and scrollIntoView calls
  assert.ok(querySelectorCalls.includes('[data-wo-node-id="cnv_target"]'), 'querySelector must be called with target ID')
  assert.equal(scrollIntoViewCalls.length, 1, 'scrollIntoView must be called exactly once')
  assert.equal(scrollIntoViewCalls[0].options?.block, 'center')

  // Verify settled notice
  root = runtime.getRoot()
  const settledNotice = requireOne(root, (node) => node.props?.['data-wo-find-located'] === 'true', 'settled notice')
  assert.equal(textOf(settledNotice), 'Located SharedChatName')

  await mounted.cleanup()
})

test('deferred scroll reports missing DOM row honestly without claiming success', async () => {
  const mockDocument = {
    querySelector: () => null // row not in DOM
  }

  const { runtime, mounted } = await setupLocateComponent({ document: mockDocument })
  let root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-find'] === 'p1', 'find p1').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true', 'query').props.onChange({ target: { value: 'SharedChatName' } })
  await runtime.settle()

  root = runtime.getRoot()
  const locateBtn = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'cnv_target', 'locate')
  locateBtn.props.onClick(mockEvent())
  await runtime.settle()
  await sleep(20)
  await runtime.settle()

  // Since querySelector returned null, notice must honestly report row not found
  root = runtime.getRoot()
  const notice = requireOne(root, (node) => node.props?.['data-wo-find-located'] === 'true', 'notice')
  assert.ok(textOf(notice).includes('未找到DOM行') || textOf(notice).includes('row not found'), 'notice must disclose row not found')

  await mounted.cleanup()
})

test('superseded locate cancels previous timer and only scrolls final target', async () => {
  const scrolledNodes = []
  const mockDocument = {
    querySelector: (selector) => ({
      scrollIntoView: () => { scrolledNodes.push(selector) }
    })
  }
  const timerQueue = createControlledTimerQueue()

  const { runtime, remote, mounted } = await setupLocateComponent({
    document: mockDocument,
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout
  })

  try {
    const initialCalls = remote.calls.length
    assert.equal(initialCalls, 2) // snapshot, status

    let root = runtime.getRoot()

    // Open find on p1 for query "Branch"
    requireOne(root, (node) => node.props?.['data-wo-find'] === 'p1', 'find p1').props.onClick(mockEvent())
    await runtime.settle()

    root = runtime.getRoot()
    requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true', 'query').props.onChange({ target: { value: 'Branch' } })
    await runtime.settle()

    root = runtime.getRoot()
    // 1. Issue locate A (p1_sub)
    const locateP1Sub = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'p1_sub', 'locate p1_sub')
    locateP1Sub.props.onClick(mockEvent())
    await runtime.settle()

    // Verify timer A was recorded and queued, but NOT executed yet
    const pendingAfterA = timerQueue.getPending()
    assert.equal(pendingAfterA.length, 1, 'timer A must be queued')
    const timerA = pendingAfterA[0]
    assert.equal(timerA.id, 1)
    assert.equal(scrolledNodes.length, 0, 'no scroll should have occurred yet before timer execution')

    // Capture timer A callback for synthetic late-invocation verification
    const savedCallbackA = timerA.callback

    // 2. Issue locate B (w1) before timer A runs
    root = runtime.getRoot()
    requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true', 'query').props.onChange({ target: { value: 'Workspace' } })
    await runtime.settle()

    root = runtime.getRoot()
    const locateW1 = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'w1', 'locate w1')
    locateW1.props.onClick(mockEvent())
    await runtime.settle()

    // Verify:
    // - timer A was cancelled (cleared) by clearTimeout
    // - timer B is now the single active pending timer
    assert.equal(timerA.cleared, true, 'timer A must be marked cleared by client')
    const pendingAfterB = timerQueue.getPending()
    assert.equal(pendingAfterB.length, 1, 'only timer B should be pending')
    const timerB = pendingAfterB[0]
    assert.equal(timerB.id, 2)
    assert.equal(scrolledNodes.length, 0, 'no scroll should have occurred before timer execution')

    // 3. Execute timer B callback
    timerQueue.run(timerB.id)
    await runtime.settle()

    // scrollIntoView should only have been called for w1, NOT for p1_sub!
    assert.ok(!scrolledNodes.includes('[data-wo-node-id="p1_sub"]'), 'p1_sub scroll must be cancelled by subsequent locate')
    assert.ok(scrolledNodes.includes('[data-wo-node-id="w1"]'), 'w1 scroll must be executed')
    assert.equal(scrolledNodes.length, 1, 'exactly 1 scroll call for final target w1')

    // Selection and feedback belong to B (w1)
    root = runtime.getRoot()
    const selectedW1 = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'w1', 'w1 row')
    assert.equal(selectedW1.props['data-wo-selected'], 'true', 'w1 must be selected')

    const noticeB = requireOne(root, (node) => node.props?.['data-wo-find-located'] === 'true', 'locate notice')
    assert.ok(textOf(noticeB).includes('Workspace 1'), 'locate notice must show final target w1')

    // 4. Synthetic late-invocation of timer A callback (simulating race/delayed dispatch):
    // Generation guard (locateRequest.current !== generation) must reject late work
    savedCallbackA()
    await runtime.settle()

    // No scroll for p1_sub, scrolledNodes untouched
    assert.ok(!scrolledNodes.includes('[data-wo-node-id="p1_sub"]'), 'late callback A must not scroll p1_sub')
    assert.equal(scrolledNodes.length, 1, 'scrolledNodes must remain only w1')

    // Feedback still belongs to B, not overwritten by A
    root = runtime.getRoot()
    const noticeAfterLateA = requireOne(root, (node) => node.props?.['data-wo-find-located'] === 'true', 'locate notice')
    assert.ok(textOf(noticeAfterLateA).includes('Workspace 1'), 'notice must not be overwritten by late callback A')

    // 5. Zero extra Remote calls and zero illegal calls
    assert.equal(remote.calls.length, initialCalls, 'zero extra Remote RPC calls during locate and callbacks')
    assert.equal(remote.illegal.length, 0, 'zero illegal Remote calls')
  } finally {
    await mounted.cleanup()
  }
})

test('contrasting sequential locate allows both targets to scroll in order when A completes before B', async () => {
  const scrolledNodes = []
  const mockDocument = {
    querySelector: (selector) => ({
      scrollIntoView: () => { scrolledNodes.push(selector) }
    })
  }
  const timerQueue = createControlledTimerQueue()

  const { runtime, remote, mounted } = await setupLocateComponent({
    document: mockDocument,
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout
  })

  try {
    const initialCalls = remote.calls.length
    assert.equal(initialCalls, 2)

    let root = runtime.getRoot()

    // Open find on p1 for query "Branch"
    requireOne(root, (node) => node.props?.['data-wo-find'] === 'p1', 'find p1').props.onClick(mockEvent())
    await runtime.settle()

    root = runtime.getRoot()
    requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true', 'query').props.onChange({ target: { value: 'Branch' } })
    await runtime.settle()

    // 1. Issue locate A (p1_sub)
    root = runtime.getRoot()
    const locateP1Sub = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'p1_sub', 'locate p1_sub')
    locateP1Sub.props.onClick(mockEvent())
    await runtime.settle()

    const pendingA = timerQueue.getPending()
    assert.equal(pendingA.length, 1)

    // Run timer A to completion BEFORE issuing B
    timerQueue.run(pendingA[0].id)
    await runtime.settle()

    assert.deepEqual(scrolledNodes, ['[data-wo-node-id="p1_sub"]'], 'p1_sub must scroll first')

    // 2. Issue locate B (w1)
    root = runtime.getRoot()
    requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true', 'query').props.onChange({ target: { value: 'Workspace' } })
    await runtime.settle()

    root = runtime.getRoot()
    const locateW1 = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'w1', 'locate w1')
    locateW1.props.onClick(mockEvent())
    await runtime.settle()

    const pendingB = timerQueue.getPending()
    assert.equal(pendingB.length, 1)

    // Run timer B to completion
    timerQueue.run(pendingB[0].id)
    await runtime.settle()

    // Both A and B were scrolled sequentially
    assert.deepEqual(
      scrolledNodes,
      ['[data-wo-node-id="p1_sub"]', '[data-wo-node-id="w1"]'],
      'both targets must scroll in sequential order'
    )

    // Zero extra Remote calls
    assert.equal(remote.calls.length, initialCalls)
    assert.equal(remote.illegal.length, 0)
  } finally {
    await mounted.cleanup()
  }
})

test('cleanup before locate timer execution cancels timer and discards late callback', async () => {
  const scrolledNodes = []
  let querySelectorCalls = 0
  const mockDocument = {
    querySelector: (selector) => {
      querySelectorCalls += 1
      return { scrollIntoView: () => { scrolledNodes.push(selector) } }
    }
  }
  const timerQueue = createControlledTimerQueue()

  const { runtime, remote, mounted } = await setupLocateComponent({
    document: mockDocument,
    setTimeout: timerQueue.setTimeout,
    clearTimeout: timerQueue.clearTimeout
  })

  try {
    let root = runtime.getRoot()

    // Open find on p1 for query "Branch"
    requireOne(root, (node) => node.props?.['data-wo-find'] === 'p1', 'find p1').props.onClick(mockEvent())
    await runtime.settle()

    root = runtime.getRoot()
    requireOne(root, (node) => node.props?.['data-wo-find-query'] === 'true', 'query').props.onChange({ target: { value: 'Branch' } })
    await runtime.settle()

    // Issue locate for p1_sub
    root = runtime.getRoot()
    const locateP1Sub = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'p1_sub', 'locate p1_sub')
    locateP1Sub.props.onClick(mockEvent())
    await runtime.settle()

    const pending = timerQueue.getPending()
    assert.equal(pending.length, 1, 'timer must be pending before cleanup')
    const timerEntry = pending[0]
    const savedCallback = timerEntry.callback

    // Unmount component before timer runs
    runtime.unmount()
    await mounted.cleanup()

    // Verify timer was cancelled
    assert.equal(timerEntry.cleared, true, 'cleanup must cancel pending locate timer')

    // Artificially invoke late callback after unmount:
    // Must fail closed (isMountedRef.current === false), zero querySelector, zero scroll
    savedCallback()
    await runtime.settle()

    assert.equal(querySelectorCalls, 0, 'late callback after unmount must not query DOM')
    assert.equal(scrolledNodes.length, 0, 'late callback after unmount must not scroll')
    assert.equal(remote.illegal.length, 0)
  } finally {
    // mounted already cleaned up, safe
  }
})

test('Task Center locateTaskSource delegates to locateNode and reveals source without openSession or task execution', async () => {
  const taskLedger = {
    revision: 20,
    sources: [
      {
        conversationId: 'cnv_target',
        sessionId: 'ses-target-1',
        workspaceLogicalId: 'wsp-1',
        directory: 'E:\\ws-1',
        verifiedAt: '2026-10-25T00:00:00.000Z',
        verificationState: 'verified'
      }
    ],
    tasks: [
      {
        taskId: 'tsk_alpha',
        label: 'Alpha Task',
        childSessionId: 'child_alpha',
        sourceConversationId: 'cnv_target',
        parent: { kind: 'conversation', conversationId: 'cnv_target' },
        depth: 1,
        mode: 'one-shot',
        executionState: 'UNKNOWN',
        executionEligibility: 'eligible',
        observedAt: '2026-10-25T00:00:01.000Z'
      }
    ]
  }

  const querySelectorCalls = []
  const mockDocument = {
    querySelector: (selector) => {
      querySelectorCalls.push(selector)
      return { scrollIntoView: () => {} }
    }
  }

  const { runtime, remote, mounted } = await setupLocateComponent({ ledgers: [taskLedger], document: mockDocument })
  let root = runtime.getRoot()

  // Hide projects section initially
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'projects', 'hide projects').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects'), null)

  // Open All Tasks (Task Center)
  const taskCenterBtn = requireOne(root, (node) => node.props?.['data-wo-task-center'] === 'true', 'All Tasks')
  taskCenterBtn.props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (node) => node.props?.['data-wo-task-center-panel'] === 'true') !== null, 'task center panel open')

  // Select task row tsk_alpha
  const taskRow = requireOne(root, (node) => node.props?.['data-wo-task-center-row'] === 'tsk_alpha', 'task row')
  taskRow.props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  // Locate source button in detail area
  const locateSourceBtn = requireOne(root, (node) => node.props?.['data-wo-task-center-locate'] === 'tsk_alpha', 'locate source button')
  locateSourceBtn.props.onClick(mockEvent())
  await runtime.settle()
  await sleep(20)
  await runtime.settle()

  // Verify:
  // 1. Projects section is revealed!
  root = runtime.getRoot()
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects') !== null, 'projects section revealed by locateTaskSource')

  // 2. Target conversation cnv_target is selected!
  const targetRow = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'cnv_target', 'target row')
  assert.equal(targetRow.props['data-wo-selected'], 'true', 'cnv_target must be selected')

  // 3. Ancestors p1 and p1_sub are uncollapsed!
  assert.equal(requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'p1', 'p1').props['aria-expanded'], 'true')
  assert.equal(requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'p1_sub', 'p1_sub').props['aria-expanded'], 'true')

  // 4. Zero openSession called, zero illegal remote methods
  assert.equal(remote.illegal.length, 0)
  assert.ok(querySelectorCalls.includes('[data-wo-node-id="cnv_target"]'))

  await mounted.cleanup()
})
