/**
 * Owner-only caller boundary against the real Typert Gateway and RemoteAccess.
 *
 * Every negative case runs against a **materialized** persistent tree: the owner
 * first creates, renames and moves nodes through the Gateway, the test asserts
 * the stored document is valid, then resets entry counters and runs the whole
 * endpoint matrix against existing and nonexistent targets. The
 * oracles are the stored bytes, revision and complete node set, the business
 * entry counters, and the Session-creation spy.
 *
 * Peers are synthesized here only because production Peers come from the Host
 * connection layer; a wire client cannot choose its principal.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

/**
 * The verification script points both roots inside its claimed run directory so
 * no subprocess writes outside it. A plain `pnpm test` run keeps the defaults.
 */
const BUILD_ROOT = process.env.WO_TEST_BUILD_ROOT ?? fileURLToPath(new URL('../build/', import.meta.url))
const TMP_ROOT = process.env.WO_TEST_TMP_ROOT ?? fileURLToPath(new URL('../build/.tmp/', import.meta.url))
await mkdir(TMP_ROOT, { recursive: true })
const { apply } = await import(pathToFileURL(join(BUILD_ROOT, 'index.js')).href)

const ENDPOINTS = [
  'status',
  'snapshot',
  'rows',
  'createProject',
  'renameNode',
  'moveNode',
  'createConversation',
  'registerWorkspace',
  'bindDirectoryConversation',
  'linkExistingSession',
  'conversationTarget',
  'reconcileTasks',
  'taskLedger'
]

/** Endpoint → service method (the Remote names several of them differently). */
const SERVICE_METHOD = {
  status: 'status',
  snapshot: 'snapshot',
  rows: 'rows',
  createProject: 'createProject',
  renameNode: 'rename',
  moveNode: 'move',
  createConversation: 'createConversation',
  registerWorkspace: 'registerWorkspace',
  bindDirectoryConversation: 'bindDirectoryConversation',
  linkExistingSession: 'linkExistingSession',
  conversationTarget: 'conversationTarget',
  reconcileTasks: 'reconcileTasks',
  taskLedger: 'taskLedger'
}

const ACTIONS = ENDPOINTS.map((method) => `workspaceOrganizer/${method}`)
const MISSING = 'test-missing-node'

function peerFor(root, kind, id) {
  return {
    id,
    ctx: root,
    principal: { kind },
    signal: new AbortController().signal,
    interactions: 'none',
    dispose: async () => undefined
  }
}

async function compose(dataDir) {
  const root = new Context()
  const fibers = []
  const track = (fiber) => {
    fibers.push(fiber)
    return fiber
  }

  let sessionCreateCalls = 0
  root.provide('sessionController', {
    async create() {
      sessionCreateCalls += 1
      return { sessionId: 'unexpected-session' }
    }
  })

  await track(root.plugin(TypertRegistry)).await()
  await track(root.plugin(RemoteAccessService)).await()
  await track(root.plugin(TypertGatewayService, {})).await()
  await track(root.plugin({
    name: 'workspace-organizer-authorization-host',
    apply(ctx) {
      apply(ctx, { dataDir })
    }
  })).await()

  const gateway = root.get('typertGateway')
  const remoteAccess = root.get('remoteAccess')
  const service = root.get('workspaceOrganizer')
  const remote = root.get('workspaceOrganizerRemote')
  assert.ok(gateway, 'typertGateway must be composed')
  assert.ok(remoteAccess, 'remoteAccess must be composed')
  assert.ok(service, 'workspaceOrganizer must be registered')
  assert.ok(remote, 'workspaceOrganizerRemote must be registered')

  const entries = Object.fromEntries(ENDPOINTS.map((name) => [name, 0]))
  for (const [endpoint, method] of Object.entries(SERVICE_METHOD)) {
    const original = service[method].bind(service)
    service[method] = (...args) => {
      entries[endpoint] += 1
      return original(...args)
    }
  }

  return {
    root,
    gateway,
    remoteAccess,
    service,
    remote,
    entries,
    resetCounters() {
      for (const endpoint of ENDPOINTS) entries[endpoint] = 0
    },
    totalEntries: () => ENDPOINTS.reduce((sum, endpoint) => sum + entries[endpoint], 0),
    /** The spy was installed before the plugin activated, so a zero is meaningful. */
    sessionSpyInstalled: true,
    sessionCalls: () => sessionCreateCalls,
    async dispose() {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  }
}

const treePath = (dataDir) => join(dataDir, 'workspace-organizer', 'tree.json')

/**
 * Read the persisted tree strictly. A missing or corrupt document must fail the
 * test, never degrade into "unchanged" via an undefined comparison.
 */
async function readTreeStrict(dataDir) {
  const raw = await readFile(treePath(dataDir), 'utf8')
  const document = JSON.parse(raw)
  assert.equal(document.schemaVersion, 2, 'persisted tree must be schema version 2')
  assert.equal(typeof document.revision, 'number')
  assert.ok(Array.isArray(document.nodes) && document.nodes.length >= 1, 'persisted tree must carry nodes')
  return {
    sha256: createHash('sha256').update(raw).digest('hex'),
    revision: document.revision,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      parentId: node.parentId,
      title: node.title
    }))
  }
}

async function invoke(gateway, peer, method, args = {}) {
  try {
    const value = await gateway.invoke({
      namespace: 'workspaceOrganizer',
      method,
      args,
      peer,
      signal: new AbortController().signal
    })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, code: error?.code, details: error?.details, message: error?.message }
  }
}

/** Owner seeds a real tree through the Gateway and returns the node ids. */
async function seedTree(gateway, owner) {
  const a = await invoke(gateway, owner, 'createProject', { request: { parentId: 'root', title: 'Seed A' } })
  assert.equal(a.ok, true, JSON.stringify(a))
  const alpha = a.value.nodes.find((node) => node.title === 'Seed A')
  assert.ok(alpha)

  const b = await invoke(gateway, owner, 'createProject', { request: { parentId: 'root', title: 'Seed B' } })
  assert.equal(b.ok, true, JSON.stringify(b))
  const beta = b.value.nodes.find((node) => node.title === 'Seed B')
  assert.ok(beta)

  const renamed = await invoke(gateway, owner, 'renameNode', { request: { id: beta.id, title: 'Seed B renamed' } })
  assert.equal(renamed.ok, true, JSON.stringify(renamed))

  const moved = await invoke(gateway, owner, 'moveNode', { request: { id: beta.id, parentId: alpha.id } })
  assert.equal(moved.ok, true, JSON.stringify(moved))
  assert.equal(moved.value.nodes.find((node) => node.id === beta.id).parentId, alpha.id)

  return { alpha: alpha.id, beta: beta.id }
}

/** One endpoint's args against an existing or a nonexistent target. */
function endpointArgs(method, target, secondary, forged) {
  const extra = forged ? { principal: { kind: 'owner' }, peer: { principal: { kind: 'owner' } }, owner: true } : {}
  switch (method) {
    case 'createProject':
      return { request: { parentId: target, title: 'Refused project', ...extra } }
    case 'renameNode':
      return { request: { id: target, title: 'Refused rename', ...extra } }
    case 'moveNode':
      return { request: { id: target, parentId: secondary, ...extra } }
    case 'createConversation':
      return { request: { parentId: target, title: 'Refused conversation', ...extra } }
    case 'registerWorkspace':
      return { request: { parentId: target, title: 'Refused workspace', directory: 'E:\\refused', ...extra } }
    case 'bindDirectoryConversation':
      return { request: { workspaceId: target, title: 'Refused binding', sessionId: secondary, ...extra } }
    case 'linkExistingSession':
      return { request: { projectId: target, title: 'Refused link', sessionId: secondary, ...extra } }
    case 'reconcileTasks':
      return { request: { conversationId: target, ...extra } }
    default:
      return {}
  }
}

/** Run every endpoint against an existing and a missing target. */
async function runMatrix(gateway, peer, ids, { forged = false } = {}) {
  const observed = []
  let entered = false
  for (const method of ENDPOINTS) {
    for (const target of [ids.alpha, MISSING]) {
      const secondary = target === ids.alpha ? ids.beta : MISSING
      const result = await invoke(gateway, peer, method, endpointArgs(method, target, secondary, forged))
      if (result.ok) entered = true
      observed.push({ method, target, code: result.code, details: result.details, message: result.message })
    }
  }
  return { observed, entered }
}

function assertAllCodes(observed, expected) {
  for (const entry of observed) {
    assert.equal(entry.code, expected, `${entry.method} → ${String(entry.code)} (target ${entry.target})`)
  }
}

test('owner dispatch and mutations build a valid persistent tree; the conversation refusal stays', async () => {
  const dir = await mkdtemp(join(TMP_ROOT, 'auth-owner-'))
  const host = await compose(dir)
  try {
    const owner = peerFor(host.root, 'owner', 'peer-owner')
    const status = await invoke(host.gateway, owner, 'status')
    assert.equal(status.ok, true, JSON.stringify(status))
    assert.equal(status.value.conversationsCreatable, false)

    const ids = await seedTree(host.gateway, owner)
    const tree = await readTreeStrict(dir)
    assert.equal(tree.revision, 4)
    assert.equal(tree.nodes.length, 3)
    assert.ok(tree.nodes.some((node) => node.id === ids.alpha && node.parentId === 'root'))
    assert.ok(tree.nodes.some((node) => node.id === ids.beta && node.parentId === ids.alpha && node.title === 'Seed B renamed'))

    const rows = await invoke(host.gateway, owner, 'rows')
    assert.equal(rows.ok, true, JSON.stringify(rows))

    const before = await readTreeStrict(dir)
    const conversation = await invoke(host.gateway, owner, 'createConversation', { request: { parentId: ids.alpha, title: 'Kickoff' } })
    assert.equal(conversation.ok, false)
    assert.equal(conversation.code, 'session/no-directory-unsupported')
    assert.equal(host.sessionSpyInstalled, true, 'the Session spy must participate for the zero to count')
    assert.equal(host.sessionCalls(), 0, 'no Session-creating call may happen')
    assert.deepEqual(await readTreeStrict(dir), before)

    assert.equal(host.entries.createProject, 2)
    assert.equal(host.entries.renameNode, 1)
    assert.equal(host.entries.moveNode, 1)
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('non-owner without a policy: every endpoint is denied and the materialized tree is byte-identical', async () => {
  const dir = await mkdtemp(join(TMP_ROOT, 'auth-default-'))
  const host = await compose(dir)
  try {
    const owner = peerFor(host.root, 'owner', 'peer-owner')
    const ids = await seedTree(host.gateway, owner)
    const before = await readTreeStrict(dir)
    host.resetCounters()

    const { observed, entered } = await runMatrix(host.gateway, peerFor(host.root, 'agent', 'peer-agent'), ids)
    assert.equal(entered, false)
    assert.equal(observed.length, ENDPOINTS.length * 2)
    assertAllCodes(observed, 'remote-access/denied')

    assert.equal(host.totalEntries(), 0)
    assert.equal(host.sessionSpyInstalled, true, 'the Session spy must participate for the zero to count')
    assert.equal(host.sessionCalls(), 0)
    assert.deepEqual(await readTreeStrict(dir), before)
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an explicit grant does not reach business code; revoking it restores the Gateway denial', async () => {
  const dir = await mkdtemp(join(TMP_ROOT, 'auth-granted-'))
  const host = await compose(dir)
  try {
    const owner = peerFor(host.root, 'owner', 'peer-owner')
    const ids = await seedTree(host.gateway, owner)
    const before = await readTreeStrict(dir)
    host.resetCounters()

    const disposePolicy = host.remoteAccess.registerPolicy('testAgent', {
      bindings: () => [{
        role: { name: 'test-allow-organizer', resource: 'global', actions: ACTIONS },
        resource: { kind: 'global' }
      }]
    })
    try {
      const { observed, entered } = await runMatrix(host.gateway, peerFor(host.root, 'testAgent', 'peer-granted'), ids, { forged: true })
      assert.equal(entered, false)
      assert.equal(observed.length, ENDPOINTS.length * 2)
      assertAllCodes(observed, 'organizer/access-denied')
      for (const entry of observed) {
        assert.deepEqual(entry.details, {}, 'a refusal must not carry tree details')
        assert.equal(entry.message, 'workspace organizer RPC is restricted to the local owner')
      }
      assert.equal(host.totalEntries(), 0)
      assert.equal(host.sessionSpyInstalled, true, 'the Session spy must participate for the zero to count')
    assert.equal(host.sessionCalls(), 0)
      assert.deepEqual(await readTreeStrict(dir), before)
    } finally {
      disposePolicy()
    }

    const revoked = await runMatrix(host.gateway, peerFor(host.root, 'testAgent', 'peer-revoked'), ids)
    assert.equal(revoked.entered, false)
    assertAllCodes(revoked.observed, 'remote-access/denied')
    assert.deepEqual(await readTreeStrict(dir), before)
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a direct call without a Gateway invocation is refused and touches nothing', async () => {
  const dir = await mkdtemp(join(TMP_ROOT, 'auth-direct-'))
  const host = await compose(dir)
  try {
    const owner = peerFor(host.root, 'owner', 'peer-owner')
    await seedTree(host.gateway, owner)
    const before = await readTreeStrict(dir)
    host.resetCounters()

    for (const method of ENDPOINTS) {
      await assert.rejects(
        host.remote[method]({}),
        (error) => error?.code === 'organizer/access-denied'
      )
    }
    assert.equal(host.totalEntries(), 0)
    assert.equal(host.sessionSpyInstalled, true, 'the Session spy must participate for the zero to count')
    assert.equal(host.sessionCalls(), 0)
    assert.deepEqual(await readTreeStrict(dir), before)
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
