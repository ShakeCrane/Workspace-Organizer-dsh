/**
 * Candidate-package verification in a NEW, uniquely claimed disposable profile.
 *
 * Directory ownership is the first invariant, not a naming convention:
 * - the run directory is claimed with `mkdtemp`, an exclusive atomic creation, so
 *   a concurrent run cannot receive the same directory;
 * - until the claim succeeds nothing may write, log, create a Profile, or spawn a
 *   process — every such operation goes through the ownership object, which
 *   refuses before reaching the injected filesystem/spawn layer;
 * - every write is additionally confined to the claimed directory, so a bug or a
 *   hostile path cannot reach an existing evidence directory;
 * - `finally` writes `results.json` only while this process holds the claim; a
 *   failed claim prints a diagnostic and writes nothing at all.
 *
 * `node scripts/verify-stage-b2.mjs --self-check` runs the controlled filesystem
 * negatives: "the target already exists" and "a concurrent claimant lost the
 * race", asserting zero write/spawn side effects on unclaimed paths.
 *
 * Verification scope is unchanged: real `pnpm pack` tarball, host-shared
 * Cordis/protocol resolution, service lifecycle, Gateway dispatch, restart and
 * removal. SIGTERM + `plugin remove` is not a live fiber hot-disable; browser
 * rendering, the WebSocket carrier, visual restore and non-owner authorization
 * remain NOT RUN.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const buildRoot = join(root, 'build')
const cli = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** Raised before any side effect when the run directory is not owned. */
export class OwnershipError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OwnershipError'
  }
}

/**
 * Build the ownership boundary around an injectable filesystem/spawn layer.
 *
 * The injection point is what makes the negative paths testable without disk:
 * the self-check passes fakes and asserts their call counts stay at zero.
 */
export function createOwnership({ io, buildRoot: base, stamp }) {
  const state = { claimed: false, work: undefined }
  const assertClaimed = (action) => {
    if (!state.claimed || state.work === undefined) {
      throw new OwnershipError(`refusing ${action}: the run directory is not claimed`)
    }
  }
  const insideWork = (target) => {
    if (state.work === undefined) return false
    const basePath = resolve(state.work)
    const targetPath = resolve(target)
    return targetPath === basePath || targetPath.startsWith(basePath + sep)
  }
  const verifyWritable = (action, target) => {
    assertClaimed(action)
    if (!insideWork(target)) {
      throw new OwnershipError(`refusing ${action}: path is outside the claimed run directory`)
    }
  }
  return {
    state,
    /** Atomically claim a fresh directory. Throws, and claims nothing, on failure. */
    async claim() {
      const directory = await io.mkdtemp(join(base, `verify-b3-${stamp}-`))
      state.work = directory
      state.claimed = true
      return directory
    },
    async mkdir(target, options) {
      verifyWritable('mkdir', target)
      return io.mkdir(target, options)
    },
    async writeFile(target, data, options) {
      verifyWritable('writeFile', target)
      return io.writeFile(target, data, options)
    },
    async rm(target, options) {
      verifyWritable('rm', target)
      return io.rm(target, options)
    },
    openLog(target) {
      verifyWritable('open log', target)
      return io.openSync(target, 'w')
    },
    spawn(command, args, options) {
      assertClaimed('spawn')
      return io.spawn(command, args, options)
    },
    spawnSync(command, args, options) {
      assertClaimed('spawnSync')
      return io.spawnSync(command, args, options)
    }
  }
}

const realIo = { mkdtemp, mkdir, writeFile, rm, openSync, spawn, spawnSync }

/** Write the final report only when this process owns a run directory. */
export async function finishRun(ownership, result) {
  if (!ownership.state.claimed || ownership.state.work === undefined) {
    return { written: false, workDir: undefined }
  }
  await ownership.mkdir(ownership.state.work, { recursive: true })
  await ownership.writeFile(
    join(ownership.state.work, 'results.json'),
    `${JSON.stringify(result, null, 2)}\n`
  )
  return { written: true, workDir: ownership.state.work }
}

/* ------------------------------------------------------------------ *
 * Controlled filesystem negatives (no disk writes)
 * ------------------------------------------------------------------ */

function fakeIo({ claimError } = {}) {
  const calls = { mkdtemp: [], writeFile: [], mkdir: [], rm: [], openSync: [], spawn: [], spawnSync: [] }
  return {
    calls,
    io: {
      mkdtemp: async (prefix) => {
        calls.mkdtemp.push(prefix)
        if (claimError !== undefined) throw claimError
        return `${prefix}abc123`
      },
      writeFile: async (target) => { calls.writeFile.push(target) },
      mkdir: async (target) => { calls.mkdir.push(target) },
      rm: async (target) => { calls.rm.push(target) },
      openSync: (target) => { calls.openSync.push(target); return 0 },
      spawn: () => { calls.spawn.push(true); return {} },
      spawnSync: () => { calls.spawnSync.push(true); return { status: 0 } }
    }
  }
}

function withCode(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** The target directory already exists: the exclusive claim fails. */
async function scenarioAlreadyExists() {
  const fake = fakeIo({ claimError: withCode('EEXIST', 'EEXIST: directory exists') })
  const ownership = createOwnership({ io: fake.io, buildRoot: 'X:\\evidence', stamp: '20260101T000000' })
  let claimError
  try {
    await ownership.claim()
  } catch (error) {
    claimError = error.code
  }
  const guards = []
  for (const attempt of [
    () => ownership.writeFile('X:\\evidence\\results.json', '{}'),
    () => ownership.mkdir('X:\\evidence\\home'),
    () => ownership.spawn('node', ['-v']),
    () => ownership.spawnSync('node', ['-v']),
    () => ownership.openLog('X:\\evidence\\run.log')
  ]) {
    try {
      await attempt()
      guards.push('ALLOWED')
    } catch (error) {
      guards.push(error instanceof OwnershipError ? 'refused' : `unexpected:${error.name}`)
    }
  }
  const finished = await finishRun(ownership, { status: 'FAIL' })
  const sideEffects = fake.calls.writeFile.length + fake.calls.mkdir.length + fake.calls.rm.length +
    fake.calls.openSync.length + fake.calls.spawn.length + fake.calls.spawnSync.length
  return {
    scenario: 'already-exists',
    ok: claimError === 'EEXIST' &&
      ownership.state.claimed === false &&
      guards.every((entry) => entry === 'refused') &&
      finished.written === false &&
      sideEffects === 0,
    claimError,
    claimed: ownership.state.claimed,
    guards,
    resultsWritten: finished.written,
    sideEffects
  }
}

/** Two claimants race for one name: the loser must stay inert. */
async function scenarioConcurrentClaim() {
  const calls = { mkdtemp: [], writeFile: [], mkdir: [], rm: [], openSync: [], spawn: [], spawnSync: [] }
  const taken = new Set()
  const io = {
    mkdtemp: async (prefix) => {
      calls.mkdtemp.push(prefix)
      const candidate = `${prefix}winner`
      if (taken.has(candidate)) throw withCode('EEXIST', 'EEXIST: claimed by another process')
      taken.add(candidate)
      return candidate
    },
    writeFile: async (target) => { calls.writeFile.push(target) },
    mkdir: async (target) => { calls.mkdir.push(target) },
    rm: async (target) => { calls.rm.push(target) },
    openSync: (target) => { calls.openSync.push(target); return 0 },
    spawn: () => { calls.spawn.push(true); return {} },
    spawnSync: () => { calls.spawnSync.push(true); return { status: 0 } }
  }
  const winner = createOwnership({ io, buildRoot: 'X:\\evidence', stamp: '20260101T000000' })
  const loser = createOwnership({ io, buildRoot: 'X:\\evidence', stamp: '20260101T000000' })
  const winnerDir = await winner.claim()
  let loserError
  try {
    await loser.claim()
  } catch (error) {
    loserError = error.code
  }
  await winner.writeFile(join(winnerDir, 'results.json'), '{"status":"PASS"}')
  const winnerWrites = calls.writeFile.length
  // Even a claimed run must not write outside its own directory (evidence dirs).
  let outsideRefused = false
  try {
    await winner.writeFile('X:\\evidence\\results.json', '{}')
  } catch (error) {
    outsideRefused = error instanceof OwnershipError
  }
  let loserSideEffects = 0
  for (const attempt of [
    () => loser.writeFile('X:\\evidence\\results.json', '{"status":"FAIL"}'),
    () => loser.spawn('node', ['-v'])
  ]) {
    try {
      await attempt()
      loserSideEffects += 1
    } catch (error) {
      if (!(error instanceof OwnershipError)) loserSideEffects += 1
    }
  }
  await finishRun(loser, { status: 'FAIL' })
  return {
    scenario: 'concurrent-claim',
    ok: loserError === 'EEXIST' &&
      loser.state.claimed === false &&
      winner.state.claimed === true &&
      winnerWrites === 1 &&
      outsideRefused &&
      calls.writeFile.every((target) => target.startsWith(winnerDir)) &&
      loserSideEffects === 0,
    loserClaimError: loserError,
    winnerDir,
    winnerWrites,
    outsideRefused,
    loserSideEffects,
    writes: calls.writeFile
  }
}

/**
 * A child process writes on its own, so the boundary must reject an escaping
 * output path or run-owned environment directory *before* spawning. The fake
 * spawn counts calls: only the valid in-directory case may reach it.
 */
function scenarioSubprocessEscape() {
  const runDir = 'X:\\evidence\\run-1'
  let spawnCalls = 0
  const guarded = createSpawnGuard(runDir, () => {
    spawnCalls += 1
    return {}
  })
  const cases = [
    { name: 'outDir', command: 'node', args: ['-p', 'tsconfig.test.json', '--outDir', 'X:\\evidence\\shared-build'], cwd: root },
    { name: 'packDestination', command: 'pnpm', args: ['pack', '--pack-destination', 'X:\\evidence\\pack'], cwd: root },
    { name: 'testTmp', command: 'node', args: ['--test'], cwd: root, env: { WO_TEST_TMP_ROOT: 'X:\\evidence\\tmp' } },
    { name: 'testBuild', command: 'node', args: ['--test'], cwd: root, env: { WO_TEST_BUILD_ROOT: 'X:\\evidence\\build' } },
    { name: 'dshHome', command: 'node', args: ['--profile', 'x'], cwd: root, env: { DSH_HOME: 'X:\\evidence\\home' } },
    { name: 'cwd', command: 'node', args: [], cwd: 'X:\\elsewhere' }
  ]
  const outcomes = []
  for (const item of cases) {
    let refused = false
    try {
      guarded(item.command, item.args, { cwd: item.cwd, env: item.env })
    } catch (error) {
      refused = error instanceof OwnershipError
    }
    outcomes.push({ name: item.name, refused })
  }
  const callsAfterEscapes = spawnCalls
  let insideAllowed = false
  try {
    guarded('node', ['-p', 'tsconfig.test.json', '--outDir', 'X:\\evidence\\run-1\\probe-build'], {
      cwd: root,
      env: { WO_TEST_BUILD_ROOT: 'X:\\evidence\\run-1\\probe-build', WO_TEST_TMP_ROOT: 'X:\\evidence\\run-1\\tmp' }
    })
    insideAllowed = true
  } catch {
    insideAllowed = false
  }
  return {
    scenario: 'subprocess-path-escape',
    ok: outcomes.every((entry) => entry.refused === true) &&
      callsAfterEscapes === 0 &&
      insideAllowed === true &&
      spawnCalls === 1,
    outcomes,
    spawnCallsBeforeValid: callsAfterEscapes,
    insideAllowed,
    spawnCalls
  }
}

async function runSelfCheck() {
  const results = [await scenarioAlreadyExists(), await scenarioConcurrentClaim(), scenarioSubprocessEscape()]
  const ok = results.every((entry) => entry.ok === true)
  console.log(JSON.stringify({ selfCheck: ok ? 'PASS' : 'FAIL', scenarios: results }, null, 2))
  return ok ? 0 : 1
}

/* ------------------------------------------------------------------ *
 * Real run
 * ------------------------------------------------------------------ */

function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

function scrub(text) {
  return String(text).replace(/([?&]token=)[^\s"<>]+/gu, '$1REDACTED')
}

/** What the Host installation itself resolves these specifiers to. */
function hostResolved(specifier) {
  try {
    return pathToFileURL(createRequire(cli).resolve(specifier)).href
  } catch {
    return undefined
  }
}

function inHostInstallation(url) {
  return typeof url === 'string' &&
    /\/node_modules\/\.pnpm\//u.test(url) &&
    !url.includes('verify-b3-') &&
    !url.includes('verify-stage-b3') &&
    !url.includes('/profiles/')
}

/* ------------------------------------------------------------------ *
 * Authorization layers: NOT RUN by default, PASS only from evidence.
 * ------------------------------------------------------------------ */

/** Every layer starts NOT RUN; no layer is ever pre-set. */
function createAuthorizationLayers() {
  return {
    inProcessProbe: 'NOT RUN',
    installedProfileMatrix: 'NOT RUN',
    realCarrierIdentity: 'NOT RUN'
  }
}

/**
 * Record one layer from an actual execution.
 * @param layers - the result's layer object.
 * @param layer - layer key.
 * @param executed - whether the check really ran.
 * @param ok - whether the executed check produced valid evidence.
 * @param detail - short evidence description.
 */
function recordLayer(layers, layer, executed, ok, detail) {
  layers[layer] = executed === true ? (ok === true ? `PASS (${detail})` : `FAIL (${detail})`) : 'NOT RUN'
}

/** A PASS report requires both executable layers to have produced PASS evidence. */
function authorizationGate(status, layers) {
  if (status !== 'PASS') return status
  const complete = layers.inProcessProbe.startsWith('PASS') && layers.installedProfileMatrix.startsWith('PASS')
  return complete ? 'PASS' : 'FAIL'
}

/* ------------------------------------------------------------------ *
 * Subprocess write boundary
 * ------------------------------------------------------------------ */

/** Flags whose value names an output path that must stay inside the run directory. */
const OUTPUT_PATH_FLAGS = new Set(['--outDir', '--pack-destination', '--tsBuildInfoFile'])

/** Environment keys whose value names a run-owned directory. */
const RUN_OWNED_ENV = ['DSH_HOME', 'WO_TEST_BUILD_ROOT', 'WO_TEST_TMP_ROOT']

function isInside(runDir, target) {
  const base = resolve(runDir)
  const value = resolve(target)
  return value === base || value.startsWith(base + sep)
}

/**
 * Validate a subprocess' actual arguments, cwd and run-owned environment before
 * it starts.
 *
 * The ownership guard covers this script's own I/O; a child process writes on
 * its own, so its output paths (`--outDir`, `--pack-destination`, ...) and the
 * directories named by its environment must resolve inside the claimed run
 * directory. The cwd may be the project root (read-only for builds) or inside
 * the run directory; anything else is refused before spawning.
 */
function assertProcessPathsInside(runDir, { command, args = [], cwd, env } = {}) {
  if (cwd !== undefined) {
    const value = resolve(cwd)
    if (!(isInside(runDir, value) || value === resolve(root))) {
      throw new OwnershipError(`refusing spawn ${String(command)}: cwd is outside the run directory and the project root`)
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (!OUTPUT_PATH_FLAGS.has(flag)) continue
    const value = args[index + 1]
    if (value === undefined || value.startsWith('-')) {
      throw new OwnershipError(`refusing spawn ${String(command)}: ${flag} has no path value`)
    }
    if (!isInside(runDir, value)) {
      throw new OwnershipError(`refusing spawn ${String(command)}: ${flag} points outside the run directory`)
    }
  }
  for (const key of RUN_OWNED_ENV) {
    const value = env?.[key]
    if (value !== undefined && !isInside(runDir, value)) {
      throw new OwnershipError(`refusing spawn ${String(command)}: ${key} points outside the run directory`)
    }
  }
}

/** Wrap a spawn function with the boundary check, so nothing starts on a bad path. */
function createSpawnGuard(runDir, spawnFn) {
  return (command, args, options = {}) => {
    assertProcessPathsInside(runDir, { command, args, cwd: options.cwd, env: options.env })
    return spawnFn(command, args, options)
  }
}

/**
 * Controlled failure-path check for the layer state machine, used by
 * `--self-check-authorization`. It proves that a pack/install/boot failure
 * cannot leave a PASS behind for a check that never produced evidence.
 */
function runAuthorizationSelfCheck() {
  const scenarios = []
  const fresh = createAuthorizationLayers()
  scenarios.push({
    name: 'defaults',
    ok: fresh.inProcessProbe === 'NOT RUN' && fresh.installedProfileMatrix === 'NOT RUN' &&
      fresh.realCarrierIdentity === 'NOT RUN' && authorizationGate('PASS', fresh) === 'FAIL',
    layers: { ...fresh },
    gate: authorizationGate('PASS', fresh)
  })

  for (const failure of ['pack', 'install', 'boot']) {
    const layers = createAuthorizationLayers()
    // The in-process probe legitimately ran first; the failing stage never
    // reaches the installed-matrix recording point.
    recordLayer(layers, 'inProcessProbe', true, true, 'simulated executed suite')
    scenarios.push({
      name: `failure-${failure}`,
      ok: layers.installedProfileMatrix === 'NOT RUN' &&
        layers.inProcessProbe.startsWith('PASS') &&
        authorizationGate('PASS', layers) === 'FAIL',
      layers: { ...layers },
      gate: authorizationGate('PASS', layers)
    })
  }

  const failedProbe = createAuthorizationLayers()
  recordLayer(failedProbe, 'inProcessProbe', true, false, 'simulated failing suite')
  scenarios.push({
    name: 'inprocess-failure',
    ok: failedProbe.inProcessProbe.startsWith('FAIL') && authorizationGate('PASS', failedProbe) === 'FAIL',
    layers: { ...failedProbe },
    gate: authorizationGate('PASS', failedProbe)
  })

  const complete = createAuthorizationLayers()
  recordLayer(complete, 'inProcessProbe', true, true, 'simulated executed suite')
  recordLayer(complete, 'installedProfileMatrix', true, true, 'simulated executed matrix')
  scenarios.push({
    name: 'complete',
    ok: authorizationGate('PASS', complete) === 'PASS' && complete.realCarrierIdentity === 'NOT RUN',
    layers: { ...complete },
    gate: authorizationGate('PASS', complete)
  })

  return { ok: scenarios.every((scenario) => scenario.ok === true), scenarios }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, '')
  const ownership = createOwnership({ io: realIo, buildRoot, stamp })
  const hostCordis = hostResolved('@deepseek-ai/cordis')
  const hostProtocol = hostResolved('@deepseek-ai/dsh-typert-protocol')

  const layers = createAuthorizationLayers()
  const result = {
    startedAt: new Date().toISOString(),
    workDir: undefined,
    profile: undefined,
    steps: [],
    status: 'FAIL',
    limits: {
      hotDisableDrain: 'NOT RUN',
      sigtermOrRemoveProvesHotDisable: false,
      browserRender: 'NOT RUN',
      webSocketCarrier: 'NOT RUN',
      visualRestore: 'NOT RUN',
      linkedDevelopmentInstall: 'NOT RUN',
      realCarrierIdentity: 'NOT RUN'
    },
    authorizationLayers: layers,
    authorizationEvidence: {
      inProcessProbe: undefined,
      installedProfileMatrix: undefined,
      realCarrierIdentity: 'NOT RUN'
    }
  }
  const commands = []
  const PROTECTED_EVIDENCE = [
    'build/profile/results.json',
    'build/verify-stage-b2/results.json',
    'build/verify-stage-b3/results.json'
  ]

  let claimed = false
  try {
    const work = await ownership.claim()
    claimed = true
    const profile = `wo3-${basename(work).replace(/^verify-b3-/u, '').toLowerCase()}`
    result.workDir = work
    result.profile = profile
    const home = join(work, 'home')
    const packDir = join(work, 'pack')
    const env = { ...process.env, DSH_HOME: home }
    const spawnChecked = createSpawnGuard(work, ownership.spawn.bind(ownership))
    const spawnSyncChecked = createSpawnGuard(work, ownership.spawnSync.bind(ownership))

    const spawnLogged = (label, command, args, options = {}) => {
      const logFile = join(work, `command-${label}.log`)
      const fd = ownership.openLog(logFile)
      try {
        const child = spawnSyncChecked(command, args, {
          cwd: options.cwd ?? work,
          env: options.env ?? env,
          timeout: options.timeout ?? 300_000,
          windowsHide: true,
          shell: options.shell === true,
          stdio: ['ignore', fd, fd]
        })
        const text = readFileSync(logFile, 'utf8')
        commands.push({ label, command, args, status: child.status ?? -1 })
        return { status: child.status ?? -1, text }
      } finally {
        closeSync(fd)
      }
    }

    const run = (label, args) => {
      const outcome = spawnLogged(label, process.execPath, [cli, ...args])
      if (outcome.status !== 0) throw new Error(`${label} failed with status ${String(outcome.status)}; see command-${label}.log`)
      return outcome.text
    }

    const openIndex = async (rawUrl) => {
      const exchange = await fetch(rawUrl, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
      const cookies = typeof exchange.headers.getSetCookie === 'function'
        ? exchange.headers.getSetCookie()
        : [exchange.headers.get('set-cookie')].filter(Boolean)
      const cookie = cookies.map((value) => value.split(';')[0]).join('; ')
      const page = await fetch(new URL('/', rawUrl), {
        headers: cookie.length === 0 ? {} : { cookie },
        signal: AbortSignal.timeout(20_000)
      })
      return { exchangeStatus: exchange.status, status: page.status, html: await page.text(), cookie }
    }

    const waitFor = async (predicate, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const value = await predicate().catch(() => undefined)
        if (value !== undefined) return value
        await new Promise((resolveWait) => setTimeout(resolveWait, 150))
      }
      throw new Error(`timed out waiting for ${label}`)
    }

    const installedPlugins = async () => {
      const found = []
      const profileRoot = join(home, 'profiles', profile)
      const candidates = [join(profileRoot, 'node_modules', 'workspace-organizer-dsh')]
      for (const candidate of candidates) {
        try {
          const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
          found.push({ path: candidate, manifest })
        } catch {
          // absent is expected for a hoisted layout; the .pnpm scan below covers it
        }
      }
      try {
        const entries = await readdir(join(profileRoot, 'node_modules', '.pnpm'))
        for (const entry of entries) {
          if (!entry.startsWith('workspace-organizer-dsh@')) continue
          const candidate = join(profileRoot, 'node_modules', '.pnpm', entry, 'node_modules', 'workspace-organizer-dsh')
          try {
            const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
            found.push({ path: candidate, manifest })
          } catch {
            // ignore a partial entry
          }
        }
      } catch {
        // no virtual store: the hoisted candidate above is the only layout
      }
      return found
    }

    const bundledRuntimeFacts = async (pluginPath) => {
      const facts = {}
      for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol']) {
        const target = join(pluginPath, 'node_modules', ...name.split('/'))
        facts[name] = await stat(target).then(() => true, () => false)
      }
      return facts
    }

    const packCandidate = async () => {
      const source = await readFile(join(root, 'dist', 'index.js'), 'utf8').catch(() => '')
      const identitySource = await readFile(join(root, 'dist', 'host', 'identity.js'), 'utf8').catch(() => '')
      const selftestSource = await readFile(join(root, 'dist', 'host', 'selftest.js'), 'utf8').catch(() => '')
      if (!source.includes('workspaceOrganizerRemote') ||
        !identitySource.includes('instanceOfContext') ||
        !selftestSource.includes('nonOwnerGrantedStillDenied')) {
        throw new Error('dist/ is missing or stale: run the package build before packing')
      }
      await ownership.mkdir(packDir, { recursive: true })
      const packed = spawnLogged('pack', 'pnpm', ['pack', '--pack-destination', packDir], { cwd: root, shell: true })
      if (packed.status !== 0) throw new Error(`pnpm pack failed with status ${String(packed.status)}`)
      const files = (await readdir(packDir)).filter((name) => name.endsWith('.tgz'))
      if (files.length !== 1) throw new Error(`expected exactly one tarball, found ${String(files.length)}`)
      const tarball = join(packDir, files[0])
      const listing = spawnLogged('pack-list', 'tar', ['-tzf', tarball])
      const entries = listing.text.split('\n').map((line) => line.trim()).filter(Boolean)
      const bytes = await readFile(tarball)
      return {
        tarball,
        name: files[0],
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        entries,
        hasNodeModules: entries.some((entry) => entry.includes('node_modules/')),
        hasDistEntry: entries.includes('package/dist/index.js'),
        hasClientEntry: entries.includes('package/client/client.js')
      }
    }

    const readTree = async () => {
      try {
        const raw = await readFile(join(home, 'workspace-organizer', 'tree.json'), 'utf8')
        const document = JSON.parse(raw)
        return { raw, sha256: sha256(raw), document }
      } catch {
        return undefined
      }
    }

    const identityGates = (identity) => {
      const cordis = identity?.cordis?.resolved
      const protocol = identity?.protocol?.resolved
      return {
        hostCordisBaselineResolved: typeof hostCordis === 'string',
        hostProtocolBaselineResolved: typeof hostProtocol === 'string',
        cordisStrictlyEqualToHost: typeof hostCordis === 'string' && cordis === hostCordis,
        protocolStrictlyEqualToHost: typeof hostProtocol === 'string' && protocol === hostProtocol,
        cordisInHostInstallation: inHostInstallation(cordis),
        protocolInHostInstallation: inHostInstallation(protocol),
        contextBrand: identity?.cordis?.contextBrand === true,
        instanceOfContext: identity?.cordis?.instanceOfContext === true,
        protocolSameServiceClass: identity?.protocol?.sameServiceClass === true
      }
    }

    const boot = async (label, settleMs) => {
      await ownership.rm(join(home, 'workspace-organizer', 'diagnostics.json'), { force: true })
      const existing = new Set(
        (await readdir(join(home, 'workspace-organizer')).catch(() => [])).filter((name) => name.startsWith('selftest-'))
      )
      const logFile = join(work, `host-${label}.log`)
      const fd = ownership.openLog(logFile)
      const child = spawnChecked(process.execPath, [cli, '--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
        cwd: work,
        env: {
          ...env,
          DSH_WORKSPACE_ORGANIZER_DIAGNOSTICS: '1',
          DSH_WORKSPACE_ORGANIZER_SELFTEST: '1',
          DSH_WORKSPACE_ORGANIZER_SETTLE_MS: String(settleMs)
        },
        windowsHide: true,
        stdio: ['ignore', fd, fd]
      })
      const logs = () => readFile(logFile, 'utf8').catch(() => '')
      let exited = false
      child.once('exit', () => { exited = true })

      try {
        const rawUrl = await waitFor(async () => {
          const text = await logs()
          if (exited) throw new Error(`host exited early: ${scrub(text)}`)
          return text.match(/https?:\/\/127\.0\.0\.1:\d+\/?\?token=\S+/u)?.[0]
        }, 120_000, `${label} readiness`)

        const diagnostics = await waitFor(async () => {
          return JSON.parse(await readFile(join(home, 'workspace-organizer', 'diagnostics.json'), 'utf8'))
        }, 120_000, `${label} diagnostics`)

        const selftest = await waitFor(async () => {
          const files = (await readdir(join(home, 'workspace-organizer')))
            .filter((name) => name.startsWith('selftest-') && !existing.has(name))
          if (files.length === 0) return undefined
          return JSON.parse(await readFile(join(home, 'workspace-organizer', files.sort().at(-1)), 'utf8'))
        }, 90_000, `${label} self-test`)

        const page = await openIndex(rawUrl)
        const html = page.html
        const entryText = html.match(/\{[^{}]*"id":"workspace-organizer-dsh"[^{}]*\}/u)?.[0] ?? ''
        const modulePath = entryText.match(/"url":"([^"]+)"/u)?.[1]
        let servedBundle = { path: modulePath ?? '(not advertised)', status: 0, bytes: 0, registersModule: false }
        if (modulePath !== undefined) {
          const moduleResponse = await fetch(new URL(modulePath, rawUrl), {
            headers: page.cookie.length === 0 ? {} : { cookie: page.cookie },
            signal: AbortSignal.timeout(20_000)
          })
          const moduleBody = await moduleResponse.text()
          servedBundle = {
            path: modulePath,
            status: moduleResponse.status,
            bytes: moduleBody.length,
            registersModule: moduleBody.includes('workspace-organizer-dsh') && moduleBody.includes('__ModuleLoader__')
          }
        }

        return {
          label,
          url: scrub(rawUrl),
          httpStatus: page.status,
          diagnostics,
          selftest,
          graphMentionsPlugin: html.includes('workspace-organizer-dsh'),
          servedBundle,
          logTail: scrub(await logs()).split('\n').slice(-10)
        }
      } finally {
        if (!exited) {
          // SIGTERM stops this child only. It is NOT a live Cordis fiber hot-disable.
          child.kill('SIGTERM')
          await Promise.race([once(child, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 20_000))]).catch(() => undefined)
        }
        closeSync(fd)
      }
    }

    const bootHtml = async (label) => {
      const logFile = join(work, `host-${label}.log`)
      const fd = ownership.openLog(logFile)
      const child = spawnChecked(process.execPath, [cli, '--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
        cwd: work,
        env,
        windowsHide: true,
        stdio: ['ignore', fd, fd]
      })
      const logs = () => readFile(logFile, 'utf8').catch(() => '')
      let exited = false
      child.once('exit', () => { exited = true })
      try {
        const url = await waitFor(async () => {
          const text = await logs()
          if (exited) throw new Error(`host exited early: ${scrub(text)}`)
          return text.match(/https?:\/\/127\.0\.0\.1:\d+\/?\?token=\S+/u)?.[0]
        }, 120_000, `${label} readiness`)
        const page = await openIndex(url)
        return {
          label,
          httpStatus: page.status,
          graphMentionsPlugin: page.html.includes('workspace-organizer-dsh'),
          logTail: scrub(await logs()).split('\n').slice(-6)
        }
      } finally {
        if (!exited) {
          child.kill('SIGTERM')
          await Promise.race([once(child, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 20_000))]).catch(() => undefined)
        }
        closeSync(fd)
      }
    }

    const evidenceFingerprints = async () => {
      const fingerprints = {}
      for (const relative of PROTECTED_EVIDENCE) {
        try {
          const bytes = await readFile(join(root, relative))
          fingerprints[relative] = { exists: true, sha256: sha256(bytes) }
        } catch {
          fingerprints[relative] = { exists: false }
        }
      }
      return fingerprints
    }

    await ownership.mkdir(home, { recursive: true })
    const evidenceBefore = await evidenceFingerprints()

    // In-process authorization probe: compiled and executed inside the claimed
    // run directory, so no subprocess writes outside it. The test file resolves
    // its module under test and temp root from these variables.
    const probeBuild = join(work, 'probe-build')
    const probeTmp = join(work, 'probe-tmp')
    await ownership.mkdir(probeBuild, { recursive: true })
    await ownership.mkdir(probeTmp, { recursive: true })
    const testBuild = spawnLogged('test-build', process.execPath, [
      join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      'tsconfig.test.json',
      '--outDir',
      probeBuild
    ], { cwd: root })
    const probeRun = testBuild.status === 0
      ? spawnLogged('inprocess-auth', process.execPath, ['--test', '--test-isolation=none', 'tests/authorization.test.mjs'], {
          cwd: root,
          env: { ...env, WO_TEST_BUILD_ROOT: probeBuild, WO_TEST_TMP_ROOT: probeTmp }
        })
      : undefined
    const probePasses = Number(/pass (\d+)/u.exec(probeRun?.text ?? '')?.[1] ?? 0)
    const probeFailures = Number(/fail (\d+)/u.exec(probeRun?.text ?? '')?.[1] ?? 1)
    const probeOk = testBuild.status === 0 && probeRun?.status === 0 && probePasses > 0 && probeFailures === 0
    result.authorizationEvidence.inProcessProbe = {
      testBuildStatus: testBuild.status,
      exitCode: probeRun?.status ?? null,
      passes: probePasses,
      failures: probeFailures,
      buildRoot: probeBuild,
      tempRoot: probeTmp,
      logSha256: probeRun === undefined ? null : sha256(probeRun.text)
    }
    recordLayer(layers, 'inProcessProbe', true, probeOk,
      `tests/authorization.test.mjs ${String(probePasses)} passed / ${String(probeFailures)} failed, exit ${String(probeRun?.status ?? 'n/a')}`)
    result.steps.push({
      step: 'in-process-authorization',
      ok: probeOk,
      ...result.authorizationEvidence.inProcessProbe
    })

    const pkg = await packCandidate()
    result.package = pkg
    result.steps.push({
      step: 'pack',
      ok: pkg.hasDistEntry && pkg.hasClientEntry && !pkg.hasNodeModules,
      tarball: pkg.name,
      bytes: pkg.bytes,
      sha256: pkg.sha256,
      hasDist: pkg.hasDistEntry,
      hasClient: pkg.hasClientEntry,
      bundlesNodeModules: pkg.hasNodeModules
    })

    const initial = run('init', ['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
    result.steps.push({ step: 'init-profile', ok: initial.length > 0 })

    run('install', ['plugin', '--profile', profile, 'add', `file:${pkg.tarball}`])
    const installed = run('installed-config', ['--profile', profile, '--dump-config'])
    await ownership.writeFile(join(work, 'installed-config.yml'), installed)

    const plugins = await installedPlugins()
    const bundleFacts = plugins.length === 0 ? {} : await bundledRuntimeFacts(plugins[0].path)
    result.install = {
      plugins: plugins.map((entry) => ({
        path: entry.path,
        declaredPeers: entry.manifest.peerDependencies ?? {},
        declaredDependencies: entry.manifest.dependencies ?? {}
      })),
      bundledRuntime: bundleFacts
    }
    result.steps.push({
      step: 'install',
      ok: installed.includes('workspace-organizer-dsh') &&
        plugins.length > 0 &&
        Object.values(bundleFacts).every((bundled) => bundled === false),
      plugins: result.install.plugins,
      bundledRuntime: bundleFacts
    })

    result.boot1 = await boot('boot-1', 8_000)
    const treeAfterBoot1 = await readTree()
    const gates1 = identityGates(result.boot1.diagnostics.moduleIdentity)
    result.steps.push({
      step: 'module-identity',
      ok: Object.values(gates1).every((gate) => gate === true),
      identity: result.boot1.diagnostics.moduleIdentity,
      hostResolution: { cordis: hostCordis, protocol: hostProtocol },
      gates: gates1
    })

    const boot1Graph = result.boot1.diagnostics.clientGraph
    const REQUIRED_SELFTEST_STEPS = [
      'ownerMatrix',
      'createConversationRefused',
      'nonOwnerDefaultDenied',
      'nonOwnerGrantedStillDenied',
      'nonOwnerGrantRevokedDenied',
      'finalState',
      'moduleIdentity'
    ]
    const boot1Steps = result.boot1.selftest.steps
    const boot1Step = (name) => boot1Steps.find((step) => step.step === name)
    const boot1MatrixOk = REQUIRED_SELFTEST_STEPS.every((name) => boot1Step(name)?.ok === true)
    result.steps.push({
      step: 'boot-1',
      ok: result.boot1.diagnostics.plugin === 'workspace-organizer' &&
        result.boot1.httpStatus === 200 &&
        boot1Graph?.mentionsPlugin === true &&
        result.boot1.diagnostics.remoteService === true &&
        result.boot1.servedBundle?.status === 200 &&
        result.boot1.servedBundle?.registersModule === true &&
        boot1Steps.every((step) => step.ok === true) &&
        boot1MatrixOk &&
        treeAfterBoot1 !== undefined,
      httpStatus: result.boot1.httpStatus,
      settle: result.boot1.diagnostics.settle,
      remoteService: result.boot1.diagnostics.remoteService,
      clientGraph: boot1Graph,
      servedBundle: result.boot1.servedBundle,
      requiredSteps: REQUIRED_SELFTEST_STEPS.map((name) => ({ name, present: boot1Step(name) !== undefined, ok: boot1Step(name)?.ok })),
      selftest: boot1Steps,
      treeAfterBoot1: treeAfterBoot1 === undefined
        ? undefined
        : { revision: treeAfterBoot1.document.revision, nodes: treeAfterBoot1.document.nodes.length }
    })
    recordLayer(layers, 'installedProfileMatrix', true, boot1MatrixOk,
      'boot-1 self-test owner matrix + 7-endpoint non-owner default/granted/revoked')
    result.authorizationEvidence.installedProfileMatrix = {
      source: 'boot-1 self-test',
      matrixOk: boot1MatrixOk,
      requiredSteps: REQUIRED_SELFTEST_STEPS.map((name) => ({ name, ok: boot1Step(name)?.ok === true })),
      ownerDelta: boot1Step('ownerMatrix')?.mutations,
      treeSha256: boot1Step('finalState')?.treeSha256
    }

    result.boot2 = await boot('boot-2', 8_000)
    const treeAfterBoot2 = await readTree()
    const gates2 = identityGates(result.boot2.diagnostics.moduleIdentity)
    const restartSnapshot = result.boot2.selftest.steps.find((step) => step.step === 'snapshot')
    const final1 = boot1Step('finalState')
    const final2 = result.boot2.selftest.steps.find((step) => step.step === 'finalState')
    const matrix2 = result.boot2.selftest.steps.find((step) => step.step === 'ownerMatrix')
    const deltaRevisions = matrix2?.mutations?.revisions
    const deltaNodes = matrix2?.mutations?.nodes
    const boot1Nodes = treeAfterBoot1?.document.nodes ?? []
    const boot2Nodes = treeAfterBoot2?.document.nodes ?? []
    const preservedNodes = boot1Nodes.length > 0 && boot1Nodes.every((before) => {
      const after = boot2Nodes.find((node) => node.id === before.id)
      return after !== undefined && after.parentId === before.parentId && after.title === before.title
    })
    result.steps.push({
      step: 'boot-2-restart',
      ok: result.boot2.graphMentionsPlugin === true &&
        result.boot2.selftest.steps.every((step) => step.ok === true) &&
        Object.values(gates2).every((gate) => gate === true) &&
        restartSnapshot !== undefined &&
        final1 !== undefined &&
        final2 !== undefined &&
        typeof deltaRevisions === 'number' && deltaRevisions > 0 &&
        typeof deltaNodes === 'number' && deltaNodes > 0 &&
        restartSnapshot.revision === final1.revision &&
        restartSnapshot.nodes === final1.nodes &&
        treeAfterBoot1.document.revision === final1.revision &&
        treeAfterBoot2.document.revision === final1.revision + deltaRevisions &&
        boot2Nodes.length === final1.nodes + deltaNodes &&
        final2.revision === treeAfterBoot2.document.revision &&
        final2.nodes === boot2Nodes.length &&
        preservedNodes,
      graphMentionsPlugin: result.boot2.graphMentionsPlugin,
      identityGates: gates2,
      selftestSnapshot: restartSnapshot,
      boot1FinalState: final1,
      boot2FinalState: final2,
      expectedDelta: { revisions: deltaRevisions, nodes: deltaNodes },
      before: treeAfterBoot1 === undefined
        ? undefined
        : { revision: treeAfterBoot1.document.revision, nodes: boot1Nodes.length },
      after: treeAfterBoot2 === undefined
        ? undefined
        : { revision: treeAfterBoot2.document.revision, nodes: boot2Nodes.length },
      preservedIds: boot1Nodes.map((node) => node.id),
      preservedNodes
    })

    run('remove', ['plugin', '--profile', profile, 'remove', 'workspace-organizer-dsh'])
    const removed = run('removed-config', ['--profile', profile, '--dump-config'])
    result.removed = await bootHtml('boot-3-removed').catch((error) => ({ error: scrub(error.message) }))
    const treeAfterRemoval = await readTree()
    const dataRetained = treeAfterRemoval !== undefined
    const dataUnchanged = treeAfterRemoval?.sha256 === treeAfterBoot2?.sha256
    result.steps.push({
      step: 'remove',
      ok: !removed.includes('workspace-organizer-dsh') &&
        result.removed?.graphMentionsPlugin === false &&
        dataRetained &&
        dataUnchanged,
      configClean: !removed.includes('workspace-organizer-dsh'),
      graphMentionsPlugin: result.removed?.graphMentionsPlugin,
      dataRetained,
      dataUnchanged,
      treeSha256: treeAfterRemoval?.sha256
    })
    await ownership.writeFile(join(work, 'removed-config.yml'), removed)

    const evidenceAfter = await evidenceFingerprints()
    const preserved = PROTECTED_EVIDENCE.every((relative) =>
      evidenceBefore[relative].exists === evidenceAfter[relative].exists &&
      evidenceBefore[relative].sha256 === evidenceAfter[relative].sha256)
    result.evidence = { before: evidenceBefore, after: evidenceAfter, preserved }
    result.steps.push({
      step: 'evidence-preserved',
      ok: preserved && evidenceBefore[PROTECTED_EVIDENCE[2]].exists === true,
      preserved,
      checked: PROTECTED_EVIDENCE
    })

    result.status = authorizationGate(result.steps.every((step) => step.ok === true) ? 'PASS' : 'FAIL', layers)
  } catch (error) {
    result.error = scrub(error instanceof Error ? error.message : String(error))
    result.stack = scrub(error instanceof Error ? error.stack : '')
  } finally {
    result.commands = commands
    result.finishedAt = new Date().toISOString()
    const finished = await finishRun(ownership, result)
    if (finished.written) {
      console.log(JSON.stringify({
        status: result.status,
        workDir: finished.workDir,
        steps: result.steps,
        error: result.error,
        results: join(finished.workDir, 'results.json')
      }, null, 2))
    } else {
      // A failed claim must not write anywhere, not even a failure report.
      console.log(JSON.stringify({
        status: 'FAIL',
        claimed,
        error: result.error ?? 'run directory was not claimed',
        writes: 0
      }, null, 2))
    }
  }
  return result.status === 'PASS' ? 0 : 1
}

if (process.argv.includes('--self-check')) {
  process.exitCode = await runSelfCheck()
} else if (process.argv.includes('--self-check-authorization')) {
  const check = runAuthorizationSelfCheck()
  console.log(JSON.stringify(check, null, 2))
  process.exitCode = check.ok ? 0 : 1
} else {
  process.exitCode = await main()
}
