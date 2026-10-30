/**
 * Module-identity probe for the peer-dependency contract.
 *
 * The candidate package declares Cordis and the Typert protocol as peers, so at
 * runtime a *normal* `import` must resolve to the host's installed copies, not
 * to a copy shipped inside the plugin. This probe records, inside the running
 * plugin: the resolved URL of each peer, whether the host Context is branded by
 * the imported Cordis, whether its prototype is that Cordis's `Context.prototype`
 * (same class identity, not just same brand), and whether the dynamically
 * imported protocol exposes the very classes this module was compiled against.
 *
 * It is diagnostic-only: no writes, no behaviour change, and it runs only when
 * the diagnostics or self-test flag is set.
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Remote as StaticRemote,
  TypertRemoteService as StaticProtocolService
} from '@deepseek-ai/dsh-typert-protocol'

/** One peer's resolution outcome. */
export interface ModuleProbe {
  readonly resolved?: string
  readonly error?: string
}

/** Cordis-specific identity facts. */
export interface CordisProbe extends ModuleProbe {
  readonly contextBrand?: boolean
  readonly instanceOfContext?: boolean
  /**
   * Strict prototype equality. Informational only: a scoped Cordis context can
   * sit behind an intermediate context object, so this may be false even when
   * both sides are the same module (the brand and `instanceof` checks settle it).
   */
  readonly prototypeMatch?: boolean
  readonly contextPrototypeName?: string
}

/** Protocol-specific identity facts. */
export interface ProtocolProbe extends ModuleProbe {
  readonly sameServiceClass?: boolean
  readonly sameRemoteDecorator?: boolean
}

/** Everything the verification needs to prove host-shared resolution. */
export interface ModuleIdentity {
  readonly pluginModule?: string
  readonly pluginRoot?: string
  readonly cordis: CordisProbe
  readonly protocol: ProtocolProbe
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `import.meta.resolve` without depending on a specific lib typing. */
function resolveSpecifier(specifier: string): string | undefined {
  const meta = import.meta as ImportMeta & { resolve?: (specifier: string) => string }
  if (typeof meta.resolve !== 'function') return undefined
  try {
    return meta.resolve(specifier)
  } catch {
    return undefined
  }
}

/** Path of this module inside the installed package. */
function pluginModulePath(): string | undefined {
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return undefined
  }
}

/** Collect the identity facts for the two shared peers. */
export async function collectModuleIdentity(host: unknown): Promise<ModuleIdentity> {
  const modulePath = pluginModulePath()
  let cordis: CordisProbe = { resolved: resolveSpecifier('@deepseek-ai/cordis') }
  try {
    const imported = await import('@deepseek-ai/cordis')
    const ContextClass = imported.Context as unknown as {
      readonly prototype: object
      readonly is?: (value: unknown) => boolean
    }
    let prototype: object | null = null
    try {
      prototype = Object.getPrototypeOf(host as object) as object | null
    } catch {
      prototype = null
    }
    let instanceOfContext: boolean | undefined
    try {
      instanceOfContext = host instanceof (imported.Context as unknown as new (...args: never[]) => object)
    } catch {
      instanceOfContext = undefined
    }
    cordis = {
      ...cordis,
      contextBrand: typeof ContextClass.is === 'function' ? ContextClass.is(host) === true : undefined,
      instanceOfContext,
      prototypeMatch: prototype !== null && prototype === ContextClass.prototype,
      contextPrototypeName: prototype === null ? undefined : (prototype as { constructor?: { name?: string } }).constructor?.name
    }
  } catch (error) {
    cordis = { ...cordis, error: message(error) }
  }

  let protocol: ProtocolProbe = { resolved: resolveSpecifier('@deepseek-ai/dsh-typert-protocol') }
  try {
    const imported = await import('@deepseek-ai/dsh-typert-protocol')
    protocol = {
      ...protocol,
      sameServiceClass: (imported.TypertRemoteService as unknown) === (StaticProtocolService as unknown),
      sameRemoteDecorator: (imported.Remote as unknown) === (StaticRemote as unknown)
    }
  } catch (error) {
    protocol = { ...protocol, error: message(error) }
  }

  return Object.freeze({
    ...(modulePath === undefined ? {} : { pluginModule: modulePath, pluginRoot: dirname(modulePath) }),
    cordis: Object.freeze(cordis),
    protocol: Object.freeze(protocol)
  })
}
