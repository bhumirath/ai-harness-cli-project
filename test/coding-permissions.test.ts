import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Permissions, parsePermissionConfig, toolCategory } from '../src/coding/permissions.ts'
import { codingRun } from '../src/coding/loop.ts'
import { WorkspaceTools } from '../src/coding/tools.ts'
import type { CodeMessage, CodeProvider, CodeTool, CodeTurn } from '../src/coding/types.ts'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-perm-'))
  temporary.push(root)
  return { root, workspace: await WorkspaceTools.open(root) }
}
const turn = (message: CodeMessage): CodeTurn => ({
  message,
  finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop',
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
  chargedMicro: '0',
})
const calls = (...items: [string, unknown][]): CodeMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: items.map(([name, args], index) => ({
    id: `c${index}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  })),
})
function scripted(turns: CodeMessage[], seenTools: CodeTool[][] = []): CodeProvider {
  return {
    async turn(_messages, tools) {
      seenTools.push(tools)
      return turn(turns.shift() ?? { role: 'assistant', content: 'done' })
    },
  }
}

describe('permission policy', () => {
  it('auto-allows reads and asks for edits, commands and web requests by default', () => {
    const policy = new Permissions('prompt')
    expect(policy.check('read_file', { path: 'a' })).toBe('allow')
    expect(policy.check('grep', { pattern: 'a' })).toBe('allow')
    expect(policy.check('todo_write', { todos: [] })).toBe('allow')
    expect(policy.check('write_file', { path: 'a' })).toBe('ask')
    expect(policy.check('run_command', { command: 'ls' })).toBe('ask')
    expect(policy.check('git_diff', {})).toBe('ask')
    expect(policy.check('web_fetch', { url: 'https://x.dev' })).toBe('ask')
    expect(new Permissions('auto').check('run_command', { command: 'ls' })).toBe('allow')
    expect(new Permissions('read-only').check('edit_file', {})).toBe('deny')
    expect(toolCategory('multi_edit')).toBe('edit')
  })

  it('remembers "always" grants by category, exact command or host', () => {
    const policy = new Permissions('prompt')
    policy.grant('edit_file', { path: 'a' })
    expect(policy.check('write_file', { path: 'b' })).toBe('allow')
    policy.grant('run_command', { command: 'pnpm test' })
    expect(policy.check('run_command', { command: 'pnpm test' })).toBe('allow')
    expect(policy.check('run_command', { command: 'pnpm test && rm -rf /' })).toBe('ask')
    policy.grant('web_fetch', { url: 'https://docs.x.dev/a' })
    expect(policy.check('web_fetch', { url: 'https://docs.x.dev/b' })).toBe('allow')
    expect(policy.check('web_fetch', { url: 'https://evil.dev/' })).toBe('ask')
    expect(policy.grantLabel('apply_patch', {})).toBe('all file edits')
  })

  it('applies user command patterns without approving compound commands', () => {
    const policy = new Permissions(
      'prompt',
      parsePermissionConfig({
        allowCommands: ['pnpm test*', 'git status'],
        denyCommands: ['git push*'],
        webfetch: 'deny',
        edit: 'bogus',
      }),
    )
    expect(policy.check('run_command', { command: 'pnpm test --run' })).toBe('allow')
    expect(policy.check('run_command', { command: 'git status' })).toBe('allow')
    expect(policy.check('run_command', { command: 'pnpm test; curl x' })).toBe('ask')
    expect(policy.check('run_command', { command: 'pnpm test $(whoami)' })).toBe('ask')
    expect(policy.check('run_command', { command: 'git push origin main' })).toBe('deny')
    expect(policy.check('web_fetch', { url: 'https://x.dev' })).toBe('deny')
    expect(policy.check('edit_file', {})).toBe('ask')
    policy.mode = 'auto'
    expect(policy.check('run_command', { command: 'git push --force' })).toBe('deny')
  })

  it('plan agent only offers read, web and plan tools and denies edits even in auto mode', () => {
    const policy = new Permissions('auto', {}, 'plan')
    const names = policy.tools().map((tool) => tool.function.name)
    expect(names).toContain('read_file')
    expect(names).toContain('todo_write')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('run_command')
    expect(policy.check('write_file', {})).toBe('deny')
    expect(policy.check('run_command', { command: 'ls' })).toBe('deny')
  })
})

describe('loop permission integration', () => {
  it('asks once, then reuses an "always" answer for later edits in the session', async () => {
    const { root, workspace } = await fixture()
    const permissions = new Permissions('prompt')
    const asked: string[] = []
    const result = await codingRun(
      scripted([
        calls(['write_file', { path: 'a.txt', content: 'a' }]),
        calls(['write_file', { path: 'b.txt', content: 'b' }]),
      ]),
      workspace,
      [{ role: 'user', content: 'go' }],
      {
        maxSteps: 5,
        signal: new AbortController().signal,
        approval: 'prompt',
        permissions,
        confirm: async (name) => {
          asked.push(name)
          return 'always'
        },
      },
    )
    expect(result.status).toBe('completed')
    expect(asked).toEqual(['write_file'])
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('b')
  })

  it('plan mode hides editing tools and rejects a forced edit call without touching files', async () => {
    const { root, workspace } = await fixture()
    await writeFile(path.join(root, 'a.txt'), 'keep')
    const seen: CodeTool[][] = []
    const messages: CodeMessage[] = [{ role: 'user', content: 'plan' }]
    const result = await codingRun(
      scripted([calls(['write_file', { path: 'a.txt', content: 'x' }])], seen),
      workspace,
      messages,
      {
        maxSteps: 3,
        signal: new AbortController().signal,
        approval: 'auto',
        permissions: new Permissions('auto', {}, 'plan'),
      },
    )
    expect(result.status).toBe('completed')
    expect(seen[0]!.map((tool) => tool.function.name)).not.toContain('write_file')
    expect(JSON.stringify(messages)).toContain('not available in plan mode')
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('keep')
  })
})
