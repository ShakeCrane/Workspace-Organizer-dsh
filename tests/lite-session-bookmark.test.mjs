import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const BUILD_ROOT = process.env.WO_LITE_TEST_BUILD_ROOT ?? fileURLToPath(new URL('../build/', import.meta.url))
const [{ OrganizerCore }, { WorkspaceOrganizerService }] = await Promise.all([
  import(pathToFileURL(join(BUILD_ROOT, 'core/service.js')).href),
  import(pathToFileURL(join(BUILD_ROOT, 'service.js')).href)
])

class MemoryRepository {
  value = null
  location = 'memory://lite-session-test'

  async load() {
    return this.value
  }

  async save(next, expectedRevision) {
    const currentRevision = this.value?.revision ?? 0
    assert.equal(currentRevision, expectedRevision, 'core must save against its loaded revision')
    this.value = next
  }
}

function createHarness(headers = new Map()) {
  const repository = new MemoryRepository()
  let nextId = 0
  const core = new OrganizerCore({
    repository,
    newId: (kind) => `${kind}-${++nextId}`
  })
  const reads = []
  const host = {
    get(name) {
      if (name !== 'sessionQuery') return undefined
      return {
        async readSession(sessionId) {
          reads.push(sessionId)
          const session = headers.get(sessionId)
          return session === undefined ? undefined : { session }
        }
      }
    }
  }
  const service = new WorkspaceOrganizerService({
    core,
    sessions: {
      available: () => false,
      reason: () => 'creation disabled in Lite',
      dependencies: () => ({ sessionController: true, connection: true, fileUploads: true, sessions: true }),
      async create() { throw new Error('Session creation must not run') }
    },
    host,
    dataDir: 'memory://lite-session-test',
    tasks: {}
  })
  return { core, service, reads }
}

test('links a readable existing Session to a nested Project without attaching its cwd', async () => {
  const headers = new Map([['native-42', { cwd: 'E:\\Existing\\Work', origin: 'interactive' }]])
  const { service } = createHarness(headers)
  const initial = await service.snapshot()
  const folder = await service.createProject({ parentId: initial.rootId, title: 'Projects' })
  const parent = folder.nodes.find((node) => node.title === 'Projects')
  const nested = await service.createProject({ parentId: parent.id, title: 'Research' })
  const targetFolder = nested.nodes.find((node) => node.title === 'Research')

  const linked = await service.linkExistingSession({ projectId: targetFolder.id, title: 'Existing chat', sessionId: ' native-42 ' })
  const conversation = linked.nodes.find((node) => node.kind === 'conversation')
  assert.ok(conversation)
  assert.equal(conversation.parentId, targetFolder.id)
  assert.equal(conversation.sessionId, 'native-42')
  assert.equal(conversation.cwd, undefined, 'a Project bookmark must not inherit the Session cwd')
  assert.equal(headers.get('native-42').cwd, 'E:\\Existing\\Work', 'the host Session record stays untouched')

  const target = await service.conversationTarget({ conversationId: conversation.id })
  assert.equal(target.sessionId, 'native-42')
  assert.equal(target.conversationId, conversation.id)
})

test('refuses unknown, subagent, duplicate, and Root links without changing the tree', async () => {
  const headers = new Map([
    ['ordinary', { cwd: 'E:\\Work', origin: 'interactive' }],
    ['child-agent', { cwd: 'E:\\Work', origin: 'subagent' }]
  ])
  const { service, reads } = createHarness(headers)
  const initial = await service.snapshot()
  const created = await service.createProject({ parentId: initial.rootId, title: 'Folder' })
  const folder = created.nodes.find((node) => node.title === 'Folder')

  await assert.rejects(
    service.linkExistingSession({ projectId: folder.id, title: 'Missing', sessionId: 'not-readable' }),
    (error) => error.code === 'task/unavailable'
  )
  await assert.rejects(
    service.linkExistingSession({ projectId: folder.id, title: 'Agent', sessionId: 'child-agent' }),
    (error) => error.code === 'task/subagent-session'
  )
  const linked = await service.linkExistingSession({ projectId: folder.id, title: 'Existing', sessionId: 'ordinary' })
  const linkedNode = linked.nodes.find((node) => node.kind === 'conversation')
  const beforeDuplicate = await service.snapshot()
  await assert.rejects(
    service.linkExistingSession({ projectId: initial.rootId, title: 'Duplicate', sessionId: 'ordinary' }),
    (error) => error.code === 'tree/invalid-parent-kind'
  )
  const otherFolder = await service.createProject({ parentId: initial.rootId, title: 'Other' })
  const other = otherFolder.nodes.find((node) => node.title === 'Other')
  const beforeSecondLink = await service.snapshot()
  await assert.rejects(
    service.linkExistingSession({ projectId: other.id, title: 'Duplicate', sessionId: 'ordinary' }),
    (error) => error.code === 'tree/duplicate-session'
  )

  assert.deepEqual(await service.snapshot(), beforeSecondLink)
  assert.ok(beforeSecondLink.nodes.some((node) => node.id === linkedNode.id))
  assert.notDeepEqual(beforeDuplicate, beforeSecondLink, 'the second folder creation is independent of the refused link')
  assert.deepEqual(reads, ['not-readable', 'child-agent', 'ordinary', 'ordinary'])
})

test('moving a Project folder rejects cycles and invalid parents', async () => {
  const { service } = createHarness()
  const initial = await service.snapshot()
  const aTree = await service.createProject({ parentId: initial.rootId, title: 'A' })
  const a = aTree.nodes.find((node) => node.title === 'A')
  const bTree = await service.createProject({ parentId: a.id, title: 'B' })
  const b = bTree.nodes.find((node) => node.title === 'B')
  const before = await service.snapshot()

  await assert.rejects(service.move({ id: a.id, parentId: b.id }), (error) => error.code === 'tree/cycle')
  await assert.rejects(service.move({ id: a.id, parentId: 'missing-folder' }), (error) => error.code === 'tree/unknown-node')
  assert.deepEqual(await service.snapshot(), before)
})
