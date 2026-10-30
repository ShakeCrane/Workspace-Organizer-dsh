/**
 * Client Conversation Capability Gate & Reason Disclosure Tests.
 *
 * Verifies ARCHITECT CONTRACT:
 * 1. Entry button (+ Conversation) and handler use strict capability gate:
 *    - Mounted, snapshot & status accepted, not stale.
 *    - conversationsCreatable must be strictly boolean true.
 *    - false means explicitly unavailable.
 *    - null / undefined / non-boolean / conflict means unverified.
 * 2. Rejection happens strictly BEFORE run():
 *    - 0 createConversation calls.
 *    - 0 snapshot / status refresh calls.
 *    - Draft title, selection, tree, revision preserved.
 * 3. Clear reason disclosure near the entry:
 *    - Discloses: "能力尚未验证", "当前不支持", "最后已知状态，刷新失败".
 *    - Priority: conversationCreation.reason > sessionSource > "未提供".
 *    - Dependency missing vs no-directory missing reasons distinct (not hardcoded).
 *    - Safe plain text rendering (no HTML execution, no private path leaks).
 * 4. Header status model preserved:
 *    - status=null does not fake report (data-wo-status is null).
 *    - Successful refresh updates status & reason without auto-retry loops.
 * 5. Synthetic fresh true control:
 *    - Validates client execution branch without claiming production capability PASS.
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
    { id: 'p1', parentId: 'root', kind: 'project', title: 'Project 1' },
    { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\ws-1' }
  ]
})

function mockEvent() {
  let stopped = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() {},
    isPropagationStopped: () => stopped
  }
}

async function setupComponent({
  snapshot = baseSnapshot,
  status = null,
  ledgers = [],
  createConversationHandler,
  snapshotHandler,
  statusHandler
} = {}) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot, status, ledgers })

  if (typeof createConversationHandler === 'function') {
    remote.allowed.createConversation = createConversationHandler
  }
  if (typeof snapshotHandler === 'function') {
    remote.allowed.snapshot = snapshotHandler
  }
  if (typeof statusHandler === 'function') {
    remote.allowed.status = statusHandler
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

  return { runtime, remote, mounted }
}

async function openCreatePanel(runtime) {
  const root = runtime.getRoot()
  const toggleBtn = requireOne(root, (n) => n.props?.['data-wo-create-toggle'] === 'true', 'Create toggle button')
  toggleBtn.props.onClick(mockEvent())
  await runtime.settle()
}

// -----------------------------------------------------------------------------
// Test 1: False reason 1: Dependency missing disclosure & fail-closed rejection
// -----------------------------------------------------------------------------
test('1. Dependency missing: authentic reason disclosure, disabled button, zero RPC on rejection', async () => {
  const reasonText = 'host Session Controller is not composed in this deployment'
  const status = Object.freeze({
    conversationsCreatable: false,
    sessionSource: reasonText,
    conversationCreation: {
      supported: false,
      reason: reasonText,
      dependencies: { sessionController: false }
    }
  })

  let createCallCount = 0
  let refreshSnapshotCount = 0
  let refreshStatusCount = 0

  const { runtime, remote } = await setupComponent({
    status,
    createConversationHandler: async () => {
      createCallCount += 1
      return { ok: true, value: { id: 'c_new', parentId: 'root', kind: 'conversation', title: 'Test' } }
    },
    snapshotHandler: async () => {
      refreshSnapshotCount += 1
      return { ok: true, value: baseSnapshot }
    },
    statusHandler: async () => {
      refreshStatusCount += 1
      return { ok: true, value: status }
    }
  })

  // Open create panel
  await openCreatePanel(runtime)
  const root = runtime.getRoot()

  // Input draft title
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-create-title'] === 'true', 'Title input')
  titleInput.props.onChange({ target: { value: 'Draft Conversation' } })
  await runtime.settle()

  const panelRoot = runtime.getRoot()
  // Capability indicator
  const capEl = requireOne(panelRoot, (n) => n.props?.['data-wo-conversation-capability'] === 'unsupported', 'Capability indicator')
  assert.equal(capEl.props['data-wo-conversation-capability-reason'], reasonText)
  assert.match(textOf(capEl), /当前不支持/u)
  assert.match(textOf(capEl), /host Session Controller is not composed in this deployment/u)

  // Header status indicator
  const statusEl = requireOne(panelRoot, (n) => n.props?.['data-wo-status'] === 'blocked', 'Header status')
  assert.match(textOf(statusEl), /host Session Controller is not composed in this deployment/u)

  // Button disabled
  const convBtn = requireOne(panelRoot, (n) => n.props?.['data-wo-create-conversation'] === 'true', '+ Conversation button')
  assert.equal(convBtn.props.disabled, true, '+ Conversation button must be disabled')

  // Direct invocation of onClick must be rejected before run()
  const initialSnapshots = refreshSnapshotCount
  const initialStatuses = refreshStatusCount
  convBtn.props.onClick()
  await runtime.settle()

  // Zero createConversation RPC
  assert.equal(createCallCount, 0, 'Must dispatch 0 createConversation RPCs')
  // Zero refresh RPCs (proves run() was never entered)
  assert.equal(refreshSnapshotCount, initialSnapshots, 'Must not dispatch snapshot refresh')
  assert.equal(refreshStatusCount, initialStatuses, 'Must not dispatch status refresh')

  // Draft title preserved
  const preservedInput = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-title'] === 'true', 'Title input')
  assert.equal(preservedInput.props.value, 'Draft Conversation', 'Draft title must be preserved')
})

// -----------------------------------------------------------------------------
// Test 2: False reason 2: No-directory capability missing disclosure
// -----------------------------------------------------------------------------
test('2. No-directory missing: distinct authentic reason disclosure without hardcoding', async () => {
  const reasonText = 'host Session Controller has no no-directory mode: create() falls back to the process directory'
  const status = Object.freeze({
    conversationsCreatable: false,
    sessionSource: reasonText,
    conversationCreation: {
      supported: false,
      reason: reasonText,
      dependencies: { sessionController: true }
    }
  })

  let createCallCount = 0
  const { runtime } = await setupComponent({
    status,
    createConversationHandler: async () => {
      createCallCount += 1
      return { ok: true, value: {} }
    }
  })

  await openCreatePanel(runtime)
  const root = runtime.getRoot()

  const capEl = requireOne(root, (n) => n.props?.['data-wo-conversation-capability'] === 'unsupported', 'Capability indicator')
  assert.equal(capEl.props['data-wo-conversation-capability-reason'], reasonText)
  assert.match(textOf(capEl), /当前不支持/u)
  assert.match(textOf(capEl), /has no no-directory mode/u)

  const convBtn = requireOne(root, (n) => n.props?.['data-wo-create-conversation'] === 'true', '+ Conversation button')
  assert.equal(convBtn.props.disabled, true)

  convBtn.props.onClick()
  await runtime.settle()
  assert.equal(createCallCount, 0)
})

// -----------------------------------------------------------------------------
// Test 3: Graceful fallback when no reason is provided
// -----------------------------------------------------------------------------
test('3. Fallback when reason missing: displays 未提供, button disabled', async () => {
  const status = Object.freeze({
    conversationsCreatable: false
  })

  const { runtime } = await setupComponent({ status })
  await openCreatePanel(runtime)
  const root = runtime.getRoot()

  const capEl = requireOne(root, (n) => n.props?.['data-wo-conversation-capability'] === 'unsupported', 'Capability indicator')
  assert.match(textOf(capEl), /当前不支持/u)
  assert.match(textOf(capEl), /未提供/u)

  const convBtn = requireOne(root, (n) => n.props?.['data-wo-create-conversation'] === 'true', '+ Conversation button')
  assert.equal(convBtn.props.disabled, true)
})

// -----------------------------------------------------------------------------
// Test 4: Unverified on missing capability field
// -----------------------------------------------------------------------------
test('4. Unverified on missing conversationsCreatable field: prompt unverified, disabled', async () => {
  const status = Object.freeze({
    sessionSource: 'some-source'
  })

  let createCallCount = 0
  const { runtime } = await setupComponent({
    status,
    createConversationHandler: async () => { createCallCount += 1 }
  })

  await openCreatePanel(runtime)
  const root = runtime.getRoot()

  const capEl = requireOne(root, (n) => n.props?.['data-wo-conversation-capability'] === 'unverified', 'Capability indicator')
  assert.match(textOf(capEl), /能力尚未验证/u)

  const convBtn = requireOne(root, (n) => n.props?.['data-wo-create-conversation'] === 'true', '+ Conversation button')
  assert.equal(convBtn.props.disabled, true)

  convBtn.props.onClick()
  await runtime.settle()
  assert.equal(createCallCount, 0)
})

// -----------------------------------------------------------------------------
// Test 5: Unverified on non-boolean values (no truthy conversion)
// -----------------------------------------------------------------------------
test('5. Non-boolean values (string, number) rejected without truthy conversion', async () => {
  // String "true"
  const { runtime: r1 } = await setupComponent({
    status: { conversationsCreatable: 'true' }
  })
  await openCreatePanel(r1)
  const cap1 = requireOne(r1.getRoot(), (n) => n.props?.['data-wo-conversation-capability'] === 'unverified')
  assert.match(textOf(cap1), /能力尚未验证/u)
  const btn1 = requireOne(r1.getRoot(), (n) => n.props?.['data-wo-create-conversation'] === 'true')
  assert.equal(btn1.props.disabled, true)

  // Number 1
  const { runtime: r2 } = await setupComponent({
    status: { conversationsCreatable: 1 }
  })
  await openCreatePanel(r2)
  const cap2 = requireOne(r2.getRoot(), (n) => n.props?.['data-wo-conversation-capability'] === 'unverified')
  assert.match(textOf(cap2), /能力尚未验证/u)
  const btn2 = requireOne(r2.getRoot(), (n) => n.props?.['data-wo-create-conversation'] === 'true')
  assert.equal(btn2.props.disabled, true)
})

// -----------------------------------------------------------------------------
// Test 6: Conflicting capability fields treated as unverified & rejected
// -----------------------------------------------------------------------------
test('6. Conflicting capability fields (boolean true vs structured false) fail closed as unverified', async () => {
  const statusConflict = Object.freeze({
    conversationsCreatable: true,
    conversationCreation: {
      supported: false,
      reason: 'Structured flag says unsupported'
    }
  })

  let createCallCount = 0
  const { runtime } = await setupComponent({
    status: statusConflict,
    createConversationHandler: async () => { createCallCount += 1 }
  })

  await openCreatePanel(runtime)
  const root = runtime.getRoot()

  const capEl = requireOne(root, (n) => n.props?.['data-wo-conversation-capability'] === 'unverified', 'Capability indicator')
  assert.match(textOf(capEl), /能力尚未验证/u)

  const convBtn = requireOne(root, (n) => n.props?.['data-wo-create-conversation'] === 'true', '+ Conversation button')
  assert.equal(convBtn.props.disabled, true)

  convBtn.props.onClick()
  await runtime.settle()
  assert.equal(createCallCount, 0)
})

// -----------------------------------------------------------------------------
// Test 7: Stale state defense (rejects even if previous status was true)
// -----------------------------------------------------------------------------
test('7. Stale state defense: refresh failure marks stale, disables button, dispatches 0 RPCs', async () => {
  const initialStatus = Object.freeze({
    conversationsCreatable: true,
    sessionSource: 'initial-ok',
    conversationCreation: { supported: true }
  })

  let createCallCount = 0
  const { runtime, remote } = await setupComponent({
    status: initialStatus,
    createConversationHandler: async () => { createCallCount += 1 }
  })

  // Trigger refresh failure -> snapshotStale becomes true
  remote.allowed.snapshot = async () => { throw new Error('Network refresh error') }
  const refreshBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-refresh'] === 'true', 'Refresh button')
  refreshBtn.props.onClick()
  await runtime.settle()

  // Open create panel
  await openCreatePanel(runtime)
  const root = runtime.getRoot()

  // Capability indicator shows stale
  const capEl = requireOne(root, (n) => n.props?.['data-wo-conversation-capability'] === 'stale', 'Stale capability')
  assert.match(textOf(capEl), /最后已知状态，刷新失败/u)

  // Button disabled
  const convBtn = requireOne(root, (n) => n.props?.['data-wo-create-conversation'] === 'true', '+ Conversation button')
  assert.equal(convBtn.props.disabled, true)

  // Direct invocation rejected
  convBtn.props.onClick()
  await runtime.settle()
  assert.equal(createCallCount, 0)
})

// -----------------------------------------------------------------------------
// Test 8: Dynamic update from true to false
// -----------------------------------------------------------------------------
test('8. Dynamic transition from true to false: button disabled, notice updated', async () => {
  const initialStatus = Object.freeze({
    conversationsCreatable: true,
    sessionSource: 'initial-ok',
    conversationCreation: { supported: true }
  })
  const updatedStatus = Object.freeze({
    conversationsCreatable: false,
    sessionSource: 'revoked',
    conversationCreation: { supported: false, reason: 'host capability withdrawn' }
  })

  let currentStatus = initialStatus
  const { runtime, remote } = await setupComponent({
    status: initialStatus,
    statusHandler: async () => ({ ok: true, value: currentStatus })
  })

  // Update status to false and refresh
  currentStatus = updatedStatus
  const refreshBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-refresh'] === 'true', 'Refresh button')
  refreshBtn.props.onClick()
  await runtime.settle()

  await openCreatePanel(runtime)
  const root = runtime.getRoot()

  const capEl = requireOne(root, (n) => n.props?.['data-wo-conversation-capability'] === 'unsupported')
  assert.match(textOf(capEl), /当前不支持/u)
  assert.match(textOf(capEl), /host capability withdrawn/u)

  const convBtn = requireOne(root, (n) => n.props?.['data-wo-create-conversation'] === 'true')
  assert.equal(convBtn.props.disabled, true)
})

// -----------------------------------------------------------------------------
// Test 9: Saved old closure handler rejected against live refs
// -----------------------------------------------------------------------------
test('9. Saved old closure handler rejected against live refs after status changes to false', async () => {
  const initialStatus = Object.freeze({
    conversationsCreatable: true,
    conversationCreation: { supported: true }
  })

  let createCallCount = 0
  let currentStatus = initialStatus

  const { runtime, remote } = await setupComponent({
    status: initialStatus,
    statusHandler: async () => ({ ok: true, value: currentStatus }),
    createConversationHandler: async () => {
      createCallCount += 1
      return { ok: true, value: {} }
    }
  })

  await openCreatePanel(runtime)
  // Input title
  const titleInput = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-title'] === 'true')
  titleInput.props.onChange({ target: { value: 'Old Handler Conv' } })
  await runtime.settle()

  // Save the onClick handler when it was enabled
  const convBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-conversation'] === 'true')
  const savedHandler = convBtn.props.onClick

  // Now change status to false and refresh
  currentStatus = Object.freeze({
    conversationsCreatable: false,
    conversationCreation: { supported: false, reason: 'now false' }
  })
  const refreshBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-refresh'] === 'true')
  refreshBtn.props.onClick()
  await runtime.settle()

  // Invoke the saved handler from the old closure!
  savedHandler()
  await runtime.settle()

  // Must be rejected against current statusRef!
  assert.equal(createCallCount, 0, 'Saved handler must be rejected when live status is false')
})

// -----------------------------------------------------------------------------
// Test 10: Unmount safety: saved handler after unmount does nothing
// -----------------------------------------------------------------------------
test('10. Unmount safety: saved handler invoked after unmount is safely rejected', async () => {
  let createCallCount = 0
  const { runtime, mounted } = await setupComponent({
    status: { conversationsCreatable: true, conversationCreation: { supported: true } },
    createConversationHandler: async () => { createCallCount += 1 }
  })

  await openCreatePanel(runtime)
  const convBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-conversation'] === 'true')
  const savedHandler = convBtn.props.onClick

  // Unmount component
  runtime.unmount()

  // Invoke saved handler after unmount
  savedHandler()
  await runtime.settle()

  assert.equal(createCallCount, 0, 'Zero RPCs on unmounted component')
})

// -----------------------------------------------------------------------------
// Test 11: Rejection happens strictly before run(): zero snapshot/status refresh
// -----------------------------------------------------------------------------
test('11. Rejection occurs strictly before run(): zero createConversation and zero refresh RPCs', async () => {
  let createCalls = 0
  let snapshotCalls = 0
  let statusCalls = 0

  const { runtime } = await setupComponent({
    status: { conversationsCreatable: false, conversationCreation: { supported: false, reason: 'blocked' } },
    createConversationHandler: async () => { createCalls += 1 },
    snapshotHandler: async () => { snapshotCalls += 1; return { ok: true, value: baseSnapshot } },
    statusHandler: async () => { statusCalls += 1; return { ok: true, value: { conversationsCreatable: false } } }
  })

  await openCreatePanel(runtime)
  const convBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-conversation'] === 'true')

  const snapBefore = snapshotCalls
  const statBefore = statusCalls

  // Trigger rejection
  convBtn.props.onClick()
  await runtime.settle()

  assert.equal(createCalls, 0)
  assert.equal(snapshotCalls, snapBefore, 'Must not call snapshot')
  assert.equal(statusCalls, statBefore, 'Must not call status')
})

// -----------------------------------------------------------------------------
// Test 12: Mutual exclusion with other workflows
// -----------------------------------------------------------------------------
test('12. Mutual exclusion: active create-project blocks + Conversation', async () => {
  const { runtime } = await setupComponent({
    status: { conversationsCreatable: true, conversationCreation: { supported: true } }
  })

  await openCreatePanel(runtime)

  // Start create project workflow
  const startProjBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-project-start'] === 'true')
  startProjBtn.props.onClick()
  await runtime.settle()

  // + Conversation must be disabled while create project is active
  const convBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-conversation'] === 'true')
  assert.equal(convBtn.props.disabled, true)
})

// -----------------------------------------------------------------------------
// Test 13: Synthetic fresh true control (validates client branch, not production PASS)
// -----------------------------------------------------------------------------
test('13. [SYNTHETIC TEST CONTROL] Fresh true enables + Conversation, creates conversation, clears draft and closes panel', async () => {
  let createdInput = null
  const syntheticStatus = Object.freeze({
    conversationsCreatable: true,
    sessionSource: 'synthetic-control-test',
    conversationCreation: { supported: true }
  })

  const { runtime } = await setupComponent({
    status: syntheticStatus,
    createConversationHandler: async (input) => {
      createdInput = input
      return { ok: true, value: { id: 'c_synth', parentId: input.parentId, kind: 'conversation', title: input.title } }
    }
  })

  await openCreatePanel(runtime)
  const root = runtime.getRoot()

  // Capability indicator shows supported
  const capEl = requireOne(root, (n) => n.props?.['data-wo-conversation-capability'] === 'supported')
  assert.match(textOf(capEl), /普通会话可用/u)

  // Enter title
  const titleInput = requireOne(root, (n) => n.props?.['data-wo-create-title'] === 'true')
  titleInput.props.onChange({ target: { value: 'Synthetic Chat' } })
  await runtime.settle()

  // Button is enabled
  const convBtn = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-conversation'] === 'true')
  assert.equal(convBtn.props.disabled, false, '+ Conversation button must be enabled under synthetic true')

  // Click button
  convBtn.props.onClick()
  await runtime.settle()

  // Assert createConversation was called with correct arguments
  assert.ok(createdInput !== null, 'createConversation must be called')
  assert.equal(createdInput.parentId, 'root')
  assert.equal(createdInput.title, 'Synthetic Chat')

  // Panel closed
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-create-panel'] === 'true'), null, 'Panel closed')
})

// -----------------------------------------------------------------------------
// Test 14: Initial status null does not fabricate report
// -----------------------------------------------------------------------------
test('14. Initial status null: header status not rendered, capability shows unverified', async () => {
  const { runtime } = await setupComponent({
    status: null
  })

  // Header status element is null
  assert.equal(findOne(runtime.getRoot(), (n) => n.props?.['data-wo-status'] !== undefined), null)

  await openCreatePanel(runtime)
  const capEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-conversation-capability'] === 'unverified')
  assert.match(textOf(capEl), /能力尚未验证/u)
})

// -----------------------------------------------------------------------------
// Test 15: Safe plain text rendering (no HTML injection)
// -----------------------------------------------------------------------------
test('15. Safe plain text rendering: reason with HTML tags renders safely as text', async () => {
  const maliciousReason = '<script>alert(1)</script><b>bold reason</b>'
  const status = Object.freeze({
    conversationsCreatable: false,
    conversationCreation: {
      supported: false,
      reason: maliciousReason
    }
  })

  const { runtime } = await setupComponent({ status })
  await openCreatePanel(runtime)
  const capEl = requireOne(runtime.getRoot(), (n) => n.props?.['data-wo-conversation-capability'] === 'unsupported')

  // Check text content contains the raw characters without HTML parsing
  assert.match(textOf(capEl), /<script>alert\(1\)<\/script>/u)
})
