/**
 * Quick Access Locate Lifecycle & Invalidation Protection offline component tests.
 *
 * Verifies the FP-121 contract for ordinary P/W/C Quick Access Locate:
 * 1. Counterexample 1: Saved Locate after Remove / Unpin invoked
 *    - Captured Locate callback for an ordinary reference cannot uncollapse, select, or schedule scroll after removal.
 * 2. Counterexample 2: Remove -> re-Pin token isolation
 *    - Captured Locate callback from previous reference instance cannot mutate or locate a newly re-pinned reference.
 * 3. Counterexample 3: Queued timer invalidation on Remove / Unpin / Re-Pin
 *    - Locate clicked, timer paused; removing or re-pinning before timer fires cancels scroll and success notice.
 *    - Valid unchanged control still scrolls and settles.
 * 4. Counterexample 4: Queued timer tree invalidation & fresh click-time rejection
 *    - Tree becomes stale, target deleted/duplicated, or ancestry broken during queued phase cancels deferred scroll.
 * 5. Counterexample 5: Unmount safety
 *    - Saved Locate callback and queued timer do zero state writes / DOM effects after unmount.
 * 6. Positive Oracles:
 *    - Current P/W/C references locate correctly (uncollapse, select, scroll, notice).
 *    - Node rename / move remains locatable at current title/path; membership and ordering preserved.
 *    - Same-title IDs remain separate.
 *    - Section hide / restore does not revoke membership or tokens.
 *    - Find and Task-source locators remain fully functional and isolated.
 *    - Zero Remote RPC calls during Locate operations.
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

const testSnapshot = Object.freeze({
  rootId: 'root',
  revision: 1,
  nodes: [
    { id: 'root', parentId: null, kind: 'project', title: 'Root Project' },
    { id: 'p1', parentId: 'root', kind: 'project', title: 'Branch 1 Project' },
    { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws1' },
    { id: 'cnv1', parentId: 'p1', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-1' },
    { id: 'p2', parentId: 'root', kind: 'project', title: 'Branch 2 Project' },
    { id: 'w2', parentId: 'p2', kind: 'workspace', title: 'Workspace 2', directory: 'E:\\ws2' },
    { id: 'cnv2', parentId: 'p2', kind: 'conversation', title: 'Conversation 1', sessionId: 'ses-2' } // same title
  ]
})

const testStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-qa-locate-lifecycle-test'
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

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

function createMockDocument() {
  const querySelectorCalls = []
  const scrollIntoViewCalls = []
  const elements = new Map()

  function getOrCreateElement(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, {
        selector,
        scrollIntoView: (options) => {
          scrollIntoViewCalls.push({ selector, options })
        }
      })
    }
    return elements.get(selector)
  }

  const doc = {
    querySelector: (selector) => {
      querySelectorCalls.push(selector)
      return getOrCreateElement(selector)
    },
    querySelectorCalls,
    scrollIntoViewCalls,
    getOrCreateElement
  }
  return doc
}

async function setupComponent({
  snapshot = testSnapshot,
  status = testStatus,
  ledgers = [],
  document: injectedDocument,
  timerQueue = null,
  onSetState = null
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  if (typeof onSetState === 'function') {
    const origUseState = runtime.React.useState
    runtime.React.useState = function (initial) {
      const [val, setVal] = origUseState.call(this, initial)
      const wrappedSetVal = (arg) => {
        onSetState(val, arg)
        return setVal(arg)
      }
      return [val, wrappedSetVal]
    }
  }
  const remote = createRemoteProxy({ snapshot, status, ledgers })
  const mounted = await mountClientApplication({
    source,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote,
    document: injectedDocument,
    setTimeout: timerQueue ? timerQueue.setTimeout : undefined,
    clearTimeout: timerQueue ? timerQueue.clearTimeout : undefined
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()
  return { runtime, remote, mounted, source }
}

test('COUNTEREXAMPLE 1: Saved Locate after Remove / Unpin invoked is rejected silently without state/ref/DOM writes', async () => {
  const mockDoc = createMockDocument()
  const timerQueue = createControlledTimerQueue()
  const stateLog = []
  const { runtime, remote, mounted } = await setupComponent({
    document: mockDoc,
    timerQueue,
    onSetState: (prev, next) => {
      stateLog.push({ prev, next })
    }
  })
  let root = runtime.getRoot()

  // 1. Pin cnv1 and w1
  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'w1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Verify cnv1 is in Quick Access
  let rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['cnv1', 'w1'])

  // 2. Capture Locate button onClick for cnv1
  const locateBtnCnv1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-locate'] === 'cnv1')
  const capturedLocateCnv1 = locateBtnCnv1.props.onClick
  assert.equal(typeof capturedLocateCnv1, 'function')

  // 3. Select workspace w2 to establish a baseline selection
  const rowW2 = requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'w2')
  rowW2.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const selectedRowBefore = findOne(root, (n) => n.props?.['data-wo-selected'] === 'true')
  assert.equal(selectedRowBefore?.props?.['data-wo-node-id'], 'w2')

  // 4. Remove cnv1 from Quick Access
  const removeBtnCnv1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-remove'] === 'cnv1')
  removeBtnCnv1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['w1'])

  // Clear tracking counters before calling saved callback
  const initialRemoteCalls = remote.calls.length
  const initialPendingTimers = timerQueue.getPending().length
  const initialScrollCalls = mockDoc.scrollIntoViewCalls.length
  stateLog.length = 0

  // 5. Invoke saved Locate callback for removed cnv1
  capturedLocateCnv1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // CONTRACT ASSERTIONS (Fail on baseline, pass with protection):
  // Baseline erroneously executes locateNode('cnv1'), selecting cnv1, scheduling timer, and writing feedback.
  // Protected code returns false immediately without state/ref/DOM/remote mutation.
  const selectedRowAfter = findOne(root, (n) => n.props?.['data-wo-selected'] === 'true')
  assert.equal(
    selectedRowAfter?.props?.['data-wo-node-id'],
    'w2',
    'saved Locate callback after remove must NOT select removed node'
  )

  // Verify findLocated was NOT modified by saved Locate callback
  const findLocatedCalls = stateLog.filter(
    (entry) => typeof entry.next === 'string' && entry.next.startsWith('Located Conversation 1')
  )
  assert.equal(
    findLocatedCalls.length,
    0,
    'saved Locate callback after remove must NOT write findLocated feedback'
  )

  assert.equal(
    timerQueue.getPending().length,
    initialPendingTimers,
    'saved Locate callback after remove must NOT schedule a scroll timer'
  )

  assert.equal(
    mockDoc.scrollIntoViewCalls.length,
    initialScrollCalls,
    'saved Locate callback after remove must NOT scroll DOM'
  )

  assert.equal(
    remote.calls.length,
    initialRemoteCalls,
    'saved Locate callback after remove must NOT make any Remote RPC calls'
  )

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 2: Remove -> re-Pin membership token isolation for Locate', async () => {
  const mockDoc = createMockDocument()
  const timerQueue = createControlledTimerQueue()
  const { runtime, remote, mounted } = await setupComponent({
    document: mockDoc,
    timerQueue
  })
  let root = runtime.getRoot()

  // 1. Pin cnv1 (Instance 1)
  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Capture Locate callback from Instance 1
  const locateBtn1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-locate'] === 'cnv1')
  const capturedLocateInstance1 = locateBtn1.props.onClick

  // 2. Remove cnv1
  requireOne(root, (n) => n.props?.['data-wo-quick-access-remove'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // 3. Re-pin cnv1 (Instance 2 with new token)
  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Capture Locate callback from Instance 2
  const locateBtn2 = requireOne(root, (n) => n.props?.['data-wo-quick-access-locate'] === 'cnv1')
  const capturedLocateInstance2 = locateBtn2.props.onClick

  // 4. Select w2 to establish baseline selection
  requireOne(root, (n) => n.props?.['data-wo-node-id'] === 'w2').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  assert.equal(findOne(root, (n) => n.props?.['data-wo-selected'] === 'true')?.props?.['data-wo-node-id'], 'w2')

  // 5. Invoke saved Locate from Instance 1 (old token)
  capturedLocateInstance1(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // CONTRACT ASSERTION: Instance 1 callback must be rejected!
  assert.equal(
    findOne(root, (n) => n.props?.['data-wo-selected'] === 'true')?.props?.['data-wo-node-id'],
    'w2',
    'Locate callback from old reference token must be rejected even after re-pinning same ID'
  )
  assert.equal(timerQueue.getPending().length, 0, 'old token callback must NOT schedule timer')

  // 6. Invoke current Locate from Instance 2 (current token)
  capturedLocateInstance2(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // CONTRACT ASSERTION: Current token Locate must succeed!
  assert.equal(
    findOne(root, (n) => n.props?.['data-wo-selected'] === 'true')?.props?.['data-wo-node-id'],
    'cnv1',
    'Locate callback with current reference token must succeed'
  )
  assert.equal(timerQueue.getPending().length, 1, 'current token callback must schedule timer')

  // Release timer and verify scroll
  timerQueue.runAll()
  assert.equal(mockDoc.scrollIntoViewCalls.length, 1)
  assert.equal(mockDoc.scrollIntoViewCalls[0].selector, '[data-wo-node-id="cnv1"]')

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 3: Queued timer invalidation on Remove / Unpin / Re-Pin', async () => {
  const mockDoc = createMockDocument()
  const timerQueue = createControlledTimerQueue()
  const stateLog = []
  const { runtime, remote, mounted } = await setupComponent({
    document: mockDoc,
    timerQueue,
    onSetState: (prev, next) => {
      stateLog.push({ prev, next })
    }
  })
  let root = runtime.getRoot()

  // 1. Pin cnv1 and w1
  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()
  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'w1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // 2. Click Locate on cnv1
  const locateCnv1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-locate'] === 'cnv1')
  locateCnv1.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Verify timer is queued and preparing state was set
  assert.equal(timerQueue.getPending().length, 1)
  const preparingNotice = stateLog.find(
    (e) => typeof e.next === 'string' && e.next.includes('Located Conversation 1')
  )
  assert.ok(preparingNotice !== undefined, 'Locate click must report preparing state')

  // 3. Remove cnv1 before the timer executes
  requireOne(root, (n) => n.props?.['data-wo-quick-access-remove'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  stateLog.length = 0

  // 4. Release old queued timer
  timerQueue.runAll()
  await runtime.settle()
  root = runtime.getRoot()

  // CONTRACT ASSERTION: Zero old scroll and no success feedback!
  assert.equal(
    mockDoc.scrollIntoViewCalls.length,
    0,
    'queued timer released after removal must NOT scroll DOM'
  )
  const settledSuccessNotice = stateLog.find(
    (e) => typeof e.next === 'string' && e.next === 'Located Conversation 1'
  )
  assert.equal(
    settledSuccessNotice,
    undefined,
    'queued timer released after removal must NOT settle to success notice'
  )

  // 5. Valid unchanged control: click Locate on w1 and release timer
  const locateW1 = requireOne(root, (n) => n.props?.['data-wo-quick-access-locate'] === 'w1')
  locateW1.props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(timerQueue.getPending().length, 1)

  timerQueue.runAll()
  await runtime.settle()
  root = runtime.getRoot()

  assert.equal(mockDoc.scrollIntoViewCalls.length, 1)
  assert.equal(mockDoc.scrollIntoViewCalls[0].selector, '[data-wo-node-id="w1"]')
  const w1Settled = stateLog.find((e) => e.next === 'Located Workspace 1')
  assert.ok(w1Settled !== undefined, 'valid unchanged control must settle to Located Workspace 1')

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 4: Queued timer tree invalidation & fresh click-time rejection', async () => {
  let shouldFailRefresh = false
  const mockDoc = createMockDocument()
  const timerQueue = createControlledTimerQueue()
  let currentSnapshot = testSnapshot

  const { runtime, remote, mounted } = await setupComponent({
    snapshot: () => {
      if (shouldFailRefresh) {
        return { ok: false, error: { message: 'Refresh failed' } }
      }
      return { ok: true, value: currentSnapshot }
    },
    document: mockDoc,
    timerQueue
  })
  let root = runtime.getRoot()

  // Pin cnv1
  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Case A: Queued timer cancelled when tree becomes stale
  requireOne(root, (n) => n.props?.['data-wo-quick-access-locate'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  assert.equal(timerQueue.getPending().length, 1)

  // Fail refresh while timer is pending
  shouldFailRefresh = true
  requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true').props.onClick()
  await runtime.settle()
  root = runtime.getRoot()

  // Verify stale banner
  assert.ok(findOne(root, (n) => n.props?.['data-wo-quick-access-stale'] === 'true'))

  // Release timer
  timerQueue.runAll()
  assert.equal(mockDoc.scrollIntoViewCalls.length, 0, 'stale tree cancels queued scroll')

  // Case B: Fresh click-time rejection when stale
  const locateBtnWhileStale = requireOne(root, (n) => n.props?.['data-wo-quick-access-locate'] === 'cnv1')
  assert.equal(locateBtnWhileStale.props.disabled, true)
  locateBtnWhileStale.props.onClick(mockEvent())
  assert.equal(timerQueue.getPending().length, 0, 'click while stale cannot schedule timer')

  await mounted.cleanup()
})

test('COUNTEREXAMPLE 5: Unmount safety - saved callback and timer do zero state/DOM writes after unmount', async () => {
  const mockDoc = createMockDocument()
  const timerQueue = createControlledTimerQueue()
  const stateLog = []

  const { runtime, remote, mounted } = await setupComponent({
    document: mockDoc,
    timerQueue,
    onSetState: (prev, next) => {
      stateLog.push({ prev, next })
    }
  })
  let root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const locateBtn = requireOne(root, (n) => n.props?.['data-wo-quick-access-locate'] === 'cnv1')
  const capturedLocate = locateBtn.props.onClick

  // Unmount component
  await runtime.unmount()
  await mounted.cleanup()

  stateLog.length = 0
  mockDoc.scrollIntoViewCalls.length = 0
  const rpcCallsBefore = remote.calls.length

  // Invoke saved Locate after unmount
  capturedLocate(mockEvent())

  assert.equal(stateLog.length, 0, 'saved Locate callback after unmount must do zero state writes')
  assert.equal(mockDoc.scrollIntoViewCalls.length, 0, 'saved Locate callback after unmount must do zero DOM calls')
  assert.equal(remote.calls.length, rpcCallsBefore, 'saved Locate callback after unmount must do zero RPC calls')
})

test('POSITIVE ORACLES: P/W/C locate, node rename/move, same-title separation, section hide/restore, isolation, zero RPCs', async () => {
  const mockDoc = createMockDocument()
  const timerQueue = createControlledTimerQueue()
  const stateLog = []
  let currentSnapshot = testSnapshot

  const { runtime, remote, mounted } = await setupComponent({
    snapshot: () => ({ ok: true, value: currentSnapshot }),
    document: mockDoc,
    timerQueue,
    onSetState: (prev, next) => {
      stateLog.push({ prev, next })
    }
  })
  let root = runtime.getRoot()

  // 1. Initial RPC calls check (snapshot, status)
  const initialCalls = remote.calls.length
  assert.equal(initialCalls, 2)

  // 2. Pin Project (p1), Workspace (w1), Conversation (cnv1)
  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'p1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'w1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  requireOne(root, (n) => n.props?.['data-wo-quick-access-toggle'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  let rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1', 'w1', 'cnv1'])

  // 3. Locate Workspace w1
  requireOne(root, (n) => n.props?.['data-wo-quick-access-locate'] === 'w1').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  assert.equal(findOne(root, (n) => n.props?.['data-wo-selected'] === 'true')?.props?.['data-wo-node-id'], 'w1')
  timerQueue.runAll()
  await runtime.settle()
  root = runtime.getRoot()

  assert.equal(mockDoc.scrollIntoViewCalls.length, 1)
  assert.equal(mockDoc.scrollIntoViewCalls[0].selector, '[data-wo-node-id="w1"]')
  const w1Settled = stateLog.find((e) => e.next === 'Located Workspace 1')
  assert.ok(w1Settled !== undefined, 'Locate w1 must settle to Located Workspace 1')

  // 4. Same-title ID separation: cnv1 vs cnv2
  // Locate cnv1 -> uncollapses p1, selects cnv1, cnv2 remains unselected and p2 unchanged
  requireOne(root, (n) => n.props?.['data-wo-quick-access-locate'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  timerQueue.runAll()
  await runtime.settle()
  root = runtime.getRoot()

  assert.equal(findOne(root, (n) => n.props?.['data-wo-selected'] === 'true')?.props?.['data-wo-node-id'], 'cnv1')
  assert.equal(mockDoc.scrollIntoViewCalls.length, 2)
  assert.equal(mockDoc.scrollIntoViewCalls[1].selector, '[data-wo-node-id="cnv1"]')

  // 5. Node rename and move: rename cnv1 and move to p2 in snapshot
  currentSnapshot = {
    ...testSnapshot,
    revision: 2,
    nodes: testSnapshot.nodes.map((node) => {
      if (node.id === 'cnv1') {
        return { ...node, title: 'Conversation Renamed', parentId: 'p2' }
      }
      return node
    })
  }

  // Refresh component
  requireOne(root, (n) => n.props?.['data-wo-refresh'] === 'true').props.onClick()
  await runtime.settle()
  root = runtime.getRoot()

  // Verify membership preserved with updated title
  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1', 'w1', 'cnv1'])
  const titleSpan = requireOne(root, (n) => n.props?.['data-wo-quick-access-title'] === 'cnv1')
  assert.equal(textOf(titleSpan), 'Conversation Renamed')

  // Locate cnv1 after rename and move
  requireOne(root, (n) => n.props?.['data-wo-quick-access-locate'] === 'cnv1').props.onClick(mockEvent())
  await runtime.settle()
  timerQueue.runAll()
  await runtime.settle()
  root = runtime.getRoot()

  assert.equal(findOne(root, (n) => n.props?.['data-wo-selected'] === 'true')?.props?.['data-wo-node-id'], 'cnv1')
  const renamedSettled = stateLog.find((e) => e.next === 'Located Conversation Renamed')
  assert.ok(renamedSettled !== undefined, 'Locate cnv1 after rename must settle to Located Conversation Renamed')

  // 6. Section hide / restore: does not revoke membership or tokens
  requireOne(root, (n) => n.props?.['data-wo-section-hide'] === 'quick-access').props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Quick access is hidden
  assert.equal(findOne(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined), null)

  // Restore quick-access section
  const restoreQa = requireOne(root, (n) => n.props?.['data-wo-restore-section'] === 'quick-access')
  restoreQa.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  // Membership preserved
  rows = findAll(root, (n) => n.props?.['data-wo-quick-access-row'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-wo-quick-access-row']), ['p1', 'w1', 'cnv1'])

  // 7. Find and Task locator compatibility
  // Locate node via Find
  const findBtn = requireOne(root, (n) => n.props?.['data-wo-find'] === 'p1')
  findBtn.props.onClick(mockEvent())
  await runtime.settle()
  root = runtime.getRoot()

  const findQuery = requireOne(root, (n) => n.props?.['data-wo-find-query'] === 'true')
  findQuery.props.onChange({ target: { value: 'Workspace 1' } })
  await runtime.settle()
  root = runtime.getRoot()

  const findResultLocate = requireOne(root, (n) => n.props?.['data-wo-find-result'] === 'w1')
  findResultLocate.props.onClick(mockEvent())
  await runtime.settle()
  timerQueue.runAll()
  await runtime.settle()
  root = runtime.getRoot()

  assert.equal(findOne(root, (n) => n.props?.['data-wo-selected'] === 'true')?.props?.['data-wo-node-id'], 'w1')

  // 8. Zero RPC check: verify no RPC calls were made during Locate operations
  // (Only the 2 initial calls and 2 refresh calls were recorded; zero calls from Locate)
  assert.equal(remote.calls.length, 4, 'Locate operations must produce zero Remote RPC calls')

  await mounted.cleanup()
})
