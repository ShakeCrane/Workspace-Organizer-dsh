/**
 * Resolve the plugin's own data directory.
 *
 * Resolution follows the host's documented precedence for harness home
 * (`DSH_HOME`, else `~/.dsh`) and appends the plugin's private folder. A
 * relative explicit path is refused: the plugin must never write somewhere
 * that depends on the process working directory.
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { OrganizerError } from '../core/errors.js'

/** Environment key the harness itself uses for its home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Folder this plugin owns inside the harness home. */
export const PLUGIN_DATA_FOLDER = 'workspace-organizer'

/** Resolve the absolute directory holding this plugin's authoritative record. */
export function resolveDataDir(configured?: string, env: Record<string, string | undefined> = process.env): string {
  if (configured !== undefined && configured.trim().length > 0) {
    if (!isAbsolute(configured)) {
      throw new OrganizerError('host/unavailable', 'configured dataDir must be an absolute path', { field: 'dataDir' })
    }
    return join(configured, PLUGIN_DATA_FOLDER)
  }
  const fromEnv = env[DSH_HOME_ENV]
  const base = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : join(homedir(), '.dsh')
  if (!isAbsolute(base)) {
    throw new OrganizerError('host/unavailable', 'resolved harness home is not an absolute path', { field: DSH_HOME_ENV })
  }
  return join(base, PLUGIN_DATA_FOLDER)
}
