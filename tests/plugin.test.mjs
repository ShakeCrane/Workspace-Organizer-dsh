/**
 * Plugin contract on a real Cordis context:
 *
 * - the Session port reads the live context, so a service provided after the
 *   plugin activated is visible (Reviewer Finding 1);
 * - the diagnostic wait does not stop early just because Typert appeared
 *   (Reviewer Finding 2);
 * - conversation creation is refused before any Session-creating call;
 * - disabling the fiber withdraws the service and drains queued writes.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { apply, DIAGNOSTICS_ENV, SERVICE_KEY, settleHostServices } from '../build/index.js'
import { OrganizerError } from '../build/core/errors.js'
import { ROOT_ID } from '../build/core/model.js'
import { collectModuleIdentity } from '../build/host/identity.js'

const TMP_ROOT = fileURLToPath(new URL('../build/.tmp/', import.meta.url))

async function area(label) {
  const dir = await mkdtemp(join(TMP_ROOT, `${label}-`))
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

async function host(dataDir) {
  const root = new Context()
  const fiber = root.plugin({
    name: 'workspace-organizer-test-host',
    apply(ctx) {
      apply(ctx, { dataDir })
    }
  })
  await fiber.await()
  return {
    root,
    async dispose() {
      await fiber.dispose()
    }
  }
}

function sessionController() {
  let calls = 0
  return {
    calls: () => calls,
    service: {
      async create() {
        calls += 1
        return { sessionId: 'session-from-controller' }
      }
    }
  }
}

test('the plugin registers the service and reports the blocked capability honestly', async () => {
  const workspace = await area('plugin-status')
  const running = await host(workspace.dir)
  try {
    const service = running.root.get(SERVICE_KEY)
    assert.ok(service, 'service must be registered under its documented key')
    const status = service.status()
    assert.equal(status.conversationsCreatable, false)
    assert.equal(status.conversationCreation.supported, false)
    assert.ok(status.conversationCreation.reason.length > 0)
    const facts = new Map(status.capabilities.map((fact) => [fact.name, fact.available]))
    assert.equal(facts.get('conversation.noDirectoryMode'), false)
    assert.match(status.treeLocation, /tree\.json$/)
  } finally {
    await running.dispose()
    await workspace.cleanup()
  }
})

test('a Session Controller provided after activation is visible (live context, no snapshot)', async () => {
  const workspace = await area('plugin-late')
  const running = await host(workspace.dir)
  try {
    const service = running.root.get(SERVICE_KEY)
    assert.equal(service.status().services.sessionController, false)

    const controller = sessionController()
    running.root.provide('sessionController', controller.service)

    const status = service.status()
    assert.equal(status.services.sessionController, true)
    assert.equal(status.conversationCreation.dependencies.sessionController, true)
    // Presence never turns into permission: the no-directory gate stays shut.
    assert.equal(status.conversationsCreatable, false)
  } finally {
    await running.dispose()
    await workspace.cleanup()
  }
})

test('conversation creation is refused before the controller is called', async () => {
  const workspace = await area('plugin-failclosed')
  const running = await host(workspace.dir)
  try {
    const controller = sessionController()
    running.root.provide('sessionController', controller.service)
    const service = running.root.get(SERVICE_KEY)
    await service.createProject({ parentId: ROOT_ID, title: 'Client work' })

    await assert.rejects(
      service.createConversation({ parentId: ROOT_ID, title: 'Kickoff' }),
      (error) => {
        assert.ok(error instanceof OrganizerError)
        assert.equal(error.code, 'session/no-directory-unsupported')
        assert.equal(error.details.fallback, 'workspace.path ?? request.cwd ?? process.cwd()')
        return true
      }
    )
    assert.equal(controller.calls(), 0, 'no Session-creating call may happen')
    const snapshot = await service.snapshot()
    assert.equal(snapshot.nodes.filter((node) => node.kind === 'conversation').length, 0)
    assert.equal(snapshot.revision, 1)
  } finally {
    await running.dispose()
    await workspace.cleanup()
  }
})

test('without a controller the refusal names the missing service', async () => {
  const workspace = await area('plugin-nosession')
  const running = await host(workspace.dir)
  try {
    const service = running.root.get(SERVICE_KEY)
    await assert.rejects(
      service.createConversation({ parentId: ROOT_ID, title: 'Kickoff' }),
      (error) => error instanceof OrganizerError && error.code === 'session/unavailable'
    )
    assert.equal((await service.snapshot()).nodes.length, 1)
  } finally {
    await running.dispose()
    await workspace.cleanup()
  }
})

test('settling waits for the Session dependency chain, not for early Typert', async () => {
  const services = new Map()
  const hostLike = { get: (name) => services.get(name) }
  services.set('typert', { register() {} })
  const started = Date.now()
  const settled = await settleHostServices(hostLike, 300)
  const waited = Date.now() - started

  assert.equal(settled.satisfied, false)
  assert.ok(waited >= 250, `expected a bounded wait, observed ${String(waited)}ms`)
  assert.ok(settled.missing.includes('sessionController'))
  assert.equal(settled.presence.typert, true, 'Typert presence must not end the wait')
})

test('settling returns as soon as the controller is provided', async () => {
  const services = new Map()
  const hostLike = { get: (name) => services.get(name) }
  setTimeout(() => services.set('sessionController', { create() {} }), 120)
  const settled = await settleHostServices(hostLike, 5_000)
  assert.equal(settled.satisfied, true)
  assert.equal(settled.presence.sessionController, true)
})

test('a relative data directory is refused before any write', async () => {
  const workspace = await area('plugin-relative')
  try {
    const root = new Context()
    await assert.rejects(
      root.plugin({
        name: 'workspace-organizer-relative',
        apply(ctx) {
          apply(ctx, { dataDir: 'relative\\path' })
        }
      }).then((fiber) => fiber.await()),
      (error) => error instanceof OrganizerError && error.code === 'host/unavailable'
    )
  } finally {
    await workspace.cleanup()
  }
})

test('disabling the fiber withdraws the service and drains queued writes', async () => {
  const workspace = await area('plugin-dispose')
  const running = await host(workspace.dir)
  try {
    const service = running.root.get(SERVICE_KEY)
    await service.createProject({ parentId: ROOT_ID, title: 'Alpha' })
    await running.dispose()

    assert.equal(running.root.get(SERVICE_KEY), undefined)
    assert.equal(running.root.get('workspaceOrganizerRemote'), undefined)
    const stored = JSON.parse(await readFile(join(workspace.dir, 'workspace-organizer', 'tree.json'), 'utf8'))
    assert.equal(stored.revision, 1)
  } finally {
    await workspace.cleanup()
  }
})

test('the diagnostics flag records the settled dependency facts', async () => {
  const workspace = await area('plugin-diagnostics')
  const previousDiagnostics = process.env[DIAGNOSTICS_ENV]
  const previousSettle = process.env.DSH_WORKSPACE_ORGANIZER_SETTLE_MS
  try {
    process.env[DIAGNOSTICS_ENV] = '1'
    process.env.DSH_WORKSPACE_ORGANIZER_SETTLE_MS = '400'
    const running = await host(workspace.dir)
    const reportPath = join(workspace.dir, 'workspace-organizer', 'diagnostics.json')

    let report
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        report = JSON.parse(await readFile(reportPath, 'utf8'))
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    await running.dispose()

    assert.ok(report, 'diagnostics.json must be written when the flag is set')
    assert.equal(report.plugin, 'workspace-organizer')
    assert.equal(report.settle.satisfied, false)
    assert.ok(report.settle.waitedMs >= 350, `settle must consume its bounded window, saw ${String(report.settle.waitedMs)}`)
    assert.ok(report.settle.missing.includes('sessionController'))
    assert.equal(report.status.conversationsCreatable, false)
    assert.equal(report.remoteNamespace, 'workspaceOrganizer')
    assert.equal(report.remoteService, true)
    assert.ok(Array.isArray(report.registeredServices))
  } finally {
    if (previousDiagnostics === undefined) delete process.env[DIAGNOSTICS_ENV]
    else process.env[DIAGNOSTICS_ENV] = previousDiagnostics
    if (previousSettle === undefined) delete process.env.DSH_WORKSPACE_ORGANIZER_SETTLE_MS
    else process.env.DSH_WORKSPACE_ORGANIZER_SETTLE_MS = previousSettle
    await workspace.cleanup()
  }
})

test('the module-identity probe recognizes the host Context class', async () => {
  const root = new Context()
  const identity = await collectModuleIdentity(root)
  assert.match(String(identity.pluginModule), /host[\\/]identity\.js$/u)
  assert.equal(identity.cordis.contextBrand, true)
  assert.equal(identity.cordis.instanceOfContext, true)
  assert.equal(identity.cordis.prototypeMatch, true)
  assert.equal(identity.protocol.sameServiceClass, true)
  assert.equal(identity.protocol.sameRemoteDecorator, true)
  assert.match(identity.cordis.resolved, /cordis/u)
  assert.match(identity.protocol.resolved, /dsh-typert-protocol/u)
})
