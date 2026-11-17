import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildProgram, main } from '../src/index.ts'
import { completionCandidates } from '../src/commands/completion.ts'

const conversation = {
  id: 'c1',
  title: 'สวัสดี',
  modelRef: 'byok:model',
  createdAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
}
const detail = {
  conversation,
  hasMore: true,
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'https://example.com/private?token=secret' } },
      ],
      status: 'complete',
      createdAt: conversation.createdAt,
    },
    {
      id: 'm2',
      role: 'assistant',
      content: null,
      toolCalls: [{ name: 'current_time' }],
      status: 'error',
      error: 'Provider unavailable',
      createdAt: conversation.createdAt,
    },
    {
      id: 'm3',
      role: 'tool',
      content: 'result',
      toolCallId: 'call1',
      status: 'complete',
      createdAt: conversation.createdAt,
    },
  ],
}

function capture() {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk)
    return true
  })
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out += `${args.join(' ')}\n`
  })
  return { out: () => out, err: () => err }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('conversation commands against HTTP', () => {
  let server: Server
  let url: string
  let requested: URL
  let auth: string | undefined
  let org: string | string[] | undefined
  let calls = 0
  beforeAll(async () => {
    server = createServer((req, res) => {
      calls++
      requested = new URL(req.url!, 'http://localhost')
      auth = req.headers.authorization
      org = req.headers['x-org-id']
      res.setHeader('content-type', 'application/json')
      if (requested.pathname.endsWith('/missing')) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } }))
      } else
        res.end(
          JSON.stringify(
            requested.pathname === '/api/conversations'
              ? { items: [conversation], nextCursor: 'c2' }
              : detail,
          ),
        )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))
  async function run(args: string[]) {
    vi.stubEnv('HARNESS_TOKEN', 'hk_test_history')
    return main(['node', 'harness', '--api-url', url, '--org', 'org1', ...args])
  }
  it('lists with search/cursor, carries auth and org, and returns only API JSON', async () => {
    const c = capture()
    expect(
      await run([
        'conversations',
        'ls',
        '--query',
        'สวัสดี',
        '--cursor',
        'older',
        '--limit',
        '2',
        '--json',
      ]),
    ).toBe(0)
    expect(JSON.parse(c.out())).toEqual({ items: [conversation], nextCursor: 'c2' })
    expect(c.err()).toBe('')
    expect(requested.searchParams.get('q')).toBe('สวัสดี')
    expect(requested.searchParams.get('cursor')).toBe('older')
    expect(requested.searchParams.get('limit')).toBe('2')
    expect(auth).toBe('Bearer hk_test_history')
    expect(org).toBe('org1')
  })
  it('shows older message pages as unmodified JSON', async () => {
    const c = capture()
    expect(
      await run(['conversations', 'show', 'c1', '--before', 'm4', '--limit', '3', '--json']),
    ).toBe(0)
    expect(JSON.parse(c.out())).toEqual(detail)
    expect(requested.pathname).toBe('/api/conversations/c1')
    expect(requested.searchParams.get('before')).toBe('m4')
    expect(requested.searchParams.get('limit')).toBe('3')
  })
  it('renders text/images/tools/errors and points to older messages', async () => {
    const c = capture()
    expect(await run(['conversations', 'show', 'c1'])).toBe(0)
    expect(c.out()).toContain('hello')
    expect(c.out()).toContain('[image]')
    expect(c.out()).not.toContain('token=secret')
    expect(c.out()).toContain('current_time')
    expect(c.out()).toContain('call1')
    expect(c.out()).toContain('Provider unavailable')
    expect(c.err()).toContain('--before m1')
  })
  it('supports the default list command and pagination hint', async () => {
    const c = capture()
    expect(await run(['conversations'])).toBe(0)
    expect(c.out()).toContain('สวัสดี')
    expect(c.err()).toContain('--cursor c2')
  })
  it.each(['0', '-1', '1.5', '10oops', '201'])(
    'rejects invalid message page size %s before HTTP',
    async (limit) => {
      const c = capture()
      const before = calls
      expect(await run(['conversations', 'show', 'c1', '--limit', limit])).toBe(2)
      expect(calls).toBe(before)
      expect(c.err()).toContain('--limit')
    },
  )
  it('returns a failing exit code and API error on missing conversation', async () => {
    const c = capture()
    expect(await run(['conversations', 'show', 'missing', '--json'])).toBe(1)
    expect(c.out()).toBe('')
    expect(c.err()).toContain('Conversation not found')
  })
})

describe('shell completion', () => {
  it('follows subcommands, skips option values, and hides internal commands', () => {
    const program = buildProgram()
    expect(completionCandidates(program, ['conversations', 's'])).toEqual(['show'])
    expect(completionCandidates(program, ['--org', 'conversations', 'ag'])).toEqual(['agents'])
    expect(completionCandidates(program, ['conversations', 'show', 'c1', '--b'])).toEqual([
      '--before',
    ])
    expect(completionCandidates(program, ['--api-url', ''])).toEqual([])
    expect(completionCandidates(program, ['--org=org1', 'conversations', ''])).toContain('ls')
    expect(completionCandidates(program, [''])).not.toContain('__complete')
  })
  it('includes help and implicit list options, but keeps explicit subcommands separate', () => {
    const program = buildProgram()
    expect(completionCandidates(program, ['--h'])).toEqual(['--help'])
    expect(completionCandidates(program, ['conversations', '--l'])).toEqual(['--limit'])
    expect(completionCandidates(program, ['conversations', '--limit', ''])).toEqual([])
    expect(completionCandidates(program, ['conversations', '--limit', '2', '--q'])).toEqual([
      '--query',
    ])
    expect(completionCandidates(program, ['conversations', 'show', 'c1', '--q'])).toEqual([])
    expect(completionCandidates(program, ['--org=org1', 'conversations', '--h'])).toEqual([
      '--help',
    ])
    expect(completionCandidates(program, ['runs', '-aNews', '--h'])).toEqual(['--help'])
  })
  it.each(['bash', 'zsh', 'fish', 'powershell'])(
    'prints a %s script without auth or API calls',
    async (shell) => {
      const c = capture()
      vi.stubEnv('HARNESS_TOKEN', '')
      const fetch = vi.spyOn(globalThis, 'fetch')
      expect(await main(['node', 'harness', 'completion', shell])).toBe(0)
      expect(c.out()).toContain('harness')
      expect(c.err()).toBe('')
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it('completes commands through the hidden entry point without auth', async () => {
    const c = capture()
    expect(
      await main(['node', 'harness', '__complete', '--', 'conversations', 'show', 'c1', '--b']),
    ).toBe(0)
    expect(c.out()).toBe('--before\n')
  })
  it('preserves empty words and quoted values through the encoded completion transport', async () => {
    const c = capture()
    const payload = Buffer.from(
      JSON.stringify(['--org', 'Some Org', 'conversations', '']),
    ).toString('base64')
    expect(await main(['node', 'harness', '__complete-json', payload])).toBe(0)
    expect(c.out().split('\n')).toEqual(expect.arrayContaining(['ls', 'show', '--limit']))
  })
  it.each([
    'not-base64!',
    Buffer.from('{}').toString('base64'),
    Buffer.from('[1]').toString('base64'),
  ])('rejects malformed encoded completion data without echoing it', async (payload) => {
    const c = capture()
    expect(await main(['node', 'harness', '__complete-json', payload])).toBe(2)
    expect(c.out()).toBe('')
    expect(c.err()).toContain('Invalid completion payload.')
  })
  it('rejects unsupported shells', async () => {
    capture()
    expect(await main(['node', 'harness', 'completion', 'unknown'])).toBe(2)
  })
  it.skipIf(process.platform === 'win32')(
    'executes the Bash adapter with a partial subcommand and an empty word',
    async () => {
      const c = capture()
      await main(['node', 'harness', 'completion', 'bash'])
      const script = c.out()
      const dir = mkdtempSync(join(tmpdir(), 'harness-completion-'))
      try {
        const path = join(dir, 'completion.bash')
        writeFileSync(path, script)
        const output = execFileSync(
          'bash',
          [
            '-c',
            'source "$1"; harness() { "$HARNESS_TEST_NODE" --experimental-strip-types "$HARNESS_TEST_ENTRY" "$@"; }; COMP_WORDS=(harness conversations s); COMP_CWORD=2; _harness_complete; printf "%s\\n" "${COMPREPLY[@]}"; COMP_WORDS=(harness conversations ""); _harness_complete; printf "%s\\n" "${COMPREPLY[@]}"',
            '_',
            path,
            process.execPath,
            resolve('src/bin.ts'),
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              HARNESS_TEST_NODE: process.execPath,
              HARNESS_TEST_ENTRY: resolve('src/bin.ts'),
            },
          },
        )
        expect(output.split('\n')).toEqual(expect.arrayContaining(['show', 'ls', '--json']))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
