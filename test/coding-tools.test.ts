import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, utimes } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoundedOutput, CODE_TOOLS, WorkspaceTools, applyTextEdits } from '../src/coding/tools.ts'
import { globToRegExp, matchesGlob } from '../src/coding/glob.ts'
import { htmlToText, isPrivateAddress, webFetch } from '../src/coding/webfetch.ts'
import { matchLines, searchRegExp } from '../src/coding/search.ts'

const temporary: string[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
  await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-tools-'))
  temporary.push(root)
  return { root, workspace: await WorkspaceTools.open(root, options) }
}
const signal = () => new AbortController().signal

describe('tool definitions', () => {
  it('stays within the backend tool contract', () => {
    expect(CODE_TOOLS.length).toBeLessThanOrEqual(16)
    for (const tool of CODE_TOOLS) {
      expect(tool.function.name.length).toBeLessThanOrEqual(100)
      expect((tool.function.description ?? '').length).toBeLessThanOrEqual(2000)
    }
    const names = CODE_TOOLS.map((tool) => tool.function.name)
    for (const name of ['grep', 'glob', 'multi_edit', 'web_fetch', 'todo_write'])
      expect(names).toContain(name)
  })
})

describe('glob matcher', () => {
  it('supports **, *, ?, braces and basename patterns', () => {
    expect(matchesGlob('src/a/b.test.ts', '**/*.test.ts')).toBe(true)
    expect(matchesGlob('b.test.ts', '**/*.test.ts')).toBe(true)
    expect(matchesGlob('src/a/b.ts', '*.ts')).toBe(true)
    expect(matchesGlob('src/a/b.ts', 'src/*.ts')).toBe(false)
    expect(matchesGlob('src/x.tsx', 'src/*.{ts,tsx}')).toBe(true)
    expect(matchesGlob('src/x.js', 'src/*.{ts,tsx}')).toBe(false)
    expect(matchesGlob('a1.md', 'a?.md')).toBe(true)
    expect(() => globToRegExp('{a,b')).toThrow()
  })
})

describe('read_file', () => {
  it('pages large files and cuts very long lines', async () => {
    const { root, workspace } = await fixture()
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`)
    lines[2] = 'x'.repeat(5000)
    await writeFile(path.join(root, 'big.txt'), lines.join('\n'))
    const first = await workspace.execute('read_file', { path: 'big.txt' }, signal())
    expect(first.totalLines).toBe(1000)
    expect(first.truncated).toBe(true)
    expect(first.nextStartLine).toBe(401)
    expect(String(first.content)).toContain('[line truncated]')
    const tail = await workspace.execute(
      'read_file',
      { path: 'big.txt', startLine: 990, endLine: 5000 },
      signal(),
    )
    expect(String(tail.content)).toContain('1000: line 1000')
    expect(tail.truncated).toBe(false)
  })
})

describe('edit tools', () => {
  it('applies exact edits, replaceAll and atomic multi-edits', async () => {
    const { root, workspace } = await fixture()
    await writeFile(path.join(root, 'a.ts'), 'const a = 1\nconst b = 1\nconst c = 2\n')
    expect(
      (
        await workspace.execute(
          'edit_file',
          { path: 'a.ts', oldText: '= 1', newText: '= 3' },
          signal(),
        )
      ).error,
    ).toMatch(/exactly once/)
    const all = await workspace.execute(
      'edit_file',
      { path: 'a.ts', oldText: '= 1', newText: '= 3', replaceAll: true },
      signal(),
    )
    expect(all.ok).toBe(true)
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe(
      'const a = 3\nconst b = 3\nconst c = 2\n',
    )
    const failed = await workspace.execute(
      'multi_edit',
      {
        path: 'a.ts',
        edits: [
          { oldText: 'const a', newText: 'let a' },
          { oldText: 'missing', newText: 'x' },
        ],
      },
      signal(),
    )
    expect(failed.ok).toBe(false)
    expect(failed.error).toMatch(/Edit 2/)
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toContain('const a')
    const ok = await workspace.execute(
      'multi_edit',
      {
        path: 'a.ts',
        edits: [
          { oldText: 'const a', newText: 'let a' },
          { oldText: 'let a = 3', newText: 'let a = 4' },
        ],
      },
      signal(),
    )
    expect(ok.ok).toBe(true)
    expect(ok.diff).toContain('+let a = 4')
  })

  it('applyTextEdits rejects no-op and empty edits', () => {
    expect(() => applyTextEdits('x', [{ oldText: '', newText: 'y' }])).toThrow(/empty/)
    expect(() => applyTextEdits('x', [{ oldText: 'x', newText: 'x' }])).toThrow(/identical/)
    expect(applyTextEdits('a$b', [{ oldText: 'a', newText: '$&$&' }])).toBe('$&$&$b')
  })
})

describe('grep and glob', () => {
  it('searches with regex, include filters and secret exclusions (built-in engine)', async () => {
    vi.stubEnv('HARNESS_RIPGREP', '0')
    const { root, workspace } = await fixture()
    await mkdir(path.join(root, 'src'))
    await mkdir(path.join(root, 'node_modules'))
    await writeFile(path.join(root, 'src', 'a.ts'), 'export function alpha() {}\nconst x = 1\n')
    await writeFile(path.join(root, 'src', 'b.md'), 'function in docs\n')
    await writeFile(path.join(root, '.env'), 'function SECRET\n')
    await writeFile(path.join(root, 'node_modules', 'x.ts'), 'function dep\n')
    const result = await workspace.execute(
      'grep',
      { pattern: 'function \\w+\\(', include: '*.ts' },
      signal(),
    )
    expect(result.ok).toBe(true)
    expect(result.engine).toBe('builtin')
    expect(result.matches).toEqual([
      { path: path.join('src', 'a.ts'), line: 1, text: 'export function alpha() {}' },
    ])
    const literal = await workspace.execute(
      'grep',
      { pattern: 'FUNCTION', literal: true, ignoreCase: true },
      signal(),
    )
    const paths = (literal.matches as { path: string }[]).map((m) => m.path).sort()
    expect(paths).toEqual([path.join('src', 'a.ts'), path.join('src', 'b.md')])
    expect((await workspace.execute('grep', { pattern: '(' }, signal())).error).toMatch(
      /Invalid regular expression/,
    )
    // Legacy literal search remains executable for older transcripts.
    expect(
      (await workspace.execute('search_files', { query: 'const x' }, signal())).matches,
    ).toHaveLength(1)
  })

  it('stops catastrophic regular expressions instead of hanging', () => {
    const regex = searchRegExp('(a+)+$', false, false)
    expect(() => matchLines(`${'a'.repeat(40)}b`, regex, 10)).toThrow(/too expensive/)
  })

  it('finds files by glob, newest first, without secrets or symlinks', async () => {
    const { root, workspace } = await fixture()
    await mkdir(path.join(root, 'src', 'deep'), { recursive: true })
    await writeFile(path.join(root, 'src', 'old.test.ts'), '')
    await writeFile(path.join(root, 'src', 'deep', 'new.test.ts'), '')
    await writeFile(path.join(root, 'src', 'key.pem'), '')
    await utimes(path.join(root, 'src', 'old.test.ts'), new Date(2000, 1), new Date(2000, 1))
    if (process.platform !== 'win32') await symlink(tmpdir(), path.join(root, 'src', 'outside'))
    const result = await workspace.execute('glob', { pattern: '**/*.test.ts' }, signal())
    expect(result.files).toEqual([
      path.join('src', 'deep', 'new.test.ts'),
      path.join('src', 'old.test.ts'),
    ])
    const scoped = await workspace.execute('glob', { pattern: '*', path: 'src' }, signal())
    expect(scoped.files).not.toContain(path.join('src', 'key.pem'))
    expect(
      (await workspace.execute('glob', { pattern: '*', path: '../' }, signal())).error,
    ).toMatch(/escapes/)
  })
})

describe('run_command', () => {
  it('runs in a workspace subdirectory and keeps the head and tail of long output', async () => {
    const { root, workspace } = await fixture()
    await mkdir(path.join(root, 'pkg'))
    const where = await workspace.execute(
      'run_command',
      { command: 'node -e "console.log(process.cwd())"', cwd: 'pkg' },
      signal(),
    )
    // macOS tmp dirs sit behind /var → /private/var; Windows may report 8.3 short names
    expect(realpathSync.native(String(where.stdout).trim())).toBe(
      realpathSync.native(path.join(root, 'pkg')),
    )
    expect(
      (await workspace.execute('run_command', { command: 'echo x', cwd: '..' }, signal())).error,
    ).toMatch(/escapes/)
    const long = await workspace.execute(
      'run_command',
      {
        command:
          "node -e \"console.log('START'); for (let i = 0; i < 20000; i++) console.log('line ' + i); console.log('END')\"",
      },
      signal(),
    )
    expect(long.truncated).toBe(true)
    expect(String(long.stdout)).toContain('START')
    expect(String(long.stdout)).toContain('END')
    expect(String(long.stdout)).toContain('omitted')
  })

  it('bounded output stays within its limit', () => {
    const output = new BoundedOutput(1000)
    for (let i = 0; i < 1000; i++) output.push(`chunk ${i}\n`)
    expect(output.truncated).toBe(true)
    expect(output.text().length).toBeLessThan(1100)
    expect(output.text()).toContain('chunk 999')
    expect(output.text()).toContain('chunk 0')
  })
})

describe('todo_write', () => {
  it('validates and stores the plan', async () => {
    const { workspace } = await fixture()
    const ok = await workspace.execute(
      'todo_write',
      {
        todos: [
          { content: 'Read code', status: 'completed' },
          { content: 'Edit code', status: 'in_progress' },
        ],
      },
      signal(),
    )
    expect(ok).toMatchObject({ ok: true, remaining: 1 })
    expect(workspace.todos).toHaveLength(2)
    const bad = await workspace.execute(
      'todo_write',
      { todos: [{ content: 'x', status: 'done' }] },
      signal(),
    )
    expect(bad.ok).toBe(false)
    expect(workspace.todos).toHaveLength(2)
  })
})

describe('web_fetch', () => {
  it('classifies private, loopback and reserved addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      'not-an-ip',
    ])
      expect(isPrivateAddress(address), address).toBe(true)
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111'])
      expect(isPrivateAddress(address), address).toBe(false)
  })

  it('refuses loopback URLs, credentials and non-http schemes', async () => {
    const { workspace } = await fixture()
    for (const url of [
      'http://127.0.0.1:1/',
      'http://localhost/',
      'http://[::1]/',
      'file:///etc/passwd',
      'https://user:pass@example.com/',
    ]) {
      const result = await workspace.execute('web_fetch', { url }, signal())
      expect(result.ok, url).toBe(false)
    }
  })

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as AddressInfo).port
  }

  it('converts HTML to text, truncates, and re-checks every redirect hop', async () => {
    const port = await serve((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: `http://127.0.0.2:${port}/page` })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(
        '<html><head><title>x</title><script>alert(1)</script></head><body><h1>Hello</h1><p>World &amp; more</p></body></html>',
      )
    })
    const allowLoopbackOnly = {
      isBlocked: (_address: string, hostname: string) => hostname !== '127.0.0.1',
    }
    const page = await webFetch(
      `http://127.0.0.1:${port}/`,
      'markdown',
      signal(),
      allowLoopbackOnly,
    )
    expect(page.ok).toBe(true)
    expect(page.content).toContain('# Hello')
    expect(page.content).toContain('World & more')
    expect(page.content).not.toContain('alert')
    await expect(
      webFetch(`http://127.0.0.1:${port}/redirect`, 'text', signal(), allowLoopbackOnly),
    ).rejects.toThrow(/Refusing/)
  })

  it('htmlToText drops scripts and keeps links', () => {
    expect(htmlToText('<a href="https://x.dev">docs</a><style>a{}</style>')).toBe(
      'docs (https://x.dev)',
    )
  })
})

const bundledRipgrep = [
  process.env.HARNESS_TEST_RIPGREP,
  '/usr/bin/rg',
  '/opt/homebrew/bin/rg',
].find((candidate) => candidate && existsSync(candidate))
describe.skipIf(!bundledRipgrep)('grep with ripgrep', () => {
  it('uses ripgrep with the same result shape and exclusions', async () => {
    vi.stubEnv('HARNESS_RIPGREP', bundledRipgrep!)
    const { root, workspace } = await fixture()
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'a.ts'), 'export function alpha() {}\n')
    await writeFile(path.join(root, '.env.local'), 'function SECRET\n')
    await writeFile(path.join(root, 'id.key'), 'function SECRET\n')
    const result = await workspace.execute('grep', { pattern: 'function\\s+\\w+' }, signal())
    expect(result.engine).toBe('ripgrep')
    expect(result.matches).toEqual([
      { path: path.join('src', 'a.ts'), line: 1, text: 'export function alpha() {}' },
    ])
    const scoped = await workspace.execute(
      'grep',
      { pattern: 'alpha', path: 'src', include: '*.md' },
      signal(),
    )
    expect(scoped.matches).toEqual([])
  })
})
