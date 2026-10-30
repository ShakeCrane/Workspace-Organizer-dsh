/**
 * Single-candidate C1 verification (test-only).
 *
 * Claims one isolated directory R, snapshots the current sources into a stage,
 * builds/packs/installs the candidate, probes the installed module, runs the
 * host C1 fixture (setup + measure2), and records every gate and raw artifact.
 * All writes stay under R; existing build/dist/evidence and the real Profile
 * are only read for before/after hashes.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = 'E:\\Project\\Workspace-Organizer'
const cli = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const R = await mkdtemp(join(root, 'build', 'c1candidate-'))
const stage = join(R, 'stage')
const packDir = join(R, 'pack')
const home = join(R, 'home')
const profile = `c1cand-${relative(join(root, 'build'), R).replace(/[^a-z0-9-]/giu, '-').toLowerCase()}`
const dataDir = join(home, 'workspace-organizer')
const commands = []
const gates = {}
const raw = {}

const storeDir = join(R, 'pnpm-home', 'store')
const npmrc = join(R, '.npmrc')
const baseEnv = {
  ...process.env,
  DSH_HOME: home,
  PNPM_STORE_DIR: storeDir,
  npm_config_store_dir: storeDir,
  npm_config_userconfig: npmrc,
  NPM_CONFIG_USERCONFIG: npmrc,
  PNPM_HOME: join(R, 'pnpm-home')
}

const log = (message) => console.log(message)

/** Every controlled path must stay inside R; existing symlinks are refused. */
async function assertInside(label, target) {
  const value = resolve(target)
  if (!(value === R || value.startsWith(R + sep))) {
    throw new Error(`${label} escapes R: ${value}`)
  }
  let cursor = value
  while (cursor !== R && cursor.startsWith(R + sep)) {
    const stat = await lstat(cursor).catch(() => null)
    if (stat?.isSymbolicLink() === true) throw new Error(`${label} is a symlink: ${cursor}`)
    cursor = dirname(cursor)
  }
  const real = await realpath(value).catch(() => null)
  if (real !== null && !(real === R || real.startsWith(R + sep))) {
    throw new Error(`${label} resolves outside R: ${real}`)
  }
}

async function hashFile(file) {
  return sha256(await readFile(file))
}

async function walk(dir) {
  const entries = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink: ${full}`)
    if (entry.isDirectory()) entries.push(...await walk(full))
    else entries.push(full)
  }
  return entries
}

async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink: ${source}`)
    if (entry.isDirectory()) await copyTree(source, target)
    else await copyFile(source, target)
  }
}

function spawnLogged(label, command, args, options = {}) {
  const logFile = join(R, `command-${label}.log`)
  return (async () => {
    const cwd = options.cwd ?? R
    const env = options.env ?? baseEnv
    await assertInside(`${label}.cwd`, cwd)
    if (env.DSH_HOME !== undefined) await assertInside(`${label}.DSH_HOME`, env.DSH_HOME)
    if (env.PNPM_STORE_DIR !== undefined) await assertInside(`${label}.PNPM_STORE_DIR`, env.PNPM_STORE_DIR)
    if (env.npm_config_store_dir !== undefined) await assertInside(`${label}.npm_config_store_dir`, env.npm_config_store_dir)
    if (env.PNPM_HOME !== undefined) await assertInside(`${label}.PNPM_HOME`, env.PNPM_HOME)
    if (env.npm_config_userconfig !== undefined) await assertInside(`${label}.npm_config_userconfig`, env.npm_config_userconfig)
    if (env.NPM_CONFIG_USERCONFIG !== undefined) await assertInside(`${label}.NPM_CONFIG_USERCONFIG`, env.NPM_CONFIG_USERCONFIG)
    for (const target of options.inside ?? []) await assertInside(`${label}.path`, target)
    const { open } = await import('node:fs/promises')
    const fd = await open(logFile, 'w')
    const started = Date.now()
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', fd.fd, fd.fd],
      shell: options.shell === true,
      windowsHide: true
    })
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
    const errored = new Promise((resolve) => child.on('error', (error) => resolve({ error: String(error?.message ?? error) })))
    const timed = await Promise.race([
      exited,
      errored,
      sleep(options.timeout ?? 300_000).then(() => null)
    ])
    let result = timed
    if (result === null) {
      child.kill('SIGKILL')
      result = { ...(await exited), timedOut: true }
    }
    await fd.close()
    const text = await readFile(logFile, 'utf8').catch(() => '')
    commands.push({
      label,
      command,
      args,
      exitCode: result.code ?? null,
      signal: result.signal ?? null,
      error: result.error ?? null,
      timedOut: result.timedOut === true,
      durationMs: Date.now() - started,
      log: logFile,
      logSha256: sha256(text)
    })
    return { ...result, text, timedOut: result.timedOut === true }
  })()
}

function runOrThrow(result, label) {
  if (result.error !== undefined || result.timedOut === true || (result.code ?? -1) !== 0) {
    throw new Error(`${label} failed: code=${String(result.code)} signal=${String(result.signal)} error=${String(result.error ?? 'none')} timedOut=${String(result.timedOut)}`)
  }
}

async function allHashes(dir) {
  const map = {}
  for (const file of await walk(dir)) {
    map[relative(dir, file).split(sep).join('/')] = await hashFile(file)
  }
  return map
}

/** Hash a store tree including symlinks/junctions; never follows or silently drops them. */
async function storeManifest(dir) {
  const entries = {}
  async function visit(current) {
    let children
    try {
      children = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of children) {
      const full = join(current, entry.name)
      const rel = relative(dir, full).split(sep).join('/')
      let stat = null
      for (let attempt = 0; attempt < 3 && stat === null; attempt += 1) {
        try {
          stat = await lstat(full)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          await sleep(50)
        }
      }
      if (stat === null) {
        entries[rel] = { type: 'vanished' }
        continue
      }
      if (stat.isSymbolicLink()) {
        let target = null
        try { target = await readlink(full) } catch { target = null }
        entries[rel] = { type: 'link', target }
        continue
      }
      if (stat.isDirectory()) {
        // Windows junctions/reparse points resolve to a different real path;
        // record them explicitly instead of silently descending through them.
        const real = await realpath(full).catch(() => null)
        if (real !== null && real.toLowerCase() !== resolve(full).toLowerCase()) {
          entries[rel] = { type: 'junction', target: real }
          continue
        }
        entries[rel] = { type: 'dir' }
        await visit(full)
        continue
      }
      entries[rel] = { type: 'file', size: stat.size, hash: await hashFile(full) }
    }
  }
  await visit(dir)
  return { exists: true, entries }
}

async function priorRuns() {
  const out = {}
  for (const entry of await readdir(join(root, 'build'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!/^c1(candidate|exit|run)-/u.test(entry.name)) continue
    const base = join(root, 'build', entry.name)
    if (base === R) continue
    const found = {}
    for (const name of ['results.json', 'c1-exit.json', 'c1-harness.json']) {
      const value = await hashFile(join(base, name)).catch(() => null)
      if (value !== null) found[name] = value
    }
    out[entry.name] = Object.keys(found).length > 0 ? found : { present: true }
  }
  return out
}

async function evidenceManifest() {
  const buildScripts = {}
  for (const name of ['c1-fixture.mjs', 'c1run.mjs', 'c1run-exit.mjs']) {
    buildScripts[name] = await hashFile(join(root, 'build', name)).catch(() => null)
  }
  const results = {}
  for (const name of ['profile', 'verify-stage-b2', 'verify-stage-b3']) {
    results[name] = await hashFile(join(root, 'build', name, 'results.json')).catch(() => null)
  }
  return {
    dist: await allHashes(join(root, 'dist')),
    buildScripts,
    results,
    priorRuns: await priorRuns(),
    pnpmStore: await storeManifest(join(root, '.pnpm-store'))
  }
}

async function boot(phase) {
  const logFile = join(R, `host-${phase}.log`)
  const started = Date.now()
  await assertInside(`boot-${phase}.cwd`, R)
  await assertInside(`boot-${phase}.DSH_HOME`, home)
  const { open } = await import('node:fs/promises')
  const fd = await open(logFile, 'w')
  const child = spawn(process.execPath, [cli, '--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: R,
    env: { ...baseEnv, DSH_HOME: home },
    stdio: ['ignore', fd.fd, fd.fd],
    windowsHide: true
  })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const errored = new Promise((resolve) => child.on('error', (error) => resolve({ error: String(error?.message ?? error) })))
  const resultFile = join(dataDir, `c1-result-${phase}.json`)
  let found
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await sleep(500)
    try {
      found = JSON.parse(await readFile(resultFile, 'utf8'))
      break
    } catch {}
  }
  child.kill('SIGTERM')
  let exit = await Promise.race([exited, errored, sleep(15_000).then(() => null)])
  if (exit === null) {
    child.kill('SIGKILL')
    exit = { ...(await exited), timedOut: true }
  }
  await fd.close()
  const text = await readFile(logFile, 'utf8').catch(() => '')
  commands.push({
    label: `boot-${phase}`,
    command: process.execPath,
    args: [cli, '--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    exitCode: exit.code ?? null,
    signal: exit.signal ?? null,
    error: exit.error ?? null,
    timedOut: exit.timedOut === true,
    durationMs: Date.now() - started,
    log: logFile,
    logSha256: sha256(text)
  })
  return { phase, found, exit: { ...exit, timedOut: exit.timedOut === true }, log: logFile }
}

async function patchFixture(phase) {
  const patch = [
    '- insert:',
    '    - id: c1-candidate-fixture',
    `      name: ${JSON.stringify(`file:///${join(R, 'fixture', 'c1-candidate-fixture.mjs').replace(/\\/gu, '/')}`)}`,
    '      config:',
    `        phase: ${phase}`,
    `        dataDir: ${JSON.stringify(dataDir)}`,
    `        dshHome: ${JSON.stringify(home)}`,
    `        dirA: ${JSON.stringify(join(R, 'ws-a'))}`,
    `        dirB: ${JSON.stringify(join(R, 'ws-b'))}`,
    ''
  ].join('\n')
  await writeFile(join(home, 'profiles', profile, 'cordis.patch.yml'), patch, 'utf8')
}

const PROBE = `
import { pathToFileURL } from 'node:url'
const mod = await import(pathToFileURL(process.argv[2]).href)
const { reconcileTasks, validateTaskLedger } = mod
const NOW = '2026-10-20T00:00:00.000Z'
const source = { conversationId: 'cnv_source', sessionId: 'sess_source', directory: 'E:\\\\work', nativeWorkspaceId: 'n1', verifiedAt: NOW, hostVersion: '0.2.1-rc.2' }
const child = (id, parentId, depth, mode = 'one-shot') => ({ kind: 'child', id, parentId, depth, mode })
const headers = { a: { cwd: 'E:\\\\work' }, b: { cwd: 'E:\\\\work' }, c: { cwd: 'E:\\\\work' }, d: { cwd: 'E:\\\\work' }, z: { cwd: 'E:\\\\work' } }
const bad = {
  schemaVersion: 1, revision: 1, updatedAt: NOW, sources: [source], diagnostics: [],
  tasks: [
    { taskId: 'tsk_a', childSessionId: 'a', sourceConversationId: 'cnv_source', parent: { kind: 'conversation', conversationId: 'cnv_source' }, depth: 1, mode: 'one-shot', observedAt: NOW, executionState: 'UNKNOWN', executionEligibility: 'eligible' },
    { taskId: 'tsk_b', childSessionId: 'b', sourceConversationId: 'cnv_source', parent: { kind: 'task', taskId: 'tsk_missing' }, depth: 2, mode: 'one-shot', observedAt: NOW, executionState: 'UNKNOWN', executionEligibility: 'eligible' }
  ]
}
let allocations = 0
let badResult
try {
  reconcileTasks({ previous: bad, source, catalog: [child('a', 'sess_source', 1), child('b', 'a', 2)], headers, now: NOW, newTaskId: (id) => { allocations += 1; return 'tsk_' + id } })
  badResult = { threw: false }
} catch (error) {
  badResult = { threw: true, code: error?.code ?? null, taskId: error?.details?.taskId ?? null, parentId: error?.details?.parentId ?? null }
}
const first = reconcileTasks({ previous: undefined, source, catalog: [child('a', 'sess_source', 1), child('b', 'a', 2), child('d', 'b', 3)], headers, now: NOW, newTaskId: (id) => 'tsk_' + id })
const before = new Map(first.ledger.tasks.map((task) => [task.childSessionId, task]))
const second = reconcileTasks({
  previous: first.ledger, source,
  catalog: [child('a', 'ghost', 1), child('b', 'a', 2), child('d', 'b', 3), child('z', 'sess_source', 1)],
  headers, now: NOW, newTaskId: (id) => 'tsk_new_' + id
})
const after = new Map(second.ledger.tasks.map((task) => [task.childSessionId, task]))
const chainOk = ['a', 'b', 'd'].every((id) => {
  const x = before.get(id); const y = after.get(id)
  return y && x && y.taskId === x.taskId && y.sourceConversationId === x.sourceConversationId &&
    JSON.stringify(y.parent) === JSON.stringify(x.parent) && y.depth === x.depth && y.executionEligibility === 'blocked'
})
const noGhost = !after.has('ghost')
const diagnosticsOk = second.ledger.diagnostics.some((entry) => entry.code === 'catalog/missing-parent') &&
  second.ledger.diagnostics.some((entry) => entry.code === 'catalog/parent-isolated')
const zOk = after.get('z')?.executionEligibility === 'eligible'
const validOk = (() => { try { validateTaskLedger(second.ledger); return true } catch { return false } })()
const repeat = reconcileTasks({ previous: second.ledger, source, catalog: [child('a', 'ghost', 1), child('b', 'a', 2), child('d', 'b', 3), child('z', 'sess_source', 1)], headers, now: '2026-10-20T01:00:00.000Z', newTaskId: () => { throw new Error('allocator must not run') } })
const repeated = new Map(repeat.ledger.tasks.map((task) => [task.childSessionId, task]))
const repeatOk = ['a', 'b', 'd', 'z'].every((id) => repeated.get(id)?.taskId === after.get(id)?.taskId)
const round = validateTaskLedger(JSON.parse(JSON.stringify(repeat.ledger)))
const roundOk = JSON.stringify(round.tasks.map((task) => [task.taskId, task.childSessionId, task.sourceConversationId, task.parent, task.depth, task.executionEligibility]).sort()) ===
  JSON.stringify(repeat.ledger.tasks.map((task) => [task.taskId, task.childSessionId, task.sourceConversationId, task.parent, task.depth, task.executionEligibility]).sort())
const ok = badResult.threw && badResult.code === 'task/invalid-ledger' && badResult.taskId === 'tsk_b' && badResult.parentId === 'tsk_missing' &&
  allocations === 0 && chainOk && noGhost && diagnosticsOk && zOk && validOk && repeatOk && roundOk
console.log(JSON.stringify({ ok, badResult, allocations, chainOk, noGhost, diagnosticsOk, zOk, validOk, repeatOk, roundOk }))
process.exitCode = ok ? 0 : 1
`

async function main() {
  log(`R=${R}`)
  await mkdir(home, { recursive: true })
  await mkdir(storeDir, { recursive: true })
  await writeFile(npmrc, `store-dir=${storeDir.replace(/\\/gu, '/')}\n`, 'utf8')
  // Snapshot the complete old evidence (dist, build scripts/results, candidates, store).
  raw.evidenceBefore = await evidenceManifest()

  // Stage copy (whitelist) with a byte manifest.
  await mkdir(stage, { recursive: true })
  const inputs = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.test.json', 'cordis.patch.yml', 'README.md']
  for (const file of inputs) await copyFile(join(root, file), join(stage, file))
  await copyTree(join(root, 'src'), join(stage, 'src'))
  await copyTree(join(root, 'client'), join(stage, 'client'))
  await mkdir(join(stage, 'tests'), { recursive: true })
  await copyFile(join(root, 'tests', 'tasks.test.mjs'), join(stage, 'tests', 'tasks.test.mjs'))
  await mkdir(join(stage, 'build', '.tmp'), { recursive: true })
  const manifest = {}
  for (const file of await walk(stage)) {
    const rel = relative(stage, file).split(sep).join('/')
    if (rel.startsWith('build/') || rel.startsWith('dist/')) continue
    manifest[rel] = await hashFile(file)
    const source = join(root, rel)
    if (await hashFile(source).catch(() => null) !== manifest[rel]) throw new Error(`snapshot mismatch: ${rel}`)
  }
  raw.manifest = manifest
  raw.manifestSha256 = sha256(JSON.stringify(manifest))

  const build = await spawnLogged('tsc-dist', process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: stage, inside: [join(stage, 'dist')] })
  runOrThrow(build, 'tsc-dist')
  const buildTest = await spawnLogged('tsc-test', process.execPath, [tsc, '-p', 'tsconfig.test.json'], { cwd: stage, inside: [join(stage, 'build')] })
  runOrThrow(buildTest, 'tsc-test')
  const tests = await spawnLogged('tests', process.execPath, ['--test', '--test-isolation=none', 'tests/tasks.test.mjs'], { cwd: stage })
  runOrThrow(tests, 'tests')
  const pass = Number(/pass (\d+)/u.exec(tests.text)?.[1] ?? 0)
  const fail = Number(/fail (\d+)/u.exec(tests.text)?.[1] ?? 1)
  gates.tests = pass === 17 && fail === 0
  if (!gates.tests) throw new Error(`targeted tests failed: pass=${String(pass)} fail=${String(fail)}`)

  await mkdir(packDir, { recursive: true })
  await writeFile(join(stage, '.npmrc'), `store-dir=${storeDir.replace(/\\/gu, '/')}\n`, 'utf8')
  const packed = await spawnLogged('pack', 'pnpm', ['pack', '--pack-destination', packDir], { cwd: stage, shell: true, env: baseEnv, inside: [packDir] })
  runOrThrow(packed, 'pack')
  const tarballs = (await readdir(packDir)).filter((name) => name.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${String(tarballs.length)}`)
  const tarball = join(packDir, tarballs[0])
  raw.candidate = { tarball, sha256: await hashFile(tarball), storeDir }

  // Extract and compare the complete payload (JS and non-JS).
  const extracted = join(R, 'extracted')
  await mkdir(extracted, { recursive: true })
  const untar = await spawnLogged('untar', 'tar', ['-xzf', tarball, '-C', extracted], { inside: [extracted] })
  runOrThrow(untar, 'untar')
  const pkg = join(extracted, 'package')
  for (const required of ['package.json', 'dist/index.js', 'client/client.js', 'cordis.patch.yml', 'README.md']) {
    if (await lstat(join(pkg, required)).then(() => false, () => true)) throw new Error(`tarball missing ${required}`)
  }
  const stageDist = await allHashes(join(stage, 'dist'))
  const packDist = await allHashes(join(pkg, 'dist'))
  gates.packBytes = JSON.stringify(stageDist) === JSON.stringify(packDist)
  if (!gates.packBytes) throw new Error('tarball dist bytes differ from stage dist')
  const stageClient = await allHashes(join(stage, 'client'))
  const packClient = await allHashes(join(pkg, 'client'))
  const stagePatch = await hashFile(join(stage, 'cordis.patch.yml'))
  const packPatch = await hashFile(join(pkg, 'cordis.patch.yml'))
  const stageReadme = await hashFile(join(stage, 'README.md'))
  const packReadme = await hashFile(join(pkg, 'README.md'))
  gates.payloadBytes = JSON.stringify(stageClient) === JSON.stringify(packClient) &&
    stagePatch === packPatch && stageReadme === packReadme
  if (!gates.payloadBytes) throw new Error('non-JS payload differs between stage and tarball')
  const stagePackage = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'))
  const packPackage = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
  gates.packageManifest = stagePackage.name === packPackage.name &&
    stagePackage.version === packPackage.version &&
    stagePackage.main === packPackage.main &&
    JSON.stringify(stagePackage.exports) === JSON.stringify(packPackage.exports) &&
    JSON.stringify(stagePackage.files) === JSON.stringify(packPackage.files)
  raw.dist = { stage: stageDist, tarball: packDist, client: { stage: stageClient, tarball: packClient }, patch: { stage: stagePatch, tarball: packPatch }, readme: { stage: stageReadme, tarball: packReadme }, packageManifest: gates.packageManifest }

  // Isolated profile: init, install (store redirected into R), resolve the real module.
  const init = await spawnLogged('profile-init', process.execPath, [cli, '--profile', profile, '--from-default-profile', 'web', '--dump-config'], { env: { ...baseEnv, DSH_HOME: home } })
  runOrThrow(init, 'profile-init')
  const install = await spawnLogged('install', process.execPath, [cli, 'plugin', '--profile', profile, 'add', `file:${tarball}`], { env: { ...baseEnv, DSH_HOME: home } })
  runOrThrow(install, 'install')
  const installLog = await readFile(join(R, 'command-install.log'), 'utf8')
  const storeMatch = /Content-addressable store is at:\s*(.+)/u.exec(installLog)
  if (storeMatch === null) throw new Error('install log did not report a content-addressable store')
  const actualStore = storeMatch[1].trim()
  await assertInside('install.store', actualStore)
  gates.storeIsolated = true
  raw.installStore = actualStore
  const profileDir = join(home, 'profiles', profile)
  const profileRequire = createRequire(join(profileDir, 'package.json'))
  const installedPackageJson = profileRequire.resolve('workspace-organizer-dsh/package.json')
  const installedDir = dirname(installedPackageJson)
  const installedPackage = JSON.parse(await readFile(installedPackageJson, 'utf8'))
  const installedDist = await allHashes(join(installedDir, 'dist'))
  const installedClient = await allHashes(join(installedDir, 'client'))
  const installedPatch = await hashFile(join(installedDir, 'cordis.patch.yml'))
  const installedReadme = await hashFile(join(installedDir, 'README.md'))
  gates.installedBytes = JSON.stringify(installedDist) === JSON.stringify(packDist) &&
    JSON.stringify(installedClient) === JSON.stringify(packClient) &&
    installedPatch === packPatch && installedReadme === packReadme
  if (!gates.installedBytes) throw new Error('installed payload differs from tarball')
  gates.installedManifest = installedPackage.name === packPackage.name &&
    installedPackage.version === packPackage.version &&
    installedPackage.main === packPackage.main &&
    JSON.stringify(installedPackage.exports) === JSON.stringify(packPackage.exports) &&
    JSON.stringify(installedPackage.files) === JSON.stringify(packPackage.files)
  const pluginRequire = createRequire(installedPackageJson)
  const pluginCordis = pluginRequire.resolve('@deepseek-ai/cordis/package.json')
  const pluginProtocol = pluginRequire.resolve('@deepseek-ai/dsh-typert-protocol/package.json')
  const hostRequire = createRequire(cli)
  const hostCordis = hostRequire.resolve('@deepseek-ai/cordis/package.json')
  const hostProtocol = hostRequire.resolve('@deepseek-ai/dsh-typert-protocol/package.json')
  const cordisSame = await realpath(pluginCordis) === await realpath(hostCordis)
  const protocolSame = await realpath(pluginProtocol) === await realpath(hostProtocol)
  let contextSame = false
  try {
    const pluginContext = (await import(pathToFileURL(join(dirname(pluginCordis), 'lib', 'index.js')).href)).Context
    const hostContext = (await import(pathToFileURL(join(dirname(hostCordis), 'lib', 'index.js')).href)).Context
    contextSame = pluginContext === hostContext
  } catch {
    contextSame = false
  }
  gates.installedIdentity = cordisSame && protocolSame && contextSame
  if (!gates.installedIdentity) throw new Error('installed module does not share the host Cordis/protocol identity')
  raw.installed = {
    dir: installedDir,
    packageJson: installedPackageJson,
    name: installedPackage.name,
    version: installedPackage.version,
    dist: installedDist,
    client: installedClient,
    patch: installedPatch,
    readme: installedReadme,
    identity: {
      pluginCordis,
      hostCordis,
      cordisSame,
      pluginProtocol,
      hostProtocol,
      protocolSame,
      contextSame
    }
  }

  // Installed-module pure-function probe.
  const probeFile = join(R, 'probe.mjs')
  await writeFile(probeFile, PROBE, 'utf8')
  const probe = await spawnLogged('probe', process.execPath, [probeFile, join(installedDir, 'dist', 'core', 'tasks.js')])
  runOrThrow(probe, 'probe')
  raw.probe = JSON.parse(probe.text.trim())
  gates.installedProbe = raw.probe.ok === true
  if (!gates.installedProbe) throw new Error('installed module probe failed')

  // Host fixture: copy baseline into R and run setup + measure2.
  await mkdir(join(R, 'fixture'), { recursive: true })
  await copyFile(join(root, 'scripts', 'c1-candidate-fixture.mjs'), join(R, 'fixture', 'c1-candidate-fixture.mjs'))
  await patchFixture('setup')
  const setup = await boot('setup')
  raw.setup = { exit: setup.exit, log: setup.log, ok: setup.found?.ok === true }
  gates.setup = setup.found?.ok === true
  if (!gates.setup) throw new Error('setup fixture failed')
  await patchFixture('measure2')
  const measure = await boot('measure2')
  raw.measure = {
    exit: measure.exit,
    log: measure.log,
    ok: measure.found?.ok === true,
    gates: measure.found?.gates ?? null,
    prepareMap: measure.found?.cold?.prepareMap ?? null,
    phases: measure.found?.cold?.phases
      ? Object.fromEntries(Object.entries(measure.found.cold.phases).filter(([key]) => ['default', 'granted', 'revoked'].includes(key)).map(([key, value]) => [key, { attempts: value.attempts, codes: value.codes, detailsEmpty: value.detailsEmpty, stable: value.hashes?.stable }]))
      : null
  }
  gates.measure = measure.found?.ok === true
  if (!gates.measure) throw new Error('measure2 fixture failed')

  // Complete old evidence (dist, build scripts/results, prior candidates, pnpm store) must be identical.
  raw.evidenceAfter = await evidenceManifest()
  gates.oldEvidence = raw.evidenceBefore?.pnpmStore?.exists === true &&
    raw.evidenceAfter?.pnpmStore?.exists === true &&
    JSON.stringify(raw.evidenceBefore) === JSON.stringify(raw.evidenceAfter)
  if (!gates.oldEvidence) throw new Error('old evidence, dist, or the root pnpm store changed')
}

let failure = null
try {
  await main()
} catch (error) {
  failure = String(error?.stack ?? error)
}
const passed = failure === null && Object.values(gates).every((value) => value === true)
const results = {
  root,
  R,
  stage,
  profile,
  passed,
  gates,
  failure,
  commands,
  raw,
  finishedAt: new Date().toISOString()
}
await writeFile(join(R, 'results.json'), JSON.stringify(results, null, 2), 'utf8')
log(JSON.stringify({ R, passed, gates, failure }, null, 2))
if (passed) log(`CANDIDATE=${raw.candidate?.tarball ?? ''}`)
process.exitCode = passed ? 0 : 1
