import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const REQUIRED_CONTEXT = ['R', 'root', 'home', 'profile', 'cli']
const ABSOLUTE_CONTEXT = ['R', 'root', 'home', 'cli']

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function createRuntimeContext(input) {
  if (input === null || typeof input !== 'object') throw new Error('runtime context must be an object')
  for (const key of REQUIRED_CONTEXT) {
    if (typeof input[key] !== 'string' || input[key].length === 0) throw new Error(`runtime context missing ${key}`)
  }
  for (const key of ABSOLUTE_CONTEXT) {
    if (!isAbsolute(input[key])) throw new Error(`runtime context ${key} must be absolute`)
  }
  if (resolve(input.R) !== input.R) throw new Error('runtime context R must be normalized')
  return Object.freeze({
    R: input.R,
    root: input.root,
    home: input.home,
    profile: input.profile,
    cli: input.cli,
    env: Object.freeze({ ...(input.env ?? {}) })
  })
}

export function artifactPath(context, name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('..') || isAbsolute(name)) throw new Error('artifact name must be a relative file name')
  return join(context.R, name)
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

export function runCommand(command, args, options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? 120_000
  const startedAt = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, shell: options.shell === true, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    const finish = (code, signal, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ command, args, code, signal, timedOut, error: error === undefined ? null : String(error?.message ?? error), stdout, stderr, durationMs: Date.now() - startedAt })
    }
    child.on('error', (error) => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal, null))
  })
}

export async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate()
    if (value !== undefined && value !== null && value !== false) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
  throw new Error(`bounded wait timed out after ${timeoutMs}ms`)
}

export function fixtureReady(state) {
  return Object.freeze({
    fixture: state?.fixture === true,
    persisted: state?.persisted === true,
    expected: state?.expected === true,
    hooks: state?.hooks === true
  })
}

export function isReady(ready) {
  return ready !== null && typeof ready === 'object' && ['fixture', 'persisted', 'expected', 'hooks'].every((key) => ready[key] === true)
}

class CdpConnection {
  constructor(url) {
    this.nextId = 1
    this.pending = new Map()
    this.socket = new WebSocket(url)
    this.ready = new Promise((resolvePromise, reject) => {
      this.socket.addEventListener('open', () => resolvePromise(this))
      this.socket.addEventListener('error', () => reject(new Error('CDP websocket error')))
    })
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try { this.socket.close() } catch {}
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text ?? 'evaluate failed')
  return result.result.value
}

async function clickVisible(cdp, selector) {
  const info = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return { found: false };
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { found: true, x, y, hit: hit === null ? null : hit.tagName + '#' + hit.id, within: hit !== null && (hit === el || el.contains(hit)) };
  })()`)
  if (info.found !== true) throw new Error(`selector missing: ${selector}`)
  if (info.within !== true) throw new Error(`element is not visibly hittable: ${selector} hit=${info.hit}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 })
  return info
}

export async function runReadinessFlow({ cold, hooks, handshake, timeoutMs = 10_000 }) {
  if (cold?.ok !== true) return { stage: 'cold', handshakeCalled: false, ready: false, resetAllowed: false, cold }
  if (hooks?.ok !== true) return { stage: 'hooks', handshakeCalled: false, ready: false, resetAllowed: false, cold, hooks }
  let timer
  try {
    const handshakeResult = await Promise.race([
      Promise.resolve().then(handshake),
      new Promise((resolvePromise, reject) => {
        timer = setTimeout(() => reject(new Error('handshake timeout')), timeoutMs)
      })
    ])
    return { stage: 'roundTrip', handshakeCalled: true, ready: true, resetAllowed: true, handshakeResult }
  } catch (error) {
    return { stage: 'handshake-timeout', handshakeCalled: true, ready: false, resetAllowed: false, error: String(error?.message ?? error) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function waitForExit(exitPromise, timeoutMs) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs)
    Promise.resolve(exitPromise).then(() => {
      clearTimeout(timer)
      resolvePromise(true)
    })
  })
}

export function validateColdRead(expected, bootstrap, checkpoint) {
  const failures = []
  const catalog = Array.isArray(checkpoint?.list) ? checkpoint.list : []
  const find = (id) => catalog.find((row) => row.id === id)
  const s1 = bootstrap?.sessions?.['web-sess-s1']
  const s2 = bootstrap?.sessions?.['web-sess-s2']
  if (checkpoint?.errors?.length !== 0) failures.push('errors')
  if (bootstrap?.a?.path !== expected?.workspace?.path) failures.push('workspace.path')
  if (s1?.marker !== expected?.marker1 || s2?.marker !== expected?.marker2) failures.push('marker')
  if (s1?.readBack?.hasMarker !== true || s1?.readBack?.count !== 3) failures.push('s1')
  if (s2?.readBack?.hasMarker !== true || s2?.readBack?.count !== 2) failures.push('s2')
  const t1 = find('wo-t1'); const t2 = find('wo-t2'); const t3 = find('wo-t3'); const t4 = find('wo-t4-missing')
  if (!(t1?.kind === 'child' && t1?.parentId === 'web-sess-s1' && t1?.depth === 1)) failures.push('t1')
  if (!(t2?.parentId === 'wo-t1' && t2?.depth === 2)) failures.push('t2')
  if (!(t3?.parentId === 'wo-t1' && t3?.depth === 2)) failures.push('t3')
  if (!(t4?.kind === 'diagnostic' && t4?.parentId === 'web-sess-s1' && t4?.depth === 1 && t4?.reason === 'unavailable')) failures.push('t4')
  if (checkpoint?.persistence?.header?.id !== 'web-sess-s1' || checkpoint?.persistence?.header?.cwd !== expected?.workspace?.path) failures.push('header')
  return { ok: failures.length === 0, failures }
}

export function validateHooks(probe, required) {
  if (probe?.probes === undefined || required === undefined) return { ok: false, failures: ['probe'] }
  const failures = []
  for (const [key, methods] of Object.entries(required)) {
    if (probe.probes[key]?.present !== true) { failures.push(key + ':present'); continue }
    for (const method of methods) {
      const row = probe.probes[key].methods?.[method]
      if (row?.typeof !== 'function' || row?.wrapped !== true) failures.push(key + '/' + method)
    }
  }
  const expectedCounts = Object.entries(required).flatMap(([key, methods]) => methods.map((method) => key + '/' + method))
  for (const key of expectedCounts) if (probe.counts?.[key] !== 0) failures.push('count:' + key)
  return { ok: failures.length === 0, failures }
}

export function validateRoundTrip({ bootId, requestId, ack, fresh, required }) {
  const failures = []
  if (ack?.ok !== true || ack?.requestId !== requestId || ack?.value !== 'missing') failures.push('ack')
  if (fresh?.bootId !== bootId || fresh?.snapshotSeq <= 0) failures.push('boot')
  const expectedCounts = Object.entries(required ?? {}).flatMap(([key, methods]) => methods.map((method) => key + '/' + method))
  for (const key of expectedCounts) if (fresh?.counts?.[key] !== 0) failures.push('count:' + key)
  if ((fresh?.calls?.length ?? 0) !== 0) failures.push('calls')
  return { ok: failures.length === 0, failures }
}

export async function runReadinessGates({ cold, hooks, handshake }) {
  if (cold?.ok !== true) return { stage: 'cold', handshakeCalled: false, cold }
  if (hooks?.ok !== true) return { stage: 'hooks', handshakeCalled: false, cold, hooks }
  const roundTrip = await handshake()
  return { stage: 'roundTrip', handshakeCalled: true, cold, hooks, roundTrip }
}

export async function neutralCdpSmoke(browserPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000
  const dir = await mkdtemp(join(tmpdir(), 'wo-cdp-smoke-'))
  const pageHtml = '<!doctype html><button id="target" style="position:absolute;left:100px;top:100px;width:80px;height:32px" onclick="window.__clicks=(window.__clicks||0)+1">go</button><div id="overlay" style="position:absolute;left:0;top:0;width:400px;height:300px;background:rgba(0,0,0,.2);display:none"></div>'
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(pageHtml) })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const url = `http://127.0.0.1:${server.address().port}/`
  const chrome = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${dir}`, '--remote-debugging-port=0', url], { windowsHide: true })
  let stderr = ''
  let browserCdp = null
  let pageCdp = null
  let result = null
  let failure = null
  let chromeExit = null
  const exitObserved = new Promise((resolvePromise) => {
    chrome.once('exit', (code, signal) => {
      chromeExit = { code, signal, observed: true, timedOut: false }
      resolvePromise()
    })
  })
  const startedAt = Date.now()
  try {
    const browserWs = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP endpoint timeout')), timeoutMs)
      chrome.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/u)
        if (match !== null) { clearTimeout(timer); resolvePromise(match[1]) }
      })
    })
    browserCdp = new CdpConnection(browserWs)
    await browserCdp.ready
    const port = new URL(browserWs).port
    const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((response) => response.json())
    pageCdp = new CdpConnection(target.webSocketDebuggerUrl)
    await pageCdp.ready
    await pageCdp.send('Runtime.enable')
    await pageCdp.send('Page.enable')
    await waitFor(async () => await evaluate(pageCdp, 'document.querySelector("#target") !== null'), timeoutMs)
    const hit = await clickVisible(pageCdp, '#target')
    const clicks = await evaluate(pageCdp, 'window.__clicks ?? 0')
    await evaluate(pageCdp, 'document.querySelector("#overlay").style.display="block"')
    let overlayRejected = false
    let overlayError = null
    try { await clickVisible(pageCdp, '#target') } catch (error) { overlayRejected = true; overlayError = String(error?.message ?? error) }
    result = {
      ok: clicks === 1 && overlayRejected,
      hit,
      clicks,
      overlayRejected,
      overlayError,
      durationMs: Date.now() - startedAt,
      stderr: stderr.slice(0, 500),
      cleanup: 'pending'
    }
  } catch (error) {
    failure = error
  } finally {
    pageCdp?.close()
    browserCdp?.close()
    chrome.kill('SIGTERM')
    const observed = await waitForExit(exitObserved, 2_000)
    if (chromeExit === null || observed === false) chromeExit = { code: null, signal: null, observed: false, timedOut: true }
    await new Promise((resolvePromise) => server.close(resolvePromise))
    try { await rm(dir, { recursive: true, force: true }) } catch {}
    if (result !== null) {
      result.chromeExit = chromeExit
      result.cleanup = 'closed'
    }
  }
  if (failure !== null) throw failure
  return result
}
