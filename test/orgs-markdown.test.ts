import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import * as prompts from '@clack/prompts'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { main } from '../src/index.ts'
import { loadConfig, saveConfig } from '../src/config.ts'
import { MarkdownStream } from '../src/markdown.ts'
import { streamTurn } from '../src/commands/chat.ts'
import { createApi, type Api } from '../src/api/client.ts'

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof prompts>()),
  select: vi.fn(),
  isCancel: vi.fn((value: unknown) => typeof value === 'symbol'),
}))

function capture() {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out += String(s)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err += String(s)
    return true
  })
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out += `${args.join(' ')}\n`
  })
  return { out: () => stripVTControlCharacters(out), err: () => err }
}
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
function tty(enabled: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: enabled })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: enabled })
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const [stream, descriptor] of [
    [process.stdin, stdinTty],
    [process.stdout, stdoutTty],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor)
    else Reflect.deleteProperty(stream, 'isTTY')
  }
})

describe('organization selection', () => {
  let server: Server
  let url = ''
  let dir = ''
  let path = ''
  let requestOrg: string | string[] | undefined
  const orgs = [
    { id: 'org1', name: 'Personal', role: 'owner', personal: true },
    { id: 'org2', name: 'Team', role: 'member', personal: false },
    { id: 'org3', name: 'Duplicate', role: 'admin', personal: false },
    { id: 'org4', name: 'Duplicate', role: 'member', personal: false },
  ]
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-orgs-'))
    path = join(dir, 'config.json')
    server = createServer((req, res) => {
      requestOrg = req.headers['x-org-id']
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ orgs, currentOrgId: 'org1' }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })
  function prepare() {
    vi.stubEnv('HARNESS_CONFIG', path)
    vi.stubEnv('HARNESS_ORG', '')
    vi.stubEnv('HARNESS_TOKEN', '')
    saveConfig(
      { apiUrl: url, token: 'hk_test', tokenId: 't1', orgId: 'stale', agentId: 'old-agent' },
      path,
    )
  }
  it('discovers memberships even with a stale saved selection, without leaking credentials', async () => {
    prepare()
    const c = capture()
    expect(await main(['node', 'harness', 'orgs', 'ls', '--json'])).toBe(0)
    expect(JSON.parse(c.out())).toEqual({ items: orgs, currentOrgId: 'stale' })
    expect(requestOrg).toBeUndefined()
    expect(c.out()).not.toContain('hk_test')
  })
  it('saves exact names while preserving credentials and clearing the old default agent', async () => {
    prepare()
    const c = capture()
    expect(await main(['node', 'harness', 'orgs', 'use', 'team', '--json'])).toBe(0)
    expect(JSON.parse(c.out())).toEqual(orgs[1])
    expect(loadConfig(path)).toEqual({
      apiUrl: url,
      token: 'hk_test',
      tokenId: 't1',
      orgId: 'org2',
    })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })
  it.each(['Duplicate', 'missing'])(
    'rejects ambiguous/unknown organization %s without changing config',
    async (name) => {
      prepare()
      capture()
      const before = readFileSync(path, 'utf8')
      expect(await main(['node', 'harness', 'orgs', 'use', name])).toBe(2)
      expect(readFileSync(path, 'utf8')).toBe(before)
    },
  )
  it('requires an explicit target in scripts/JSON mode', async () => {
    prepare()
    capture()
    tty(false)
    expect(await main(['node', 'harness', 'orgs', 'use'])).toBe(2)
    expect(await main(['node', 'harness', 'orgs', 'use', '--json'])).toBe(2)
  })
  it('uses the interactive picker and persists its selection', async () => {
    prepare()
    const c = capture()
    tty(true)
    vi.mocked(prompts.select).mockResolvedValueOnce('org2')
    expect(await main(['node', 'harness', 'orgs', 'use'])).toBe(0)
    expect(loadConfig(path).orgId).toBe('org2')
    expect(c.out()).toContain('Team')
  })
  it('cancellation leaves the saved login untouched', async () => {
    prepare()
    capture()
    tty(true)
    const before = readFileSync(path, 'utf8')
    vi.mocked(prompts.select).mockResolvedValueOnce(Symbol('cancel'))
    expect(await main(['node', 'harness', 'orgs', 'use'])).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
  it('preserves environment precedence and explains it after saving', async () => {
    prepare()
    vi.stubEnv('HARNESS_ORG', 'org1')
    const c = capture()
    expect(await main(['node', 'harness', 'orgs', 'use', 'org2'])).toBe(0)
    expect(loadConfig(path).orgId).toBe('org2')
    expect(c.err()).toContain('HARNESS_ORG')
  })
})

describe('Markdown streaming', () => {
  function render(chunks: string[]) {
    let text = ''
    const renderer = new MarkdownStream((s) => {
      text += s
    })
    for (const chunk of chunks) renderer.push(chunk)
    renderer.flush()
    return stripVTControlCharacters(text)
  }
  it('renders split headings/bold/code/links and leaves fenced code literal', () => {
    expect(
      render([
        '# Tit',
        'le\n- **bo',
        'ld** and `x` [docs](https://example.com)\n```ts\n',
        '**literal**\n```\n> quote',
      ]),
    ).toBe('Title\n• bold and x docs (https://example.com)\n[ts]\n**literal**\n\n│ quote')
  })
  it('does not close a code fence on a different or shorter marker', () => {
    expect(render(['````\n```\n~~~\n**code**\n````\n**bold**'])).toBe(
      '\n```\n~~~\n**code**\n\nbold',
    )
  })
  it('removes terminal escape/control sequences', () => {
    const output = render(['# hi\u001b]52;c;secret\u0007\u001b[2J\u0000\n'])
    expect(output).toBe('hi\n')
  })
  it('makes progress on long lines and preserves all text', () => {
    let result = ''
    const renderer = new MarkdownStream((s) => {
      result += s
    })
    renderer.push('a'.repeat(8192))
    expect(result.length).toBe(8192)
    renderer.push('tail\n# Heading\n')
    renderer.flush()
    expect(result).toBe(`${'a'.repeat(8192)}tail\nHeading\n`)
  })
  function apiWith(events: { event: string; data: unknown }[], failure?: Error): Api {
    const api = createApi({ apiUrl: 'http://unused', token: 'hk_test' })
    return {
      ...api,
      async *stream() {
        for (const event of events) yield event
        if (failure) throw failure
      },
    } as Api
  }
  it('keeps raw return text while rendering and preserving tool-event order', async () => {
    const c = capture()
    const api = apiWith([
      { event: 'delta', data: { text: '**before**' } },
      { event: 'tool_call', data: { name: 'current_time' } },
      { event: 'tool_result', data: { ok: true } },
      { event: 'delta', data: { text: '\n# After' } },
    ])
    const result = await streamTurn(api, '/unused', {}, { markdown: true })
    expect(result.text).toBe('**before**\n# After')
    expect(c.out()).toMatch(/before[\s\S]*current_time[\s\S]*After/)
    expect(c.out()).not.toContain('**')
  })
  it.each(['error', 'abort'])('flushes pending partial text on %s', async (kind) => {
    const c = capture()
    const failure =
      kind === 'abort' ? new DOMException('Aborted', 'AbortError') : new Error('Disconnected')
    await expect(
      streamTurn(
        apiWith([{ event: 'delta', data: { text: '**partial**' } }], failure),
        '/unused',
        {},
        { markdown: true },
      ),
    ).rejects.toThrow()
    expect(c.out()).toBe('partial\n')
  })
  it('quiet JSON mode never emits terminal formatting or text', async () => {
    const c = capture()
    const r = await streamTurn(
      apiWith([{ event: 'delta', data: { text: '**raw**' } }]),
      '/unused',
      {},
      { quiet: true, markdown: true },
    )
    expect(r.text).toBe('**raw**')
    expect(c.out()).toBe('')
  })
})
