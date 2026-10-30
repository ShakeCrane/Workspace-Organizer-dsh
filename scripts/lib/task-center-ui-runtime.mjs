import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

export function pidBelongsToRun(pid, ownedPids) {
  return Number.isInteger(pid) && pid > 0 && ownedPids.includes(pid)
}

export async function superviseUi(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 240_000
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true })
  const startedAt = Date.now()
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const exited = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, error: String(error?.message ?? error) }))
    child.on('exit', (code, signal) => resolve({ code, signal, error: null }))
  })
  let timer
  const timerFired = new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(null) }, timeoutMs) })
  let outcome = await Promise.race([exited, timerFired])
  if (timedOut) {
    if (options.cancelFile !== undefined) await writeFile(options.cancelFile, 'cancel', 'utf8')
    outcome = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 5_000))])
    if (outcome === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      child.kill('SIGKILL')
      outcome = await exited
    }
  }
  clearTimeout(timer)
  if (options.stdoutFile !== undefined) await writeFile(options.stdoutFile, stdout, 'utf8')
  if (options.stderrFile !== undefined) await writeFile(options.stderrFile, stderr, 'utf8')
  return { ...outcome, timedOut, pid: child.pid, stdout, stderr, durationMs: Date.now() - startedAt }
}


export async function withDeadline(phase, timeoutMs, fn, checkpoint) {
  const controller = new AbortController()
  let timer
  const timeout = new Promise((resolvePromise, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`phase timeout: ${phase}`))
    }, timeoutMs)
  })
  if (checkpoint !== undefined) await checkpoint({ phase, event: 'enter', timeoutMs })
  try {
    const value = await Promise.race([Promise.resolve().then(() => fn(controller.signal)), timeout])
    if (checkpoint !== undefined) await checkpoint({ phase, event: 'exit' })
    return value
  } finally {
    clearTimeout(timer)
  }
}

export async function abortableFetch(url, timeoutMs, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function boundedChildExit(child, exited, options = {}) {
  const termMs = options.termMs ?? 5_000
  const killMs = options.killMs ?? 5_000
  child.kill('SIGTERM')
  let exit = await raceTimeout(exited, termMs)
  let killed = false
  if (exit === null) {
    killed = true
    child.kill('SIGKILL')
    exit = await raceTimeout(exited, killMs)
  }
  return { exit, killed, timedOut: exit === null }
}

async function raceTimeout(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(null), timeoutMs) })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function checkpointWriter(file) {
  let chain = Promise.resolve()
  return (entry) => {
    chain = chain.then(async () => {
      const line = JSON.stringify({ at: Date.now(), ...entry }) + '\n'
      await writeFile(file, line, { encoding: 'utf8', flag: 'a' })
    })
    return chain
  }
}
