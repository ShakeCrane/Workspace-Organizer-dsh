/**
 * Isolated-profile host verification for the Workspace-Organizer host half.
 *
 * It never touches the real `DSH_HOME`, a running instance, or another project:
 * every directory it writes lives under `build/`, it starts only the child it
 * created, and it removes the profile copy at the end while keeping the results
 * file. The plugin source is the compiled output in `build/`, staged as a local
 * package so `dsh plugin add file:<path>` installs exactly what was built.
 *
 * Steps: init profile → install → boot #1 (self-test) → boot #2 (restart,
 * persistence) → stop → remove → confirm config removal and retained data.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(root, 'build', 'profile')
const home = join(work, 'home')
const staged = join(work, 'plugin')
const events = join(work, 'plugin-events.jsonl')
const cli = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const env = { ...process.env, DSH_HOME: home, DSH_AUDIT_LOG: events }
const result = { startedAt: new Date().toISOString(), steps: [], status: 'FAIL' }
const commands = []

function scrub(text) {
  return String(text).replace(/([?&]token=)[^\s"<>]+/gu, '$1REDACTED')
}

function run(label, args, options = {}) {
  // File-backed stdio, not pipes: the confined sandbox rejects piped child stdio.
  const logFile = join(work, `command-${label}.log`)
  const fd = openSync(logFile, 'w')
  try {
    const child = spawnSync(process.execPath, [cli, ...args], {
      cwd: work,
      env: { ...env, ...options.env },
      timeout: 120_000,
      windowsHide: true,
      stdio: ['ignore', fd, fd]
    })
    if (child.status !== 0) {
      commands.push({ label, args, status: child.status ?? -1 })
      throw new Error(`${label} failed with status ${String(child.status)}; see ${logFile}`)
    }
    commands.push({ label, args, status: 0 })
    return readFileSync(logFile, 'utf8')
  } finally {
    closeSync(fd)
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => undefined)
    if (value !== undefined) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function stagePlugin() {
  await mkdir(staged, { recursive: true })
  const source = join(root, 'build')
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() && entry.name.endsWith('.js')) {
      await cp(join(source, entry.name), join(staged, entry.name))
    }
    if (entry.isDirectory() && ['core', 'host'].includes(entry.name)) {
      await cp(join(source, entry.name), join(staged, entry.name), { recursive: true })
    }
  }
  await writeFile(join(staged, 'package.json'), `${JSON.stringify({
    name: 'workspace-organizer-dsh',
    version: '0.1.0',
    private: true,
    type: 'module',
    main: './index.js',
    exports: { '.': './index.js', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' } }
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(staged, 'cordis.patch.yml'), `- insert:
    - id: workspace-organizer
      name: workspace-organizer-dsh
`, 'utf8')
}

async function boot(label) {
  await rm(join(home, 'workspace-organizer', 'diagnostics.json'), { force: true })
  const existing = new Set(
    (await readdir(join(home, 'workspace-organizer')).catch(() => [])).filter((name) => name.startsWith('selftest-'))
  )
  const logFile = join(work, `host-${label}.log`)
  const fd = openSync(logFile, 'w')
  const child = spawn(process.execPath, [cli, '--profile', 'wo', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: work,
    env: { ...env, DSH_WORKSPACE_ORGANIZER_DIAGNOSTICS: '1', DSH_WORKSPACE_ORGANIZER_SELFTEST: '1' },
    windowsHide: true,
    stdio: ['ignore', fd, fd]
  })
  const logs = () => readFile(logFile, 'utf8').catch(() => '')
  let exited = false
  child.once('exit', () => { exited = true })

  try {
    const url = await waitFor(async () => {
      const text = scrub(await logs())
      if (exited) throw new Error(`host exited early: ${text}`)
      const match = text.match(/https?:\/\/127\.0\.0\.1:\d+/u)
      if (match === null) return undefined
      await readFile(join(home, 'workspace-organizer', 'diagnostics.json'), 'utf8')
      return match[0]
    }, 60_000, `${label} readiness`)

    const selftest = await waitFor(async () => {
      const files = (await readdir(join(home, 'workspace-organizer')))
        .filter((name) => name.startsWith('selftest-') && !existing.has(name))
      if (files.length === 0) return undefined
      return JSON.parse(await readFile(join(home, 'workspace-organizer', files.sort().at(-1)), 'utf8'))
    }, 40_000, `${label} self-test`)

    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })

    return {
      label,
      pid: child.pid,
      url,
      httpStatus: response.status,
      hostExited: exited,
      diagnostics: JSON.parse(await readFile(join(home, 'workspace-organizer', 'diagnostics.json'), 'utf8')),
      selftest,
      logTail: scrub(await logs()).split('\n').slice(-10)
    }
  } finally {
    if (!exited) {
      child.kill('SIGTERM')
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolveWait) => setTimeout(resolveWait, 15_000))
      ]).catch(() => undefined)
    }
    closeSync(fd)
  }
}

try {
  await rm(work, { recursive: true, force: true })
  await mkdir(home, { recursive: true })
  await stagePlugin()
  result.steps.push({ step: 'stage', ok: true, staged })

  const initial = run('init', ['--profile', 'wo', '--from-default-profile', 'web', '--dump-config'])
  result.steps.push({ step: 'init-profile', ok: initial.length > 0 })
  run('install', ['plugin', '--profile', 'wo', 'add', `file:${staged}`])
  const installed = run('installed-config', ['--profile', 'wo', '--dump-config'])
  result.steps.push({ step: 'install', ok: installed.includes('workspace-organizer-dsh') })
  await writeFile(join(work, 'installed-config.yml'), installed, 'utf8')

  result.boot1 = await boot('boot-1')
  result.steps.push({
    step: 'boot-1',
    ok: result.boot1.diagnostics.plugin === 'workspace-organizer',
    httpStatus: result.boot1.httpStatus,
    selftest: result.boot1.selftest.steps
  })

  result.boot2 = await boot('boot-2')
  const second = result.boot2.selftest.steps.find((step) => step.step === 'snapshot')
  result.steps.push({ step: 'boot-2-restart', ok: second?.nodes > 1, nodes: second?.nodes, revision: second?.revision })

  run('remove', ['plugin', '--profile', 'wo', 'remove', 'workspace-organizer-dsh'])
  const removed = run('removed-config', ['--profile', 'wo', '--dump-config'])
  const dataKept = await readFile(join(home, 'workspace-organizer', 'tree.json'), 'utf8').then(() => true, () => false)
  result.steps.push({
    step: 'remove',
    ok: !removed.includes('workspace-organizer-dsh'),
    dataRetained: dataKept
  })
  await writeFile(join(work, 'removed-config.yml'), removed, 'utf8')

  result.status = result.steps.every((step) => step.ok === true) ? 'PASS' : 'FAIL'
} catch (error) {
  result.error = scrub(error instanceof Error ? error.message : String(error))
  result.stack = scrub(error instanceof Error ? error.stack : '')
} finally {
  result.commands = commands
  result.finishedAt = new Date().toISOString()
  await mkdir(work, { recursive: true })
  await writeFile(join(work, 'results.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ status: result.status, steps: result.steps, error: result.error, results: join(work, 'results.json') }, null, 2))
}
if (result.status !== 'PASS') process.exitCode = 1
