import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readKeychainToken, deleteKeychainToken } from '../../dist/keychain.js'

const testToken = `hk_native_test_${randomUUID()}`
const run = (args) => execFileSync('harness', args, { encoding: 'utf8', env: process.env })
// Seed through config API rather than placing the dummy token on a shell command line.
const { saveConfig } = await import('../../dist/config.js')
saveConfig({ apiUrl: 'http://127.0.0.1:1', token: testToken })
try {
  assert.equal(
    JSON.parse(run(['credentials', 'storage', 'keychain', '--json'])).storage,
    'keychain',
  )
  const stored = JSON.parse(readFileSync(process.env.HARNESS_CONFIG, 'utf8'))
  assert.ok(stored.keychainRef)
  assert.equal(stored.token, undefined)
  assert.ok(readKeychainToken(stored.keychainRef) === testToken, 'Keychain roundtrip failed')
  assert.equal(JSON.parse(run(['credentials', 'storage', 'file', '--json'])).storage, 'file')
  assert.ok(
    JSON.parse(readFileSync(process.env.HARNESS_CONFIG, 'utf8')).token === testToken,
    'File migration failed',
  )
  assert.throws(() => readKeychainToken(stored.keychainRef))
  run(['credentials', 'storage', 'keychain', '--json'])
  const second = JSON.parse(readFileSync(process.env.HARNESS_CONFIG, 'utf8'))
  run(['logout'])
  assert.throws(() => readKeychainToken(second.keychainRef))
  assert.equal(JSON.parse(readFileSync(process.env.HARNESS_CONFIG, 'utf8')).token, undefined)
  console.log('native keychain write/read/migration/logout passed')
} finally {
  const config = JSON.parse(readFileSync(process.env.HARNESS_CONFIG, 'utf8'))
  if (config.keychainRef) deleteKeychainToken(config.keychainRef)
}
