import { createRequire } from 'node:module'
import { CliError, EXIT } from './api/errors.ts'

const require = createRequire(import.meta.url)
const SERVICE = 'ai-harness-cli'

function entry(ref: string): import('@napi-rs/keyring').Entry {
  const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring')
  // Linux's kernel keyring is volatile; require a persistent desktop credential store.
  return new Entry(SERVICE, ref, { linux: { store: 'secret-service' } })
}
function unavailable(): CliError {
  return new CliError(
    'OS keychain unavailable or locked. Unlock it (Linux: enable Secret Service), or use file storage explicitly with `harness login --no-keychain`.',
    { exitCode: EXIT.auth },
  )
}
export function readKeychainToken(ref: string): string {
  let token: string | null
  try {
    token = entry(ref).getPassword()
  } catch {
    throw unavailable()
  }
  if (!token)
    throw new CliError('The saved keychain token is missing — run `harness login` again.', {
      exitCode: EXIT.auth,
    })
  return token
}
export function writeKeychainToken(ref: string, token: string): void {
  try {
    entry(ref).setPassword(token)
  } catch {
    throw unavailable()
  }
}
export function deleteKeychainToken(ref: string): void {
  try {
    entry(ref).deleteCredential()
  } catch {
    throw unavailable()
  }
}
