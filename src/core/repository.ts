/**
 * Repository port and its two adapters.
 *
 * `JsonTreeRepository` persists the single authoritative aggregate as one JSON
 * record with a schema version, writing through a temporary file and rename so
 * a reader never observes a half-written document. It refuses a stale write
 * (optimistic revision check) and refuses to load a document it cannot prove
 * valid — no silent repair, because a repaired tree could re-parent user data.
 *
 * The DSH `storageDomain` + JSON backend is the same backing technology; wiring
 * that service is deferred until its official package can be declared as a real
 * dependency of this plugin (see the Stage B report). Keeping the port narrow
 * means that adapter replaces this one without touching the core.
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { OrganizerError } from './errors.js'
import { OLDEST_READABLE_SCHEMA_VERSION, TREE_SCHEMA_VERSION, validateDocument, type TreeDocument } from './model.js'

/** Largest accepted on-disk document; a larger file is refused rather than truncated. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

/** The durability boundary the core depends on. */
export interface TreeRepository {
  /** Human-readable storage location for diagnostics; never a secret. */
  readonly location: string
  load(): Promise<TreeDocument | undefined>
  save(document: TreeDocument, expectedRevision: number): Promise<void>
}

function corrupt(message: string, details: Record<string, unknown> = {}): never {
  throw new OrganizerError('tree/corrupt', message, details)
}

/** In-memory adapter: deterministic, used by tests and by host-less harnesses. */
export class MemoryTreeRepository implements TreeRepository {
  readonly location = 'memory:tree'
  #document: TreeDocument | undefined

  async load(): Promise<TreeDocument | undefined> {
    return this.#document
  }

  async save(document: TreeDocument, expectedRevision: number): Promise<void> {
    const current = this.#document?.revision ?? 0
    if (current !== expectedRevision) {
      throw new OrganizerError('tree/conflict', 'tree was changed by another writer', { expectedRevision, found: current })
    }
    this.#document = document
  }
}

/** One-file JSON adapter with atomic replacement and an optimistic revision gate. */
export class JsonTreeRepository implements TreeRepository {
  readonly location: string

  constructor(readonly file: string) {
    this.location = file
  }

  async load(): Promise<TreeDocument | undefined> {
    let text: string
    try {
      const bytes = await readFile(this.file)
      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        corrupt('tree document exceeds the accepted size bound', { bytes: bytes.byteLength, limit: MAX_DOCUMENT_BYTES })
      }
      text = bytes.toString('utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new OrganizerError('host/unavailable', 'tree document could not be read', {
        location: this.location,
        cause: error instanceof Error ? error.message : String(error)
      })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch (error) {
      corrupt('tree document is not valid JSON', { location: this.location, cause: error instanceof Error ? error.message : String(error) })
    }
    const version = typeof parsed === 'object' && parsed !== null
      ? (parsed as { schemaVersion?: unknown }).schemaVersion
      : undefined
    if (typeof version !== 'number' || !Number.isInteger(version) ||
      version < OLDEST_READABLE_SCHEMA_VERSION || version > TREE_SCHEMA_VERSION) {
      throw new OrganizerError('tree/invalid-schema-version', `unsupported tree schema version ${String(version)}`, {
        readable: [OLDEST_READABLE_SCHEMA_VERSION, TREE_SCHEMA_VERSION],
        found: version
      })
    }
    try {
      return validateDocument(parsed)
    } catch (error) {
      if (error instanceof OrganizerError &&
        (error.code === 'tree/invalid-schema-version' || error.code === 'tree/migration-unsupported')) throw error
      throw new OrganizerError('tree/corrupt', 'stored tree document failed validation', {
        location: this.location,
        cause: error instanceof Error ? error.message : String(error)
      })
    }
  }

  async save(document: TreeDocument, expectedRevision: number): Promise<void> {
    const current = await this.load()
    const found = current?.revision ?? 0
    if (found !== expectedRevision) {
      throw new OrganizerError('tree/conflict', 'tree was changed by another writer', { expectedRevision, found })
    }
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = join(dirname(this.file), `.tree-${String(process.pid)}-${String(Date.now())}.tmp`)
    const body = `${JSON.stringify(document, null, 2)}\n`
    const handle = await open(temporary, 'w')
    try {
      await handle.writeFile(body, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, this.file)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw new OrganizerError('host/unavailable', 'tree document could not be installed', {
        location: this.location,
        cause: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
