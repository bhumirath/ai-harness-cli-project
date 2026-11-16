import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkForUpdate } from '../src/commands/update.ts'
import { main } from '../src/index.ts'
import { VERSION } from '../src/version.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
function registry(body: unknown, status = 200) {
  const mock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}
describe('explicit update notice', () => {
  it('compares SemVer rather than strings and never sends credentials', async () => {
    vi.stubEnv('HARNESS_TOKEN', 'hk_never_send')
    const fetch = registry({ version: '0.10.0' })
    expect(await checkForUpdate()).toEqual({
      current: VERSION,
      latest: '0.10.0',
      updateAvailable: true,
    })
    expect(fetch.mock.calls[0]![0]).toBe('https://registry.npmjs.org/@ai-harness%2fcli/latest')
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('hk_never_send')
    expect(fetch.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal)
  })
  it('does not suggest downgrading a newer installed version', async () => {
    registry({ version: '0.0.9' })
    expect((await checkForUpdate()).updateAvailable).toBe(false)
  })
  it('reports the unpublished package clearly', async () => {
    registry({}, 404)
    await expect(checkForUpdate()).rejects.toThrow('not been published')
  })
  it.each([null, {}, { version: 'arbitrary terminal output\u001b[2J' }])(
    'rejects invalid registry metadata',
    async (body) => {
      registry(body)
      await expect(checkForUpdate()).rejects.toThrow('invalid CLI version')
    },
  )
  it('bounds network failures without leaking raw error text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('hk_secret')))
    await expect(checkForUpdate()).rejects.toThrow('Cannot check npm')
  })
  it('prints only one JSON document without loading a saved login', async () => {
    registry({ version: VERSION })
    vi.stubEnv('HARNESS_CONFIG', '/nonexistent/harness/config.json')
    let stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      stdout += String(s)
      return true
    })
    expect(await main(['node', 'harness', 'update-check', '--json'])).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      current: VERSION,
      latest: VERSION,
      updateAvailable: false,
    })
  })
})
