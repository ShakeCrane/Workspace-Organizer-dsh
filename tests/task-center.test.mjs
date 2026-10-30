import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SOURCE_URL = new URL('../client/client.js', import.meta.url)

test('task center is a ledger-only centralized projection with stable task identity', async () => {
  const source = await readFile(fileURLToPath(SOURCE_URL), 'utf8')
  assert.match(source, /data-wo-task-center/u)
  assert.match(source, /data-wo-task-center-panel/u)
  assert.match(source, /data-wo-task-center-row/u)
  assert.match(source, /data-wo-task-center-detail/u)
  assert.match(source, /data-wo-task-center-error/u)
  assert.match(source, /data-wo-task-center-empty/u)
  assert.match(source, /remote\.taskLedger\(\)/u)
  assert.match(source, /seen\.has\(task\.taskId\)/u)
  assert.match(source, /taskCenterRequest/u)
  assert.match(source, /last observed source facts only/u)
  assert.match(source, /executionState/u)
  assert.match(source, /data-wo-source-id/u)
  assert.match(source, /data-wo-source-logical/u)
  assert.match(source, /data-wo-source-native/u)
  assert.match(source, /data-wo-source-directory/u)
  assert.match(source, /data-wo-source-verified-at/u)
  assert.match(source, /data-wo-source-verification/u)
  assert.match(source, /data-wo-source-blocked/u)
  assert.match(source, /data-wo-task-center-stale/u)
  assert.match(source, /taskCenterRequest\.current !== generation/u)
})
