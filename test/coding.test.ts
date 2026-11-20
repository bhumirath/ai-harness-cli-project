import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, access } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceTools } from '../src/coding/tools.ts'
import { codingRun } from '../src/coding/loop.ts'
import { directProvider, accountProvider } from '../src/coding/providers.ts'
import { createApi } from '../src/api/client.ts'
import { CliError, EXIT } from '../src/api/errors.ts'
import { main } from '../src/index.ts'
import type { CodeMessage, CodeProvider, CodeTurn } from '../src/coding/types.ts'

const temporary: string[] = []
const originalExit = process.exitCode
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = originalExit
  await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-code-'))
  temporary.push(root)
  return { root, workspace: await WorkspaceTools.open(root) }
}
const signal = () => new AbortController().signal
const turn = (message: CodeMessage): CodeTurn => ({
  message,
  finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop',
  usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
  chargedMicro: '0',
})
const call = (name: string, args: unknown, id = 'call1'): CodeMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})

describe('workspace coding tools', () => {
  it('protects CLI credentials in tool output/environment without erasing secrets from source edits', async () => {
    const { root, workspace } = await fixture()
    const secret = 'private-coding-test-key'
    vi.stubEnv('CODING_TEST_SECRET', secret)
    workspace.protectCredentials([secret], ['CODING_TEST_SECRET'])
    await writeFile(path.join(root, 'config.txt'), `key=${secret}\nvalue=old\n`)
    const read = await workspace.execute('read_file', { path: 'config.txt' }, signal())
    expect(workspace.stringify(read)).not.toContain(secret)
    expect(workspace.stringify(read)).toContain('[REDACTED]')
    expect(
      (
        await workspace.execute(
          'write_file',
          { path: 'config.txt', content: 'key=[REDACTED]', expectedHash: read.hash },
          signal(),
        )
      ).ok,
    ).toBe(false)
    expect(
      (
        await workspace.execute(
          'edit_file',
          { path: 'config.txt', oldText: 'value=old', newText: 'value=new' },
          signal(),
        )
      ).ok,
    ).toBe(true)
    const afterEdit = await workspace.execute('read_file', { path: 'config.txt' }, signal())
    expect(
      (
        await workspace.execute(
          'apply_patch',
          {
            path: 'config.txt',
            expectedHash: afterEdit.hash,
            patch: '@@\n-value=new\n+value=newer',
          },
          signal(),
        )
      ).ok,
    ).toBe(true)
    expect(await readFile(path.join(root, 'config.txt'), 'utf8')).toContain(secret)
    const command = await workspace.execute(
      'run_command',
      { command: 'node -e "console.log(Boolean(process.env.CODING_TEST_SECRET))"' },
      signal(),
    )
    expect(command.stdout).toContain('false')
  })

  it('reloads changed project instructions before editing files', async () => {
    const { root, workspace } = await fixture()
    await writeFile(path.join(root, 'AGENTS.md'), 'Old rule.')
    await workspace.context()
    await writeFile(path.join(root, 'AGENTS.md'), 'New rule from another agent.')
    const result = await workspace.execute(
      'write_file',
      { path: 'new.txt', content: 'safe' },
      signal(),
    )
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result.instructions)).toContain('New rule from another agent.')
    await expect(access(path.join(root, 'new.txt'))).rejects.toThrow()
  })

  it('reads, edits, searches and refuses stale or ambiguous writes', async () => {
    const { root, workspace } = await fixture()
    await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n')
    const first = await workspace.execute('read_file', { path: 'a.txt' }, signal())
    expect(first.content).toContain('1: one')
    const edit = await workspace.execute(
      'edit_file',
      { path: 'a.txt', oldText: 'two', newText: 'three' },
      signal(),
    )
    expect(edit.ok).toBe(true)
    expect(edit.diff).toContain('-two')
    expect(edit.diff).toContain('+three')
    expect(
      (
        await workspace.execute(
          'write_file',
          { path: 'a.txt', expectedHash: first.hash, content: 'overwrite' },
          signal(),
        )
      ).ok,
    ).toBe(false)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\nthree\n')
    const found = await workspace.execute('search_files', { query: 'three' }, signal())
    expect(found.matches).toEqual([expect.objectContaining({ path: 'a.txt', line: 2 })])
    await writeFile(path.join(root, 'a.txt'), 'x x')
    expect(
      (
        await workspace.execute(
          'edit_file',
          { path: 'a.txt', oldText: 'x', newText: 'y' },
          signal(),
        )
      ).ok,
    ).toBe(false)
  })
  it('applies multiple optimistic context hunks and rejects stale or ambiguous patches', async () => {
    const { root, workspace } = await fixture()
    await writeFile(
      path.join(root, 'app.ts'),
      'const first = 1\nconst middle = 2\nconst last = 3\n',
    )
    const read = await workspace.execute('read_file', { path: 'app.ts' }, signal())
    const applied = await workspace.execute(
      'apply_patch',
      {
        path: 'app.ts',
        expectedHash: read.hash,
        patch:
          '*** Begin Patch\n*** Update File: app.ts\n@@\n-const first = 1\n+const first = 10\n@@\n-const last = 3\n+const last = 30\n*** End Patch',
      },
      signal(),
    )
    expect(applied.ok).toBe(true)
    expect(applied.diff).toContain('+const first = 10')
    expect(await readFile(path.join(root, 'app.ts'), 'utf8')).toBe(
      'const first = 10\nconst middle = 2\nconst last = 30\n',
    )

    const stale = await workspace.execute(
      'apply_patch',
      {
        path: 'app.ts',
        expectedHash: read.hash,
        patch: '@@\n-const middle = 2\n+const middle = 20',
      },
      signal(),
    )
    expect(stale.ok).toBe(false)
    expect(stale.error).toContain('changed since read_file')

    await writeFile(path.join(root, 'repeat.txt'), 'same\nsame\n')
    const repeated = await workspace.execute('read_file', { path: 'repeat.txt' }, signal())
    const ambiguous = await workspace.execute(
      'apply_patch',
      { path: 'repeat.txt', expectedHash: repeated.hash, patch: '@@\n-same\n+changed' },
      signal(),
    )
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.error).toContain('ambiguous')
  })
  it('refuses traversal, symlink escape, Git metadata, secrets and binary files', async () => {
    const { root, workspace } = await fixture()
    const outside = await fixture()
    await writeFile(path.join(outside.root, 'private.txt'), 'outside')
    await symlink(
      outside.root,
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    for (const target of [
      '../outside',
      path.join(outside.root, 'private.txt'),
      'escape/private.txt',
      '.git/config',
      '.env',
    ]) {
      expect((await workspace.execute('read_file', { path: target }, signal())).ok).toBe(false)
    }
    expect(
      (await workspace.execute('write_file', { path: 'escape/new.txt', content: 'bad' }, signal()))
        .ok,
    ).toBe(false)
    expect(
      (
        await workspace.execute(
          'apply_patch',
          { path: 'escape/private.txt', expectedHash: 'fake', patch: '@@\n-outside\n+bad' },
          signal(),
        )
      ).ok,
    ).toBe(false)
    await expect(access(path.join(outside.root, 'new.txt'))).rejects.toThrow()
    expect(
      (await workspace.execute('write_file', { path: 'bad.bin', content: 'bad\0data' }, signal()))
        .ok,
    ).toBe(false)
    await expect(access(path.join(root, 'bad.bin'))).rejects.toThrow()
    await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]))
    expect((await workspace.execute('read_file', { path: 'binary' }, signal())).ok).toBe(false)
  })
  it.skipIf(process.platform === 'win32')(
    'rejects a dangling file symlink rather than following it on write',
    async () => {
      const { root, workspace } = await fixture()
      const outside = await fixture()
      await symlink(path.join(outside.root, 'missing.txt'), path.join(root, 'dangling'))
      expect(
        (await workspace.execute('write_file', { path: 'dangling', content: 'bad' }, signal())).ok,
      ).toBe(false)
      await expect(access(path.join(outside.root, 'missing.txt'))).rejects.toThrow()
    },
  )
  it('loads root and nested AGENTS instructions before a write', async () => {
    const { root, workspace } = await fixture()
    await writeFile(path.join(root, 'AGENTS.md'), 'Use tests.')
    await mkdir(path.join(root, 'nested'))
    await writeFile(path.join(root, 'nested/AGENTS.md'), 'Keep LF.')
    expect(await workspace.context()).toContain('Use tests.')
    const result = await workspace.execute(
      'write_file',
      { path: 'nested/new.txt', content: 'ok\n' },
      signal(),
    )
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result.instructions)).toContain('Keep LF.')
    await expect(access(path.join(root, 'nested/new.txt'))).rejects.toThrow()
    expect(
      (await workspace.execute('write_file', { path: 'nested/new.txt', content: 'ok\n' }, signal()))
        .ok,
    ).toBe(true)
  })
  it('captures exit code/output, times out, and aborts a running command', async () => {
    const { workspace } = await fixture()
    const output = await workspace.execute(
      'run_command',
      { command: 'node -e "console.log(42)"' },
      signal(),
    )
    expect(output).toMatchObject({ ok: true, exitCode: 0 })
    expect(output.stdout).toContain('42')
    const timeout = await workspace.execute(
      'run_command',
      { command: 'node -e "setInterval(()=>{},1000)"', timeoutMs: 50 },
      signal(),
    )
    expect(timeout).toMatchObject({ ok: false, timedOut: true })
    const abort = new AbortController()
    const pending = workspace.execute(
      'run_command',
      { command: 'node -e "setInterval(()=>{},1000)"' },
      abort.signal,
    )
    setTimeout(() => abort.abort(new DOMException('Canceled', 'AbortError')), 50)
    await expect(pending).rejects.toThrow()
  }, 15000)
})

describe('coding loop permissions and limits', () => {
  it('does not report a truncated final response as completed', async () => {
    const { workspace } = await fixture()
    const provider: CodeProvider = {
      turn: async () => ({
        ...turn({ role: 'assistant', content: 'Partial answer' }),
        finishReason: 'length',
      }),
    }
    expect(
      (
        await codingRun(provider, workspace, [], {
          maxSteps: 2,
          signal: signal(),
          approval: 'read-only',
        })
      ).status,
    ).toBe('failed')
  })
  it('preserves project instructions when compressing older tool output', async () => {
    const { workspace } = await fixture()
    const messages: CodeMessage[] = [
      { role: 'system', content: 'Root rules' },
      { role: 'user', content: 'Continue coding' },
    ]
    for (let i = 0; i < 4; i++) {
      messages.push(call('read_file', { path: 'file.txt' }, `read-${i}`))
      messages.push({
        role: 'tool',
        tool_call_id: `read-${i}`,
        content: JSON.stringify({
          ok: true,
          content: 'x'.repeat(60000),
          instructions: i === 0 ? [{ path: 'nested/AGENTS.md', content: 'Keep these rules.' }] : [],
        }),
      })
    }
    for (let i = 0; i < 7; i++)
      messages.push(
        { role: 'user', content: 'Next' },
        { role: 'assistant', content: 'Acknowledged' },
      )
    const provider: CodeProvider = {
      turn: async (current) => {
        const old = current.find((m) => m.tool_call_id === 'read-0')!
        expect(JSON.parse(old.content!).instructions[0].content).toBe('Keep these rules.')
        return turn({ role: 'assistant', content: 'Finished.' })
      },
    }
    expect(
      (
        await codingRun(provider, workspace, messages, {
          maxSteps: 2,
          signal: signal(),
          approval: 'read-only',
        })
      ).status,
    ).toBe('completed')
  })

  it('requires command permission even for Git diff, because repository filters can run programs', async () => {
    const { workspace } = await fixture()
    let step = 0
    const provider: CodeProvider = {
      turn: async (messages) => {
        if (step++ === 0) return turn(call('git_diff', {}))
        expect(messages.at(-1)?.content).toContain('denied')
        return turn({ role: 'assistant', content: 'No command executed.' })
      },
    }
    expect(
      (
        await codingRun(provider, workspace, [], {
          maxSteps: 3,
          signal: signal(),
          approval: 'read-only',
        })
      ).status,
    ).toBe('completed')
  })
  it('rejects malformed upstream tool calls before any local action', async () => {
    const { root, workspace } = await fixture()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'bad',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: { path: 'never.txt', content: 'bad' },
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    )
    const result = await codingRun(directProvider('test', 'http://localhost/v1'), workspace, [], {
      maxSteps: 3,
      signal: signal(),
      approval: 'auto',
    })
    expect(result.status).toBe('failed')
    await expect(access(path.join(root, 'never.txt'))).rejects.toThrow()
  })

  it('returns a failed JSON-ready result with the original exit code and retained edits', async () => {
    const { root, workspace } = await fixture()
    let calls = 0
    const provider: CodeProvider = {
      turn: async () => {
        if (calls++ === 0)
          return turn(call('write_file', { path: 'new.txt', content: 'keep this' }))
        throw new CliError('Credits exhausted', { exitCode: EXIT.payment })
      },
    }
    const result = await codingRun(provider, workspace, [], {
      maxSteps: 4,
      signal: signal(),
      approval: 'auto',
    })
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 4,
      changedFiles: ['new.txt'],
      error: 'Credits exhausted',
    })
    expect(await readFile(path.join(root, 'new.txt'), 'utf8')).toBe('keep this')
  })

  it('returns a denied result to the model without modifying files', async () => {
    const { root, workspace } = await fixture()
    let count = 0
    const provider: CodeProvider = {
      turn: async (messages) => {
        if (count++ === 0) return turn(call('write_file', { path: 'new.txt', content: 'bad' }))
        expect(messages.at(-1)?.content).toContain('denied')
        return turn({ role: 'assistant', content: 'Read-only mode: no files changed.' })
      },
    }
    const result = await codingRun(provider, workspace, [{ role: 'user', content: 'inspect' }], {
      maxSteps: 4,
      signal: signal(),
      approval: 'read-only',
    })
    expect(result.status).toBe('completed')
    expect(result.changedFiles).toEqual([])
    await expect(access(path.join(root, 'new.txt'))).rejects.toThrow()
  })
  it('returns invalid/unknown tool errors and stops at the iteration limit', async () => {
    const { workspace } = await fixture()
    const provider: CodeProvider = { turn: async () => turn(call('not_a_tool', {})) }
    const messages: CodeMessage[] = [{ role: 'user', content: 'do things' }]
    expect(
      (
        await codingRun(provider, workspace, messages, {
          maxSteps: 2,
          signal: signal(),
          approval: 'auto',
        })
      ).status,
    ).toBe('max_steps')
    expect(messages.at(-1)?.content).toContain('Unknown coding tool')
  })
  it('cancels before any tool action after the model returns', async () => {
    const { root, workspace } = await fixture()
    const abort = new AbortController()
    const provider: CodeProvider = {
      turn: async () => {
        abort.abort()
        return turn(call('write_file', { path: 'bad', content: 'bad' }))
      },
    }
    expect(
      (
        await codingRun(provider, workspace, [], {
          maxSteps: 3,
          signal: abort.signal,
          approval: 'auto',
        })
      ).status,
    ).toBe('canceled')
    await expect(access(path.join(root, 'bad'))).rejects.toThrow()
  })
})

async function modelServer(kind: 'harness' | 'direct') {
  let step = 0
  const received: { body: Record<string, unknown>; auth?: string }[] = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      received.push({ body, auth: req.headers.authorization })
      let message: CodeMessage
      if (step === 0) message = call('read_file', { path: 'sum.mjs' })
      else if (step === 1) {
        const messages = body.messages as CodeMessage[]
        const read = JSON.parse(messages.at(-1)!.content!) as { hash: string }
        message = call(
          'apply_patch',
          {
            path: 'sum.mjs',
            expectedHash: read.hash,
            patch: '@@\n-export const add = (a, b) => a - b\n+export const add = (a, b) => a + b',
          },
          'patch',
        )
      } else if (step === 2) message = call('run_command', { command: 'node test.mjs' }, 'test')
      else {
        const messages = body.messages as CodeMessage[]
        const result = JSON.parse(messages.at(-1)!.content!) as { ok: boolean; exitCode: number }
        message = {
          role: 'assistant',
          content:
            result.ok && result.exitCode === 0
              ? 'Fixed addition; fixture test passed.'
              : 'Test failed.',
        }
      }
      step++
      res.setHeader('content-type', 'application/json')
      const payload =
        kind === 'harness'
          ? turn(message)
          : {
              choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }
      if (kind === 'harness' && req.url === '/api/coding/stream') {
        res.setHeader('content-type', 'text/event-stream')
        if (message.content)
          res.write(`event: delta\ndata: ${JSON.stringify({ text: message.content })}\n\n`)
        res.end(`event: done\ndata: ${JSON.stringify(payload)}\n\n`)
      } else res.end(JSON.stringify(payload))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
describe('coding inspect/edit/test integration', () => {
  it('streams direct-provider text deltas and returns the validated final turn', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'Hello ' } }] })}\n\n`,
      )
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }] })}\n\n`,
      )
      res.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`,
      )
      res.end('data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    const deltas: string[] = []
    try {
      const result = await directProvider('model', url).turn(
        [{ role: 'user', content: 'hello' }],
        [],
        signal(),
        (text) => deltas.push(text),
      )
      expect(deltas).toEqual(['Hello ', 'world'])
      expect(result).toMatchObject({
        message: { role: 'assistant', content: 'Hello world' },
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 2 },
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.each(['harness', 'direct'] as const)(
    'finishes a real fixture edit/test loop through %s',
    async (backend) => {
      const { root, workspace } = await fixture()
      const model = await modelServer(backend)
      await writeFile(path.join(root, 'sum.mjs'), 'export const add = (a, b) => a - b\n')
      await writeFile(
        path.join(root, 'test.mjs'),
        "import { strict as assert } from 'node:assert'; import { add } from './sum.mjs'; assert.equal(add(2, 3), 5)\n",
      )
      try {
        const provider =
          backend === 'harness'
            ? accountProvider(
                createApi({ apiUrl: model.url, token: 'hk_saas_test' }),
                'byok:ref:model',
              )
            : directProvider('direct-model', `${model.url}/v1`, 'direct-test-key')
        const result = await codingRun(
          provider,
          workspace,
          [
            { role: 'system', content: await workspace.context() },
            { role: 'user', content: 'Fix addition and run its test.' },
          ],
          { approval: 'auto', maxSteps: 8, signal: signal() },
        )
        expect(result).toMatchObject({
          status: 'completed',
          steps: 4,
          changedFiles: ['sum.mjs'],
          summary: 'Fixed addition; fixture test passed.',
        })
        expect(await readFile(path.join(root, 'sum.mjs'), 'utf8')).toContain('a + b')
        expect(model.received[0]!.auth).toBe(
          backend === 'harness' ? 'Bearer hk_saas_test' : 'Bearer direct-test-key',
        )
      } finally {
        await model.close()
      }
    },
  )
  it('direct code command never loads a saved SaaS keychain and emits clean final JSON', async () => {
    const { root } = await fixture()
    const model = await modelServer('direct')
    await writeFile(path.join(root, 'sum.mjs'), 'export const add = (a, b) => a - b\n')
    await writeFile(
      path.join(root, 'test.mjs'),
      "import { strict as assert } from 'node:assert'; import { add } from './sum.mjs'; assert.equal(add(2, 3), 5)\n",
    )
    const config = path.join(root, 'config.json')
    await writeFile(config, '{"keychainRef":"missing-keychain"}')
    vi.stubEnv('HARNESS_CONFIG', config)
    vi.stubEnv('CODE_TEST_KEY', 'direct-only-key')
    let stdout = ''
    let stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      stdout += String(text)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
      stderr += String(text)
      return true
    })
    try {
      expect(
        await main([
          'node',
          'harness',
          'code',
          'Fix addition',
          '--cwd',
          root,
          '--backend',
          'direct',
          '--base-url',
          `${model.url}/v1`,
          '--model',
          'test',
          '--api-key-env',
          'CODE_TEST_KEY',
          '--approval',
          'auto',
          '--json',
        ]),
      ).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({
        status: 'completed',
        changedFiles: ['sum.mjs'],
        backend: 'direct',
      })
      expect(stderr).toContain('run_command')
      expect(stdout + stderr).not.toContain('direct-only-key')
    } finally {
      await model.close()
    }
  })
})
