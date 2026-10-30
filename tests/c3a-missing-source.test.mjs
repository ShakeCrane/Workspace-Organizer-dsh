import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  completeDetailErrors,
  createHooksRuntime,
  createRemoteProxy,
  createSyntheticScenario,
  createZodTestDouble,
  detailSnapshot,
  digestValue,
  extractTaskCenterDetail,
  extractTaskCenterState,
  inputStabilityErrors,
  missingSourceDetailErrors,
  mountClientApplication,
  scenarioCallErrors,
  textOf
} from '../scripts/lib/c3a-synthetic-component-runtime.mjs'

const scenario = createSyntheticScenario()

function buildDetail(h, overrides = {}) {
  const values = {
    taskId: scenario.targetTask.taskId,
    sourceId: scenario.targetTask.sourceConversationId,
    logical: 'unknown',
    native: 'unknown',
    directory: 'unknown',
    verifiedAt: 'unknown',
    verification: 'unverified',
    sourceBlocked: null,
    taskBlocked: 'blocked: source/source-archived',
    staleAttr: 'false',
    staleText: 'last observed source facts only',
    resourceSession: 'resource session: unknown',
    hostVersion: 'hostVersion: unknown',
    execution: 'execution: UNKNOWN (blocked)',
    ...overrides
  }
  const field = (name, attr, text) => h('div', { [name]: attr }, text)
  return h('div', { 'data-wo-task-center-detail': values.taskId },
    h('div', {}, `taskId: ${values.taskId}`),
    h('div', {}, `sourceConversationId: ${values.sourceId}`),
    h('div', {}, `parent: conversation:${values.sourceId}`),
    h('div', {}, 'childSessionId: wo-u1'),
    h('div', {}, 'depth/mode: 1/one-shot'),
    h('div', {}, 'observedAt: 2026-10-24T00:00:04.000Z'),
    h('div', {}, values.execution),
    values.taskBlocked === null ? null : h('div', { 'data-wo-task-center-blocked': 'true' }, values.taskBlocked),
    field('data-wo-source-id', values.sourceId, `source C: ${values.sourceId}`),
    field('data-wo-source-logical', values.logical, `logical workspace: ${values.logical}`),
    field('data-wo-source-native', values.native, `native workspace: ${values.native}`),
    field('data-wo-source-directory', values.directory, `observed directory: ${values.directory}`),
    field('data-wo-source-verified-at', values.verifiedAt, `verifiedAt: ${values.verifiedAt}`),
    field('data-wo-source-verification', values.verification, `verification: ${values.verification}`),
    values.sourceBlocked === null ? null : h('div', { 'data-wo-source-blocked': 'true' }, values.sourceBlocked),
    h('div', { 'data-wo-source-stale': values.staleAttr }, values.staleText),
    h('div', {}, values.resourceSession),
    h('div', {}, values.hostVersion),
    h('button', { 'data-wo-task-center-locate': values.taskId }, 'Locate source'))
}

function buildState(h, { detail, status = 'Tasks ledger: ready (rev 5)', error = null, stale = null, rows = scenario.baseline.tasks.map((task) => task.taskId) } = {}) {
  return h('div', {},
    h('span', { 'data-wo-task-center-status': 'true' }, status),
    error === null ? null : h('div', { 'data-wo-task-center-error': 'true' }, error),
    stale === null ? null : h('div', { 'data-wo-task-center-stale': 'true' }, stale),
    rows.map((id) => h('button', { 'data-wo-task-center-row': id }, id)),
    detail)
}

test('real VNode detail oracle accepts complete baseline and missing-Source A defense', () => {
  const runtime = createHooksRuntime()
  const h = runtime.React.createElement
  const missingDetail = extractTaskCenterDetail((() => {
    const detail = buildDetail(h)
    return buildState(h, { detail })
  })(), scenario.targetTask.taskId)
  const missingState = extractTaskCenterState(buildState(h, { detail: buildDetail(h) }))
  assert.deepEqual(missingSourceDetailErrors({ detail: missingDetail, state: missingState, task: scenario.targetTask, otherSource: scenario.otherSource, revision: 5 }), [])
  assert.equal(missingDetail.sourceId, scenario.targetTask.sourceConversationId)
  assert.equal(missingDetail.resourceSession, 'resource session: unknown')
  assert.equal(missingDetail.hostVersion, 'hostVersion: unknown')

  const baselineDetailVNode = buildDetail(h, {
    logical: scenario.targetSource.workspaceLogicalId,
    native: scenario.targetSource.nativeWorkspaceId,
    directory: scenario.targetSource.directory,
    verifiedAt: scenario.targetSource.verifiedAt,
    verification: 'blocked',
    sourceBlocked: 'source blocked: source-archived',
    resourceSession: `resource session: ${scenario.targetSource.sessionId}`,
    hostVersion: `hostVersion: ${scenario.targetSource.hostVersion}`
  })
  const baselineState = extractTaskCenterState(buildState(h, { detail: baselineDetailVNode }))
  const baselineDetail = extractTaskCenterDetail(buildState(h, { detail: baselineDetailVNode }), scenario.targetTask.taskId)
  assert.deepEqual(completeDetailErrors({ detail: baselineDetail, state: baselineState, task: scenario.targetTask, source: scenario.targetSource, revision: 5 }), [])
  const snapshot = detailSnapshot(buildState(h, { detail: baselineDetailVNode }), scenario.targetTask.taskId)
  assert.ok(snapshot.nodes.some((node) => node.attrs['data-wo-source-id'] === scenario.targetTask.sourceConversationId))
  assert.ok(snapshot.nodes.some((node) => node.text.startsWith('source C:')))
})

test('missing-Source oracle rejects wrong source id, retained old values, leaks, fake block and stale', () => {
  const runtime = createHooksRuntime()
  const h = runtime.React.createElement
  const base = () => {
    const detailVNode = buildDetail(h)
    const state = extractTaskCenterState(buildState(h, { detail: detailVNode }))
    return { detail: extractTaskCenterDetail(buildState(h, { detail: detailVNode }), scenario.targetTask.taskId), state }
  }
  const check = (detailOverrides = {}, stateOverrides = {}) => {
    const detailVNode = buildDetail(h, detailOverrides)
    const state = extractTaskCenterState(buildState(h, { detail: detailVNode, ...stateOverrides }))
    const detail = extractTaskCenterDetail(buildState(h, { detail: detailVNode }), scenario.targetTask.taskId)
    return missingSourceDetailErrors({ detail, state, task: scenario.targetTask, otherSource: scenario.otherSource, revision: 5 })
  }
  assert.ok(check({ sourceId: 'unknown' }).includes('source-id'))
  assert.ok(check({ logical: scenario.targetSource.workspaceLogicalId }).includes('logical'))
  assert.ok(check({ native: scenario.otherSource.nativeWorkspaceId }).includes('native'))
  assert.ok(check({ native: scenario.otherSource.nativeWorkspaceId }).includes('leak-native'))
  assert.ok(check({ directory: scenario.otherSource.directory }).includes('leak-directory'))
  assert.ok(check({ sourceBlocked: 'source blocked: source-archived' }).includes('missing-source-blocked'))
  assert.ok(check({ taskBlocked: 'source blocked: source-archived' }).includes('task-blocked-text'))
  assert.ok(check({ staleAttr: 'true', staleText: 'last observed source facts; stale' }).includes('source-stale-attr'))
  assert.ok(check({}, { status: 'Tasks ledger: ready (rev 6)' }).includes('state-status'))
  assert.ok(check({}, { error: 'Failed to fetch' }).includes('state-error'))
  assert.ok(check({}, { stale: 'Showing last observed ledger; request failed (stale)' }).includes('state-stale'))
  assert.deepEqual(missingSourceDetailErrors({ detail: null, state: base().state, task: scenario.targetTask, otherSource: scenario.otherSource, revision: 5 }), ['detail-missing'])
})

test('hooks runtime preserves state/ref, runs effects once and executes cleanup on unmount', async () => {
  const runtime = createHooksRuntime()
  let setReady = null
  let effectRuns = 0
  let cleanups = 0
  function Component() {
    const [ready, update] = runtime.React.useState(false)
    setReady = update
    const ref = runtime.React.useRef(0)
    ref.current += 1
    const stable = runtime.React.useCallback(() => (ready ? 'ready' : 'wait'), [ready])
    runtime.React.useEffect(() => {
      effectRuns += 1
      return () => { cleanups += 1 }
    }, [])
    return runtime.React.createElement('div', { 'data-test': String(ready) }, stable())
  }
  runtime.setComponent(Component)
  let root = runtime.render()
  assert.equal(textOf(root), 'wait')
  await runtime.settle()
  assert.equal(textOf(root), 'wait')
  setReady(true)
  await runtime.settle()
  root = runtime.getRoot()
  assert.equal(textOf(root), 'ready')
  assert.equal(effectRuns, 1)
  runtime.unmount()
  assert.equal(cleanups, 1)
  assert.equal(runtime.stats.effectRuns, 1)
  assert.equal(runtime.stats.effectCleanups, 1)
  assert.equal(runtime.stats.unmounts, 1)
  assert.equal(runtime.pending(), false)
})

test('waitFor fails when async state never settles', async () => {
  const runtime = createHooksRuntime()
  function Component() {
    runtime.React.useState(false)
    return runtime.React.createElement('div', {}, 'static')
  }
  runtime.setComponent(Component)
  runtime.render()
  await assert.rejects(runtime.waitFor(() => false, 'never', 3), /condition did not settle: never/)
})

test('remote test double records the exact allowed calls and rejects unknown methods', async () => {
  const remote = createRemoteProxy({ snapshot: { rootId: 'root', revision: 0, nodes: [] }, status: { conversationsCreatable: true }, ledgers: [scenario.baseline, scenario.missing] })
  assert.deepEqual(await remote.outer.workspaceOrganizer.snapshot(), { ok: true, value: { rootId: 'root', revision: 0, nodes: [] } })
  await remote.outer.workspaceOrganizer.status()
  await remote.outer.workspaceOrganizer.taskLedger()
  await remote.outer.workspaceOrganizer.taskLedger()
  assert.deepEqual(remote.calls.map((entry) => entry.method), ['snapshot', 'status', 'taskLedger', 'taskLedger'])
  assert.throws(() => remote.outer.workspaceOrganizer.reconcileTasks, /illegal remote method/)
  assert.deepEqual(remote.illegal, [{ method: 'reconcileTasks' }])
  assert.equal(remote.remaining(), 0)
  assert.ok(scenarioCallErrors([{ method: 'snapshot' }], ['snapshot', 'taskLedger']).includes('order:snapshot'))
  assert.ok(scenarioCallErrors([{ method: 'snapshot' }], ['snapshot'], [{ method: 'follow' }]).includes('illegal:follow'))
})

test('input freeze/hash stability detects mutation and frozen inputs', () => {
  const before = digestValue(scenario.baseline)
  assert.equal(scenario.baseline.revision, 5)
  assert.throws(() => { scenario.baseline.revision = 6 }, TypeError)
  assert.equal(digestValue(scenario.baseline), before)
  assert.deepEqual(inputStabilityErrors({ before, after: before, frozen: Object.isFrozen(scenario.baseline) }), [])
  assert.ok(inputStabilityErrors({ before, after: before, frozen: false }).includes('input-not-frozen'))
  assert.ok(inputStabilityErrors({ before, after: 'changed', frozen: true }).includes('input-sha-changed'))
})

test('missing-Source oracle preserves absent task blockedReason and rejects fabricated task block', () => {
  const runtime = createHooksRuntime()
  const h = runtime.React.createElement
  const noBlockTask = { ...scenario.targetTask, blockedReason: undefined }
  const detailVNode = buildDetail(h, { taskBlocked: null })
  const state = extractTaskCenterState(buildState(h, { detail: detailVNode }))
  const detail = extractTaskCenterDetail(buildState(h, { detail: detailVNode }), noBlockTask.taskId)
  assert.deepEqual(missingSourceDetailErrors({ detail, state, task: noBlockTask, otherSource: scenario.otherSource, revision: 5 }), [])
  const fabricated = extractTaskCenterDetail(buildState(h, { detail: buildDetail(h) }), noBlockTask.taskId)
  const fabricatedState = extractTaskCenterState(buildState(h, { detail: buildDetail(h) }))
  assert.ok(missingSourceDetailErrors({ detail: fabricated, state: fabricatedState, task: noBlockTask, otherSource: scenario.otherSource, revision: 5 }).includes('task-blocked-attr'))
})

test('driver boundary detects a component that never invokes taskLedger', async () => {
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot: scenario.snapshot, status: scenario.status, ledgers: [scenario.baseline, scenario.missing] })
  function Component() {
    const [, update] = runtime.React.useState(false)
    return runtime.React.createElement('button', { 'data-wo-task-center': 'true', onClick: () => update(true) }, 'All Tasks')
  }
  runtime.setComponent(Component)
  let root = runtime.render()
  await runtime.settle()
  root = runtime.getRoot()
  const button = root
  button.props.onClick()
  await runtime.settle()
  assert.deepEqual(remote.calls.map((entry) => entry.method), [])
  const errors = scenarioCallErrors(remote.calls, ['snapshot', 'status', 'taskLedger', 'taskLedger'])
  assert.ok(errors.some((error) => error.startsWith('order:')))
  assert.equal(extractTaskCenterDetail(runtime.getRoot(), scenario.targetTask.taskId), null)
  runtime.unmount()
})

test('real client module mounts through the test slots and registers the sidebar component', async () => {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  const runtime = createHooksRuntime()
  const remote = createRemoteProxy({ snapshot: scenario.snapshot, status: scenario.status, ledgers: [] })
  const mounted = await mountClientApplication({ source, react: runtime.React, zod: createZodTestDouble(), remote })
  assert.equal(typeof mounted.component, 'function')
  assert.equal(mounted.registrations.length, 1)
  assert.equal(mounted.registrations[0].options.name, 'sidebar.workspaces')
  assert.equal(mounted.contribution.package, 'workspace-organizer-dsh')
  assert.ok(mounted.contribution.descriptors.length >= 1)
  await mounted.cleanup()
  assert.equal(mounted.lifecycle.slotDisposed, 1)
  assert.equal(mounted.lifecycle.handleDisposed, 1)
  assert.equal(mounted.lifecycle.mountDisposed, 1)
  assert.deepEqual(remote.mountCalls.map((entry) => entry.step), ['mount', 'unmount'])
})
