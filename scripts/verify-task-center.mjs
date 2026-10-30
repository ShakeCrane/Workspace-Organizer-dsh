import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCold, checkPrepared, evaluateP2aGate, validateUiEvidence } from './lib/task-center-oracle.mjs'
import { superviseUi } from './lib/task-center-ui-runtime.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const worker = join(here, 'verify-web-organizer.mjs')
const candidate = process.env.P2A_CANDIDATE ?? join(root, 'build', 'c1web-QQVtK6', 'pack', 'workspace-organizer-dsh-0.1.0.tgz')
const expectedSha = '540f9ab99d47255713a4a0d35a11c057e0f731c73df4e1f496f9d8dc936142d3'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const candidateSha = sha256(await readFile(candidate))
if (candidateSha !== expectedSha) throw new Error(`candidate mismatch: ${candidateSha}`)

const R = join(root, 'build', `p2a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
await mkdir(R, { recursive: true })
const dirA = join(R, 'ws-a')
const dirB = join(R, 'ws-b')
await mkdir(dirA, { recursive: true })
await mkdir(dirB, { recursive: true })
await writeFile(join(dirA, 'sentinel.txt'), 'P2A_A', 'utf8')
await writeFile(join(dirB, 'sentinel.txt'), 'P2A_B', 'utf8')
const sentinelA = sha256(await readFile(join(dirA, 'sentinel.txt')))
const sentinelB = sha256(await readFile(join(dirB, 'sentinel.txt')))
await writeFile(join(R, 'fixture-spec.json'), JSON.stringify({
  version: 1,
  expectedCandidate: expectedSha,
  workspaces: { A: 'Native A', B: 'Native B' },
  sources: { C_A: { sessionId: 'wo-c-a', catalog: ['wo-c-t1'] }, C_B: { sessionId: 'wo-c-b', catalog: ['wo-c-u1'] } },
  tasks: { 'wo-c-t1': ['wo-c-t2', 'wo-c-t3'], 'wo-c-u1': [] },
  sentinels: { A: sentinelA, B: sentinelB }
}, null, 2), 'utf8')

const child = spawn(process.execPath, [worker, '--task-center-prepare-worker'], {
  cwd: root,
  env: { ...process.env, WO_R: R, WO_SMOKE_CANDIDATE: candidate },
  windowsHide: true
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
let timedOut = false
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 180_000)
const outcome = await new Promise((resolvePromise) => {
  child.on('error', (error) => resolvePromise({ code: null, signal: null, error: String(error?.message ?? error) }))
  child.on('exit', (code, signal) => resolvePromise({ code, signal, error: null }))
})
clearTimeout(timer)

let prepared = null
let expected = null
let prepareError = null
let hostExit = null
let coldWorkerResult = null
let coldHostExit = null
let uiRuns = null
try {
  if (outcome.code !== 0) throw new Error(`worker exit ${outcome.code}/${outcome.signal}`)
  const envelope = JSON.parse(await readFile(join(R, 'worker-result.json'), 'utf8'))
  prepared = envelope.prepared
  hostExit = envelope.hostExit
  const spec = JSON.parse(await readFile(join(R, 'fixture-spec.json'), 'utf8'))
  const tasks = prepared.ledger.tasks
  const specErrors = checkPrepared(spec, prepared)
  if (specErrors.length !== 0) throw new Error('fixture spec relation check failed: ' + specErrors.join(','))
  expected = {
    candidateSha,
    workspaces: { A: prepared.a, B: prepared.b },
    projects: { A: { id: prepared.pA.id, parentId: prepared.pA.parentId }, B: { id: prepared.pB.id, parentId: prepared.pB.parentId } },
    workspacesOrganizer: { A: { id: prepared.wA.id, parentId: prepared.wA.parentId, directory: prepared.wA.directory }, B: { id: prepared.wB.id, parentId: prepared.wB.parentId, directory: prepared.wB.directory } },
    sources: { A: { id: prepared.cA.id, parentId: prepared.cA.parentId, sessionId: prepared.cA.sessionId }, B: { id: prepared.cB.id, parentId: prepared.cB.parentId, sessionId: prepared.cB.sessionId } },
    tasks: tasks.map((task) => ({ taskId: task.taskId, childSessionId: task.childSessionId, sourceConversationId: task.sourceConversationId, parent: task.parent, depth: task.depth })),
    revision: prepared.ledger.revision,
    ledgerSources: prepared.ledger.sources,
    treeRevision: prepared.snapshot.revision,
    tree: prepared.snapshot.nodes,
    sessionEvents: Object.fromEntries(Object.entries(prepared.sessions).map(([id, session]) => [id, session.events])),
    sentinels: { A: sentinelA, B: sentinelB }
  }
  await writeFile(join(R, 'expected.json'), JSON.stringify(expected, null, 2), { encoding: 'utf8', flag: 'wx' })
  const coldChild = spawn(process.execPath, [worker, '--task-center-cold-worker'], {
    cwd: root,
    env: { ...process.env, WO_R: R },
    windowsHide: true
  })
  let coldStdout = ''
  let coldStderr = ''
  coldChild.stdout.on('data', (chunk) => { coldStdout += chunk.toString() })
  coldChild.stderr.on('data', (chunk) => { coldStderr += chunk.toString() })
  let coldTimedOut = false
  const coldTimer = setTimeout(() => { coldTimedOut = true; coldChild.kill('SIGKILL') }, 180_000)
  const coldOutcome = await new Promise((resolvePromise) => {
    coldChild.on('error', (error) => resolvePromise({ code: null, signal: null, error: String(error?.message ?? error) }))
    coldChild.on('exit', (code, signal) => resolvePromise({ code, signal, error: null }))
  })
  clearTimeout(coldTimer)
  coldWorkerResult = { ...coldOutcome, timedOut: coldTimedOut }
  coldHostExit = JSON.parse(await readFile(join(R, 'cold-result.json'), 'utf8')).hostExit
  const cold = JSON.parse(await readFile(join(R, 'cold.json'), 'utf8'))
  const coldErrors = checkCold(expected, cold)
  if (coldErrors.length !== 0) throw new Error('cold readback failed: ' + coldErrors.join(','))
  const sentinelAfterA = sha256(await readFile(join(dirA, 'sentinel.txt')))
  const sentinelAfterB = sha256(await readFile(join(dirB, 'sentinel.txt')))
  if (sentinelAfterA !== sentinelA || sentinelAfterB !== sentinelB) throw new Error('sentinel changed')
  const uiNormal = await superviseUi(process.execPath, [worker, '--task-center-ui-worker'], {
    cwd: root,
    env: { ...process.env, WO_R: R },
    timeoutMs: 240_000,
    stdoutFile: join(R, 'ui-normal.stdout.txt'),
    stderrFile: join(R, 'ui-normal.stderr.txt')
  })
  const uiResult = JSON.parse(await readFile(join(R, 'ui-result.json'), 'utf8'))
  const uiProcesses = JSON.parse(await readFile(join(R, 'ui-processes.json'), 'utf8'))
  await writeFile(join(R, 'ui-cancel'), '', 'utf8')
  const uiHold = await superviseUi(process.execPath, [worker, '--task-center-ui-worker'], {
    cwd: root,
    env: { ...process.env, WO_R: R, WO_UI_FAULT: 'hold' },
    timeoutMs: 3_000,
    cancelFile: join(R, 'ui-cancel'),
    stdoutFile: join(R, 'ui-hold.stdout.txt'),
    stderrFile: join(R, 'ui-hold.stderr.txt')
  })
  const checkpoints = (await readFile(join(R, 'ui-checkpoints.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const hold = checkpoints.filter((entry) => entry.phase === 'fault-hold').pop()
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  await writeFile(join(R, 'ui-hold-final-cleanup.json'), await readFile(join(R, 'ui-final-cleanup.json'), 'utf8'), 'utf8')
  const sentinel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true })
  let uiPid = null
  let ownership = null
  let pidCleanup = null
  let sentinelAlive = null
  let sentinelError = null
  try {
    uiPid = await superviseUi(process.execPath, [worker, '--task-center-ui-worker'], {
      cwd: root,
      env: { ...process.env, WO_R: R, WO_UI_FAULT: 'pid-mismatch', WO_UI_FOREIGN_PID: String(sentinel.pid) },
      timeoutMs: 15_000,
      stdoutFile: join(R, 'ui-pid.stdout.txt'),
      stderrFile: join(R, 'ui-pid.stderr.txt')
    })
    ownership = JSON.parse(await readFile(join(R, 'ui-ownership.json'), 'utf8'))
    pidCleanup = JSON.parse(await readFile(join(R, 'ui-final-cleanup.json'), 'utf8'))
  } catch (error) {
    sentinelError = String(error?.message ?? error)
  } finally {
    sentinelAlive = alive(sentinel.pid)
    sentinel.kill('SIGKILL')
  }
  await writeFile(join(R, 'ui-pidmismatch.json'), JSON.stringify({ outcome: uiPid, ownership, sentinelPid: sentinel.pid, sentinelAlive, cleanup: pidCleanup, error: sentinelError }, null, 2), 'utf8')
  if (sentinelError !== null) throw new Error('PID ownership probe failed: ' + sentinelError)
  const pidOk = uiPid.code === 1 && ownership.foreignRejected === true && sentinelAlive === true && pidCleanup.host?.signal === 'SIGTERM' && pidCleanup.browser?.exit?.signal === 'SIGTERM'
  const holdCleanup = JSON.parse(await readFile(join(R, 'ui-hold-final-cleanup.json'), 'utf8'))
  const uiEvidenceErrors = validateUiEvidence({ normal: uiProcesses, hold: holdCleanup, holdPids: hold, alive })
  const uiOk = uiNormal.code === 0 && uiNormal.timedOut === false && uiResult.ok === true && uiEvidenceErrors.length === 0 && uiHold.timedOut === true && pidOk === true
  const uiSupervisor = { normal: { code: uiNormal.code, signal: uiNormal.signal, timedOut: uiNormal.timedOut, durationMs: uiNormal.durationMs, pid: uiNormal.pid }, hold: { code: uiHold.code, signal: uiHold.signal, timedOut: uiHold.timedOut, durationMs: uiHold.durationMs, pid: uiHold.pid, hostPid: hold?.hostPid ?? null, browserPid: hold?.browserPid ?? null }, hostAlive: uiProcesses.hostAlive, browserAlive: uiProcesses.browserAlive }
  await writeFile(join(R, 'ui-supervisor.json'), JSON.stringify(uiSupervisor, null, 2), 'utf8')
  if (uiOk !== true) throw new Error('UI supervisor gate failed')
  prepared.cold = cold
} catch (error) {
  prepareError = String(error?.message ?? error)
}
const expectedSha256 = expected === null ? null : sha256(await readFile(join(R, 'expected.json')))
const gate = evaluateP2aGate({ prepareWorker: { ...outcome, timedOut }, hostExit, coldWorker: coldWorkerResult, coldHostExit, prepareError })
const results = {
  passed: gate.ok,
  gateErrors: gate.errors,
  uiRuns,
  R,
  candidate,
  candidateSha,
  worker: { ...outcome, timedOut, stdout, stderr },
  hostExit,
  coldWorker: coldWorkerResult,
  coldHostExit,
  prepareError,
  expectedSha256,
  expected,
  browser: 'NOT_RUN'
}
await writeFile(join(R, 'results.json'), JSON.stringify(results, null, 2), 'utf8')
console.log(JSON.stringify({ R, passed: results.passed, worker: { code: outcome.code, signal: outcome.signal, timedOut }, expectedSha256, error: prepareError }))
process.exitCode = results.passed ? 0 : 1
