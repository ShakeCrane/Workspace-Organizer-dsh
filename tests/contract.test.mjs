/**
 * Host ↔ browser contract without a transport.
 *
 * The Host face declares its endpoints through `Remote` markers; the Gateway's
 * source mode derives each endpoint's wire parameters from the live method
 * source. The browser face must mount exactly those endpoints with exactly
 * those wire names, or a call would fail at dispatch time. This test compares
 * both sides directly so a drift is caught without a browser.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceOrganizerRemote } from '../build/host/remote.js'

const CLIENT_URL = new URL('../client/client.js', import.meta.url)

const schema = {
  optional: () => schema,
  array: () => schema,
  readonly: () => schema
}
const zodStub = {
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

async function loadContribution() {
  const source = await readFile(fileURLToPath(CLIENT_URL), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
  // eslint-disable-next-line no-new-func
  new Function('window', source)(window)
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return { createElement: () => null, useState: () => [], useEffect: () => undefined, useCallback: (fn) => fn }
    if (specifier === 'zod') return zodStub
    throw new Error(`unexpected require(${specifier})`)
  })
  return exports.contribution
}

/** Mirror the Gateway's source-mode parameter extraction. */
function parameterNames(method) {
  const source = Function.prototype.toString.call(method)
  const open = source.indexOf('(')
  const close = source.indexOf(')', open + 1)
  const body = source.slice(open + 1, close).trim()
  return body.length === 0 ? [] : body.split(',').map((part) => part.trim())
}

function serviceStub() {
  const answer = async () => ({ revision: 0, rootId: 'root', nodes: [] })
  return {
    status: async () => ({}),
    snapshot: answer,
    rows: async () => ({ revision: 0, rows: [] }),
    createProject: answer,
    rename: answer,
    move: answer,
    createConversation: answer
  }
}

test('the Host Remote markers match the browser contribution endpoint for endpoint', async () => {
  const contribution = await loadContribution()
  const remote = new WorkspaceOrganizerRemote(new Context(), serviceStub())
  const markers = remoteMethods(remote)
  assert.ok(markers.length > 0, 'Remote markers must exist after construction')

  const hostMethods = markers.map((marker) => marker.exportName ?? marker.method).sort()
  const clientMethods = contribution.descriptors.map((descriptor) => descriptor.method).sort()
  assert.deepEqual(clientMethods, hostMethods)
  assert.ok(markers.every((marker) => marker.invocation.kind === 'direct'))
  assert.equal(contribution.descriptors.every((descriptor) => descriptor.invocation.kind === 'direct'), true)
})

test('every browser wire parameter matches the Host method parameter list', async () => {
  const contribution = await loadContribution()
  const remote = new WorkspaceOrganizerRemote(new Context(), serviceStub())
  const markers = new Map(remoteMethods(remote).map((marker) => [marker.exportName ?? marker.method, marker]))

  for (const descriptor of contribution.descriptors) {
    const marker = markers.get(descriptor.method)
    assert.ok(marker, `host marker missing for ${descriptor.method}`)
    const names = parameterNames(remote[marker.method])
    assert.deepEqual(
      descriptor.parameters.map((parameter) => parameter.wire),
      names,
      `${descriptor.method} wire parameters must mirror the Host signature`
    )
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict')
    }
  }
})
