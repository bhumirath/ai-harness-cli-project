import { randomUUID } from 'node:crypto'
import { deleteKeychainToken, readKeychainToken, writeKeychainToken } from '../dist/keychain.js'

if (!['darwin', 'win32'].includes(process.platform)) {
  throw new Error('Native keychain CI check only supports macOS and Windows')
}

const ref = `native-ci-${randomUUID()}`
const token = `hk_native_${randomUUID()}`
let stored = false

try {
  writeKeychainToken(ref, token)
  stored = true
  if (readKeychainToken(ref) !== token) throw new Error('Native keychain round-trip mismatch')
  deleteKeychainToken(ref)
  stored = false
  try {
    readKeychainToken(ref)
    throw new Error('Deleted native keychain credential remained readable')
  } catch (error) {
    if (error instanceof Error && error.message.includes('remained readable')) throw error
  }
  console.log(`native ${process.platform} keychain write/read/delete passed`)
} finally {
  if (stored) {
    try {
      deleteKeychainToken(ref)
    } catch {
      // Best-effort cleanup must not hide the original test failure.
    }
  }
}
