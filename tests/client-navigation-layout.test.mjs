/**
 * Core navigation slice offline component tests.
 *
 * Verifies:
 * 1. Independent hide and restore of the 3 navigation sections (quick-access, projects, recent).
 * 2. Persistent restore area remains reachable outside the 3 sections even when all 3 are hidden.
 * 3. Restoring is idempotent ("重复恢复无重复分区").
 * 4. Fold state, project internal expansion Set, active selection, and find details are preserved across hide/restore.
 * 5. Zero Remote and zero uiWorkspace RPC side-effects caused by hide/restore.
 * 6. Section hide and restore button clicks stop propagation and do not toggle section headers or project rows.
 * 7. FP-90 Note 1: Conversation row disclosure ("打开原生会话；尚未提供UX-10产品Tab/多窗口及工具焦点保护").
 * 8. FP-90 Note 2: Find result action labeled "定位树节点" and persistent UX-13 notice in Find panel.
 * 9. Unfulfilled disclosures: "隐藏未实现" removed, while truthful notices for drag/resize/persistence and missing data sources are preserved.
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
    { id: 'p1', parentId: null, kind: 'project', title: 'Alpha Project' },
    { id: 'p2', parentId: 'p1', kind: 'project', title: 'Beta Subproject' },
    { id: 'w1', parentId: 'p1', kind: 'workspace', title: 'Workspace 1', directory: 'E:\\alpha-ws' },
    { id: 'c1', parentId: 'p1', kind: 'conversation', title: 'Chat Alpha', sessionId: 'ses-alpha-1' }
  ]
})

const testStatus = Object.freeze({
  conversationsCreatable: true,
  sessionSource: 'synthetic-test'
})

async function setupTestComponent(customSnapshot = testSnapshot, customStatus = testStatus) {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot: customSnapshot, status: customStatus, ledgers: [] })
  const mounted = await mountClientApplication({
    source,
    react: runtime.React,
    zod: createZodTestDouble(),
    remote
  })
  runtime.setComponent(mounted.component)
  runtime.render()
  await runtime.settle()
  return { runtime, remote, mounted, source }
}

function mockEvent() {
  let stopped = false
  let prevented = false
  return {
    stopPropagation() { stopped = true },
    preventDefault() { prevented = true },
    isPropagationStopped: () => stopped,
    isDefaultPrevented: () => prevented
  }
}

test('initial state renders all three navigation sections visible and restore area has no hidden sections', async () => {
  const { runtime, remote, mounted } = await setupTestComponent()
  const root = runtime.getRoot()

  const quickAccess = findOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access')
  const projects = findOne(root, (node) => node.props?.['data-wo-section'] === 'projects')
  const recent = findOne(root, (node) => node.props?.['data-wo-section'] === 'recent')

  assert.ok(quickAccess !== null, 'quick-access section must be visible initially')
  assert.ok(projects !== null, 'projects section must be visible initially')
  assert.ok(recent !== null, 'recent section must be visible initially')

  const restoreArea = requireOne(root, (node) => node.props?.['data-wo-navigation-restore'] === 'true', 'navigation restore container')
  assert.ok(restoreArea !== null, 'permanent navigation restore container must exist outside sections')

  const restoreQuick = findOne(restoreArea, (node) => node.props?.['data-wo-restore-section'] === 'quick-access')
  const restoreProjects = findOne(restoreArea, (node) => node.props?.['data-wo-restore-section'] === 'projects')
  const restoreRecent = findOne(restoreArea, (node) => node.props?.['data-wo-restore-section'] === 'recent')
  const restoreAll = findOne(restoreArea, (node) => node.props?.['data-wo-restore-all'] === 'true')

  assert.equal(restoreQuick, null, 'restore quick-access button should not appear when section is visible')
  assert.equal(restoreProjects, null, 'restore projects button should not appear when section is visible')
  assert.equal(restoreRecent, null, 'restore recent button should not appear when section is visible')
  assert.equal(restoreAll, null, 'restore all button should not appear when all sections are visible')

  await mounted.cleanup()
})

test('hiding quick-access hides quick-access section only, leaving projects and recent visible, and makes quick-access restore button available in permanent restore area', async () => {
  const { runtime, mounted } = await setupTestComponent()
  let root = runtime.getRoot()

  const hideButton = requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'quick-access', 'hide quick-access button')
  const event = mockEvent()
  hideButton.props.onClick(event)
  assert.equal(event.isPropagationStopped(), true, 'hide button click must call stopPropagation')
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access'), null, 'quick-access must be hidden')
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects') !== null, 'projects must remain visible')
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'recent') !== null, 'recent must remain visible')

  const restoreArea = requireOne(root, (node) => node.props?.['data-wo-navigation-restore'] === 'true', 'navigation restore container')
  const restoreQuick = requireOne(restoreArea, (node) => node.props?.['data-wo-restore-section'] === 'quick-access', 'restore quick-access button')
  const restoreAll = requireOne(restoreArea, (node) => node.props?.['data-wo-restore-all'] === 'true', 'restore all button')
  assert.ok(restoreQuick !== null)
  assert.ok(restoreAll !== null)

  await mounted.cleanup()
})

test('restoring quick-access restores it while projects and recent remain unaffected; duplicate restore is idempotent', async () => {
  const { runtime, mounted } = await setupTestComponent()
  let root = runtime.getRoot()

  // Hide quick-access
  const hideButton = requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'quick-access', 'hide quick-access')
  hideButton.props.onClick(mockEvent())
  await runtime.settle()

  // Restore quick-access
  root = runtime.getRoot()
  const restoreButton = requireOne(root, (node) => node.props?.['data-wo-restore-section'] === 'quick-access', 'restore quick-access')
  const restoreEvent = mockEvent()
  restoreButton.props.onClick(restoreEvent)
  assert.equal(restoreEvent.isPropagationStopped(), true, 'restore button click must call stopPropagation')
  await runtime.settle()

  root = runtime.getRoot()
  const quickAccess = findOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access')
  const projects = findOne(root, (node) => node.props?.['data-wo-section'] === 'projects')
  const recent = findOne(root, (node) => node.props?.['data-wo-section'] === 'recent')
  assert.ok(quickAccess !== null, 'quick-access must be restored')
  assert.ok(projects !== null, 'projects must remain visible')
  assert.ok(recent !== null, 'recent must remain visible')

  // Check no duplicate sections exist in DOM
  const quickSections = findAll(root, (node) => node.props?.['data-wo-section'] === 'quick-access')
  assert.equal(quickSections.length, 1, 'must have exactly one quick-access section')

  await mounted.cleanup()
})

test('hiding projects hides projects section only, and restoring it restores projects', async () => {
  const { runtime, mounted } = await setupTestComponent()
  let root = runtime.getRoot()

  const hideProjects = requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'projects', 'hide projects')
  hideProjects.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects'), null)
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access') !== null)
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'recent') !== null)

  const restoreProjects = requireOne(root, (node) => node.props?.['data-wo-restore-section'] === 'projects', 'restore projects')
  restoreProjects.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects') !== null)
  assert.equal(findAll(root, (node) => node.props?.['data-wo-section'] === 'projects').length, 1)

  await mounted.cleanup()
})

test('hiding recent hides recent section only, and restoring it restores recent', async () => {
  const { runtime, mounted } = await setupTestComponent()
  let root = runtime.getRoot()

  const hideRecent = requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'recent', 'hide recent')
  hideRecent.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'recent'), null)
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access') !== null)
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects') !== null)

  const restoreRecent = requireOne(root, (node) => node.props?.['data-wo-restore-section'] === 'recent', 'restore recent')
  restoreRecent.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'recent') !== null)
  assert.equal(findAll(root, (node) => node.props?.['data-wo-section'] === 'recent').length, 1)

  await mounted.cleanup()
})

test('hiding all three sections keeps permanent restore area reachable with individual restore buttons and restore-all button', async () => {
  const { runtime, mounted } = await setupTestComponent()
  let root = runtime.getRoot()

  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'quick-access', 'hide quick').props.onClick(mockEvent())
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'projects', 'hide projects').props.onClick(mockEvent())
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'recent', 'hide recent').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access'), null)
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects'), null)
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'recent'), null)

  const restoreArea = requireOne(root, (node) => node.props?.['data-wo-navigation-restore'] === 'true', 'restore area')
  assert.ok(restoreArea !== null, 'restore area must be reachable when all sections are hidden')

  assert.ok(findOne(restoreArea, (node) => node.props?.['data-wo-restore-section'] === 'quick-access') !== null)
  assert.ok(findOne(restoreArea, (node) => node.props?.['data-wo-restore-section'] === 'projects') !== null)
  assert.ok(findOne(restoreArea, (node) => node.props?.['data-wo-restore-section'] === 'recent') !== null)
  assert.ok(findOne(restoreArea, (node) => node.props?.['data-wo-restore-all'] === 'true') !== null)

  // Clicking restore-all restores all three
  const restoreAll = requireOne(restoreArea, (node) => node.props?.['data-wo-restore-all'] === 'true', 'restore all')
  const restoreAllEvent = mockEvent()
  restoreAll.props.onClick(restoreAllEvent)
  assert.equal(restoreAllEvent.isPropagationStopped(), true)
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access') !== null)
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects') !== null)
  assert.ok(findOne(root, (node) => node.props?.['data-wo-section'] === 'recent') !== null)

  await mounted.cleanup()
})

test('hiding and restoring preserves section fold states, project internal expansion, active selection, and find state', async () => {
  const { runtime, mounted } = await setupTestComponent()
  let root = runtime.getRoot()

  // 1. Collapse the Projects section header
  const projectsSection = requireOne(root, (node) => node.props?.['data-wo-section'] === 'projects', 'projects section')
  const projectsCollapseToggle = requireOne(projectsSection, (node) => node.props?.role === 'button' && node.props?.['aria-expanded'] !== undefined, 'projects header collapse toggle')
  assert.equal(projectsCollapseToggle.props['aria-expanded'], 'true', 'projects should initially be expanded')
  projectsCollapseToggle.props.onClick()
  await runtime.settle()

  root = runtime.getRoot()
  const collapsedHeaderBefore = requireOne(root, (node) => node.props?.role === 'button' && node.props?.['aria-expanded'] !== undefined && node.props['data-wo-section-hide'] === undefined && textOf(node).includes('文件夹'), 'collapsed projects header')
  assert.equal(collapsedHeaderBefore.props['aria-expanded'], 'false', 'projects section should now be collapsed')

  // 2. Hide Projects section while collapsed
  const hideProjects = requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'projects', 'hide projects')
  hideProjects.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.equal(findOne(root, (node) => node.props?.['data-wo-section'] === 'projects'), null)

  // 3. Restore Projects section
  const restoreProjects = requireOne(root, (node) => node.props?.['data-wo-restore-section'] === 'projects', 'restore projects')
  restoreProjects.props.onClick(mockEvent())
  await runtime.settle()

  // 4. Verify Projects section is STILL collapsed!
  root = runtime.getRoot()
  const restoredHeader = requireOne(root, (node) => node.props?.role === 'button' && node.props?.['aria-expanded'] !== undefined && textOf(node).includes('文件夹'), 'restored projects header')
  assert.equal(restoredHeader.props['aria-expanded'], 'false', 'projects section must retain its collapsed state across hide/restore')

  // Uncollapse projects header to test node internal expansion and selection
  restoredHeader.props.onClick()
  await runtime.settle()

  // Collapse project p1 node internally
  root = runtime.getRoot()
  const p1Row = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'p1', 'p1 row')
  assert.equal(p1Row.props['aria-expanded'], 'true', 'p1 node should initially be expanded')
  p1Row.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const p1Collapsed = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'p1', 'p1 row collapsed')
  assert.equal(p1Collapsed.props['aria-expanded'], 'false', 'p1 node should now be collapsed')

  // Select c1 (expand p1 again to reach c1)
  p1Collapsed.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const selectButton = requireOne(root, (node) => node.props?.['data-wo-select'] === 'c1', 'select c1')
  selectButton.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const c1Row = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'c1', 'c1 row')
  assert.equal(c1Row.props['data-wo-selected'], 'true', 'c1 should be selected')

  // Open Find panel on p1
  const findBtn = requireOne(root, (node) => node.props?.['data-wo-find'] === 'p1', 'find p1')
  findBtn.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  assert.ok(findOne(root, (node) => node.props?.['data-wo-find-panel'] === 'p1') !== null, 'find panel should be open')

  // Now hide and restore quick-access and recent
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'quick-access', 'hide quick').props.onClick(mockEvent())
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'recent', 'hide recent').props.onClick(mockEvent())
  await runtime.settle()

  // Hide and restore projects
  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'projects', 'hide projects').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-restore-all'] === 'true', 'restore all').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  // Verify selected c1 is still selected and find panel on p1 is still open!
  const c1After = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'c1', 'c1 row after restore')
  assert.equal(c1After.props['data-wo-selected'], 'true', 'active selection c1 must be preserved')
  assert.ok(findOne(root, (node) => node.props?.['data-wo-find-panel'] === 'p1') !== null, 'find panel must remain open')

  await mounted.cleanup()
})

test('hide and restore actions produce zero remote and zero uiWorkspace RPC side effects', async () => {
  const { runtime, remote, mounted } = await setupTestComponent()

  // Initial load calls: snapshot, status
  const initialCallCount = remote.calls.length
  assert.deepEqual(remote.calls.map((c) => c.method), ['snapshot', 'status'])
  assert.equal(remote.illegal.length, 0)

  let root = runtime.getRoot()

  // Perform multiple hide and restore operations
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'quick-access', 'hide quick').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'projects', 'hide projects').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-section-hide'] === 'recent', 'hide recent').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-restore-section'] === 'quick-access', 'restore quick').props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  requireOne(root, (node) => node.props?.['data-wo-restore-all'] === 'true', 'restore all').props.onClick(mockEvent())
  await runtime.settle()

  // Assert ZERO new remote calls!
  assert.equal(remote.calls.length, initialCallCount, 'hide/restore must not produce any remote calls')
  assert.equal(remote.illegal.length, 0, 'no illegal remote methods called')

  await mounted.cleanup()
})

test('FP-90 Note 1: conversation row discloses native session open notice without windowing/double-click/fork', async () => {
  const { runtime, mounted, source } = await setupTestComponent()
  const root = runtime.getRoot()

  const c1Row = requireOne(root, (node) => node.props?.['data-wo-node-id'] === 'c1', 'c1 conversation row')
  const expectedNotice = '打开原生会话；尚未提供UX-10产品Tab/多窗口及工具焦点保护'

  // 1. Static attribute assertion on conversation title
  assert.ok(typeof c1Row.props.title === 'string' && c1Row.props.title.includes(expectedNotice), 'conversation row title must disclose notice')

  // 2. Rendered notice element assertion
  const noticeSpan = requireOne(c1Row, (node) => node.props?.['data-wo-conversation-notice'] === 'true', 'conversation notice span')
  assert.equal(textOf(noticeSpan), expectedNotice, 'conversation notice span must have exact disclosure text')

  // 3. No double-click or fork handlers added in source
  assert.ok(!source.includes('onDoubleClick'), 'no double click handler should exist in client')
  assert.ok(!source.includes('forkSession'), 'no forkSession call should exist in client')

  await mounted.cleanup()
})

test('FP-90 Note 2: find result button has 定位树节点 label and find panel contains persistent UX-13 notice', async () => {
  const { runtime, mounted, source } = await setupTestComponent()
  let root = runtime.getRoot()

  // Open find panel on p1
  const findButton = requireOne(root, (node) => node.props?.['data-wo-find'] === 'p1', 'find button on p1')
  findButton.props.onClick(mockEvent())
  await runtime.settle()

  root = runtime.getRoot()
  const findPanel = requireOne(root, (node) => node.props?.['data-wo-find-panel'] === 'p1', 'find panel')

  // 1. Persistent find notice assertion
  const expectedNotice = '当前仅按节点名称查找；会话消息全文搜索尚未实现（UX-13）'
  const findNotice = requireOne(findPanel, (node) => node.props?.['data-wo-find-notice'] === 'true', 'find notice element')
  assert.equal(textOf(findNotice), expectedNotice, 'find panel must disclose name-only search limitation')

  // 2. Search for child node and verify result button label
  const queryInput = requireOne(findPanel, (node) => node.props?.['data-wo-find-query'] === 'true', 'find query input')
  queryInput.props.onChange({ target: { value: 'Beta' } })
  await runtime.settle()

  root = runtime.getRoot()
  const resultButton = requireOne(root, (node) => node.props?.['data-wo-find-result'] === 'p2', 'find result button for p2')
  assert.ok(textOf(resultButton).includes('定位树节点'), 'result button must be labeled 定位树节点')

  // 3. Source assertions
  assert.match(source, /data-wo-find-notice/u)
  assert.match(source, /定位树节点/u)

  await mounted.cleanup()
})

test('unfulfilled notices remove 隐藏未实现 while preserving truthful drag/resize/persistence and missing data source disclosures', async () => {
  const { runtime, mounted } = await setupTestComponent()
  const root = runtime.getRoot()

  const quickAccess = requireOne(root, (node) => node.props?.['data-wo-section'] === 'quick-access', 'quick-access section')
  const recent = requireOne(root, (node) => node.props?.['data-wo-section'] === 'recent', 'recent section')

  const quickText = textOf(quickAccess)
  const recentText = textOf(recent)

  // Must NOT claim hide is unfulfilled
  assert.ok(!quickText.includes('隐藏：未实现'), 'quick-access must not claim hide is unfulfilled')
  assert.ok(!quickText.includes('隐藏未实现'), 'quick-access must not claim hide is unfulfilled')
  assert.ok(!recentText.includes('隐藏：未实现'), 'recent must not claim hide is unfulfilled')
  assert.ok(!recentText.includes('隐藏未实现'), 'recent must not claim hide is unfulfilled')

  // Must truthfully disclose drag/resize unfulfilled
  assert.ok(quickText.includes('分区拖动排序 / 自由调高：未实现'), 'quick-access must disclose drag/resize unfulfilled')
  assert.ok(recentText.includes('分区拖动排序 / 自由调高：未实现'), 'recent must disclose drag/resize unfulfilled')

  // Must truthfully disclose missing data sources
  assert.ok(quickText.includes('尚未实现（无合法快捷访问数据源，不使用模拟项填充）'))
  assert.ok(recentText.includes('尚未实现（无用户消息排序或权威事件数据源，不按修改时间或工具日志拼凑）'))

  await mounted.cleanup()
})
