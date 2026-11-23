import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readKeychainToken } from './keychain.ts'

/** What `harness login` stores. The token is a secret: file mode 0600, never printed. */
export interface StoredConfig {
  apiUrl?: string
  token?: string
  /** Opaque account reference in the OS keychain; no secret in this file. */
  keychainRef?: string
  /** id of the token (for `logout` → revoke) */
  tokenId?: string
  orgId?: string
  /** default agent for chat/ask */
  agentId?: string
  /** default model for the local coding agent */
  codeModel?: string
}

export const DEFAULT_API_URL = 'https://aiharness.bhumirath.com'

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HARNESS_CONFIG) return env.HARNESS_CONFIG
  if (process.platform === 'win32' && env.APPDATA) {
    return join(env.APPDATA, 'ai-harness', 'config.json')
  }
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'ai-harness', 'config.json')
}

export function loadConfig(path = configPath()): StoredConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as StoredConfig) : {}
  } catch {
    return {}
  }
}

export function saveConfig(cfg: StoredConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  try {
    chmodSync(path, 0o600) // also tighten a pre-existing file
  } catch {
    // Windows: ACLs, not modes
  }
}

export function clearConfig(path = configPath()): void {
  rmSync(path, { force: true })
}

export interface Settings {
  apiUrl: string
  token?: string
  orgId?: string
  agentId?: string
}

/** Precedence: flags → env → config file → default. */
export function resolveSettings(
  flags: { apiUrl?: string; org?: string; token?: string },
  env: NodeJS.ProcessEnv = process.env,
  stored: StoredConfig = loadConfig(),
): Settings {
  const apiUrl = (flags.apiUrl || env.HARNESS_API_URL || stored.apiUrl || DEFAULT_API_URL).replace(
    /\/+$/,
    '',
  )
  return {
    apiUrl,
    token:
      flags.token ||
      env.HARNESS_TOKEN ||
      (stored.keychainRef ? readKeychainToken(stored.keychainRef) : stored.token),
    orgId: flags.org || env.HARNESS_ORG || stored.orgId,
    agentId: stored.agentId,
  }
}
