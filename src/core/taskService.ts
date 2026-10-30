/**
 * Durable task ledger: one atomic aggregate, a serialized reconcile queue, and
 * an optimistic revision gate. Reads never migrate or rewrite the file.
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { OrganizerError } from './errors.js'
import {
  emptyTaskLedger,
  reconcileTasks,
  TASK_LEDGER_SCHEMA_VERSION,
  validateTaskLedger,
  type CatalogRow,
  type HeaderObservation,
  type ReconcileInput,
  type ReconcileResult,
  type SourceRecord,
  type TaskLedger
} from './tasks.js'

/** The durability boundary the ledger service depends on. */
export interface TaskLedgerRepository {
  readonly location: string
  load(): Promise<TaskLedger | undefined>
  save(ledger: TaskLedger, expectedRevision: number): Promise<void>
}

/** In-memory adapter for tests and host-less harnesses. */
export class MemoryTaskLedgerRepository implements TaskLedgerRepository {
  readonly location = 'memory:tasks'
  #ledger: TaskLedger | undefined

  async load(): Promise<TaskLedger | undefined> {
    return this.#ledger
  }

  async save(ledger: TaskLedger, expectedRevision: number): Promise<void> {
    const current = this.#ledger?.revision ?? 0
    if (current !== expectedRevision) {
      throw new OrganizerError('task/conflict', 'task ledger changed by another writer', { expectedRevision, found: current })
    }
    this.#ledger = ledger
  }
}

/** One-file JSON adapter with atomic replacement and a revision gate. */
export class JsonTaskLedgerRepository implements TaskLedgerRepository {
  readonly location: string

  constructor(readonly file: string) {
    this.location = file
  }

  async load(): Promise<TaskLedger | undefined> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new OrganizerError('task/unavailable', 'task ledger could not be read', {
        location: this.location,
        cause: error instanceof Error ? error.message : String(error)
      })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new OrganizerError('task/invalid-ledger', 'task ledger is not valid JSON', {
        location: this.location,
        cause: error instanceof Error ? error.message : String(error)
      })
    }
    return validateTaskLedger(parsed)
  }

  async save(ledger: TaskLedger, expectedRevision: number): Promise<void> {
    const current = await this.load()
    const found = current?.revision ?? 0
    if (found !== expectedRevision) {
      throw new OrganizerError('task/conflict', 'task ledger changed by another writer', { expectedRevision, found })
    }
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = join(dirname(this.file), `.tasks-${String(process.pid)}-${String(Date.now())}.tmp`)
    const handle = await open(temporary, 'w')
    try {
      await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, this.file)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw new OrganizerError('task/unavailable', 'task ledger could not be installed', {
        location: this.location,
        cause: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

/** Serialized use cases over one ledger. */
export class TaskLedgerService {
  readonly #repository: TaskLedgerRepository
  readonly #now: () => string
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: { repository: TaskLedgerRepository; now?: () => string }) {
    this.#repository = options.repository
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  get location(): string {
    return this.#repository.location
  }

  snapshot(): Promise<TaskLedger> {
    return this.#enqueue(async () => (await this.#repository.load()) ?? emptyTaskLedger(this.#now()))
  }

  reconcile(input: {
    source: SourceRecord
    catalog: readonly CatalogRow[]
    headers: Readonly<Record<string, HeaderObservation>>
    sourceBlockedReason?: string
    newTaskId?: (childSessionId: string) => string
  }): Promise<ReconcileResult> {
    return this.#enqueue(async () => {
      const previous = await this.#repository.load()
      const result = reconcileTasks({
        previous,
        source: input.source,
        catalog: input.catalog,
        headers: input.headers,
        now: this.#now(),
        ...(input.sourceBlockedReason === undefined ? {} : { sourceBlockedReason: input.sourceBlockedReason }),
        ...(input.newTaskId === undefined ? {} : { newTaskId: input.newTaskId })
      } satisfies ReconcileInput)
      await this.#repository.save(result.ledger, previous?.revision ?? 0)
      return result
    })
  }

  async drain(): Promise<void> {
    await this.#tail
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work)
    this.#tail = run.then(() => undefined, () => undefined)
    return run.catch((error: unknown) => {
      throw error instanceof OrganizerError ? error : new OrganizerError('task/unavailable', 'task ledger operation failed', {
        cause: error instanceof Error ? error.message : String(error)
      })
    })
  }
}

/** Re-exported for callers that only need the schema constant. */
export { TASK_LEDGER_SCHEMA_VERSION }
