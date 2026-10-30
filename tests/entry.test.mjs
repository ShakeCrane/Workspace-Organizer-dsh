/**
 * Entry contract: the plugin advertises its documented name, refuses a context
 * that cannot register a service, and owns exactly one lifecycle hook on a real
 * Cordis context.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { apply, name, SERVICE_KEY } from '../build/index.js'
import { OrganizerError } from '../build/core/errors.js'

const TMP_ROOT = fileURLToPath(new URL('../build/.tmp/', import.meta.url))

test('the entry declares its plugin name and service key', () => {
  assert.equal(name, 'workspace-organizer')
  assert.equal(SERVICE_KEY, 'workspaceOrganizer')
})

test('a context without provide is rejected instead of silently doing nothing', () => {
  assert.throws(
    () => apply({ effect() {} }),
    (error) => error instanceof OrganizerError && error.code === 'host/unavailable'
  )
})

test('apply registers the service and its Remote namespace on one fiber', async () => {
  const dir = await mkdtemp(join(TMP_ROOT, 'entry-'))
  const root = new Context()
  try {
    const fiber = root.plugin({
      name: 'workspace-organizer-entry',
      apply(ctx) {
        apply(ctx, { dataDir: dir })
      }
    })
    await fiber.await()

    assert.equal(root.get(SERVICE_KEY) !== undefined, true)
    assert.equal(root.get('workspaceOrganizerRemote') !== undefined, true)

    await fiber.dispose()
    assert.equal(root.get(SERVICE_KEY), undefined)
    assert.equal(root.get('workspaceOrganizerRemote'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
