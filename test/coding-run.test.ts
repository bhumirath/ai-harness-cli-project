import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/index.ts'
import { codingRun } from '../src/coding/loop.ts'
import { Permissions } from '../src/coding/permissions.ts'
import { WorkspaceTools } from '../src/coding/tools.ts'
import type { CodeMessage } from '../src/coding/types.ts'

const temporary: string[] = []
const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = undefined
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
  await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

const call = (name: string, args: unknown, id: string): CodeMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})

/** OpenAI-compatible mock that replays a script; each entry may inspect the request. */
async function scriptedModel(script: ((body: { messages: CodeMessage[] }) => CodeMessage)[]) {
  const requests: { messages: CodeMessage[]; tools: { function: { name: string } }[] }[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += String(chunk)))
    req.on('end', () => {
      const body = JSON.parse(raw) as (typeof requests)[number]
      requests.push(body)
      const next = script.shift()
      const message = next ? next(body) : { role: 'assistant' as const, content: 'done' }
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      )
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests }
}

async function run(args: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-run-'))
  temporary.push(root)
  vi.stubEnv('HARNESS_CONFIG', path.join(root, 'config.json'))
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
  return {
    root,
    invoke: async (extra: string[]) => {
      const code = await main(['node', 'harness', ...args, '--cwd', root, ...extra])
      return { code, stdout: () => stdout, stderr: () => stderr }
    },
  }
}

describe('non-interactive coding runs', () => {
  it('runs `harness run -p ... --yes --json` to completion with todos, edits and JSON output', async () => {
    const model = await scriptedModel([
      () =>
        call(
          'todo_write',
          { todos: [{ content: 'Create hello.txt', status: 'in_progress' }] },
          't1',
        ),
      () => call('write_file', { path: 'hello.txt', content: 'hi\n' }, 'w1'),
      () => ({ role: 'assistant', content: 'Created hello.txt.' }),
    ])
    const { root, invoke } = await run(['run'])
    const result = await invoke([
      '-p',
      'Create hello.txt with @missing-file mention',
      '--backend',
      'direct',
      '--base-url',
      model.url,
      '--model',
      'mock',
      '--yes',
      '--no-session',
      '--json',
    ])
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout())
    expect(json).toMatchObject({
      status: 'completed',
      changedFiles: ['hello.txt'],
      summary: 'Created hello.txt.',
      agent: 'build',
      model: 'mock',
      todos: [{ content: 'Create hello.txt', status: 'in_progress' }],
    })
    expect(await readFile(path.join(root, 'hello.txt'), 'utf8')).toBe('hi\n')
    expect(model.requests[0]!.tools.map((tool) => tool.function.name)).toContain('grep')
  })

  it('returns exit code 1 and failed JSON when the step limit is reached', async () => {
    const model = await scriptedModel(
      Array.from({ length: 5 }, (_, i) => () => call('list_files', {}, `l${i}`)),
    )
    const { invoke } = await run(['code'])
    const result = await invoke([
      '--prompt',
      'loop forever',
      '--backend',
      'direct',
      '--base-url',
      model.url,
      '--model',
      'mock',
      '--approval',
      'read-only',
      '--max-steps',
      '2',
      '--no-session',
      '--json',
    ])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout())).toMatchObject({ status: 'max_steps', steps: 2 })
  })

  it('plan agent in a script cannot edit even with --yes', async () => {
    const model = await scriptedModel([
      () => call('write_file', { path: 'x.txt', content: 'x' }, 'w1'),
      () => ({ role: 'assistant', content: 'Plan: create x.txt' }),
    ])
    const { root, invoke } = await run(['code'])
    const result = await invoke([
      '-p',
      'plan it',
      '--agent',
      'plan',
      '--backend',
      'direct',
      '--base-url',
      model.url,
      '--model',
      'mock',
      '--yes',
      '--no-session',
      '--json',
    ])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout())).toMatchObject({ agent: 'plan', changedFiles: [] })
    expect(model.requests[0]!.tools.map((tool) => tool.function.name)).not.toContain('write_file')
    await expect(readFile(path.join(root, 'x.txt'))).rejects.toThrow()
  })

  it('validates usage errors with exit code 2', async () => {
    const { invoke } = await run(['code'])
    for (const extra of [
      ['task', '-p', 'also prompt', '--yes'],
      ['task', '--agent', 'chaos', '--yes'],
      ['task', '--yes', '--approval', 'read-only'],
      ['task', '--context-tokens', '10', '--yes'],
      ['task', '--max-output-tokens', '9000', '--yes'],
    ]) {
      const result = await invoke(extra)
      expect(result.code, extra.join(' ')).toBe(2)
    }
  })

  it('attaches @file mentions to the user message', async () => {
    const model = await scriptedModel([() => ({ role: 'assistant', content: 'Looks fine.' })])
    const { root, invoke } = await run(['code'])
    await writeFile(path.join(root, 'notes.md'), 'remember the milk')
    const result = await invoke([
      '-p',
      'Review @notes.md',
      '--backend',
      'direct',
      '--base-url',
      model.url,
      '--model',
      'mock',
      '--approval',
      'read-only',
      '--no-session',
      '--json',
    ])
    expect(result.code).toBe(0)
    const user = model.requests[0]!.messages.find((message) => message.role === 'user')
    expect(user?.content).toContain('<file path="notes.md">\nremember the milk')
  })

  it('runs the project check command after edits and returns diagnostics to the model', async () => {
    let diagnostics: unknown
    const model = await scriptedModel([
      () => call('write_file', { path: 'a.js', content: 'broken(' }, 'w1'),
      (body) => {
        diagnostics = JSON.parse(body.messages.at(-1)!.content!).diagnostics
        return { role: 'assistant', content: 'Saw the check failure.' }
      },
    ])
    const { root, invoke } = await run(['code'])
    await writeFile(
      path.join(root, '.harness-check.mjs'),
      "console.error('a.js: SyntaxError'); process.exit(3)\n",
    )
    await mkdir(path.join(root, '.harness'), { recursive: true })
    await writeFile(
      path.join(root, '.harness', 'config.json'),
      JSON.stringify({ check: 'node .harness-check.mjs' }),
    )
    const result = await invoke([
      '-p',
      'write a.js',
      '--backend',
      'direct',
      '--base-url',
      model.url,
      '--model',
      'mock',
      '--yes',
      '--no-session',
      '--json',
    ])
    expect(result.code).toBe(0)
    expect(diagnostics).toMatchObject({
      ok: false,
      exitCode: 3,
      command: 'node .harness-check.mjs',
    })
    expect(JSON.stringify(diagnostics)).toContain('SyntaxError')
  })

  it('skips the check for the rest of the run when command permission is denied', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-run-'))
    temporary.push(root)
    const workspace = await WorkspaceTools.open(root)
    const script = [
      call('write_file', { path: 'a.txt', content: 'a' }, 'w1'),
      call('write_file', { path: 'b.txt', content: 'b' }, 'w2'),
      { role: 'assistant' as const, content: 'done' },
    ]
    const notices: string[] = []
    const asked: string[] = []
    const messages: CodeMessage[] = [{ role: 'user', content: 'go' }]
    const result = await codingRun(
      {
        async turn() {
          const message = script.shift()!
          return {
            message,
            finishReason: message.tool_calls ? 'tool_calls' : 'stop',
            usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
            chargedMicro: '0',
          }
        },
      },
      workspace,
      messages,
      {
        maxSteps: 5,
        signal: new AbortController().signal,
        approval: 'prompt',
        permissions: new Permissions('prompt', { edit: 'allow' }),
        checkCommand: 'node -e "process.exit(1)"',
        confirm: async (name) => {
          asked.push(name)
          return false
        },
        progress: (event) => {
          if (event.type === 'notice') notices.push(event.text)
        },
      },
    )
    expect(result.status).toBe('completed')
    expect(asked).toEqual(['run_command'])
    expect(notices).toEqual(['Post-edit check skipped for this run.'])
    expect(JSON.stringify(messages)).not.toContain('diagnostics')
  })

  it('restores the agent mode and plan when resuming a saved session', async () => {
    const model = await scriptedModel([
      () => call('todo_write', { todos: [{ content: 'Step one', status: 'pending' }] }, 't1'),
      () => ({ role: 'assistant', content: 'Planned.' }),
      () => ({ role: 'assistant', content: 'Resumed.' }),
    ])
    const { invoke } = await run(['code'])
    const common = ['--backend', 'direct', '--base-url', model.url, '--model', 'mock', '--json']
    const first = await invoke(['-p', 'plan', '--agent', 'plan', '--yes', ...common])
    const { sessionId } = JSON.parse(first.stdout())
    expect(sessionId).toBeTruthy()
    const before = first.stdout().length
    const second = await invoke(['-p', 'continue', '--resume', sessionId, '--yes', ...common])
    expect(second.code).toBe(0)
    expect(JSON.parse(second.stdout().slice(before))).toMatchObject({
      agent: 'plan',
      todos: [{ content: 'Step one', status: 'pending' }],
      summary: 'Resumed.',
    })
    expect(model.requests[2]!.tools.map((tool) => tool.function.name)).not.toContain('write_file')
  })
})
