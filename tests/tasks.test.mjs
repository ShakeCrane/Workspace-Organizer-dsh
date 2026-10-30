/**
 * C1 read-only vertical slice: terminal Workspace, directory-bound Conversation,
 * stable TaskId reconciliation, migration, conflict negatives and persistence.
 *
 * Nothing here starts, resumes, messages, stops or archives a Task; execution
 * state must remain UNKNOWN, and the host adapter is proven to call only the
 * read-only catalog observer.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { JsonTreeRepository } from '../build/core/repository.js'
import { OrganizerCore } from '../build/core/service.js'
import { ROOT_ID, validateDocument } from '../build/core/model.js'
import {
  emptyTaskLedger,
  reconcileTasks,
  validateTaskLedger
} from '../build/core/tasks.js'
import {
  JsonTaskLedgerRepository,
  MemoryTaskLedgerRepository,
  TaskLedgerService
} from '../build/core/taskService.js'
import { observeCatalog, taskHostAvailability } from '../build/host/tasks.js'
import { WorkspaceOrganizerService } from '../build/service.js'

const TMP_ROOT = fileURLToPath(new URL('../build/.tmp/', import.meta.url))
const NOW = '2026-10-20T00:00:00.000Z'
const VERSION = '0.2.1-rc.2'
const DIR = 'E:\\work\\alpha'

async function area(label) {
  const dir = await mkdtemp(join(TMP_ROOT, `${label}-`))
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

function source(overrides = {}) {
  return {
    conversationId: 'cnv_source',
    sessionId: 'sess_source',
    workspaceLogicalId: 'wsp_1',
    directory: DIR,
    nativeWorkspaceId: 'native-ws-1',
    verifiedAt: NOW,
    hostVersion: VERSION,
    ...overrides
  }
}

function catalog(rows) {
  return rows.map((row) => ({ ...row }))
}

function child(id, parentId, depth, mode = 'one-shot', label) {
  return { kind: 'child', id, parentId, depth, mode, ...(label === undefined ? {} : { label }) }
}

const HEADERS = {
  t1: { cwd: DIR },
  t2: { cwd: DIR },
  t3: { cwd: DIR }
}

test('tree schema v1 is read, not rewritten, and migrates on the next mutation', async () => {
  const workspace = await area('tree-migration')
  try {
    const file = join(workspace.dir, 'tree.json')
    const v1 = {
      schemaVersion: 1,
      revision: 3,
      rootId: ROOT_ID,
      nodes: [{ id: ROOT_ID, kind: 'project', parentId: null, title: 'Root', createdAt: NOW, updatedAt: NOW }]
    }
    await writeFile(file, JSON.stringify(v1), 'utf8')
    const before = await readFile(file, 'utf8')
    const core = new OrganizerCore({ repository: new JsonTreeRepository(file) })
    const snapshot = await core.snapshot()
    assert.equal(snapshot.revision, 3)
    assert.equal(await readFile(file, 'utf8'), before, 'reading must not rewrite the stored document')

    const registered = await core.registerWorkspace({ parentId: ROOT_ID, title: 'Alpha', directory: DIR, nativeWorkspaceId: 'native-1' })
    assert.equal(registered.revision, 4)
    const stored = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(stored.schemaVersion, 2)
    assert.ok(stored.nodes.some((node) => node.kind === 'workspace' && node.directory === DIR))
  } finally {
    await workspace.cleanup()
  }
})

test('a workspace binds one directory and its conversations must share that cwd', async () => {
  let doc = { schemaVersion: 2, revision: 0, rootId: ROOT_ID, nodes: [{ id: ROOT_ID, kind: 'project', parentId: null, title: 'Root', createdAt: NOW, updatedAt: NOW }, { id: 'wsp_1', kind: 'workspace', parentId: ROOT_ID, title: 'Alpha', directory: DIR, nativeWorkspaceId: 'native-1', createdAt: NOW, updatedAt: NOW }] }
  doc = validateDocument(doc)
  assert.ok(doc.nodes.some((node) => node.kind === 'workspace'))

  assert.throws(
    () => validateDocument({
      ...doc,
      nodes: [...doc.nodes, { id: 'cnv_bad', kind: 'conversation', parentId: 'wsp_1', title: 'Bad', sessionId: 's1', cwd: 'E:\\other', createdAt: NOW, updatedAt: NOW }]
    }),
    (error) => error.code === 'tree/invalid-parent-kind'
  )
  assert.throws(
    () => validateDocument({
      ...doc,
      nodes: [...doc.nodes, { id: 'cnv_bad', kind: 'conversation', parentId: ROOT_ID, title: 'Bad', sessionId: 's1', cwd: DIR, createdAt: NOW, updatedAt: NOW }]
    }),
    (error) => error.code === 'tree/invalid-parent-kind'
  )
  const ok = validateDocument({
    ...doc,
    nodes: [...doc.nodes, { id: 'cnv_ok', kind: 'conversation', parentId: 'wsp_1', title: 'Chat', sessionId: 's1', cwd: DIR, createdAt: NOW, updatedAt: NOW }]
  })
  assert.ok(ok.nodes.some((node) => node.id === 'cnv_ok' && node.cwd === DIR))

  // CORE-004: a Workspace is terminal; a Project may only nest under a Project.
  assert.throws(
    () => validateDocument({
      ...doc,
      nodes: [...doc.nodes, { id: 'prj_bad', kind: 'project', parentId: 'wsp_1', title: 'Bad project', createdAt: NOW, updatedAt: NOW }]
    }),
    (error) => error.code === 'tree/invalid-parent-kind'
  )
  assert.throws(
    () => validateDocument({
      ...doc,
      nodes: [
        ...doc.nodes,
        { id: 'prj_bad', kind: 'project', parentId: 'wsp_1', title: 'Bad project', createdAt: NOW, updatedAt: NOW },
        { id: 'wsp_bad', kind: 'workspace', parentId: 'prj_bad', title: 'Bad workspace', directory: 'E:\\work\\beta', nativeWorkspaceId: 'native-2', createdAt: NOW, updatedAt: NOW }
      ]
    }),
    (error) => error.code === 'tree/invalid-parent-kind'
  )
  assert.ok(validateDocument({
    ...doc,
    nodes: [...doc.nodes, { id: 'prj_nested', kind: 'project', parentId: ROOT_ID, title: 'Nested', createdAt: NOW, updatedAt: NOW }]
  }).nodes.some((node) => node.id === 'prj_nested'))
})

test('catalog reconciliation maps C → T1 → T2 → T3 with stable ids and UNKNOWN execution', () => {
  const first = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([
      child('t1', 'sess_source', 1, 'one-shot', 'root child'),
      child('t2', 't1', 2, 'continuable', 'grandchild'),
      child('t3', 't2', 3, 'continuable', 'great-grandchild')
    ]),
    headers: HEADERS,
    now: NOW,
    newTaskId: (childSessionId) => `tsk_fixed_${childSessionId}`
  })
  const ledger = first.ledger
  assert.equal(ledger.schemaVersion, 1)
  assert.equal(ledger.tasks.length, 3)
  const byChild = new Map(ledger.tasks.map((task) => [task.childSessionId, task]))
  assert.deepEqual(byChild.get('t1').parent, { kind: 'conversation', conversationId: 'cnv_source' })
  assert.deepEqual(byChild.get('t2').parent, { kind: 'task', taskId: 'tsk_fixed_t1' })
  assert.deepEqual(byChild.get('t3').parent, { kind: 'task', taskId: 'tsk_fixed_t2' })
  assert.deepEqual([...byChild.values()].map((task) => task.depth), [1, 2, 3])
  assert.ok([...byChild.values()].every((task) => task.executionState === 'UNKNOWN'))
  assert.ok([...byChild.values()].every((task) => task.executionEligibility === 'eligible'))

  const second = reconcileTasks({
    previous: ledger,
    source: source(),
    catalog: catalog([child('t1', 'sess_source', 1, 'one-shot'), child('t2', 't1', 2, 'continuable')]),
    headers: { t1: { cwd: DIR }, t2: { cwd: DIR } },
    now: '2026-10-20T01:00:00.000Z',
    newTaskId: () => 'tsk_should_not_be_used'
  })
  const stable = new Map(second.ledger.tasks.map((task) => [task.childSessionId, task.taskId]))
  assert.equal(stable.get('t1'), 'tsk_fixed_t1')
  assert.equal(stable.get('t2'), 'tsk_fixed_t2')
  // t3 disappeared from the catalog: kept, blocked, never deleted.
  assert.equal(stable.get('t3'), 'tsk_fixed_t3')
  const t3 = second.ledger.tasks.find((task) => task.childSessionId === 't3')
  assert.equal(t3.executionEligibility, 'blocked')
  assert.equal(t3.blockedReason, 'catalog/not-observed')
})

test('conflicts and unprovable branches are isolated, never guessed', () => {
  const dual = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([
      child('c1', 'sess_source', 1),
      child('c1', 'sess_other', 2),
      child('c2', 'c1', 2)
    ]),
    headers: {},
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  assert.equal(dual.ledger.tasks.some((task) => task.childSessionId === 'c1'), false)
  assert.ok(dual.ledger.diagnostics.some((entry) => entry.code === 'catalog/dual-parent'))
  assert.ok(dual.ledger.diagnostics.some((entry) => entry.code === 'catalog/parent-isolated'))

  const cycle = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('a', 'b', 2), child('b', 'a', 2)]),
    headers: {},
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  assert.ok(cycle.ledger.diagnostics.some((entry) => entry.code === 'catalog/cycle'))
  assert.equal(cycle.ledger.tasks.length, 0)

  const missing = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('x', 'ghost', 1)]),
    headers: {},
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  assert.ok(missing.ledger.diagnostics.some((entry) => entry.code === 'catalog/missing-parent'))

  const unknown = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('u', 'sess_source', 1, 'unknown')]),
    headers: { u: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  const unknownTask = unknown.ledger.tasks.find((task) => task.childSessionId === 'u')
  assert.equal(unknownTask.executionEligibility, 'blocked')
  assert.equal(unknownTask.blockedReason, 'catalog/unsupported-mode')

  const mismatch = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('m', 'sess_source', 5)]),
    headers: { m: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  assert.ok(mismatch.ledger.diagnostics.some((entry) => entry.code === 'catalog/depth-mismatch'))

  const cwd = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('w', 'sess_source', 1)]),
    headers: { w: { cwd: 'E:\\elsewhere' } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  const cwdTask = cwd.ledger.tasks.find((task) => task.childSessionId === 'w')
  assert.equal(cwdTask.executionEligibility, 'blocked')
  assert.equal(cwdTask.blockedReason, 'cwd/unverified')

  const noHeader = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('h', 'sess_source', 1)]),
    headers: {},
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  assert.equal(noHeader.ledger.tasks.find((task) => task.childSessionId === 'h').blockedReason, 'header/unavailable')
})

test('a fork-only Session absent from the catalog is never imported', () => {
  const result = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('t1', 'sess_source', 1)]),
    headers: { t1: { cwd: DIR }, forked: { cwd: DIR, parentSessionId: 'sess_source' } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  assert.deepEqual(result.ledger.tasks.map((task) => task.childSessionId), ['t1'])
})

test('ledger persists across a restart and refuses stale writes', async () => {
  const workspace = await area('ledger')
  try {
    const file = join(workspace.dir, 'tasks.json')
    const first = new TaskLedgerService({ repository: new JsonTaskLedgerRepository(file), now: () => NOW })
    const result = await first.reconcile({
      source: source(),
      catalog: catalog([child('t1', 'sess_source', 1)]),
      headers: { t1: { cwd: DIR } },
      newTaskId: (id) => `tsk_${id}`
    })
    assert.equal(result.ledger.tasks.length, 1)

    const reopened = new TaskLedgerService({ repository: new JsonTaskLedgerRepository(file), now: () => NOW })
    const snapshot = await reopened.snapshot()
    assert.equal(snapshot.revision, result.ledger.revision)
    assert.equal(snapshot.tasks[0].taskId, 'tsk_t1')
    assert.equal(snapshot.tasks[0].executionState, 'UNKNOWN')

    const repository = new JsonTaskLedgerRepository(file)
    await assert.rejects(
      repository.save({ ...snapshot, revision: 0 }, 0),
      (error) => error.code === 'task/conflict'
    )
  } finally {
    await workspace.cleanup()
  }
})

test('the read-only host adapter only calls listDescendants and reports missing services', async () => {
  const calls = []
  const services = {
    subagents: {
      async listDescendants(rootSessionId) {
        calls.push(['listDescendants', rootSessionId])
        return [
          { kind: 'child', id: 't1', parentId: rootSessionId, depth: 1, mode: 'one-shot' },
          { kind: 'diagnostic', id: 'bad', parentId: rootSessionId, depth: 1, reason: 'unsupported' }
        ]
      },
      async start() { calls.push(['start']); throw new Error('must not start') },
      async interrupt() { calls.push(['interrupt']); throw new Error('must not interrupt') }
    },
    sessionQuery: { async readSession() { calls.push(['readSession']); return { session: { cwd: DIR } } } },
    workspaceRegistry: { async resolveByPath() { calls.push(['resolveByPath']); return { id: 'native-1', path: DIR } } }
  }
  const availability = taskHostAvailability(services)
  assert.equal(availability.available, true)
  const rows = await observeCatalog(services, 'sess_source')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'child')
  assert.equal(rows[1].kind, 'diagnostic')
  assert.deepEqual(calls, [['listDescendants', 'sess_source']])

  const missing = taskHostAvailability({})
  assert.equal(missing.available, false)
  assert.deepEqual([...missing.missing].sort(), ['sessionQuery.readSession', 'subagents.listDescendants', 'workspaceRegistry.resolveByPath'])
})

test('ledger validation rejects duplicates and non-UNKNOWN execution states', () => {
  const base = emptyTaskLedger(NOW)
  const task = {
    taskId: 'tsk_1', childSessionId: 't1', sourceConversationId: 'cnv_source',
    parent: { kind: 'conversation', conversationId: 'cnv_source' }, depth: 1, mode: 'one-shot',
    observedAt: NOW, executionState: 'UNKNOWN', executionEligibility: 'eligible'
  }
  const valid = validateTaskLedger({
    ...base,
    sources: [source()],
    tasks: [task]
  })
  assert.equal(valid.tasks.length, 1)
  assert.throws(
    () => validateTaskLedger({ ...base, sources: [source()], tasks: [{ ...task, executionState: 'running' }] }),
    (error) => error.code === 'task/invalid-ledger'
  )
  assert.throws(
    () => validateTaskLedger({ ...base, sources: [source()], tasks: [task, { ...task, taskId: 'tsk_2' }] }),
    (error) => error.code === 'task/invalid-ledger'
  )
  assert.throws(
    () => validateTaskLedger({ ...base, sources: [source()], tasks: [task, { ...task, taskId: 'tsk_2', childSessionId: 't2', parent: { kind: 'task', taskId: 'ghost' } }] }),
    (error) => error.code === 'task/invalid-ledger'
  )
})

test('a known child never changes source and not-observed is scoped to one source', () => {
  const a = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('x', 'sess_source', 1)]),
    headers: { x: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  const bSource = source({ conversationId: 'cnv_other', sessionId: 'sess_other' })

  const b = reconcileTasks({
    previous: a.ledger,
    source: bSource,
    catalog: catalog([child('x', 'sess_other', 1), child('y', 'sess_other', 1)]),
    headers: { x: { cwd: DIR }, y: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_b_${id}`
  })
  assert.equal(b.ledger.tasks.some((task) => task.childSessionId === 'x' && task.sourceConversationId === 'cnv_other'), false)
  assert.ok(b.ledger.diagnostics.some((entry) => entry.code === 'task/cross-source'))
  const x = b.ledger.tasks.find((task) => task.childSessionId === 'x')
  assert.equal(x.sourceConversationId, 'cnv_source')
  assert.deepEqual(x.parent, { kind: 'conversation', conversationId: 'cnv_source' })
  assert.ok(!b.ledger.diagnostics.some((entry) => entry.code === 'catalog/not-observed' && entry.childSessionId === 'x'))

  const aAgain = reconcileTasks({
    previous: b.ledger,
    source: source(),
    catalog: catalog([]),
    headers: {},
    now: NOW,
    newTaskId: () => 'tsk_should_not_be_used'
  })
  // A's x is the only task of A; B's y is untouched by A's pass.
  assert.equal(aAgain.ledger.tasks.find((task) => task.childSessionId === 'y').sourceConversationId, 'cnv_other')
  assert.equal(aAgain.ledger.tasks.find((task) => task.childSessionId === 'y').executionEligibility, 'eligible')
  assert.equal(aAgain.ledger.tasks.find((task) => task.childSessionId === 'x').blockedReason, 'catalog/not-observed')
})

test('a diagnostic row blocks its child even when a child row also exists, and any non-known mode is blocked', () => {
  const mixed = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: [
      child('d', 'sess_source', 1),
      { kind: 'diagnostic', id: 'd', parentId: 'sess_source', depth: 1, reason: 'unsupported' }
    ],
    headers: { d: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  const d = mixed.ledger.tasks.find((task) => task.childSessionId === 'd')
  assert.equal(d.executionEligibility, 'blocked')
  assert.equal(d.blockedReason, 'catalog/unsupported')

  const future = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('f', 'sess_source', 1, 'future-mode')]),
    headers: { f: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  assert.equal(future.ledger.tasks.find((task) => task.childSessionId === 'f').blockedReason, 'catalog/unsupported-mode')
})

test('a later catalog cannot re-parent a known task; the stored relation wins and is blocked', () => {
  const first = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('a', 'sess_source', 1), child('b', 'a', 2)]),
    headers: { a: { cwd: DIR }, b: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  const moved = reconcileTasks({
    previous: first.ledger,
    source: source(),
    catalog: catalog([child('a', 'sess_source', 1), child('c', 'sess_source', 1), child('b', 'c', 2)]),
    headers: { a: { cwd: DIR }, b: { cwd: DIR }, c: { cwd: DIR } },
    now: NOW,
    newTaskId: () => 'tsk_new'
  })
  const c = moved.ledger.tasks.find((task) => task.childSessionId === 'c')
  assert.equal(c.taskId, 'tsk_new')
  const b = moved.ledger.tasks.find((task) => task.childSessionId === 'b')
  assert.deepEqual(b.parent, { kind: 'task', taskId: 'tsk_a' })
  // The stored parent stays paired with its stored depth, not the observed one.
  assert.equal(b.depth, 2)
  assert.equal(b.executionEligibility, 'blocked')
  assert.equal(b.blockedReason, 'task/rebind-detected')
  assert.ok(moved.ledger.diagnostics.some((entry) => entry.code === 'task/rebind-detected'))
  assert.doesNotThrow(() => validateTaskLedger(moved.ledger))
  assert.throws(
    () => validateTaskLedger({
      ...moved.ledger,
      tasks: moved.ledger.tasks.map((task) => task.childSessionId === 'b' ? { ...task, depth: 1 } : task)
    }),
    (error) => error.code === 'task/invalid-ledger'
  )
})

test('an ancestor rebind keeps descendants on the stored chain and the ledger valid', () => {
  const first = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('a', 'sess_source', 1), child('b', 'a', 2)]),
    headers: { a: { cwd: DIR }, b: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  const moved = reconcileTasks({
    previous: first.ledger,
    source: source(),
    catalog: catalog([child('c', 'sess_source', 1), child('a', 'c', 2), child('b', 'a', 3)]),
    headers: { a: { cwd: DIR }, b: { cwd: DIR }, c: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  const a = moved.ledger.tasks.find((task) => task.childSessionId === 'a')
  const b = moved.ledger.tasks.find((task) => task.childSessionId === 'b')
  assert.deepEqual(a.parent, { kind: 'conversation', conversationId: 'cnv_source' })
  assert.equal(a.depth, 1)
  assert.equal(a.blockedReason, 'task/rebind-detected')
  assert.deepEqual(b.parent, { kind: 'task', taskId: 'tsk_a' })
  assert.equal(b.depth, 2, 'depth must follow the effective parent, not the observed chain')
  assert.equal(b.executionEligibility, 'blocked')
  assert.equal(b.blockedReason, 'ancestor-blocked')
  assert.doesNotThrow(() => validateTaskLedger(moved.ledger))
  assert.ok(moved.ledger.tasks.filter((task) => task.childSessionId === 'a' || task.childSessionId === 'b')
    .every((task) => task.executionEligibility === 'blocked'))
})

test('a corrupt previous ledger is rejected before any id allocation', () => {
  const previous = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: NOW,
    sources: [source()],
    diagnostics: [],
    tasks: [
      {
        taskId: 'tsk_a', childSessionId: 'a', sourceConversationId: 'cnv_source',
        parent: { kind: 'conversation', conversationId: 'cnv_source' }, depth: 1, mode: 'one-shot',
        observedAt: NOW, executionState: 'UNKNOWN', executionEligibility: 'eligible'
      },
      {
        taskId: 'tsk_b', childSessionId: 'b', sourceConversationId: 'cnv_source',
        parent: { kind: 'task', taskId: 'tsk_missing' }, depth: 2, mode: 'one-shot',
        observedAt: NOW, executionState: 'UNKNOWN', executionEligibility: 'eligible'
      }
    ]
  }
  let allocations = 0
  // The pure function validates the previous ledger before traversal or ID
  // allocation; a dangling parent is refused, not repaired into a success.
  assert.throws(
    () => reconcileTasks({
      previous,
      source: source(),
      catalog: catalog([child('a', 'sess_source', 1), child('b', 'a', 2), child('c', 'sess_source', 1)]),
      headers: { a: { cwd: DIR }, b: { cwd: DIR }, c: { cwd: DIR } },
      now: NOW,
      newTaskId: (id) => {
        allocations += 1
        return `tsk_${id}`
      }
    }),
    (error) => error.code === 'task/invalid-ledger' &&
      error.details?.taskId === 'tsk_b' &&
      error.details?.parentId === 'tsk_missing'
  )
  assert.equal(allocations, 0, 'the id allocator must not run for a corrupt previous ledger')
})

test('missing catalog ancestors keep the stored chain blocked and process a later independent row', () => {
  const first = reconcileTasks({
    previous: undefined,
    source: source(),
    catalog: catalog([child('a', 'sess_source', 1), child('b', 'a', 2), child('d', 'b', 3)]),
    headers: { a: { cwd: DIR }, b: { cwd: DIR }, d: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  const before = new Map(first.ledger.tasks.map((task) => [task.childSessionId, task]))
  const second = reconcileTasks({
    previous: first.ledger,
    source: source(),
    catalog: catalog([
      child('a', 'ghost', 1),
      child('b', 'a', 2),
      child('d', 'b', 3),
      child('z', 'sess_source', 1)
    ]),
    headers: { a: { cwd: DIR }, b: { cwd: DIR }, d: { cwd: DIR }, z: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_new_${id}`
  })
  const after = new Map(second.ledger.tasks.map((task) => [task.childSessionId, task]))
  assert.equal(after.has('ghost'), false, 'no TaskRecord is synthesized for the missing parent')
  for (const id of ['a', 'b', 'd']) {
    assert.equal(after.get(id).taskId, before.get(id).taskId)
    assert.equal(after.get(id).sourceConversationId, before.get(id).sourceConversationId)
    assert.deepEqual(after.get(id).parent, before.get(id).parent)
    assert.equal(after.get(id).depth, before.get(id).depth)
    assert.equal(after.get(id).executionEligibility, 'blocked')
  }
  assert.equal(after.get('z').executionEligibility, 'eligible', 'a later independent row is still processed')
  assert.ok(second.ledger.diagnostics.some((entry) => entry.code === 'catalog/missing-parent'))
  assert.ok(second.ledger.diagnostics.some((entry) => entry.code === 'catalog/parent-isolated'))
  assert.doesNotThrow(() => validateTaskLedger(second.ledger))

  let repeatAllocations = 0
  const third = reconcileTasks({
    previous: second.ledger,
    source: source(),
    catalog: catalog([
      child('a', 'ghost', 1),
      child('b', 'a', 2),
      child('d', 'b', 3),
      child('z', 'sess_source', 1)
    ]),
    headers: { a: { cwd: DIR }, b: { cwd: DIR }, d: { cwd: DIR }, z: { cwd: DIR } },
    now: '2026-10-20T01:00:00.000Z',
    newTaskId: (id) => {
      repeatAllocations += 1
      return `tsk_repeat_${id}`
    }
  })
  const repeated = new Map(third.ledger.tasks.map((task) => [task.childSessionId, task]))
  for (const id of ['a', 'b', 'd', 'z']) {
    assert.equal(repeated.get(id).taskId, after.get(id).taskId, `${id} keeps its id across scans`)
  }
  assert.equal(repeatAllocations, 0, 'a repeated scan reuses every known task id')
  assert.doesNotThrow(() => validateTaskLedger(third.ledger))

  const roundTripped = validateTaskLedger(JSON.parse(JSON.stringify(third.ledger)))
  assert.deepEqual(
    roundTripped.tasks.map((task) => task.taskId).sort(),
    third.ledger.tasks.map((task) => task.taskId).sort()
  )
})

test('a resolvable stored parent keeps later independent catalog rows processed', () => {
  const previous = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: NOW,
    sources: [source()],
    diagnostics: [],
    tasks: [
      {
        taskId: 'tsk_a', childSessionId: 'a', sourceConversationId: 'cnv_source',
        parent: { kind: 'conversation', conversationId: 'cnv_source' }, depth: 1, mode: 'one-shot',
        observedAt: NOW, executionState: 'UNKNOWN', executionEligibility: 'eligible'
      },
      {
        taskId: 'tsk_b', childSessionId: 'b', sourceConversationId: 'cnv_source',
        parent: { kind: 'task', taskId: 'tsk_a' }, depth: 2, mode: 'one-shot',
        observedAt: NOW, executionState: 'UNKNOWN', executionEligibility: 'eligible'
      }
    ]
  }
  const result = reconcileTasks({
    previous,
    source: source(),
    catalog: catalog([child('a', 'sess_source', 1), child('d', 'sess_source', 1), child('b', 'd', 2), child('c', 'sess_source', 1)]),
    headers: { a: { cwd: DIR }, b: { cwd: DIR }, c: { cwd: DIR }, d: { cwd: DIR } },
    now: NOW,
    newTaskId: (id) => `tsk_${id}`
  })
  const b = result.ledger.tasks.find((task) => task.childSessionId === 'b')
  const c = result.ledger.tasks.find((task) => task.childSessionId === 'c')
  assert.deepEqual(b.parent, { kind: 'task', taskId: 'tsk_a' })
  assert.equal(b.blockedReason, 'task/rebind-detected')
  assert.equal(c.executionEligibility, 'eligible', 'a later independent row is still processed')
  assert.doesNotThrow(() => validateTaskLedger(result.ledger))
})

test('version 1 documents with a directory-bound project conversation are refused, not guessed', async () => {
  const workspace = await area('migration-boundary')
  try {
    const file = join(workspace.dir, 'tree.json')
    const v1 = {
      schemaVersion: 1,
      revision: 1,
      rootId: ROOT_ID,
      nodes: [
        { id: ROOT_ID, kind: 'project', parentId: null, title: 'Root', createdAt: NOW, updatedAt: NOW },
        { id: 'cnv_old', kind: 'conversation', parentId: ROOT_ID, title: 'Old', sessionId: 's_old', cwd: DIR, createdAt: NOW, updatedAt: NOW }
      ]
    }
    await writeFile(file, JSON.stringify(v1), 'utf8')
    const before = await readFile(file, 'utf8')
    const core = new OrganizerCore({ repository: new JsonTreeRepository(file) })
    await assert.rejects(core.snapshot(), (error) => error.code === 'tree/migration-unsupported')
    assert.equal(await readFile(file, 'utf8'), before, 'a refused migration must not rewrite the file')
  } finally {
    await workspace.cleanup()
  }
})

test('binding admits a plain fork but rejects subagent origin; an archived source stays blocked and unrefreshed', async () => {
  const workspace = await area('origin-currentness')
  try {
    const treeFile = join(workspace.dir, 'tree.json')
    const core = new OrganizerCore({ repository: new JsonTreeRepository(treeFile) })
    const ledger = new TaskLedgerService({ repository: new MemoryTaskLedgerRepository(), now: () => NOW })
    const headers = new Map()
    let archived = []
    let archivedKnown = true
    let nativeId = 'native-1'
    let catalogRows = []
    const host = {
      get(name) {
        if (name === 'sessionQuery') return { readSession: async (id) => (headers.has(id) ? { session: headers.get(id) } : undefined) }
        if (name === 'workspaceRegistry') return {
          resolveByPath: async () => ({ id: nativeId, path: DIR }),
          get archivedSessionIds() { return archivedKnown ? archived : undefined }
        }
        if (name === 'subagents') return { listDescendants: async () => catalogRows }
        return undefined
      }
    }
    const service = new WorkspaceOrganizerService({
      core,
      sessions: { create: async () => ({ sessionId: 'sess_new' }) },
      host,
      dataDir: workspace.dir,
      tasks: ledger
    })
    await core.registerWorkspace({ parentId: ROOT_ID, title: 'W', directory: DIR, nativeWorkspaceId: 'native-1' })
    const snapshot = await core.snapshot()
    const wsp = snapshot.nodes.find((node) => node.kind === 'workspace')
    headers.set('sess_archived', { cwd: DIR })
    archived = ['sess_archived']
    await assert.rejects(
      service.bindDirectoryConversation({ workspaceId: wsp.id, title: 'Archived', sessionId: 'sess_archived' }),
      (error) => error.code === 'task/source-not-bound' && error.details?.reason === 'archived'
    )
    archived = []
    headers.set('sess_current', { cwd: DIR })
    nativeId = 'native-other'
    await assert.rejects(
      service.bindDirectoryConversation({ workspaceId: wsp.id, title: 'Stale', sessionId: 'sess_current' }),
      (error) => error.code === 'task/source-not-bound'
    )
    nativeId = 'native-1'
    archivedKnown = false
    headers.set('sess_unknown', { cwd: DIR })
    await assert.rejects(
      service.bindDirectoryConversation({ workspaceId: wsp.id, title: 'Unknown', sessionId: 'sess_unknown' }),
      (error) => error.code === 'task/unavailable'
    )
    archivedKnown = true
    headers.set('sess_subagent', { cwd: DIR, origin: 'subagent' })
    await assert.rejects(
      service.bindDirectoryConversation({ workspaceId: wsp.id, title: 'X', sessionId: 'sess_subagent' }),
      (error) => error.code === 'task/subagent-session'
    )
    headers.set('sess_fork', { cwd: DIR, parentSession: 'sess_parent' })
    const bound = await service.bindDirectoryConversation({ workspaceId: wsp.id, title: 'Fork', sessionId: 'sess_fork' })
    assert.ok(bound.nodes.some((node) => node.sessionId === 'sess_fork'))

    headers.set('sess_source', { cwd: DIR })
    const sourceNode = await core.bindDirectoryConversation({ workspaceId: wsp.id, title: 'Source', sessionId: 'sess_source' })
    const conversation = sourceNode.nodes.find((node) => node.sessionId === 'sess_source')
    const target = await service.conversationTarget({ conversationId: conversation.id })
    assert.equal(target.sessionId, 'sess_source')
    archived = ['sess_source']
    await assert.rejects(
      service.conversationTarget({ conversationId: conversation.id }),
      (error) => error.code === 'task/source-not-bound'
    )
    archived = []

    // Successful pass verifies the source.
    catalogRows = [
      { kind: 'child', id: 't1', parentId: 'sess_source', depth: 1, mode: 'one-shot' },
      { kind: 'child', id: 't2', parentId: 't1', depth: 2, mode: 'one-shot' },
      { kind: 'child', id: 't3', parentId: 't1', depth: 2, mode: 'one-shot' }
    ]
    headers.set('t1', { cwd: DIR })
    headers.set('t2', { cwd: DIR })
    headers.set('t3', { cwd: DIR })
    const ok = await service.reconcileTasks({ conversationId: conversation.id })
    const okSource = ok.ledger.sources.find((entry) => entry.conversationId === conversation.id)
    assert.equal(okSource.verificationState, 'verified')
    assert.equal(typeof okSource.verifiedAt, 'string')
    assert.equal(ok.ledger.tasks.length, 3)
    const okTasks = new Map(ok.ledger.tasks.map((task) => [task.childSessionId, task]))
    assert.equal(okTasks.get('t1').depth, 1)
    assert.equal(okTasks.get('t2').depth, 2)
    assert.equal(okTasks.get('t3').depth, 2)
    assert.equal(okTasks.get('t2').parent.kind, 'task')
    assert.equal(okTasks.get('t2').parent.taskId, okTasks.get('t1').taskId)
    assert.ok([...okTasks.values()].every((task) => task.executionEligibility === 'eligible'))

    // Archived source: blocked, no new edge, previous verifiedAt preserved.
    archived = ['sess_source']
    catalogRows = [{ kind: 'child', id: 't4', parentId: 'sess_source', depth: 1, mode: 'one-shot' }]
    headers.set('t4', { cwd: DIR })
    const blocked = await service.reconcileTasks({ conversationId: conversation.id })
    const blockedSource = blocked.ledger.sources.find((entry) => entry.conversationId === conversation.id)
    assert.equal(blockedSource.verificationState, 'blocked')
    assert.equal(blockedSource.blockedReason, 'source-archived')
    assert.equal(blockedSource.verifiedAt, okSource.verifiedAt)
    assert.equal(blocked.ledger.tasks.some((task) => task.childSessionId === 't4'), false)
    assert.ok(blocked.ledger.tasks.every((task) => task.executionEligibility === 'blocked'))
    assert.ok(blocked.ledger.diagnostics.some((entry) => entry.code === 'source/source-archived'))
    const project = (ledger) => ledger.tasks.map((task) => ({
      taskId: task.taskId,
      childSessionId: task.childSessionId,
      sourceConversationId: task.sourceConversationId,
      parent: task.parent,
      depth: task.depth
    })).sort((a, b) => a.childSessionId.localeCompare(b.childSessionId))
    assert.deepEqual(project(blocked.ledger), project(ok.ledger))

    // Registry archive field unavailable: fail closed, preserve identity/subtree, adopt no new edge.
    archivedKnown = false
    catalogRows = [{ kind: 'child', id: 't5', parentId: 'sess_source', depth: 1, mode: 'one-shot' }]
    headers.set('t5', { cwd: DIR })
    const unknown = await service.reconcileTasks({ conversationId: conversation.id })
    const unknownSource = unknown.ledger.sources.find((entry) => entry.conversationId === conversation.id)
    assert.equal(unknownSource.verificationState, 'blocked')
    assert.equal(unknownSource.blockedReason, 'source-archived-unknown')
    assert.equal(unknownSource.verifiedAt, okSource.verifiedAt)
    assert.equal(unknown.ledger.tasks.some((task) => task.childSessionId === 't5'), false)
    assert.ok(unknown.ledger.tasks.every((task) => task.executionEligibility === 'blocked'))
    assert.ok(unknown.ledger.diagnostics.some((entry) => entry.code === 'source/source-archived-unknown'))
    assert.deepEqual(project(unknown.ledger), project(ok.ledger))
  } finally {
    await workspace.cleanup()
  }
})
