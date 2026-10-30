/**
 * Persistence contract: one versioned aggregate, atomic replacement, stale-write
 * refusal, fail-closed corruption handling, and stable identity across restart.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { OrganizerError } from '../build/core/errors.js'
import { JsonTreeRepository } from '../build/core/repository.js'
import { OrganizerCore } from '../build/core/service.js'
import { ROOT_ID } from '../build/core/model.js'

const TMP_ROOT = fileURLToPath(new URL('../build/.tmp/', import.meta.url))
await mkdir(TMP_ROOT, { recursive: true })

async function workdir(label) {
  const dir = await mkdtemp(join(TMP_ROOT, `${label}-`))
  return {
    dir,
    file: join(dir, 'tree.json'),
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

test('logical ids and parent relations survive a full restart', async () => {
  const area = await workdir('restart')
  try {
    const first = new OrganizerCore({ repository: new JsonTreeRepository(area.file) })
    const created = await first.createProject({ parentId: ROOT_ID, title: 'Client work' })
    const project = created.nodes.find((node) => node.title === 'Client work')
    await first.attachConversation({ parentId: project.id, title: 'Kickoff', sessionId: 'session-123' })
    const before = await first.snapshot()

    // A new process would build a new repository and core over the same file.
    const second = new OrganizerCore({ repository: new JsonTreeRepository(area.file) })
    const after = await second.snapshot()

    assert.deepEqual(after, before)
    assert.equal(after.revision, before.revision)
    const conversation = after.nodes.find((node) => node.sessionId === 'session-123')
    assert.equal(conversation.parentId, project.id)
    assert.equal(conversation.id, before.nodes.find((node) => node.sessionId === 'session-123').id)
    assert.notEqual(conversation.id, 'session-123')

    const raw = JSON.parse(await readFile(area.file, 'utf8'))
    assert.equal(raw.schemaVersion, 2)
    assert.equal(raw.revision, before.revision)
  } finally {
    await area.cleanup()
  }
})

test('reading a snapshot does not create storage', async () => {
  const area = await workdir('readonly')
  try {
    const core = new OrganizerCore({ repository: new JsonTreeRepository(area.file) })
    const snapshot = await core.snapshot()
    assert.equal(snapshot.revision, 0)
    assert.equal(snapshot.nodes.length, 1)
    await assert.rejects(readFile(area.file, 'utf8'), (error) => error.code === 'ENOENT')
  } finally {
    await area.cleanup()
  }
})

test('a stale writer is refused and the newer tree is preserved', async () => {
  const area = await workdir('conflict')
  try {
    const repositoryA = new JsonTreeRepository(area.file)
    const repositoryB = new JsonTreeRepository(area.file)
    const coreA = new OrganizerCore({ repository: repositoryA })
    const coreB = new OrganizerCore({ repository: repositoryB })

    await coreA.createProject({ parentId: ROOT_ID, title: 'First writer' })
    await coreB.createProject({ parentId: ROOT_ID, title: 'Second writer' })

    // Both cores wrote in sequence; a save carrying an older expected revision
    // must be refused instead of rolling the stored tree back.
    const stale = await repositoryA.load()
    const current = await repositoryB.load()
    assert.equal(stale.revision, current.revision)
    await assert.rejects(
      repositoryA.save({ ...stale, revision: stale.revision + 1 }, stale.revision - 1),
      (error) => error instanceof OrganizerError && error.code === 'tree/conflict'
    )
    const after = await repositoryB.load()
    assert.equal(after.revision, current.revision)
    assert.ok(after.nodes.some((node) => node.title === 'Second writer'))
  } finally {
    await area.cleanup()
  }
})

test('concurrent host calls serialize into one revision per mutation', async () => {
  const area = await workdir('serial')
  try {
    const core = new OrganizerCore({ repository: new JsonTreeRepository(area.file) })
    await Promise.all(Array.from({ length: 12 }, (_, index) => core.createProject({
      parentId: ROOT_ID,
      title: `Project ${String(index)}`
    })))
    const snapshot = await core.snapshot()
    assert.equal(snapshot.revision, 12)
    assert.equal(snapshot.nodes.length, 13)
    assert.equal(new Set(snapshot.nodes.map((node) => node.id)).size, 13)
  } finally {
    await area.cleanup()
  }
})

test('corruption and unknown schema versions fail closed without being rewritten', async () => {
  const area = await workdir('corrupt')
  try {
    const repository = new JsonTreeRepository(area.file)
    await writeFile(area.file, '{ not json', 'utf8')
    await assert.rejects(repository.load(), (error) => error instanceof OrganizerError && error.code === 'tree/corrupt')
    assert.equal(await readFile(area.file, 'utf8'), '{ not json')

    await writeFile(area.file, JSON.stringify({ schemaVersion: 99, revision: 0, rootId: ROOT_ID, nodes: [] }), 'utf8')
    await assert.rejects(
      repository.load(),
      (error) => error instanceof OrganizerError && error.code === 'tree/invalid-schema-version'
    )

    await writeFile(area.file, JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      rootId: ROOT_ID,
      nodes: [
        { id: ROOT_ID, kind: 'project', parentId: null, title: 'Root', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' },
        { id: 'cnv_a', kind: 'conversation', parentId: 'ghost', title: 'X', sessionId: 's1', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' }
      ]
    }), 'utf8')
    await assert.rejects(repository.load(), (error) => error instanceof OrganizerError && error.code === 'tree/corrupt')
  } finally {
    await area.cleanup()
  }
})
