/**
 * Browser-half contract, executed without a browser:
 *
 * - the bundle registers itself with the documented module id;
 * - every Remote descriptor carries a strict input codec, as the Gateway's
 *   client contribution validator requires;
 * - `apply` mounts the namespace and shadows `sidebar.workspaces` at a lower
 *   priority than the native occupation, so withdrawing it restores the native
 *   region;
 * - the cleanup functions returned by `apply` dispose both, in either order.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SOURCE_URL = new URL('../client/client.js', import.meta.url)

/** Permissive chainable stand-in for the seed Zod runtime. */
function zodStub() {
  const schema = {
    optional: () => schema,
    nullish: () => schema,
    array: () => schema,
    readonly: () => schema
  }
  return {
    string: () => schema,
    number: () => schema,
    boolean: () => schema,
    any: () => schema,
    object: () => schema,
    array: () => schema,
    union: () => schema,
    literal: () => schema,
    lazy: () => schema
  }
}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => undefined],
  useEffect: () => undefined,
  useCallback: (callback) => callback,
  useRef: (initial) => ({ current: initial })
}

async function loadBundle() {
  const source = await readFile(fileURLToPath(SOURCE_URL), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
  // The bundle is written for the browser's loader facade; evaluate it with a
  // synthetic window and hand its factory the two platform seed modules.
  // eslint-disable-next-line no-new-func
  new Function('window', source)(window)
  assert.ok(registration, 'bundle must register through window.__ModuleLoader__.load')
  const required = []
  const exports = registration.factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return reactStub
    if (specifier === 'zod') return zodStub()
    throw new Error(`unexpected require(${specifier})`)
  })
  return { registration, exports, required }
}

test('the browser bundle registers its package id and service dependencies', async () => {
  const { registration, exports } = await loadBundle()
  assert.equal(registration.id, 'workspace-organizer-dsh')
  assert.deepEqual([...exports.inject], ['slots', 'remote', 'uiWorkspace'])
})

test('every Remote descriptor declares strict input codecs and a direct invocation', async () => {
  const { exports } = await loadBundle()
  const contribution = exports.contribution
  assert.equal(contribution.package, 'workspace-organizer-dsh')
  assert.equal(contribution.descriptors.length, 13)

  const methods = contribution.descriptors.map((descriptor) => descriptor.method).sort()
  assert.deepEqual(methods, [
    'bindDirectoryConversation',
    'conversationTarget',
    'createConversation',
    'createProject',
    'linkExistingSession',
    'moveNode',
    'reconcileTasks',
    'registerWorkspace',
    'renameNode',
    'rows',
    'snapshot',
    'status',
    'taskLedger'
  ])

  for (const descriptor of contribution.descriptors) {
    assert.equal(descriptor.namespace, 'workspaceOrganizer')
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.equal(typeof descriptor.result.create, 'function')
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict', `${descriptor.method}/${parameter.name} needs a strict codec`)
      assert.equal(parameter.source, 'json')
      assert.equal(typeof parameter.codec.create, 'function')
    }
  }
})

test('apply mounts the namespace and shadows the native sidebar seat at a lower priority', async () => {
  const { exports, required } = await loadBundle()
  const mounted = []
  const registered = []
  const injected = []
  const disposed = []
  const remote = {
    $mount: async (contribution) => {
      mounted.push(contribution)
      return () => { disposed.push('mount') }
    }
  }
  const slots = {
    inject: (name, callback) => {
      injected.push(name)
      return callback()
    },
    register: (options) => {
      registered.push(options)
      return () => { disposed.push('slot') }
    }
  }
  const ctx = {
    remote,
    slots,
    inject: (dependencies, callback) => {
      callback(ctx)
      return { dispose: async () => { disposed.push('child') } }
    },
    get: (name) => {
      if (name === 'remote') return remote
      if (name === 'uiWorkspace') return {}
      return undefined
    }
  }

  const dispose = await exports.apply(ctx)

  assert.equal(mounted.length, 1)
  assert.equal(mounted[0].package, 'workspace-organizer-dsh')
  assert.deepEqual(injected, ['sidebar.workspaces'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'sidebar.workspaces')
  assert.ok(registered[0].priority < 0, 'the organizer entry must shadow the native occupant')
  assert.ok(required.includes('react'))
  assert.ok(required.includes('zod'))

  await dispose()
  assert.deepEqual(disposed.sort(), ['child', 'mount', 'slot'])
})

test('the real Typert registry accepts all 13 descriptors and withdraws them on dispose', async () => {
  const { exports } = await loadBundle()
  const { Context } = await import('@deepseek-ai/cordis')
  const registryModule = await import('@deepseek-ai/dsh-typert-registry')
  const TypertRegistry = registryModule.TypertRegistry ?? registryModule.default
  const context = new Context()
  const registry = new TypertRegistry(context)
  const cleanups = []
  const slots = { inject: (name, callback) => callback(), register: () => () => undefined }
  const remote = { $mount: registry.remotes.register, ...registry.remotes }
  const ctx = {
    remote,
    slots,
    effect: (register) => { cleanups.push(register()) },
    inject: (dependencies, callback) => {
      callback(ctx)
      return { dispose: async () => undefined }
    },
    get: () => undefined
  }
  const dispose = await exports.apply(ctx)
  assert.deepEqual(registry.remotes.list().map((entry) => entry.method).sort(), exports.contribution.descriptors.map((entry) => entry.method).sort())
  assert.equal(registry.remotes.list().length, 13)

  const missingService = {
    package: 'workspace-organizer-missing-service',
    descriptors: exports.contribution.descriptors.map((descriptor) => {
      const { service, ...rest } = descriptor
      return rest
    })
  }
  assert.throws(
    () => registry.remotes.register(missingService),
    (error) => error instanceof TypeError || /service/u.test(error.message)
  )

  await dispose()
  assert.equal(registry.remotes.list().length, 0, 'disposing the contribution withdraws every endpoint')
})

test('the project body is a collapse control and row actions are explicit', async () => {
  const source = await readFile(fileURLToPath(SOURCE_URL), 'utf8')
  assert.match(source, /data-wo-toggle/u)
  assert.match(source, /aria-expanded/u)
  assert.match(source, /data-wo-select/u)
  assert.match(source, /data-wo-add-child/u)
  assert.match(source, /toggleProject/u)
  assert.match(source, /stopPropagation/u)
})

test('workspace linking targets an existing directory and renders a terminal node', async () => {
  const source = await readFile(fileURLToPath(SOURCE_URL), 'utf8')
  assert.match(source, /data-wo-directory/u)
  assert.match(source, /data-wo-link/u)
  assert.match(source, /data-wo-terminal/u)
  assert.match(source, /registerWorkspace/u)
  assert.match(source, /selectedNode\.kind === "project" \? selectedNode\.id : undefined/u)
  assert.match(source, /const canCreate = parentId !== undefined/u)
})

test('session linking is offered only on a selected workspace and does not open it', async () => {
  const source = await readFile(fileURLToPath(SOURCE_URL), 'utf8')
  assert.match(source, /data-wo-session/u)
  assert.match(source, /data-wo-bind/u)
  assert.match(source, /data-wo-bind-panel/u)
  assert.match(source, /bindDirectoryConversation/u)
  assert.match(source, /conversationTarget/u)
  assert.match(source, /openSession\(target\.sessionId\)/u)
  assert.match(source, /conversationId: node\.id/u)
  assert.match(source, /selectedNode\.kind === "workspace"/u)
})

test('existing Session links target Project folders and use the host readback/open path', async () => {
  const source = await readFile(fileURLToPath(SOURCE_URL), 'utf8')
  assert.match(source, /data-wo-existing-session-start/u)
  assert.match(source, /data-wo-existing-session-panel/u)
  assert.match(source, /remote\.linkExistingSession/u)
  assert.match(source, /await workspace\.openSession\(target\.sessionId\)/u)
  assert.match(source, /No host session list is available/u)
  assert.match(source, /never creates or moves a Session/u)
})

test('project/workspace move is explicit, descendant-safe, and cancellable', async () => {
  const source = await readFile(fileURLToPath(SOURCE_URL), 'utf8')
  assert.match(source, /data-wo-move-panel/u)
  assert.match(source, /data-wo-move-to/u)
  assert.match(source, /data-wo-move-cancel/u)
  assert.match(source, /setMoveMode\(false\)/u)
  assert.match(source, /moveMode/u)
  assert.match(source, /remote\.moveNode/u)
  assert.match(source, /isDescendantOf/u)
  assert.match(source, /selectedNode\.kind === "workspace"/u)
  assert.match(source, /const canMove =/u)
})

test('rename uses an explicit per-node editor with validation and cancel', async () => {
  const source = await readFile(fileURLToPath(SOURCE_URL), 'utf8')
  assert.match(source, /data-wo-rename-panel/u)
  assert.match(source, /data-wo-rename-input/u)
  assert.match(source, /data-wo-rename-save/u)
  assert.match(source, /data-wo-rename-cancel/u)
  assert.match(source, /remote\.renameNode/u)
  assert.match(source, /Name must be 1–200 characters/u)
  assert.match(source, /renameTarget/u)
})

test('task tree is a source-side read-only projection with explicit refresh', async () => {
  const source = await readFile(fileURLToPath(SOURCE_URL), 'utf8')
  assert.match(source, /data-wo-task-panel/u)
  assert.match(source, /data-wo-tasks/u)
  assert.match(source, /data-wo-task-refresh/u)
  assert.match(source, /data-wo-task-row/u)
  assert.match(source, /remote\.taskLedger/u)
  assert.match(source, /remote\.reconcileTasks/u)
  assert.match(source, /executionState/u)
})

test('name find is scoped, descendant-aware, and locates without opening', async () => {
  const source = await readFile(fileURLToPath(SOURCE_URL), 'utf8')
  assert.match(source, /data-wo-find-panel/u)
  assert.match(source, /data-wo-find-query/u)
  assert.match(source, /data-wo-find-mode/u)
  assert.match(source, /data-wo-find-result/u)
  assert.match(source, /data-wo-find-located/u)
  assert.match(source, /isDescendantOf/u)
  assert.match(source, /pathOf/u)
  assert.match(source, /scrollIntoView/u)
})

test('failed snapshot refresh marks the previous view stale', async () => {
  const source = await readFile(fileURLToPath(SOURCE_URL), 'utf8')
  assert.match(source, /data-wo-snapshot-stale/u)
  assert.match(source, /setSnapshotStale\(true\)/u)
  assert.match(source, /setSnapshotStale\(false\)/u)
})
