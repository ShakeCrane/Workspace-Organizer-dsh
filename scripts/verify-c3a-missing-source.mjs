#!/usr/bin/env node
/**
 * Test-only synthetic A component defense runner.
 *
 * Evidence kind is always `synthetic-component`: this executes the real
 * read-only client/client.js component and its async hooks in a Node VM with
 * labeled React/zod/Remote test doubles. It does not start DSH, a profile,
 * a Host, Chrome, DOM, transport or a real pointer.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLIENT_SHA256,
  EVIDENCE_KIND,
  completeDetailErrors,
  createHooksRuntime,
  createRemoteProxy,
  createSyntheticScenario,
  createZodTestDouble,
  digestValue,
  extractTaskCenterDetail,
  extractTaskCenterState,
  detailSnapshot,
  inputStabilityErrors,
  missingSourceDetailErrors,
  mountClientApplication,
  requireOne,
  scenarioCallErrors,
  sha256
} from './lib/c3a-synthetic-component-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(root, 'client', 'client.js')
const argv = process.argv.slice(2)
const valueOf = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const outArg = valueOf('--out')
if (typeof outArg !== 'string' || outArg.length === 0) {
  console.error('usage: node scripts/verify-c3a-missing-source.mjs --out test/<run>/missing-source-R')
  process.exit(2)
}
const out = resolve(outArg)

if (argv.includes('--inner')) await runInner()
else await runOuter()

async function runOuter() {
  await mkdir(out, { recursive: true })
  const startedAt = Date.now()
  const child = spawn(process.execPath, [process.argv[1], '--inner', '--out', out], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  })
  let settled = false
  const exited = new Promise((resolveExit) => {
    child.on('error', (error) => {
      if (settled) return
      settled = true
      resolveExit({ code: null, signal: null, error: String(error?.message ?? error), observed: false, timedOut: false })
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      resolveExit({ code, signal, error: null, observed: true, timedOut: false })
    })
  })
  let timer
  const deadline = new Promise((resolveDeadline) => { timer = setTimeout(() => resolveDeadline(null), 120_000) })
  let outcome = await Promise.race([exited, deadline])
  clearTimeout(timer)
  let timedOut = false
  if (outcome === null) {
    timedOut = true
    child.kill('SIGTERM')
    outcome = await Promise.race([exited, new Promise((resolveGrace) => setTimeout(() => resolveGrace(null), 10_000))])
    if (outcome === null) {
      child.kill('SIGKILL')
      outcome = await Promise.race([exited, new Promise((resolveKill) => setTimeout(() => resolveKill({ code: null, signal: null, error: null, observed: false, timedOut: true }), 5_000))])
    }
  }
  const inner = {
    ...outcome,
    timedOut: timedOut || outcome?.timedOut === true,
    pid: child.pid,
    startedAt,
    finishedAt: Date.now(),
    durationMs: Date.now() - startedAt
  }
  let evidence = null
  try { evidence = JSON.parse(await readFile(join(out, 'evidence.json'), 'utf8')) } catch {}
  const endCheck = evidence?.endCheck ?? null
  const endCheckOk = endCheck?.inputUnchanged === true && endCheck?.noIllegal === true && endCheck?.settled === true && endCheck?.cleanupUnmounts === true
  const passed = inner.observed === true && inner.code === 0 && inner.signal === null && inner.timedOut === false && evidence?.passed === true && endCheckOk
  const record = {
    evidenceKind: EVIDENCE_KIND,
    synthetic: true,
    inner,
    innerPassed: evidence?.passed ?? null,
    endCheck,
    endCheckOk,
    passed,
    host: 'NOT_STARTED',
    chrome: 'NOT_STARTED',
    dshProfile: 'NOT_CREATED',
    at: new Date().toISOString()
  }
  await writeFile(join(out, 'runner-actual-exit.json'), JSON.stringify(record, null, 2), 'utf8')
  process.exit(passed ? 0 : 1)
}

async function runInner() {
  await mkdir(out, { recursive: true })
  const source = await readFile(clientPath, 'utf8')
  const clientSha256 = sha256(source)
  const scenario = createSyntheticScenario()
  const baseline = scenario.baseline
  const missing = scenario.missing
  const baselineSha = digestValue(baseline)
  const missingSha = digestValue(missing)
  const expected = {
    evidenceKind: EVIDENCE_KIND,
    synthetic: true,
    scope: { realDshAB: 'NOT_RUN', dshProfile: 'NOT_CREATED', host: 'NOT_STARTED', chrome: 'NOT_STARTED', dom: 'NOT_RUN', hitTest: 'NOT_RUN', transport: 'NOT_RUN' },
    client: { path: 'client/client.js', sha256: clientSha256, expectedSha256: CLIENT_SHA256, matches: clientSha256 === CLIENT_SHA256 },
    revision: baseline.revision,
    task: scenario.targetTask,
    targetSource: scenario.targetSource,
    otherSource: scenario.otherSource,
    inputs: { baseline: { sha256: baselineSha }, missing: { sha256: missingSha } },
    expectedDetail: scenario.expected
  }
  await writeFile(join(out, 'expected.json'), JSON.stringify(expected, null, 2), 'utf8')
  await writeFile(join(out, 'baseline-input.json'), JSON.stringify({ synthetic: true, kind: 'synthetic-complete-ledger', ledger: baseline }, null, 2), 'utf8')
  await writeFile(join(out, 'missing-source-input.json'), JSON.stringify({ synthetic: true, kind: 'synthetic-missing-source-ledger', ledger: missing }, null, 2), 'utf8')

  const evidence = {
    evidenceKind: EVIDENCE_KIND,
    synthetic: true,
    scope: expected.scope,
    client: expected.client,
    driver: { mode: 'node-vm+real-client+hooks-test-double', react: 'test-double', zod: 'test-double', remote: 'test-double', realDsh: false },
    expected,
    inputs: {
      baseline: { before: baselineSha, after: null, unchanged: false, frozen: Object.isFrozen(baseline) },
      missing: { before: missingSha, after: null, unchanged: false, frozen: Object.isFrozen(missing) }
    },
    calls: [],
    mountCalls: [],
    illegal: [],
    order: [],
    events: [],
    registrations: null,
    contribution: null,
    renders: null,
    hooks: null,
    baseline: null,
    missing: null,
    cleanup: null,
    oracle: null,
    passed: false,
    blocker: null
  }

  try {
    if (clientSha256 !== CLIENT_SHA256) throw new Error(`client SHA mismatch: ${clientSha256}`)
    const hooks = createHooksRuntime()
    const zod = createZodTestDouble()
    const remote = createRemoteProxy({ snapshot: scenario.snapshot, status: scenario.status, ledgers: [baseline, missing] })
    const mounted = await mountClientApplication({ source, react: hooks.React, zod, remote })
    evidence.registrations = mounted.registrations
    evidence.contribution = { package: mounted.contribution?.package ?? null, descriptors: Array.isArray(mounted.contribution?.descriptors) ? mounted.contribution.descriptors.length : 0 }
    hooks.setComponent(mounted.component)

    let root = hooks.render()
    await hooks.settle()
    const allTasks = requireOne(root, (node) => node.props?.['data-wo-task-center'] === 'true', 'All Tasks')
    evidence.events.push({ seq: 1, event: 'all-tasks' })
    allTasks.props.onClick()
    await hooks.waitFor((tree) => {
      const state = extractTaskCenterState(tree)
      return state.status?.includes('ready') === true && state.rows.length === 4
    }, 'baseline rows')
    root = hooks.getRoot()
    const row = requireOne(root, (node) => node.props?.['data-wo-task-center-row'] === scenario.targetTask.taskId, 'target row')
    evidence.events.push({ seq: 2, event: 'row:' + scenario.targetTask.taskId })
    row.props.onClick()
    await hooks.waitFor((tree) => extractTaskCenterDetail(tree, scenario.targetTask.taskId) !== null, 'baseline detail')
    root = hooks.getRoot()
    const baselineDetail = extractTaskCenterDetail(root, scenario.targetTask.taskId)
    const baselineState = extractTaskCenterState(root)
    const baselineVNode = detailSnapshot(root, scenario.targetTask.taskId)

    const reload = requireOne(root, (node) => node.props?.['data-wo-task-center-refresh'] === 'true', 'Reload')
    evidence.events.push({ seq: 3, event: 'reload' })
    reload.props.onClick()
    await hooks.waitFor((tree) => {
      const detail = extractTaskCenterDetail(tree, scenario.targetTask.taskId)
      return detail !== null && detail.verification === 'unverified'
    }, 'missing-source detail')
    root = hooks.getRoot()
    const missingDetail = extractTaskCenterDetail(root, scenario.targetTask.taskId)
    const missingState = extractTaskCenterState(root)
    const missingVNode = detailSnapshot(root, scenario.targetTask.taskId)
    await hooks.settle()
    const settled = hooks.pending() === false

    await mounted.cleanup()
    hooks.unmount()

    const baselineAfter = digestValue(baseline)
    const missingAfter = digestValue(missing)
    const completeErrors = completeDetailErrors({ detail: baselineDetail, state: baselineState, task: scenario.targetTask, source: scenario.targetSource, revision: baseline.revision })
    const missingErrors = missingSourceDetailErrors({ detail: missingDetail, state: missingState, task: scenario.targetTask, otherSource: scenario.otherSource, revision: missing.revision })
    const callErrors = scenarioCallErrors(remote.calls, ['snapshot', 'status', 'taskLedger', 'taskLedger'], remote.illegal)
    const stability = [
      ...inputStabilityErrors({ before: baselineSha, after: baselineAfter, frozen: Object.isFrozen(baseline) }).map((error) => 'baseline:' + error),
      ...inputStabilityErrors({ before: missingSha, after: missingAfter, frozen: Object.isFrozen(missing) }).map((error) => 'missing:' + error)
    ]
    const extraErrors = []
    if (settled !== true) extraErrors.push('async-not-settled')
    if (remote.remaining() !== 0) extraErrors.push('unused-taskLedger-answers')
    if (remote.illegal.length > 0) extraErrors.push('illegal-remote')
    if (remote.calls.length !== 4) extraErrors.push('call-count')
    if (mounted.registrations.length !== 1 || mounted.registrations[0]?.options?.name !== 'sidebar.workspaces') extraErrors.push('registration')
    if (mounted.contribution?.package !== 'workspace-organizer-dsh' || !Array.isArray(mounted.contribution?.descriptors) || mounted.contribution.descriptors.length < 1) extraErrors.push('contribution')
    if (hooks.stats.renders < 3) extraErrors.push('renders')
    if (hooks.stats.effectRuns < 1) extraErrors.push('effects')
    if (hooks.stats.unmounts !== 1) extraErrors.push('cleanup-unmount')
    if (mounted.lifecycle.slotDisposed !== 1 || mounted.lifecycle.handleDisposed !== 1 || mounted.lifecycle.mountDisposed !== 1) extraErrors.push('cleanup-lifecycle')
    if (evidence.events.length !== 3) extraErrors.push('events')
    if (baselineState.status !== 'Tasks ledger: ready (rev 5)' || missingState.status !== 'Tasks ledger: ready (rev 5)') extraErrors.push('status')
    if (baselineState.error !== null || baselineState.stale !== null || missingState.error !== null || missingState.stale !== null) extraErrors.push('state-normal')
    if (baselineState.rows.length !== 4 || missingState.rows.length !== 4) extraErrors.push('rows')
    if (baselineDetail?.detailId !== scenario.targetTask.taskId || missingDetail?.detailId !== scenario.targetTask.taskId) extraErrors.push('selected-task')

    evidence.inputs.baseline.after = baselineAfter
    evidence.inputs.baseline.unchanged = baselineAfter === baselineSha
    evidence.inputs.missing.after = missingAfter
    evidence.inputs.missing.unchanged = missingAfter === missingSha
    evidence.calls = remote.calls
    evidence.mountCalls = remote.mountCalls
    evidence.illegal = remote.illegal
    evidence.order = remote.calls.map((entry) => entry.method)
    evidence.renders = hooks.stats.renders
    evidence.hooks = { ...hooks.stats }
    evidence.baseline = { state: baselineState, detail: baselineDetail, vnode: baselineVNode }
    evidence.missing = { state: missingState, detail: missingDetail, vnode: missingVNode }
    evidence.cleanup = { ...mounted.lifecycle, effectCleanups: hooks.stats.effectCleanups, unmounts: hooks.stats.unmounts, unmountCalled: true }
    evidence.oracle = { completeErrors, missingErrors, callErrors, stability, extraErrors, settled }
    evidence.passed = [completeErrors, missingErrors, callErrors, stability, extraErrors].every((list) => list.length === 0)
    evidence.endCheck = {
      inputUnchanged: evidence.inputs.baseline.unchanged === true && evidence.inputs.missing.unchanged === true,
      noIllegal: evidence.illegal.length === 0,
      settled: evidence.oracle.settled === true,
      cleanupUnmounts: evidence.cleanup.unmounts === 1
    }
  } catch (error) {
    evidence.blocker = String(error?.stack ?? error)
    evidence.passed = false
  }

  await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  console.log(JSON.stringify({ evidenceKind: EVIDENCE_KIND, out, passed: evidence.passed, blocker: evidence.blocker, oracle: evidence.oracle }))
  process.exit(evidence.passed ? 0 : 1)
}
