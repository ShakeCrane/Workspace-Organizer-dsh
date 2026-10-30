const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function checkPrepared(spec, prepared) {
  const errors = []
  if (prepared.a.id === prepared.b.id || prepared.a.path === prepared.b.path) errors.push('native')
  if (prepared.pA.parentId !== 'root' || prepared.pB.parentId !== 'root') errors.push('project')
  if (prepared.wA.parentId !== prepared.pA.id || prepared.wB.parentId !== prepared.pB.id) errors.push('workspace')
  if (prepared.wA.directory !== prepared.a.path || prepared.wB.directory !== prepared.b.path) errors.push('cwd')
  if (prepared.cA.parentId !== prepared.wA.id || prepared.cB.parentId !== prepared.wB.id) errors.push('source-parent')
  if (prepared.cA.sessionId !== spec.sources.C_A.sessionId || prepared.cB.sessionId !== spec.sources.C_B.sessionId) errors.push('source-session')

  const expected = new Map()
  const sourceIds = { C_A: prepared.cA.id, C_B: prepared.cB.id }
  const taskIdOf = (childId) => prepared.ledger.tasks.find((entry) => entry.childSessionId === childId)?.taskId ?? null
  const visit = (childId, sourceKey, parent, depth) => {
    if (expected.has(childId)) { errors.push('duplicate-child:' + childId); return }
    expected.set(childId, { sourceConversationId: sourceIds[sourceKey], parent, depth })
    for (const next of spec.tasks[childId] ?? []) {
      visit(next, sourceKey, { kind: 'task', taskId: taskIdOf(childId) }, depth + 1)
    }
  }
  for (const [sourceKey, source] of Object.entries(spec.sources)) {
    for (const childId of source.catalog ?? []) {
      visit(childId, sourceKey, { kind: 'conversation', conversationId: sourceIds[sourceKey] }, 1)
    }
  }
  const tasks = prepared.ledger.tasks
  if (!same(tasks.map((task) => task.childSessionId).sort(), [...expected.keys()].sort())) errors.push('task-set')
  for (const task of tasks) {
    const wanted = expected.get(task.childSessionId)
    if (wanted === undefined) { errors.push('unexpected-task:' + task.childSessionId); continue }
    if (task.sourceConversationId !== wanted.sourceConversationId) errors.push('task-source:' + task.childSessionId)
    if (task.depth !== wanted.depth) errors.push('task-depth:' + task.childSessionId)
    if (!same(task.parent, wanted.parent)) errors.push('task-parent:' + task.childSessionId)
  }
  for (const [id, expectedCwd] of [['wo-c-a', prepared.a.path], ['wo-c-t1', prepared.a.path], ['wo-c-t2', prepared.a.path], ['wo-c-t3', prepared.a.path], ['wo-c-b', prepared.b.path], ['wo-c-u1', prepared.b.path]]) {
    const session = prepared.sessions[id]
    if (session === undefined || session.header?.id !== id || session.header?.cwd !== expectedCwd) errors.push('session:' + id)
  }
  return errors
}

export async function waitForRecovery(exited, timeoutMs) {
  return await Promise.race([
    Promise.resolve(exited),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), timeoutMs))
  ])
}

export function finalizeTaskEvidence({ childCode, childSignal, readError, errors }) {
  const failures = []
  if (childCode !== 0) failures.push('child-exit:' + String(childCode) + '/' + String(childSignal))
  if (readError !== null && readError !== undefined) failures.push('outer-read:' + String(readError))
  else for (const error of errors ?? []) failures.push(error)
  return { exitCode: failures.length === 0 ? 0 : 1, errors: failures }
}

export function evaluateTaskEvidence({ gates, windows, transport, hostExits, runnerExit }) {
  const errors = []
  const required = ['first-before', 'first-after', 'reload-before', 'reload-after', 'stop-before', 'stop-after', 'cold-ready', 'cold-page-attach', 'cold-tasks-after', 'error-before', 'error-after']
  const requiredGates = ['taskReadOnly', 'taskTree', 'taskReload', 'taskColdRestart', 'taskSourceIsolation', 'taskRace', 'taskRepeat', 'taskStale', 'taskTransportStale', 'taskEmptyStates', 'taskCloseLate', 'c3aResource', 'c3aObserver', 'c3aHoldLoadTasks', 'c3aHoldRefresh', 'c3aPagehide']
  for (const name of requiredGates) if (gates?.[name] !== true) errors.push('gate:' + name)
  const expectedIds = ['web-sess-s1', 'web-sess-s2', 'wo-t1', 'wo-t2', 'wo-t3', 'wo-u1', 'web-sess-empty', 'web-sess-other', 'web-sess-sub']
  const byLabel = Object.fromEntries((windows ?? []).map((entry) => [entry.label, entry]))
  for (const label of required) {
    if (byLabel[label] === undefined) errors.push('missing-window:' + label)
    else if (byLabel[label].files === undefined) errors.push('missing-files:' + label)
  }
  const unavailable = ['stop-after', 'error-after']
  for (const label of required.filter((entry) => !unavailable.includes(entry))) {
    const logical = byLabel[label]?.logical
    if (logical?.sessions === undefined) {
      errors.push('sessions:' + label)
    } else {
      const keys = Object.keys(logical.sessions).sort()
      if (JSON.stringify(keys) !== JSON.stringify(expectedIds.slice().sort())) errors.push('session-keys:' + label)
      for (const id of expectedIds) {
        const session = logical.sessions[id]
        if (session?.header?.id !== id) errors.push('header:' + label + ':' + id)
        if (!Number.isInteger(session?.inheritedEventCount)) errors.push('inherited:' + label + ':' + id)
        if (!Array.isArray(session?.events)) errors.push('events:' + label + ':' + id)
      }
    }
    if (typeof logical?.bootId !== 'string' || logical.bootId.length === 0) errors.push('boot:' + label)
    if (!Number.isInteger(logical?.seq) || logical.seq <= 0) errors.push('seq:' + label)
  }
  for (const label of unavailable) {
    if (byLabel[label]?.logical !== 'UNAVAILABLE_HOST_STOPPED') errors.push('host-stopped:' + label)
  }
  const boot1 = byLabel['first-before']?.logical?.bootId
  const boot2 = byLabel['cold-ready']?.logical?.bootId
  if (boot1 === undefined || boot2 === undefined || boot1 === boot2) errors.push('boot-segments')
  const seq1 = ['first-before', 'first-after', 'reload-before', 'reload-after', 'stop-before'].map((label) => byLabel[label]?.logical?.seq)
  const seq2 = ['cold-ready', 'cold-page-attach', 'cold-tasks-after', 'error-before'].map((label) => byLabel[label]?.logical?.seq)
  for (const seqs of [seq1, seq2]) for (let index = 1; index < seqs.length; index += 1) if (!(seqs[index] > seqs[index - 1])) errors.push('seq-order')
  const fileHash = (label) => JSON.stringify(byLabel[label]?.files)
  if (!['first-after', 'reload-before', 'reload-after', 'stop-before'].every((label) => fileHash(label) === fileHash('first-before'))) errors.push('file-stable-warm')
  if (!['cold-page-attach', 'cold-tasks-after', 'error-before'].every((label) => fileHash(label) === fileHash('cold-page-attach'))) errors.push('file-stable-cold')
  if (JSON.stringify(transport?.rows?.slice().sort()) !== JSON.stringify(['wo-t1', 'wo-t2', 'wo-t3'])) errors.push('transport-rows')
  if (transport?.marker !== true || typeof transport?.error !== 'string' || !transport.error.includes('Failed to fetch')) errors.push('transport-stale')
  if (hostExits?.initial?.timedOut !== false || hostExits?.transport?.timedOut !== false) errors.push('host-exits')
  if (!validExitRecord(hostExits?.initial)) errors.push('host-initial-exit')
  if (!validExitRecord(hostExits?.transport)) errors.push('host-transport-exit')
  if (runnerExit !== 0) errors.push('runner-exit')
  return errors
}

export function evaluateTaskStale({ archive, marker, error, rows, expectedRow = 'wo-u1' }) {
  return archive?.confirmed === true && marker === true && Array.isArray(rows) && rows.length === 1 && rows[0] === expectedRow
}

export function validExitRecord(exit) {
  if (exit === null || exit === undefined) return false
  if (exit.timedOut !== false) return false
  return (exit.code === 0 && exit.signal === null) || (exit.code === null && exit.signal === 'SIGTERM')
}

export function validateUiEvidence({ normal, hold, holdPids, alive }) {
  const errors = []
  if (!Number.isInteger(normal?.hostPid) || normal.hostPid <= 0) errors.push('normal-host-pid')
  if (!Number.isInteger(normal?.browserPid) || normal.browserPid <= 0) errors.push('normal-browser-pid')
  if (normal?.hostAlive !== false || normal?.browserAlive !== false) errors.push('normal-alive')
  if (!validExitRecord(normal?.hostExit)) errors.push('normal-host-exit')
  if (!validExitRecord(normal?.browserExit)) errors.push('normal-browser-exit')
  if (alive(normal?.hostPid) || alive(normal?.browserPid)) errors.push('normal-pid-still-alive')
  if (!validExitRecord(hold?.host)) errors.push('hold-host-exit')
  if (!validExitRecord({ ...(hold?.browser?.exit ?? null), timedOut: hold?.browser?.timedOut })) errors.push('hold-browser-exit')
  if (!Number.isInteger(holdPids?.hostPid) || holdPids.hostPid <= 0) errors.push('hold-host-pid')
  if (!Number.isInteger(holdPids?.browserPid) || holdPids.browserPid <= 0) errors.push('hold-browser-pid')
  if (alive(holdPids?.hostPid) || alive(holdPids?.browserPid)) errors.push('hold-pid-still-alive')
  return errors
}

export function evaluateP2aGate({ prepareWorker, hostExit, coldWorker, coldHostExit, prepareError }) {
  const errors = []
  if (prepareError !== null) errors.push('prepare-error')
  if (prepareWorker?.code !== 0 || prepareWorker?.timedOut !== false) errors.push('prepare-worker')
  if (hostExit === null || hostExit === undefined) errors.push('missing-prepare-host-exit')
  else if (hostExit.timedOut !== false) errors.push('prepare-host-timeout')
  else if (!((hostExit.code === 0 && hostExit.signal === null) || (hostExit.code === null && hostExit.signal === 'SIGTERM'))) errors.push('prepare-host-exit')
  if (coldWorker === null || coldWorker === undefined) errors.push('missing-cold-worker')
  else if (coldWorker.code !== 0 || coldWorker.timedOut !== false) errors.push('cold-worker')
  if (coldHostExit === null || coldHostExit === undefined) errors.push('missing-cold-host-exit')
  else if (coldHostExit.timedOut !== false) errors.push('cold-host-timeout')
  else if (!((coldHostExit.code === 0 && coldHostExit.signal === null) || (coldHostExit.code === null && coldHostExit.signal === 'SIGTERM'))) errors.push('cold-host-exit')
  return { ok: errors.length === 0, errors }
}

export function checkCold(expected, cold) {
  const errors = []
  if (cold.a?.id !== expected.workspaces.A.id || cold.b?.id !== expected.workspaces.B.id) errors.push('native')
  if (!same(cold.ledger.tasks.map((task) => ({ taskId: task.taskId, childSessionId: task.childSessionId, sourceConversationId: task.sourceConversationId, parent: task.parent, depth: task.depth })), expected.tasks)) errors.push('tasks')
  if (!same(cold.ledger.sources, expected.ledgerSources)) errors.push('sources')
  if (cold.ledger.revision !== expected.revision) errors.push('ledger-revision')
  if (cold.snapshot.revision !== expected.treeRevision) errors.push('revision')
  if (!same(cold.snapshot.nodes, expected.tree)) errors.push('tree')
  for (const [id, events] of Object.entries(expected.sessionEvents ?? {})) {
    if (cold.sessions[id]?.events !== events) errors.push('events:' + id)
  }
  for (const [id, dir] of [['wo-c-a', expected.workspacesOrganizer.A.directory], ['wo-c-t1', expected.workspacesOrganizer.A.directory], ['wo-c-t2', expected.workspacesOrganizer.A.directory], ['wo-c-t3', expected.workspacesOrganizer.A.directory], ['wo-c-b', expected.workspacesOrganizer.B.directory], ['wo-c-u1', expected.workspacesOrganizer.B.directory]]) {
    const session = cold.sessions[id]
    if (session === undefined || session.header?.id !== id || session.header?.cwd !== dir) errors.push('session:' + id)
  }
  return errors
}
