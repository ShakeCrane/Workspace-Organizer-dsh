import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRuntimeContext, fixtureReady, isReady, runCommand, runReadinessFlow, runReadinessGates, validateColdRead, validateHooks, validateRoundTrip, waitForExit } from '../scripts/lib/web-fixture-runtime.mjs'

test('import is side-effect free and context is explicit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wo-runtime-test-'))
  const before = await readdir(dir)
  const context = createRuntimeContext({ R: dir, root: dir, home: join(dir, 'home'), profile: 'p', cli: join(dir, 'cli.js') })
  assert.equal(context.R, dir)
  assert.deepEqual(await readdir(dir), before)
  assert.throws(() => createRuntimeContext({ R: 'relative', root: dir, home: dir, profile: 'p', cli: dir }), /absolute/u)
  assert.throws(() => createRuntimeContext({ R: dir }), /missing root/u)
  assert.throws(() => createRuntimeContext({ R: dir, root: dir, home: join(dir, 'home'), cli: join(dir, 'cli.js') }), /missing profile/u)
  assert.deepEqual(await readdir(dir), before)
})

test('runCommand records real code/stdout/stderr', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok"); process.stderr.write("err")'], { timeoutMs: 10_000 })
  assert.equal(result.code, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.stdout, 'ok')
  assert.equal(result.stderr, 'err')
})

test('runCommand kills a timed out child and records timeout', async () => {
  const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 250 })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.code, 0)
})

test('fixture ready requires all four gates', () => {
  assert.equal(isReady(fixtureReady({ fixture: true, persisted: true, expected: true, hooks: false })), false)
  assert.equal(isReady(fixtureReady({ fixture: true, persisted: true, expected: true, hooks: true })), true)
})

test('waitForExit clears the fallback timer when exit wins', async () => {
  const startedAt = Date.now()
  const observed = await waitForExit(Promise.resolve(), 5_000)
  assert.equal(observed, true)
  assert.ok(Date.now() - startedAt < 1_000)
})

const expected = {
  workspace: { path: 'C:\\r\\ws-a' },
  marker1: 'M1',
  marker2: 'M2'
}
const hookSpec = { sessions: ['get'], agents: ['create'] }
const validCold = () => ({
  expected,
  bootstrap: {
    a: { path: expected.workspace.path },
    sessions: {
      'web-sess-s1': { marker: 'M1', readBack: { hasMarker: true, count: 3 } },
      'web-sess-s2': { marker: 'M2', readBack: { hasMarker: true, count: 2 } }
    }
  },
  checkpoint: {
    errors: [],
    persistence: { header: { id: 'web-sess-s1', cwd: expected.workspace.path } },
    list: [
      { kind: 'child', id: 'wo-t1', parentId: 'web-sess-s1', depth: 1 },
      { kind: 'child', id: 'wo-t2', parentId: 'wo-t1', depth: 2 },
      { kind: 'child', id: 'wo-t3', parentId: 'wo-t1', depth: 2 },
      { kind: 'diagnostic', id: 'wo-t4-missing', parentId: 'web-sess-s1', depth: 1, reason: 'unavailable' }
    ]
  }
})
const validProbe = () => ({
  probes: {
    sessions: { present: true, methods: { get: { typeof: 'function', wrapped: true } } },
    agents: { present: true, methods: { create: { typeof: 'function', wrapped: true } } }
  },
  counts: { 'sessions/get': 0, 'agents/create': 0 }
})

test('coldRead validator passes prepared sample and rejects cwd/catalog/T4 mutations', () => {
  const base = validCold()
  assert.equal(validateColdRead(base.expected, base.bootstrap, base.checkpoint).ok, true)
  const badPath = validCold(); badPath.bootstrap.a.path = 'C:\\r\\other'
  assert.equal(validateColdRead(badPath.expected, badPath.bootstrap, badPath.checkpoint).ok, false)
  const badCatalog = validCold(); badCatalog.checkpoint.list[1].parentId = 'wo-t3'
  assert.equal(validateColdRead(badCatalog.expected, badCatalog.bootstrap, badCatalog.checkpoint).ok, false)
  const badT4 = validCold(); badT4.checkpoint.list[3].reason = 'available'
  assert.equal(validateColdRead(badT4.expected, badT4.bootstrap, badT4.checkpoint).ok, false)
})

test('hooks validator rejects missing wrapper and counts without hooks', () => {
  assert.equal(validateHooks(validProbe(), hookSpec).ok, true)
  const missing = validProbe(); missing.probes.sessions.methods.get.wrapped = false
  assert.equal(validateHooks(missing, hookSpec).ok, false)
  assert.equal(validateHooks({ counts: { 'sessions/get': 0, 'agents/create': 0 } }, hookSpec).ok, false)
})

test('roundTrip rejects old boot/requestId and non-zero counts', () => {
  const required = { sessions: ['get'] }
  const ack = { ok: true, requestId: 'r1', value: 'missing' }
  const fresh = { bootId: 'b1', snapshotSeq: 2, counts: { 'sessions/get': 0 }, calls: [] }
  assert.equal(validateRoundTrip({ bootId: 'b1', requestId: 'r1', ack, fresh, required }).ok, true)
  assert.equal(validateRoundTrip({ bootId: 'old', requestId: 'r1', ack, fresh, required }).ok, false)
  assert.equal(validateRoundTrip({ bootId: 'b1', requestId: 'old', ack, fresh, required }).ok, false)
  const dirty = { ...fresh, counts: { 'sessions/get': 1 } }
  assert.equal(validateRoundTrip({ bootId: 'b1', requestId: 'r1', ack, fresh: dirty, required }).ok, false)
})

test('fail-fast gates do not call handshake after cold/hooks failure', async () => {
  let calls = 0
  const handshake = async () => { calls += 1; return { ok: true } }
  const coldFail = await runReadinessGates({ cold: { ok: false }, hooks: { ok: true }, handshake })
  assert.equal(coldFail.stage, 'cold')
  assert.equal(coldFail.handshakeCalled, false)
  assert.equal(calls, 0)
  const hooksFail = await runReadinessGates({ cold: { ok: true }, hooks: { ok: false }, handshake })
  assert.equal(hooksFail.stage, 'hooks')
  assert.equal(hooksFail.handshakeCalled, false)
  assert.equal(calls, 0)
  const pass = await runReadinessGates({ cold: { ok: true }, hooks: { ok: true }, handshake })
  assert.equal(pass.stage, 'roundTrip')
  assert.equal(calls, 1)
})

test('readiness flow times out handshake and forbids reset', async () => {
  const result = await runReadinessFlow({
    cold: { ok: true },
    hooks: { ok: true },
    handshake: () => new Promise(() => {}),
    timeoutMs: 100
  })
  assert.equal(result.stage, 'handshake-timeout')
  assert.equal(result.handshakeCalled, true)
  assert.equal(result.ready, false)
  assert.equal(result.resetAllowed, false)
})

test('readiness flow fail-fast uses the verifier path', async () => {
  let calls = 0
  const coldFail = await runReadinessFlow({ cold: { ok: false }, hooks: { ok: true }, handshake: async () => { calls += 1; return { ok: true } } })
  assert.equal(coldFail.stage, 'cold')
  assert.equal(coldFail.handshakeCalled, false)
  assert.equal(calls, 0)
  const hooksFail = await runReadinessFlow({ cold: { ok: true }, hooks: { ok: false }, handshake: async () => { calls += 1; return { ok: true } } })
  assert.equal(hooksFail.stage, 'hooks')
  assert.equal(hooksFail.handshakeCalled, false)
  assert.equal(calls, 0)
})
