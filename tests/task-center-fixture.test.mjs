import assert from 'node:assert/strict'
import test from 'node:test'
import { checkCold, checkPrepared, evaluateP2aGate, evaluateTaskEvidence, evaluateTaskStale, finalizeTaskEvidence, validateUiEvidence, waitForRecovery } from '../scripts/lib/task-center-oracle.mjs'

test('P2a fixture spec has two sources and four task identities', () => {
  const spec = {
    workspaces: { A: 'Native A', B: 'Native B' },
    sources: { C_A: { sessionId: 'wo-c-a' }, C_B: { sessionId: 'wo-c-b' } },
    tasks: { 'wo-c-t1': ['wo-c-t2', 'wo-c-t3'], 'wo-c-u1': [] }
  }
  assert.notEqual(spec.workspaces.A, spec.workspaces.B)
  assert.notEqual(spec.sources.C_A.sessionId, spec.sources.C_B.sessionId)
  assert.equal(new Set(['wo-c-t1', 'wo-c-t2', 'wo-c-t3', 'wo-c-u1']).size, 4)
})

const base = () => ({
  a: { id: 'nat_a', path: 'C:\\A' },
  b: { id: 'nat_b', path: 'C:\\B' },
  pA: { id: 'p_a', parentId: 'root' },
  pB: { id: 'p_b', parentId: 'root' },
  wA: { id: 'w_a', parentId: 'p_a', directory: 'C:\\A' },
  wB: { id: 'w_b', parentId: 'p_b', directory: 'C:\\B' },
  cA: { id: 'c_a', parentId: 'w_a', sessionId: 'wo-c-a' },
  cB: { id: 'c_b', parentId: 'w_b', sessionId: 'wo-c-b' },
  ledger: {
    revision: 2,
    tasks: [
      { childSessionId: 'wo-c-t1', sourceConversationId: 'c_a', parent: { kind: 'conversation', conversationId: 'c_a' }, depth: 1 },
      { childSessionId: 'wo-c-t2', sourceConversationId: 'c_a', parent: { kind: 'task', taskId: 'tsk_t1' }, depth: 2 },
      { childSessionId: 'wo-c-t3', sourceConversationId: 'c_a', parent: { kind: 'task', taskId: 'tsk_t1' }, depth: 2 },
      { childSessionId: 'wo-c-u1', sourceConversationId: 'c_b', parent: { kind: 'conversation', conversationId: 'c_b' }, depth: 1 }
    ]
  },
  liveSessions: 0
})

function check(p) {
  const errors = []
  if (p.a.id === p.b.id || p.a.path === p.b.path) errors.push('native')
  if (p.pA.parentId !== 'root' || p.pB.parentId !== 'root') errors.push('project')
  if (p.wA.parentId !== p.pA.id || p.wB.parentId !== p.pB.id) errors.push('workspace')
  if (p.wA.directory !== p.a.path || p.wB.directory !== p.b.path) errors.push('cwd')
  if (p.cA.parentId !== p.wA.id || p.cB.parentId !== p.wB.id) errors.push('source')
  const tasks = p.ledger.tasks
  if (tasks.length !== 4) errors.push('missing')
  const t1 = tasks.find((t) => t.childSessionId === 'wo-c-t1')
  for (const id of ['wo-c-t2', 'wo-c-t3']) {
    const task = tasks.find((t) => t.childSessionId === id)
    if (task?.sourceConversationId !== 'c_a' || task?.parent?.taskId !== 'tsk_t1' || task?.depth !== 2) errors.push('relation')
  }
  const u1 = tasks.find((t) => t.childSessionId === 'wo-c-u1')
  if (u1?.sourceConversationId !== 'c_b' || u1?.parent?.conversationId !== 'c_b' || u1?.depth !== 1) errors.push('relation')
  if (t1?.depth !== 1) errors.push('depth')
  if (p.liveSessions !== 0) errors.push('live')
  return errors
}

test('P2a relation checker accepts base and rejects seven mutations', () => {
  assert.deepEqual(check(base()), [])
  const mutations = []
  let v = base(); v.ledger.tasks[1].sourceConversationId = 'c_b'; mutations.push(v)
  v = base(); v.ledger.tasks[1].parent = { kind: 'conversation', conversationId: 'c_a' }; mutations.push(v)
  v = base(); v.ledger.tasks[1].depth = 1; mutations.push(v)
  v = base(); v.ledger.tasks.pop(); mutations.push(v)
  v = base(); v.a.id = v.b.id; mutations.push(v)
  v = base(); v.wA.directory = 'C:\\wrong'; mutations.push(v)
  v = base(); v.liveSessions = 1; mutations.push(v)
  for (const mutation of mutations) assert.notDeepEqual(check(mutation), [])
})

test('production prepare predicate rejects the same relation mutations', () => {
  const spec = {
    sources: { C_A: { sessionId: 'wo-c-a', catalog: ['wo-c-t1'] }, C_B: { sessionId: 'wo-c-b', catalog: ['wo-c-u1'] } },
    tasks: { 'wo-c-t1': ['wo-c-t2', 'wo-c-t3'], 'wo-c-u1': [] }
  }
  const make = () => {
    const p = base()
    p.sessions = {
      'wo-c-a': { header: { id: 'wo-c-a', cwd: p.a.path } },
      'wo-c-t1': { header: { id: 'wo-c-t1', cwd: p.a.path } },
      'wo-c-t2': { header: { id: 'wo-c-t2', cwd: p.a.path } },
      'wo-c-t3': { header: { id: 'wo-c-t3', cwd: p.a.path } },
      'wo-c-b': { header: { id: 'wo-c-b', cwd: p.b.path } },
      'wo-c-u1': { header: { id: 'wo-c-u1', cwd: p.b.path } }
    }
    p.ledger.tasks[0].taskId = 'tsk_t1'
    return p
  }
  assert.deepEqual(checkPrepared(spec, make()), [])
  const mutations = []
  let v = make(); v.ledger.tasks[1].sourceConversationId = 'c_b'; mutations.push(v)
  v = make(); v.ledger.tasks[1].parent = { kind: 'conversation', conversationId: 'c_a' }; mutations.push(v)
  v = make(); v.ledger.tasks[1].depth = 1; mutations.push(v)
  v = make(); v.ledger.tasks.pop(); mutations.push(v)
  v = make(); v.a.id = v.b.id; mutations.push(v)
  v = make(); v.wA.directory = 'C:\\wrong'; mutations.push(v)
  v = make(); v.sessions['wo-c-u1'].header.cwd = v.a.path; mutations.push(v)
  for (const mutation of mutations) assert.notDeepEqual(checkPrepared(spec, mutation), [])
})

test('production cold predicate compares frozen tree, tasks, sessions and native ids', () => {
  const expected = {
    workspaces: { A: { id: 'nat_a' }, B: { id: 'nat_b' } },
    workspacesOrganizer: { A: { directory: 'C:\\A' }, B: { directory: 'C:\\B' } },
    tasks: [{ taskId: 't1', childSessionId: 'wo-c-t1', sourceConversationId: 'c_a', parent: { kind: 'conversation', conversationId: 'c_a' }, depth: 1 }],
    revision: 2,
    ledgerSources: [{}, {}],
    treeRevision: 6,
    tree: [{ id: 'root', kind: 'project' }],
    sessionEvents: { 'wo-c-a': 1 }
  }
  const cold = () => ({
    a: { id: 'nat_a' }, b: { id: 'nat_b' },
    snapshot: { revision: 6, nodes: [{ id: 'root', kind: 'project' }] },
    ledger: { revision: 2, tasks: [{ taskId: 't1', childSessionId: 'wo-c-t1', sourceConversationId: 'c_a', parent: { kind: 'conversation', conversationId: 'c_a' }, depth: 1 }], sources: [{}, {}] },
    sessions: { 'wo-c-a': { header: { id: 'wo-c-a', cwd: 'C:\\A' }, events: 1 }, 'wo-c-t1': { header: { id: 'wo-c-t1', cwd: 'C:\\A' } }, 'wo-c-t2': { header: { id: 'wo-c-t2', cwd: 'C:\\A' } }, 'wo-c-t3': { header: { id: 'wo-c-t3', cwd: 'C:\\A' } }, 'wo-c-b': { header: { id: 'wo-c-b', cwd: 'C:\\B' } }, 'wo-c-u1': { header: { id: 'wo-c-u1', cwd: 'C:\\B' } } }
  })
  assert.deepEqual(checkCold(expected, cold()), [])
  const badTask = cold(); badTask.ledger.tasks[0].depth = 2
  assert.notDeepEqual(checkCold(expected, badTask), [])
  const badTree = cold(); badTree.snapshot.nodes[0].kind = 'workspace'
  assert.notDeepEqual(checkCold(expected, badTree), [])
  const badSession = cold(); badSession.sessions['wo-c-a'].events = 9
  assert.notDeepEqual(checkCold(expected, badSession), [])
})

test('P2a total gate fails closed on missing or timed-out exits', () => {
  const good = () => ({
    prepareWorker: { code: 0, timedOut: false },
    hostExit: { code: null, signal: 'SIGTERM', timedOut: false },
    coldWorker: { code: 0, timedOut: false },
    coldHostExit: { code: null, signal: 'SIGTERM', timedOut: false },
    prepareError: null
  })
  assert.equal(evaluateP2aGate(good()).ok, true)
  const missingPrepare = good(); missingPrepare.hostExit = null
  assert.equal(evaluateP2aGate(missingPrepare).ok, false)
  const timeoutPrepare = good(); timeoutPrepare.hostExit = { code: null, signal: null, timedOut: true }
  assert.equal(evaluateP2aGate(timeoutPrepare).ok, false)
  const missingColdHost = good(); missingColdHost.coldHostExit = null
  assert.equal(evaluateP2aGate(missingColdHost).ok, false)
  const timeoutColdHost = good(); timeoutColdHost.coldHostExit = { code: null, signal: null, timedOut: true }
  assert.equal(evaluateP2aGate(timeoutColdHost).ok, false)
  const coldWorkerTimeout = good(); coldWorkerTimeout.coldWorker = { code: null, signal: 'SIGKILL', timedOut: true }
  assert.equal(evaluateP2aGate(coldWorkerTimeout).ok, false)
  const missingPrepareTimedOut = good(); delete missingPrepareTimedOut.prepareWorker.timedOut
  assert.equal(evaluateP2aGate(missingPrepareTimedOut).ok, false)
  const missingColdTimedOut = good(); delete missingColdTimedOut.coldWorker.timedOut
  assert.equal(evaluateP2aGate(missingColdTimedOut).ok, false)
  const contradictoryHost = good(); contradictoryHost.hostExit = { code: 0, signal: 'SIGTERM', timedOut: false }
  assert.equal(evaluateP2aGate(contradictoryHost).ok, false)
  const nullHost = good(); nullHost.hostExit = { code: null, signal: null, timedOut: false }
  assert.equal(evaluateP2aGate(nullHost).ok, false)
  const codeHost = good(); codeHost.hostExit = { code: 0, signal: null, timedOut: false }
  assert.equal(evaluateP2aGate(codeHost).ok, true)
})

test('SIGKILL recovery has a bounded wait', async () => {
  const startedAt = Date.now()
  const result = await waitForRecovery(new Promise(() => {}), 100)
  assert.equal(result, null)
  assert.ok(Date.now() - startedAt < 1_000)
  assert.deepEqual(await waitForRecovery(Promise.resolve({ code: null, signal: 'SIGKILL' }), 100), { code: null, signal: 'SIGKILL' })
})

test('normal/hold UI exit evidence must be complete and non-contradictory', () => {
  const normal = { hostPid: 11, browserPid: 22, hostAlive: false, browserAlive: false, hostExit: { code: null, signal: 'SIGTERM', timedOut: false }, browserExit: { code: null, signal: 'SIGTERM', timedOut: false } }
  const hold = { host: { code: null, signal: 'SIGTERM', timedOut: false }, browser: { timedOut: false, exit: { code: null, signal: 'SIGTERM', timedOut: false } } }
  const holdPids = { hostPid: 33, browserPid: 44 }
  const alive = () => false
  assert.deepEqual(validateUiEvidence({ normal, hold, holdPids, alive }), [])
  assert.notDeepEqual(validateUiEvidence({ normal: { ...normal, hostExit: null }, hold, holdPids, alive }), [])
  assert.notDeepEqual(validateUiEvidence({ normal: { ...normal, hostExit: { code: 0, signal: 'SIGTERM', timedOut: false } }, hold, holdPids, alive }), [])
  assert.notDeepEqual(validateUiEvidence({ normal: { ...normal, hostAlive: true }, hold, holdPids, alive }), [])
  assert.notDeepEqual(validateUiEvidence({ normal, hold: { ...hold, host: undefined }, holdPids, alive }), [])
  assert.notDeepEqual(validateUiEvidence({ normal, hold, holdPids: { hostPid: 0, browserPid: 44 }, alive }), [])
  assert.notDeepEqual(validateUiEvidence({ normal, hold, holdPids, alive: (pid) => pid === 33 }), [])
})

test('task stale evaluator requires confirmed archive, marker and exact source row', () => {
  const base = { archive: { confirmed: true }, marker: true, error: '', rows: ['wo-u1'] }
  assert.equal(evaluateTaskStale(base), true)
  assert.equal(evaluateTaskStale({ ...base, marker: false, error: 'transport failed' }), false)
  assert.equal(evaluateTaskStale({ ...base, archive: { confirmed: false } }), false)
  assert.equal(evaluateTaskStale({ ...base, rows: ['wo-t1'] }), false)
  assert.equal(evaluateTaskStale({ ...base, rows: ['wo-u1', 'wo-t1'] }), false)
})

test('task evidence evaluator rejects missing identities, bad seq and extra transport rows', () => {
  const ids = Object.fromEntries(['web-sess-s1', 'web-sess-s2', 'wo-t1', 'wo-t2', 'wo-t3', 'wo-u1', 'web-sess-empty', 'web-sess-other', 'web-sess-sub'].map((id) => [id, { header: { id }, inheritedEventCount: 0, events: [] }]))
  const goodGates = Object.fromEntries(['taskReadOnly', 'taskTree', 'taskReload', 'taskColdRestart', 'taskSourceIsolation', 'taskRace', 'taskRepeat', 'taskStale', 'taskTransportStale', 'taskEmptyStates', 'taskCloseLate', 'c3aResource', 'c3aObserver', 'c3aHoldLoadTasks', 'c3aHoldRefresh', 'c3aPagehide'].map((name) => [name, true]))
  const win = (label, seq, boot, file) => ({ label, files: { s: { sha256: file } }, logical: { bootId: boot, seq, sessions: ids } })
  const windows = [
    win('first-before', 1, 'b1', 'a'), win('first-after', 2, 'b1', 'a'), win('reload-before', 3, 'b1', 'a'), win('reload-after', 4, 'b1', 'a'), win('stop-before', 5, 'b1', 'a'),
    { label: 'stop-after', files: { s: { sha256: 'a' } }, logical: 'UNAVAILABLE_HOST_STOPPED' },
    win('cold-ready', 1, 'b2', 'b'), win('cold-page-attach', 2, 'b2', 'b'), win('cold-tasks-after', 3, 'b2', 'b'), win('error-before', 4, 'b2', 'b'),
    { label: 'error-after', files: { s: { sha256: 'b' } }, logical: 'UNAVAILABLE_HOST_STOPPED' }
  ]
  const transport = { rows: ['wo-t1', 'wo-t2', 'wo-t3'], marker: true, error: 'Failed to fetch' }
  const hostExits = { initial: { code: null, signal: 'SIGTERM', timedOut: false }, transport: { code: null, signal: 'SIGTERM', timedOut: false } }
  assert.deepEqual(evaluateTaskEvidence({ gates: goodGates, windows, transport, hostExits, runnerExit: 0 }), [])
  assert.notDeepEqual(evaluateTaskEvidence({ gates: {}, windows: windows.slice(1), transport, hostExits, runnerExit: 0 }), [])
  const badSeq = structuredClone(windows); badSeq[1].logical.seq = 1
  assert.notDeepEqual(evaluateTaskEvidence({ gates: {}, windows: badSeq, transport, hostExits, runnerExit: 0 }), [])
  const badIds = structuredClone(windows); delete badIds[0].logical.sessions['web-sess-sub']
  assert.notDeepEqual(evaluateTaskEvidence({ gates: {}, windows: badIds, transport, hostExits, runnerExit: 0 }), [])
  assert.notDeepEqual(evaluateTaskEvidence({ gates: {}, windows, transport: { ...transport, rows: ['wo-t1', 'wo-t2', 'wo-t3', 'wo-u1'] }, hostExits, runnerExit: 0 }), [])
  assert.notDeepEqual(evaluateTaskEvidence({ gates: goodGates, windows, transport, hostExits, runnerExit: 1 }), [])
  const badHeader = structuredClone(windows); badHeader[0].logical.sessions['wo-t1'].header.id = 'wrong'
  assert.notDeepEqual(evaluateTaskEvidence({ gates: goodGates, windows: badHeader, transport, hostExits, runnerExit: 0 }), [])
  assert.notDeepEqual(evaluateTaskEvidence({ gates: { ...goodGates, taskTree: false }, windows, transport, hostExits, runnerExit: 0 }), [])
  assert.notDeepEqual(evaluateTaskEvidence({ gates: goodGates, windows, transport, hostExits: { initial: { timedOut: false }, transport: hostExits.transport }, runnerExit: 0 }), [])
})

test('outer supervisor exits nonzero when child is 0 but readback fails or evidence errors', () => {
  assert.equal(finalizeTaskEvidence({ childCode: 0, childSignal: null, readError: null, errors: [] }).exitCode, 0)
  assert.equal(finalizeTaskEvidence({ childCode: 0, childSignal: null, readError: 'ENOENT results.json', errors: [] }).exitCode, 1)
  assert.equal(finalizeTaskEvidence({ childCode: 0, childSignal: null, readError: null, errors: ['gate:taskTree'] }).exitCode, 1)
  assert.equal(finalizeTaskEvidence({ childCode: 1, childSignal: null, readError: null, errors: [] }).exitCode, 1)
})
