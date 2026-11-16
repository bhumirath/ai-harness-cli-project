import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as keychain from '../src/keychain.ts'
import * as config from '../src/config.ts'
import { saveLogin, savedToken } from '../src/login-store.ts'
import { main } from '../src/index.ts'

vi.mock('../src/keychain.ts', () => ({
  readKeychainToken: vi.fn(),
  writeKeychainToken: vi.fn(),
  deleteKeychainToken: vi.fn(),
}))
const token = 'hk_test_secret_never_print'
let dir = ''
let path = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-storage-'))
  path = join(dir, 'config.json')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  vi.stubEnv('HARNESS_CONFIG', path)
  vi.stubEnv('HARNESS_TOKEN', '')
  vi.stubEnv('HARNESS_ORG', '')
  vi.mocked(keychain.readKeychainToken).mockReset().mockReturnValue(token)
  vi.mocked(keychain.writeKeychainToken).mockReset()
  vi.mocked(keychain.deleteKeychainToken).mockReset()
  config.saveConfig({ apiUrl: 'http://saved.test', token, tokenId: 't1', orgId: 'org1' })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
function capture() {
  let output = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    output += String(s)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    output += String(s)
    return true
  })
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output += args.join(' ')
  })
  return () => output
}

describe('keychain login persistence', () => {
  it('moves the token out of config, retaining metadata and restrictive permissions', () => {
    saveLogin(config.loadConfig(), token, true)
    const stored = config.loadConfig()
    expect(stored).toMatchObject({ tokenId: 't1', orgId: 'org1' })
    expect(stored.keychainRef).toBeTruthy()
    expect(readFileSync(path, 'utf8')).not.toContain(token)
    expect(stored.token).toBeUndefined()
    expect(keychain.writeKeychainToken).toHaveBeenCalledWith(stored.keychainRef, token)
    expect(savedToken(stored)).toBe(token)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })
  it('keeps flags/env ahead of the keychain without opening it', () => {
    const stored = { keychainRef: 'ref', token: 'stale-file-token' }
    expect(config.resolveSettings({ token: 'flag' }, {}, stored).token).toBe('flag')
    expect(config.resolveSettings({}, { HARNESS_TOKEN: 'env' }, stored).token).toBe('env')
    expect(keychain.readKeychainToken).not.toHaveBeenCalled()
    expect(config.resolveSettings({}, {}, stored).token).toBe(token)
    expect(keychain.readKeychainToken).toHaveBeenCalledWith('ref')
  })
  it('does not fall back to a stale file token when keychain reads fail', () => {
    vi.mocked(keychain.readKeychainToken).mockImplementation(() => {
      throw new Error('locked')
    })
    expect(() => config.resolveSettings({}, {}, { token, keychainRef: 'ref' })).toThrow('locked')
  })
  it('leaves the old login unchanged when the keychain write fails', () => {
    const before = readFileSync(path, 'utf8')
    vi.mocked(keychain.writeKeychainToken).mockImplementation(() => {
      throw new Error('locked')
    })
    expect(() => saveLogin(config.loadConfig(), 'hk_new', true)).toThrow('locked')
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(keychain.deleteKeychainToken).not.toHaveBeenCalled()
  })
  it('cleans up a new entry if saving config fails and preserves the old entry', () => {
    config.saveConfig({ keychainRef: 'old-ref', tokenId: 't1' })
    const before = readFileSync(path, 'utf8')
    vi.spyOn(config, 'saveConfig').mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => saveLogin({ keychainRef: 'old-ref' }, 'hk_new', true)).toThrow('disk full')
    const ref = vi.mocked(keychain.writeKeychainToken).mock.calls[0]![0]
    expect(ref).not.toBe('old-ref')
    expect(keychain.deleteKeychainToken).toHaveBeenCalledExactlyOnceWith(ref)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
  it('moves explicitly back to file storage, then removes the old keychain entry', () => {
    saveLogin({ keychainRef: 'old-ref', tokenId: 't1' }, token, false)
    expect(config.loadConfig()).toEqual({ token, tokenId: 't1' })
    expect(keychain.deleteKeychainToken).toHaveBeenCalledExactlyOnceWith('old-ref')
  })
  it('keeps the new login usable and warns without secrets if old-entry cleanup fails', () => {
    const output = capture()
    vi.mocked(keychain.deleteKeychainToken).mockImplementation(() => {
      throw new Error(token)
    })
    saveLogin({ keychainRef: 'old-ref' }, token, false)
    expect(config.loadConfig().token).toBe(token)
    expect(output()).toContain('previous OS keychain entry')
    expect(output()).not.toContain(token)
  })
  it('migrates through the CLI with JSON metadata only, without any API call', async () => {
    const output = capture()
    const fetch = vi.spyOn(globalThis, 'fetch')
    expect(await main(['node', 'harness', 'credentials', 'storage', 'keychain', '--json'])).toBe(0)
    expect(JSON.parse(output())).toEqual({ storage: 'keychain' })
    expect(fetch).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).not.toContain(token)
  })
})

describe('login and logout with keychain storage', () => {
  let server: Server
  let url = ''
  let revoked = false
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'DELETE') {
        revoked = true
        res.end('{}')
      } else res.end(JSON.stringify({ id: 't-new', name: 'test login' }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))
  it('stores a validated login in the keychain', async () => {
    const output = capture()
    expect(
      await main(['node', 'harness', '--api-url', url, 'login', '--token', token, '--keychain']),
    ).toBe(0)
    expect(config.loadConfig()).toMatchObject({
      apiUrl: url,
      tokenId: 't-new',
      keychainRef: expect.any(String),
    })
    expect(readFileSync(path, 'utf8')).not.toContain(token)
    expect(output()).not.toContain(token)
  })
  it('allows explicit file login without unlocking a missing old keychain', async () => {
    capture()
    config.saveConfig({ keychainRef: 'missing', apiUrl: url })
    vi.mocked(keychain.readKeychainToken).mockImplementation(() => {
      throw new Error('missing')
    })
    expect(await main(['node', 'harness', 'login', '--token', token, '--no-keychain'])).toBe(0)
    expect(config.loadConfig().token).toBe(token)
    expect(keychain.readKeychainToken).not.toHaveBeenCalled()
  })
  it('revokes the saved token and removes the keychain entry on logout', async () => {
    const output = capture()
    revoked = false
    config.saveConfig({ apiUrl: url, keychainRef: 'ref', tokenId: 't1' })
    vi.stubEnv('HARNESS_API_URL', 'http://127.0.0.1:1')
    expect(await main(['node', 'harness', 'logout'])).toBe(0)
    expect(revoked).toBe(true)
    expect(keychain.deleteKeychainToken).toHaveBeenCalledWith('ref')
    expect(config.loadConfig()).toEqual({ apiUrl: url })
    expect(output()).not.toContain(token)
  })
})
