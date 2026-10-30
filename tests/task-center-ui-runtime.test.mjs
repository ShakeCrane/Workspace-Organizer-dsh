import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { boundedChildExit, checkpointWriter, pidBelongsToRun, superviseUi, withDeadline } from '../scripts/lib/task-center-ui-runtime.mjs'

test('withDeadline aborts and rejects a never-resolving phase', async () => {
  const startedAt = Date.now()
  let aborted = false
  await assert.rejects(withDeadline('stuck', 100, (signal) => {
    signal.addEventListener('abort', () => { aborted = true })
    return new Promise(() => {})
  }), /phase timeout/u)
  assert.equal(aborted, true)
  assert.ok(Date.now() - startedAt < 1_000)
})

test('withDeadline records enter/exit checkpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ui-runtime-'))
  const file = join(dir, 'checkpoints.jsonl')
  const checkpoint = checkpointWriter(file)
  await withDeadline('ok', 1_000, async () => 1, checkpoint)
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((line) => line.event), ['enter', 'exit'])
  assert.equal(lines[0].phase, 'ok')
})

test('boundedChildExit TERMs and records real exit', async () => {
  const child = new EventEmitter()
  child.kill = (signal) => { if (signal === 'SIGTERM') setTimeout(() => child.emit('exit', 0, null), 10) }
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const result = await boundedChildExit(child, exited, { termMs: 100, killMs: 100 })
  assert.deepEqual(result, { exit: { code: 0, signal: null }, killed: false, timedOut: false })
})

test('boundedChildExit escalates to KILL and records bounded timeout', async () => {
  const child = new EventEmitter()
  let killed = false
  child.kill = (signal) => { if (signal === 'SIGKILL') { killed = true; setTimeout(() => child.emit('exit', null, 'SIGKILL'), 10) } }
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const result = await boundedChildExit(child, exited, { termMs: 50, killMs: 100 })
  assert.equal(killed, true)
  assert.equal(result.killed, true)
  assert.deepEqual(result.exit, { code: null, signal: 'SIGKILL' })
  assert.equal(result.timedOut, false)
})

test('boundedChildExit reports timeout when KILL exit is never observed', async () => {
  const child = new EventEmitter()
  child.kill = () => {}
  const result = await boundedChildExit(child, new Promise(() => {}), { termMs: 50, killMs: 50 })
  assert.equal(result.killed, true)
  assert.equal(result.timedOut, true)
  assert.equal(result.exit, null)
})

test('superviseUi enforces a hard timeout and captures stdio', async () => {
  const result = await superviseUi(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 150 })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.code, 0)
  assert.ok(result.pid > 0)
  assert.equal(typeof result.stdout, 'string')
})

test('PID identity check rejects foreign or invalid PIDs', () => {
  assert.equal(pidBelongsToRun(1234, [1234, 5678]), true)
  assert.equal(pidBelongsToRun(9999, [1234, 5678]), false)
  assert.equal(pidBelongsToRun(0, [1234]), false)
  assert.equal(pidBelongsToRun(null, [1234]), false)
})
