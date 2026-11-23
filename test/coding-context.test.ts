import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compactMessages,
  expandMentions,
  MAX_MESSAGES_BEFORE_COMPACTION,
  needsCompaction,
} from '../src/coding/context.ts'
import { codingRun } from '../src/coding/loop.ts'
import { WorkspaceTools } from '../src/coding/tools.ts'
import type { CodeMessage, CodeProvider, CodeTool, CodeTurn } from '../src/coding/types.ts'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-ctx-'))
  temporary.push(root)
  return { root, workspace: await WorkspaceTools.open(root) }
}
const turn = (message: CodeMessage, inputTokens = 1): CodeTurn => ({
  message,
  finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop',
  usage: { inputTokens, outputTokens: 1, cachedInputTokens: 0 },
  chargedMicro: '0',
})
function history(pairs: number, size = 0): CodeMessage[] {
  const messages: CodeMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'Original request: add pagination' },
  ]
  for (let i = 0; i < pairs; i++) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `call${i}`,
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: `f${i}.ts` }) },
        },
      ],
    })
    messages.push({
      role: 'tool',
      tool_call_id: `call${i}`,
      content: `content ${i}`.padEnd(size, '.'),
    })
  }
  return messages
}

describe('project instructions', () => {
  it('falls back to CLAUDE.md when a directory has no AGENTS.md and includes user instructions', async () => {
    const { root, workspace } = await fixture()
    await writeFile(path.join(root, 'CLAUDE.md'), 'Use tabs.')
    await mkdir(path.join(root, 'pkg'))
    await writeFile(path.join(root, 'pkg', 'AGENTS.md'), 'Package rule.')
    await writeFile(path.join(root, 'pkg', 'CLAUDE.md'), 'Ignored when AGENTS.md exists.')
    const context = await workspace.context('Always answer briefly.')
    expect(context).toContain('Use tabs.')
    expect(context).toContain('Always answer briefly.')
    const read = await workspace.execute(
      'read_file',
      { path: 'pkg/AGENTS.md' },
      new AbortController().signal,
    )
    expect(JSON.stringify(read.instructions)).toContain('Package rule.')
    expect(JSON.stringify(read.instructions)).not.toContain('Ignored when')
  })
})

describe('@ mentions', () => {
  it('attaches mentioned files and directories, ignoring non-files and protected paths', async () => {
    const { root, workspace } = await fixture()
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
    await writeFile(path.join(root, '.env'), 'SECRET=1')
    const result = await expandMentions(
      'Fix @src/a.ts, see @src/ and ping me@example.com about @types/node and @.env',
      workspace,
    )
    expect(result.attached).toEqual(['src/a.ts', 'src/'])
    expect(result.content).toContain('<file path="src/a.ts">\nexport const a = 1')
    expect(result.content).toContain('<directory path="src/">\na.ts')
    expect(result.content).not.toContain('SECRET')
    expect((await expandMentions('no mentions', workspace)).content).toBe('no mentions')
    expect((await expandMentions('@../etc/passwd', workspace)).attached).toEqual([])
  })
})

describe('compaction', () => {
  it('detects when the context or message count approaches the limit', () => {
    expect(needsCompaction(history(2), { contextTokens: 128_000 })).toBe(false)
    expect(needsCompaction(history(2), { contextTokens: 128_000 }, 100_000)).toBe(true)
    expect(
      needsCompaction(history(MAX_MESSAGES_BEFORE_COMPACTION), { contextTokens: 10_000_000 }),
    ).toBe(true)
  })

  it('summarizes older history and keeps tool calls paired with their results', async () => {
    const messages = history(10)
    let request: CodeMessage[] = []
    let requestTools: CodeTool[] = [{} as CodeTool]
    const provider: CodeProvider = {
      async turn(sent, tools) {
        request = sent
        requestTools = tools
        return turn({ role: 'assistant', content: 'User wants pagination. Read f0..f7.' }, 50)
      },
    }
    const result = await compactMessages(provider, messages, new AbortController().signal, {
      keep: 4,
      todos: '[~] add pagination',
    })
    expect(result.compacted).toBe(true)
    expect(result.usage.inputTokens).toBe(50)
    expect(requestTools).toEqual([])
    expect(request[1]!.content).toContain('Original request: add pagination')
    expect(messages[0]!.content).toBe('system prompt')
    expect(messages[1]!.content).toContain('User wants pagination')
    expect(messages[1]!.content).toContain('[~] add pagination')
    // Every kept tool result still follows its assistant tool call.
    for (let i = 2; i < messages.length; i++)
      if (messages[i]!.role === 'tool')
        expect(messages[i - 1]!.tool_calls?.[0]?.id).toBe(messages[i]!.tool_call_id)
    expect(messages[2]!.role).toBe('assistant')
  })

  it('runs automatically inside the coding loop near the context limit', async () => {
    const { workspace } = await fixture()
    const messages = history(30, 1200)
    const requests: number[] = []
    const provider: CodeProvider = {
      async turn(sent, tools) {
        requests.push(sent.length)
        if (!tools.length) return turn({ role: 'assistant', content: 'summary of work' })
        return turn({ role: 'assistant', content: 'finished' })
      },
    }
    const notices: string[] = []
    const result = await codingRun(provider, workspace, messages, {
      maxSteps: 3,
      signal: new AbortController().signal,
      approval: 'read-only',
      contextTokens: 8000,
      progress: (event) => {
        if (event.type === 'notice') notices.push(event.text)
      },
    })
    expect(result.status).toBe('completed')
    expect(notices.join()).toContain('Compacted')
    expect(requests[0]).toBe(2)
    expect(messages.length).toBeLessThan(20)
    expect(JSON.stringify(messages)).toContain('summary of work')
  })
})
