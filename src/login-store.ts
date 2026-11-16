import { randomUUID } from 'node:crypto'
import { saveConfig, type StoredConfig } from './config.ts'
import { deleteKeychainToken, readKeychainToken, writeKeychainToken } from './keychain.ts'

export function savedToken(config: StoredConfig): string | undefined {
  return config.keychainRef ? readKeychainToken(config.keychainRef) : config.token
}

/** Create a new entry first: a failed write must leave the previous login usable. */
export function saveLogin(config: StoredConfig, token: string, useKeychain: boolean): void {
  const ref = useKeychain ? randomUUID() : undefined
  if (ref) writeKeychainToken(ref, token)
  try {
    saveConfig({ ...config, token: ref ? undefined : token, keychainRef: ref })
  } catch (error) {
    if (ref) {
      try {
        deleteKeychainToken(ref)
      } catch {
        /* Preserve the original persistence error. */
      }
    }
    throw error
  }
  if (config.keychainRef) {
    try {
      deleteKeychainToken(config.keychainRef)
    } catch {
      process.stderr.write(
        'Login saved, but the previous OS keychain entry could not be removed.\n',
      )
    }
  }
}
