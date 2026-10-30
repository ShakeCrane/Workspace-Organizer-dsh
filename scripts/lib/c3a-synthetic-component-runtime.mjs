/**
 * Test-only synthetic component runtime for the C3a missing-SourceRecord
 * defense slice. This file intentionally contains no product code:
 * - `createHooksRuntime` is a minimal React hooks/VNode test double.
 * - `loadClientModule` executes the real, read-only client/client.js in a VM.
 * - `mountClientApplication` invokes the real `exports.apply` with test slots.
 * - `createRemoteProxy` is the labeled remote test double; any method outside
 *   snapshot/status/taskLedger fails closed.
 * - Oracle helpers inspect actual VNode props/text, never the expected dict.
 */
import { createHash } from 'node:crypto'
import vm from 'node:vm'

export const CLIENT_SHA256 = '3b43df8ead294a28c20d35efa34f7b59144c6bdc0dfb13c8ee3966cc9d57a494'
export const EVIDENCE_KIND = 'synthetic-component'

export const SYNTHETIC_IDS = Object.freeze({
  root: 'root',
  conversationTarget: 'cnv_synthetic_u1',
  conversationOther: 'cnv_synthetic_c1',
  workspaceTarget: 'wsp_synthetic_target',
  workspaceOther: 'wsp_synthetic_other',
  nativeTarget: 'nws_synthetic_target',
  nativeOther: 'nws_synthetic_other',
  sessionTarget: 'synthetic-s2',
  sessionOther: 'synthetic-s1',
  taskT1: 'tsk_synthetic_t1',
  taskT2: 'tsk_synthetic_t2',
  taskT3: 'tsk_synthetic_t3',
  taskU1: 'tsk_synthetic_u1',
  childT1: 'wo-t1',
  childT2: 'wo-t2',
  childT3: 'wo-t3',
  childU1: 'wo-u1'
})

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map((entry) => canonicalJson(entry)).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function digestValue(value) {
  return sha256(canonicalJson(value))
}

export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

/** Build the immutable baseline and the A input (target SourceRecord removed). */
export function createSyntheticScenario() {
  const otherSource = {
    conversationId: SYNTHETIC_IDS.conversationOther,
    sessionId: SYNTHETIC_IDS.sessionOther,
    workspaceLogicalId: SYNTHETIC_IDS.workspaceOther,
    nativeWorkspaceId: SYNTHETIC_IDS.nativeOther,
    directory: 'D:\\synthetic\\other',
    verifiedAt: '2026-10-24T00:00:01.000Z',
    verificationState: 'verified',
    hostVersion: '0.2.1-rc.2'
  }
  const targetSource = {
    conversationId: SYNTHETIC_IDS.conversationTarget,
    sessionId: SYNTHETIC_IDS.sessionTarget,
    workspaceLogicalId: SYNTHETIC_IDS.workspaceTarget,
    nativeWorkspaceId: SYNTHETIC_IDS.nativeTarget,
    directory: 'D:\\synthetic\\target',
    verifiedAt: '2026-10-24T00:00:02.000Z',
    verificationState: 'blocked',
    blockedReason: 'source-archived',
    hostVersion: '0.2.1-rc.2'
  }
  const task = (taskId, childSessionId, sourceConversationId, parent, depth, label, extra = {}) => ({
    taskId,
    label,
    childSessionId,
    sourceConversationId,
    parent,
    depth,
    mode: 'one-shot',
    executionState: 'UNKNOWN',
    executionEligibility: depth === 1 && childSessionId === SYNTHETIC_IDS.childU1 ? 'blocked' : 'eligible',
    observedAt: `2026-10-24T00:00:0${String(depth + 3)}.000Z`,
    ...extra
  })
  const tasks = [
    task(SYNTHETIC_IDS.taskT1, SYNTHETIC_IDS.childT1, SYNTHETIC_IDS.conversationOther, { kind: 'conversation', conversationId: SYNTHETIC_IDS.conversationOther }, 1, 'T1'),
    task(SYNTHETIC_IDS.taskT2, SYNTHETIC_IDS.childT2, SYNTHETIC_IDS.conversationOther, { kind: 'task', taskId: SYNTHETIC_IDS.taskT1 }, 2, 'T2'),
    task(SYNTHETIC_IDS.taskT3, SYNTHETIC_IDS.childT3, SYNTHETIC_IDS.conversationOther, { kind: 'task', taskId: SYNTHETIC_IDS.taskT1 }, 2, 'T3'),
    task(SYNTHETIC_IDS.taskU1, SYNTHETIC_IDS.childU1, SYNTHETIC_IDS.conversationTarget, { kind: 'conversation', conversationId: SYNTHETIC_IDS.conversationTarget }, 1, 'U1', { blockedReason: 'source/source-archived' })
  ]
  const targetTask = tasks.find((entry) => entry.taskId === SYNTHETIC_IDS.taskU1)
  const baseline = {
    revision: 5,
    updatedAt: '2026-10-24T00:00:00.000Z',
    tasks,
    sources: [otherSource, targetSource]
  }
  const missing = {
    revision: 5,
    updatedAt: '2026-10-24T00:00:00.000Z',
    tasks,
    sources: [otherSource]
  }
  const snapshot = {
    rootId: SYNTHETIC_IDS.root,
    revision: 5,
    nodes: [
      { id: SYNTHETIC_IDS.root, kind: 'project', title: 'Root', parentId: null },
      { id: SYNTHETIC_IDS.conversationOther, kind: 'conversation', title: 'C1', parentId: SYNTHETIC_IDS.workspaceOther, sessionId: SYNTHETIC_IDS.sessionOther },
      { id: SYNTHETIC_IDS.conversationTarget, kind: 'conversation', title: 'C2', parentId: SYNTHETIC_IDS.workspaceTarget, sessionId: SYNTHETIC_IDS.sessionTarget }
    ]
  }
  const status = { conversationsCreatable: true }
  const expected = {
    revision: 5,
    baseline: {
      sourceId: targetSource.conversationId,
      sourceText: `source C: ${targetSource.conversationId}`,
      logical: targetSource.workspaceLogicalId,
      native: targetSource.nativeWorkspaceId,
      directory: targetSource.directory,
      verifiedAt: targetSource.verifiedAt,
      verification: targetSource.verificationState,
      sourceBlocked: `source blocked: ${targetSource.blockedReason}`,
      taskBlocked: `blocked: ${targetTask.blockedReason}`,
      resourceSession: `resource session: ${targetSource.sessionId}`,
      hostVersion: `hostVersion: ${targetSource.hostVersion}`,
      parent: `parent: conversation:${targetTask.parent.conversationId}`,
      child: `childSessionId: ${targetTask.childSessionId}`,
      depth: `depth/mode: ${targetTask.depth}/${targetTask.mode}`,
      execution: `execution: ${targetTask.executionState} (${targetTask.executionEligibility})`,
      sourceStaleAttr: 'false',
      sourceStale: 'last observed source facts only',
      status: `Tasks ledger: ready (rev 5)`
    },
    missing: {
      sourceId: targetSource.conversationId,
      sourceText: `source C: ${targetSource.conversationId}`,
      logical: 'unknown',
      native: 'unknown',
      directory: 'unknown',
      verifiedAt: 'unknown',
      verification: 'unverified',
      sourceBlocked: null,
      taskBlocked: `blocked: ${targetTask.blockedReason}`,
      resourceSession: 'resource session: unknown',
      hostVersion: 'hostVersion: unknown',
      parent: `parent: conversation:${targetTask.parent.conversationId}`,
      child: `childSessionId: ${targetTask.childSessionId}`,
      depth: `depth/mode: ${targetTask.depth}/${targetTask.mode}`,
      execution: `execution: ${targetTask.executionState} (${targetTask.executionEligibility})`,
      sourceStaleAttr: 'false',
      sourceStale: 'last observed source facts only',
      status: `Tasks ledger: ready (rev 5)`
    }
  }
  deepFreeze(baseline)
  deepFreeze(missing)
  deepFreeze(snapshot)
  deepFreeze(status)
  deepFreeze(expected)
  return { baseline, missing, targetTask, targetSource, otherSource, snapshot, status, expected }
}

/** Minimal React hooks/VNode test double. Every hook used by the real client is implemented. */
export function createHooksRuntime() {
  let component = null
  let currentRoot = null
  let slots = []
  let pendingEffects = []
  const cleanups = new Map()
  let index = 0
  let renderRequested = false
  let mounted = false
  const stats = { renders: 0, effectRuns: 0, effectCleanups: 0, unmounts: 0, useState: 0, useRef: 0, useCallback: 0, useEffect: 0 }

  const depsEqual = (left, right) => {
    if (left === undefined || right === undefined) return false
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, position) => Object.is(value, right[position]))
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = []
      const visit = (value) => {
        if (Array.isArray(value)) value.forEach(visit)
        else if (value !== null && value !== undefined && typeof value !== 'boolean') flat.push(value)
      }
      children.forEach(visit)
      return { $$vnode: true, type, props: { ...(props ?? {}), children: flat } }
    },
    useState(initial) {
      stats.useState += 1
      const position = index
      index += 1
      if (!(position in slots)) slots[position] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[position]
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        renderRequested = true
      }
      return [slot.value, setState]
    },
    useRef(initial) {
      stats.useRef += 1
      const position = index
      index += 1
      if (!(position in slots)) slots[position] = { kind: 'ref', value: { current: initial } }
      return slots[position].value
    },
    useCallback(fn, deps) {
      stats.useCallback += 1
      const position = index
      index += 1
      const previous = slots[position]
      if (previous !== undefined && previous.kind === 'callback' && depsEqual(previous.deps, deps)) return previous.fn
      slots[position] = { kind: 'callback', fn, deps }
      return fn
    },
    useEffect(fn, deps) {
      stats.useEffect += 1
      const position = index
      index += 1
      const previous = slots[position]
      const changed = previous === undefined || previous.kind !== 'effect' || depsEqual(previous.deps, deps) !== true
      slots[position] = { kind: 'effect', deps }
      if (changed) pendingEffects.push({ position, fn })
    }
  }

  function render() {
    if (component === null) throw new Error('component is not mounted')
    index = 0
    const effects = []
    pendingEffects = effects
    renderRequested = false
    const root = component({})
    currentRoot = root
    stats.renders += 1
    pendingEffects = []
    for (const effect of effects) {
      const previousCleanup = cleanups.get(effect.position)
      if (typeof previousCleanup === 'function') {
        previousCleanup()
        stats.effectCleanups += 1
        cleanups.delete(effect.position)
      }
      const cleanup = effect.fn()
      stats.effectRuns += 1
      if (typeof cleanup === 'function') cleanups.set(effect.position, cleanup)
    }
    return root
  }

  async function settle(maxTicks = 100) {
    let idle = 0
    for (let tick = 0; tick < maxTicks; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      if (renderRequested) {
        render()
        idle = 0
        continue
      }
      await new Promise((resolve) => setImmediate(resolve))
      if (renderRequested) {
        render()
        idle = 0
        continue
      }
      idle += 1
      if (idle >= 2) return currentRoot
    }
    throw new Error(`component did not settle after ${String(maxTicks)} ticks`)
  }

  async function waitFor(predicate, label, maxTicks = 100) {
    for (let tick = 0; tick < maxTicks; tick += 1) {
      const value = predicate(currentRoot)
      if (value) return value
      await new Promise((resolve) => setImmediate(resolve))
      if (renderRequested) render()
    }
    throw new Error(`condition did not settle: ${label}`)
  }

  function unmount() {
    for (const cleanup of cleanups.values()) {
      try { cleanup() } catch {}
      stats.effectCleanups += 1
    }
    cleanups.clear()
    mounted = false
    stats.unmounts += 1
  }

  return {
    React,
    setComponent(value) { component = value; mounted = true },
    render,
    settle,
    waitFor,
    unmount,
    getRoot() { return currentRoot },
    isMounted() { return mounted },
    pending() { return renderRequested },
    stats
  }
}

export function createZodTestDouble() {
  const schema = (kind, extra = {}) => ({ kind, ...extra, safeParse: (value) => ({ success: true, data: value }) })
  return {
    any: () => schema('any'),
    string: () => schema('string'),
    object: (properties) => schema('object', { properties })
  }
}

/** Execute the real read-only client module in a VM and capture its loader factory. */
export function loadClientModule({ source, react, zod, document: injectedDocument, setTimeout: injectedSetTimeout, clearTimeout: injectedClearTimeout }) {
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { captured = definition } } },
    console,
    setTimeout: injectedSetTimeout ?? setTimeout,
    clearTimeout: injectedClearTimeout ?? clearTimeout,
    ...(injectedDocument !== undefined ? { document: injectedDocument } : {})
  }
  vm.runInNewContext(source, sandbox, { filename: 'client/client.js' })
  if (captured === null || typeof captured.factory !== 'function') throw new Error('client module loader was not captured')
  const exportsObject = captured.factory((name) => {
    if (name === 'react') return react
    if (name === 'zod') return zod
    throw new Error(`unexpected client require: ${name}`)
  })
  if (exportsObject === null || typeof exportsObject !== 'object') throw new Error('client module factory did not return exports')
  return { definition: captured, exports: exportsObject }
}

/** Labeled remote test double; unknown namespace methods fail immediately. */
export function createRemoteProxy({ snapshot, status, ledgers }) {
  const calls = []
  const mountCalls = []
  const illegal = []
  const answers = [...ledgers]
  const allowed = {
    snapshot: async () => {
      calls.push({ method: 'snapshot', args: [] })
      if (typeof snapshot === 'function') return snapshot()
      return { ok: true, value: snapshot }
    },
    status: async () => {
      calls.push({ method: 'status', args: [] })
      if (typeof status === 'function') return status()
      return { ok: true, value: status }
    },
    taskLedger: async () => {
      calls.push({ method: 'taskLedger', args: [] })
      if (answers.length === 0) throw new Error('no synthetic taskLedger answer remains')
      return { ok: true, value: answers.shift() }
    }
  }
  const namespace = new Proxy({}, {
    get(_target, property) {
      if (typeof property === 'symbol') return undefined
      if (property === 'then') return undefined
      if (!Object.prototype.hasOwnProperty.call(allowed, property)) {
        illegal.push({ method: String(property) })
        throw new Error(`illegal remote method: ${String(property)}`)
      }
      return allowed[property]
    }
  })
  const outer = {
    workspaceOrganizer: namespace,
    $mount: async (contribution) => {
      mountCalls.push({ step: 'mount', descriptors: Array.isArray(contribution?.descriptors) ? contribution.descriptors.length : null })
      return async () => { mountCalls.push({ step: 'unmount' }) }
    }
  }
  return { outer, calls, mountCalls, illegal, allowed, remaining: () => answers.length }
}

/** Invoke the real exports.apply with test slots and capture OrganizerBrowser. */
export async function mountClientApplication({ source, react, zod, remote, document, setTimeout, clearTimeout }) {
  const loaded = loadClientModule({ source, react, zod, document, setTimeout, clearTimeout })
  const registrations = []
  let component = null
  const lifecycle = { slotDisposed: 0, handleDisposed: 0, mountDisposed: 0 }
  const slots = {
    inject(name, fn) {
      if (name !== 'sidebar.workspaces') throw new Error(`unexpected slot inject: ${name}`)
      return fn()
    },
    register(options, value) {
      component = value
      registrations.push({ options })
      return async () => { lifecycle.slotDisposed += 1 }
    }
  }
  const child = {
    get(name) {
      if (name === 'remote') return remote.outer
      if (name === 'uiWorkspace') return undefined
      throw new Error(`unexpected service get: ${name}`)
    },
    slots
  }
  const ctx = {
    remote: remote.outer,
    get(name) { return child.get(name) },
    inject(_names, callback) {
      callback(child)
      return { dispose: async () => { lifecycle.handleDisposed += 1 } }
    },
    slots
  }
  const cleanup = await loaded.exports.apply(ctx)
  if (component === null) throw new Error('OrganizerBrowser was not registered')
  return {
    component,
    registrations,
    contribution: loaded.exports.contribution,
    lifecycle,
    cleanup: async () => {
      await cleanup()
      lifecycle.mountDisposed += 1
    }
  }
}

export function isVNode(value) {
  return value !== null && typeof value === 'object' && value.$$vnode === true
}

export function walkVNodes(root, visit) {
  if (Array.isArray(root)) {
    root.forEach((entry) => walkVNodes(entry, visit))
    return
  }
  if (!isVNode(root)) return
  visit(root)
  for (const child of root.props.children ?? []) walkVNodes(child, visit)
}

export function findAll(root, predicate) {
  const found = []
  walkVNodes(root, (node) => { if (predicate(node)) found.push(node) })
  return found
}

export function findOne(root, predicate) {
  return findAll(root, predicate)[0] ?? null
}

export function textOf(value) {
  if (Array.isArray(value)) return value.map((entry) => textOf(entry)).join('')
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (isVNode(value)) return textOf(value.props.children)
  return ''
}

export function requireOne(root, predicate, label) {
  const found = findOne(root, predicate)
  if (found === null) throw new Error(`VNode not found: ${label}`)
  return found
}

function fieldOf(detail, name) {
  const node = findOne(detail, (entry) => entry.props?.[name] !== undefined)
  return node === null ? { attr: null, text: 'unknown' } : { attr: node.props[name], text: textOf(node) }
}

function ownText(node) {
  return (node.props.children ?? []).filter((value) => typeof value === 'string' || typeof value === 'number').map((value) => String(value)).join('')
}

function lineOf(detail, prefix) {
  const node = findOne(detail, (entry) => ownText(entry).startsWith(prefix))
  return node === null ? 'unknown' : ownText(node)
}

export function extractTaskCenterDetail(root, taskId) {
  const detail = findOne(root, (node) => node.props?.['data-wo-task-center-detail'] === taskId)
  if (detail === null) return null
  const sourceId = fieldOf(detail, 'data-wo-source-id')
  const logical = fieldOf(detail, 'data-wo-source-logical')
  const native = fieldOf(detail, 'data-wo-source-native')
  const directory = fieldOf(detail, 'data-wo-source-directory')
  const verifiedAt = fieldOf(detail, 'data-wo-source-verified-at')
  const verification = fieldOf(detail, 'data-wo-source-verification')
  const sourceBlocked = fieldOf(detail, 'data-wo-source-blocked')
  const taskBlocked = fieldOf(detail, 'data-wo-task-center-blocked')
  const sourceStale = fieldOf(detail, 'data-wo-source-stale')
  return {
    detailId: detail.props['data-wo-task-center-detail'],
    taskId,
    sourceId: sourceId.attr,
    sourceText: sourceId.text,
    logical: logical.attr,
    logicalText: logical.text,
    native: native.attr,
    nativeText: native.text,
    directory: directory.attr,
    directoryText: directory.text,
    verifiedAt: verifiedAt.attr,
    verifiedAtText: verifiedAt.text,
    verification: verification.attr,
    verificationText: verification.text,
    sourceBlocked: sourceBlocked.attr,
    sourceBlockedText: sourceBlocked.text,
    taskBlocked: taskBlocked.attr,
    taskBlockedText: taskBlocked.text,
    sourceStaleAttr: sourceStale.attr,
    sourceStaleText: sourceStale.text,
    resourceSession: lineOf(detail, 'resource session: '),
    hostVersion: lineOf(detail, 'hostVersion: '),
    execution: textOf(detail)
  }
}

export function extractTaskCenterState(root) {
  const status = findOne(root, (node) => node.props?.['data-wo-task-center-status'] !== undefined)
  const error = findOne(root, (node) => node.props?.['data-wo-task-center-error'] !== undefined)
  const stale = findOne(root, (node) => node.props?.['data-wo-task-center-stale'] !== undefined)
  const detail = findOne(root, (node) => node.props?.['data-wo-task-center-detail'] !== undefined)
  const sourceStale = detail === null ? null : findOne(detail, (node) => node.props?.['data-wo-source-stale'] !== undefined)
  return {
    status: status === null ? null : textOf(status),
    error: error === null ? null : textOf(error),
    stale: stale === null ? null : textOf(stale),
    rows: findAll(root, (node) => node.props?.['data-wo-task-center-row'] !== undefined).map((node) => node.props['data-wo-task-center-row']),
    detailId: detail === null ? null : detail.props['data-wo-task-center-detail'],
    sourceStale: sourceStale === null ? null : textOf(sourceStale),
    sourceStaleAttr: sourceStale === null ? null : sourceStale.props['data-wo-source-stale']
  }
}

export function detailSnapshot(root, taskId) {
  const detail = findOne(root, (node) => node.props?.['data-wo-task-center-detail'] === taskId)
  if (detail === null) return null
  const nodes = []
  walkVNodes(detail, (node) => {
    const attrs = {}
    for (const [key, value] of Object.entries(node.props ?? {})) {
      if (key.startsWith('data-wo-')) attrs[key] = value
    }
    nodes.push({ type: node.type, attrs, text: textOf(node) })
  })
  return { detailId: detail.props['data-wo-task-center-detail'], nodes }
}

function detailFieldErrors(detail, task, expected, errors) {
  if (detail.detailId !== task.taskId) errors.push('detail-id')
  if (detail.sourceId !== task.sourceConversationId) errors.push('source-id')
  if (detail.sourceText !== `source C: ${task.sourceConversationId}`) errors.push('source-text')
  const checks = [
    ['logical', 'logicalText'],
    ['native', 'nativeText'],
    ['directory', 'directoryText'],
    ['verifiedAt', 'verifiedAtText'],
    ['verification', 'verificationText']
  ]
  for (const [valueKey, textKey] of checks) {
    if (detail[valueKey] !== expected[valueKey]) errors.push(valueKey)
    if (detail[textKey] !== expected[textKey]) errors.push(textKey)
  }
  if (detail.resourceSession !== expected.resourceSession) errors.push('resource-session')
  if (detail.hostVersion !== expected.hostVersion) errors.push('host-version')
  if (detail.sourceBlocked !== (expected.sourceBlocked ?? null)) errors.push('source-blocked-attr')
  if (detail.sourceBlockedText !== (expected.sourceBlockedText ?? 'unknown')) errors.push('source-blocked-text')
  if (detail.taskBlocked !== (expected.taskBlocked ?? null)) errors.push('task-blocked-attr')
  if (detail.taskBlockedText !== (expected.taskBlockedText ?? 'unknown')) errors.push('task-blocked-text')
  for (const key of ['parent', 'child', 'depth', 'execution']) {
    if (detail.execution.includes(expected[key]) !== true) errors.push(`execution-${key}`)
  }
  if (detail.sourceStaleAttr !== 'false') errors.push('source-stale-attr')
  if (detail.sourceStaleText !== 'last observed source facts only') errors.push('source-stale-text')
}

export function completeDetailErrors({ detail, state, task, source, revision }) {
  if (detail === null || detail === undefined) return ['detail-missing']
  const errors = []
  const expected = {
    logical: source.workspaceLogicalId,
    logicalText: `logical workspace: ${source.workspaceLogicalId}`,
    native: source.nativeWorkspaceId,
    nativeText: `native workspace: ${source.nativeWorkspaceId}`,
    directory: source.directory,
    directoryText: `observed directory: ${source.directory}`,
    verifiedAt: source.verifiedAt,
    verifiedAtText: `verifiedAt: ${source.verifiedAt}`,
    verification: source.verificationState,
    verificationText: `verification: ${source.verificationState}`,
    sourceBlocked: source.blockedReason === undefined ? null : 'true',
    sourceBlockedText: source.blockedReason === undefined ? 'unknown' : `source blocked: ${String(source.blockedReason)}`,
    taskBlocked: task.blockedReason === undefined ? null : 'true',
    taskBlockedText: task.blockedReason === undefined ? 'unknown' : `blocked: ${String(task.blockedReason)}`,
    resourceSession: `resource session: ${source.sessionId}`,
    hostVersion: `hostVersion: ${source.hostVersion}`,
    parent: `parent: ${task.parent.kind}:${task.parent.kind === 'conversation' ? task.parent.conversationId : task.parent.taskId}`,
    child: `childSessionId: ${task.childSessionId}`,
    depth: `depth/mode: ${task.depth}/${task.mode}`,
    execution: `execution: ${task.executionState} (${task.executionEligibility})`
  }
  detailFieldErrors(detail, task, expected, errors)
  if (state?.status !== `Tasks ledger: ready (rev ${String(revision)})`) errors.push('state-status')
  if (state?.error !== null) errors.push('state-error')
  if (state?.stale !== null) errors.push('state-stale')
  if (state?.detailId !== task.taskId) errors.push('state-detail')
  if (!Array.isArray(state?.rows) || state.rows.length !== 4 || !state.rows.includes(task.taskId)) errors.push('state-rows')
  if (detail.sourceBlocked !== 'true') errors.push('source-blocked-attr')
  if (task.blockedReason !== undefined && detail.taskBlocked !== 'true') errors.push('task-blocked-attr')
  return errors
}

export function missingSourceDetailErrors({ detail, state, task, otherSource, revision }) {
  if (detail === null || detail === undefined) return ['detail-missing']
  const errors = []
  const expected = {
    logical: 'unknown',
    logicalText: 'logical workspace: unknown',
    native: 'unknown',
    nativeText: 'native workspace: unknown',
    directory: 'unknown',
    directoryText: 'observed directory: unknown',
    verifiedAt: 'unknown',
    verifiedAtText: 'verifiedAt: unknown',
    verification: 'unverified',
    verificationText: 'verification: unverified',
    sourceBlocked: null,
    sourceBlockedText: 'unknown',
    taskBlocked: task.blockedReason === undefined ? null : 'true',
    taskBlockedText: task.blockedReason === undefined ? 'unknown' : `blocked: ${String(task.blockedReason)}`,
    resourceSession: 'resource session: unknown',
    hostVersion: 'hostVersion: unknown',
    parent: `parent: ${task.parent.kind}:${task.parent.kind === 'conversation' ? task.parent.conversationId : task.parent.taskId}`,
    child: `childSessionId: ${task.childSessionId}`,
    depth: `depth/mode: ${task.depth}/${task.mode}`,
    execution: `execution: ${task.executionState} (${task.executionEligibility})`
  }
  detailFieldErrors(detail, task, expected, errors)
  if (detail.sourceBlocked !== null) errors.push('missing-source-blocked')
  if (detail.taskBlocked !== (task.blockedReason === undefined ? null : 'true')) errors.push('missing-task-blocked')
  if (state?.status !== `Tasks ledger: ready (rev ${String(revision)})`) errors.push('state-status')
  if (state?.error !== null) errors.push('state-error')
  if (state?.stale !== null) errors.push('state-stale')
  if (state?.detailId !== task.taskId) errors.push('state-detail')
  if (!Array.isArray(state?.rows) || state.rows.length !== 4 || !state.rows.includes(task.taskId)) errors.push('state-rows')
  if (detail.sourceId === otherSource.conversationId) errors.push('leak-conversation')
  if (detail.logical === otherSource.workspaceLogicalId) errors.push('leak-logical')
  if (detail.native === otherSource.nativeWorkspaceId) errors.push('leak-native')
  if (detail.directory === otherSource.directory) errors.push('leak-directory')
  if (detail.verifiedAt === otherSource.verifiedAt) errors.push('leak-verified-at')
  if (detail.resourceSession === `resource session: ${otherSource.sessionId}`) errors.push('leak-resource-session')
  for (const value of [otherSource.directory, otherSource.nativeWorkspaceId, otherSource.workspaceLogicalId, otherSource.verifiedAt]) {
    if (detail.execution.includes(value)) errors.push('leak-execution:' + value)
  }
  return errors
}

export function scenarioCallErrors(calls, expectedOrder, illegal = []) {
  const errors = []
  if (illegal.length > 0) errors.push('illegal:' + illegal.map((entry) => entry.method).join(','))
  const methods = calls.map((entry) => entry.method)
  if (JSON.stringify(methods) !== JSON.stringify(expectedOrder)) errors.push('order:' + methods.join(','))
  return errors
}

export function inputStabilityErrors({ before, after, frozen }) {
  const errors = []
  if (frozen !== true) errors.push('input-not-frozen')
  if (before !== after) errors.push('input-sha-changed')
  return errors
}
