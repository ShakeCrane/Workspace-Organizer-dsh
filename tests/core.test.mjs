/**
 * Core tree invariants: stable identity, single parent, nesting rules, and the
 * refusal paths that protect user data.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { OrganizerError } from '../build/core/errors.js'
import {
  createEmptyTree,
  ROOT_ID,
  toRows,
  toSnapshot,
  validateDocument
} from '../build/core/model.js'
import {
  bindDirectoryConversation,
  createConversation,
  createProject,
  moveNode,
  registerWorkspace,
  renameNode
} from '../build/core/ops.js'

const NOW = '2026-10-20T00:00:00.000Z'

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof OrganizerError, `expected OrganizerError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

test('an empty tree carries exactly one project root', () => {
  const tree = createEmptyTree(NOW)
  assert.equal(tree.schemaVersion, 2)
  assert.equal(tree.revision, 0)
  assert.equal(tree.rootId, ROOT_ID)
  assert.equal(tree.nodes.length, 1)
  assert.equal(tree.nodes[0].id, ROOT_ID)
  assert.equal(tree.nodes[0].kind, 'project')
  assert.equal(tree.nodes[0].parentId, null)
  assert.deepEqual(toRows(tree).map((row) => row.node.id), [ROOT_ID])
})

test('projects nest and a conversation maps one real Session without becoming it', () => {
  let tree = createEmptyTree(NOW)
  tree = createProject(tree, { parentId: ROOT_ID, title: '  Client work  ', id: 'prj_a', now: NOW })
  tree = createProject(tree, { parentId: 'prj_a', title: 'Website', id: 'prj_b', now: NOW })
  tree = createConversation(tree, {
    parentId: 'prj_b',
    title: 'Kickoff',
    sessionId: 'session-1',
    id: 'cnv_a',
    now: NOW
  })

  assert.equal(tree.revision, 3)
  const conversation = tree.nodes.find((node) => node.id === 'cnv_a')
  assert.equal(conversation.parentId, 'prj_b')
  assert.equal(conversation.title, 'Kickoff')
  assert.equal(conversation.sessionId, 'session-1')
  assert.notEqual(conversation.id, conversation.sessionId)
  assert.equal(conversation.cwd, undefined)

  const rows = toRows(tree)
  const rootChildren = rows[0].children.map((row) => row.node.id)
  assert.deepEqual(rootChildren, ['prj_a'])
  assert.deepEqual(rows[0].children[0].children.map((row) => row.node.id), ['prj_b'])
  assert.deepEqual(rows[0].children[0].children[0].children.map((row) => row.node.id), ['cnv_a'])
})

test('a conversation is terminal and requires a distinct Session id', () => {
  let tree = createEmptyTree(NOW)
  tree = createConversation(tree, { parentId: ROOT_ID, title: 'Loose chat', sessionId: 'session-1', id: 'cnv_a', now: NOW })

  expectCode(
    () => createConversation(tree, { parentId: 'cnv_a', title: 'Nested', sessionId: 'session-2', id: 'cnv_b', now: NOW }),
    'tree/invalid-parent-kind'
  )
  expectCode(
    () => createConversation(tree, { parentId: ROOT_ID, title: 'Again', sessionId: 'session-1', id: 'cnv_b', now: NOW }),
    'tree/duplicate-session'
  )
  expectCode(
    () => createConversation(tree, { parentId: ROOT_ID, title: 'No session', sessionId: '', id: 'cnv_c', now: NOW }),
    'tree/invalid-session'
  )
  expectCode(
    () => createConversation(tree, { parentId: ROOT_ID, title: 'Self', sessionId: 'cnv_d', id: 'cnv_d', now: NOW }),
    'tree/invalid-session'
  )
})

test('titles, parents, and duplicate ids are rejected with stable codes', () => {
  let tree = createEmptyTree(NOW)
  tree = createProject(tree, { parentId: ROOT_ID, title: 'A', id: 'prj_a', now: NOW })

  expectCode(() => createProject(tree, { parentId: ROOT_ID, title: '   ', id: 'prj_b', now: NOW }), 'tree/invalid-title')
  expectCode(
    () => createProject(tree, { parentId: ROOT_ID, title: 'x'.repeat(201), id: 'prj_b', now: NOW }),
    'tree/invalid-title'
  )
  expectCode(() => createProject(tree, { parentId: 'missing', title: 'B', id: 'prj_b', now: NOW }), 'tree/unknown-node')
  expectCode(() => createProject(tree, { parentId: ROOT_ID, title: 'B', id: 'prj_a', now: NOW }), 'tree/duplicate-id')
  expectCode(() => renameNode(tree, { id: 'missing', title: 'B', now: NOW }), 'tree/unknown-node')
})

test('moving a project changes only the logical parent', () => {
  let tree = createEmptyTree(NOW)
  tree = createProject(tree, { parentId: ROOT_ID, title: 'A', id: 'prj_a', now: NOW })
  tree = createProject(tree, { parentId: ROOT_ID, title: 'B', id: 'prj_b', now: NOW })
  tree = registerWorkspace(tree, {
    parentId: 'prj_a',
    title: 'W',
    directory: 'E:\\work\\a',
    nativeWorkspaceId: 'native-a',
    id: 'wsp_a',
    now: NOW
  })
  tree = bindDirectoryConversation(tree, {
    workspaceId: 'wsp_a',
    title: 'Chat',
    sessionId: 'session-1',
    id: 'cnv_a',
    now: NOW
  })
  const before = tree.nodes.find((node) => node.id === 'cnv_a')

  tree = moveNode(tree, { id: 'prj_a', parentId: 'prj_b', now: '2026-10-20T01:00:00.000Z' })
  const after = tree.nodes.find((node) => node.id === 'cnv_a')

  assert.equal(tree.nodes.find((node) => node.id === 'prj_a').parentId, 'prj_b')
  assert.equal(after.parentId, 'wsp_a')
  assert.equal(after.sessionId, before.sessionId)
  assert.equal(after.cwd, before.cwd)
  assert.equal(after.updatedAt, before.updatedAt, 'moving an ancestor must not touch descendant rows')
})

test('a project cannot move into itself or a descendant, and the root cannot move', () => {
  let tree = createEmptyTree(NOW)
  tree = createProject(tree, { parentId: ROOT_ID, title: 'A', id: 'prj_a', now: NOW })
  tree = createProject(tree, { parentId: 'prj_a', title: 'B', id: 'prj_b', now: NOW })

  expectCode(() => moveNode(tree, { id: 'prj_a', parentId: 'prj_a', now: NOW }), 'tree/cycle')
  expectCode(() => moveNode(tree, { id: 'prj_a', parentId: 'prj_b', now: NOW }), 'tree/cycle')
  expectCode(() => moveNode(tree, { id: ROOT_ID, parentId: 'prj_a', now: NOW }), 'tree/root-invariant')
})

test('renaming is a no-op when the normalized title is unchanged', () => {
  let tree = createEmptyTree(NOW)
  tree = createProject(tree, { parentId: ROOT_ID, title: 'Alpha', id: 'prj_a', now: NOW })
  const same = renameNode(tree, { id: 'prj_a', title: '  Alpha  ', now: '2026-10-21T00:00:00.000Z' })
  assert.equal(same, tree)
  assert.equal(same.revision, 1)

  const renamed = renameNode(tree, { id: 'prj_a', title: 'Beta', now: '2026-10-21T00:00:00.000Z' })
  assert.equal(renamed.revision, 2)
  assert.equal(renamed.nodes.find((node) => node.id === 'prj_a').title, 'Beta')
  assert.equal(renamed.nodes.find((node) => node.id === 'prj_a').createdAt, NOW)
})

test('validation refuses wrong versions, duplicate ids, dangling parents, cycles, and two roots', () => {
  const valid = createEmptyTree(NOW)
  assert.equal(validateDocument(JSON.parse(JSON.stringify(valid))).revision, 0)

  expectCode(() => validateDocument({ ...valid, schemaVersion: 99 }), 'tree/invalid-schema-version')
  expectCode(() => validateDocument({ ...valid, nodes: [] }), 'tree/invalid-document')
  expectCode(
    () => validateDocument({ ...valid, nodes: [...valid.nodes, { ...valid.nodes[0] }] }),
    'tree/duplicate-id'
  )
  expectCode(
    () => validateDocument({
      ...valid,
      nodes: [...valid.nodes, { id: 'prj_x', kind: 'project', parentId: 'ghost', title: 'X', createdAt: NOW, updatedAt: NOW }]
    }),
    'tree/unknown-parent'
  )
  expectCode(
    () => validateDocument({
      ...valid,
      nodes: [
        ...valid.nodes,
        { id: 'prj_a', kind: 'project', parentId: 'prj_b', title: 'A', createdAt: NOW, updatedAt: NOW },
        { id: 'prj_b', kind: 'project', parentId: 'prj_a', title: 'B', createdAt: NOW, updatedAt: NOW }
      ]
    }),
    'tree/cycle'
  )
  expectCode(
    () => validateDocument({
      ...valid,
      nodes: [...valid.nodes, { id: 'prj_other', kind: 'project', parentId: null, title: 'Other', createdAt: NOW, updatedAt: NOW }]
    }),
    'tree/root-invariant'
  )
  expectCode(
    () => validateDocument({
      ...valid,
      nodes: [...valid.nodes, { id: 'cnv_x', kind: 'conversation', parentId: ROOT_ID, title: 'No mapping', createdAt: NOW, updatedAt: NOW }]
    }),
    'tree/invalid-session'
  )
})

test('snapshots expose no storage handle and cannot be mutated by a consumer', () => {
  let tree = createEmptyTree(NOW)
  tree = createProject(tree, { parentId: ROOT_ID, title: 'Alpha', id: 'prj_a', now: NOW })
  const snapshot = toSnapshot(tree)
  assert.equal(snapshot.revision, 1)
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot.nodes))
  assert.ok(Object.isFrozen(snapshot.nodes[0]))
  assert.equal(Object.hasOwn(snapshot, 'schemaVersion'), false)
})
