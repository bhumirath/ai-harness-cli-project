import type { WorkspaceTools } from './tools.ts'
import type { CodeMessage, CodeProvider } from './types.ts'

const MAX_MENTIONS = 8
const MAX_MENTION_CHARS = 40_000
const MAX_MENTIONS_TOTAL = 120_000

/**
 * Expands `@path` mentions of workspace files/directories into attached context. Mentions that are
 * not workspace files (e-mail addresses, npm scopes, protected paths) are left untouched.
 */
export async function expandMentions(
  task: string,
  workspace: WorkspaceTools,
): Promise<{ content: string; attached: string[] }> {
  const attached: string[] = []
  const blocks: string[] = []
  let total = 0
  const seen = new Set<string>()
  for (const match of task.matchAll(/(?:^|\s)@((?:[\w.-]+[\\/])*[\w.-]+[\\/]?)/g)) {
    const mention = match[1]!.replace(/[.,;:!?)]+$/, '')
    if (seen.has(mention) || attached.length >= MAX_MENTIONS) continue
    seen.add(mention)
    const signal = new AbortController().signal
    const listing = await workspace.execute('list_files', { path: mention }, signal)
    if (listing.ok) {
      const entries = (listing.entries as { name: string; directory: boolean }[])
        .map((entry) => `${entry.name}${entry.directory ? '/' : ''}`)
        .join('\n')
      blocks.push(`<directory path="${mention}">\n${entries}\n</directory>`)
      attached.push(mention)
      continue
    }
    let content: string | undefined
    try {
      content = await workspace.readText(mention)
    } catch {
      continue
    }
    if (content === undefined) continue
    const truncated = content.length > MAX_MENTION_CHARS
    const body = truncated ? content.slice(0, MAX_MENTION_CHARS) : content
    if (total + body.length > MAX_MENTIONS_TOTAL) continue
    total += body.length
    blocks.push(`<file path="${mention}"${truncated ? ' truncated="true"' : ''}>\n${body}\n</file>`)
    attached.push(mention)
  }
  if (!blocks.length) return { content: task, attached }
  return {
    content: `${task}\n\nAttached files referenced with @ (current content; read_file again before editing to get its hash):\n${blocks.join('\n')}`,
    attached,
  }
}

/** Rough token estimate (about 4 characters per token for code and English text). */
export function estimateTokens(messages: CodeMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}

export interface CompactionLimits {
  /** Model context window in tokens. */
  contextTokens: number
}
/** Backend DTO allows 200 messages; leave room for a few more turns before compaction runs. */
export const MAX_MESSAGES_BEFORE_COMPACTION = 140

export function needsCompaction(
  messages: CodeMessage[],
  limits: CompactionLimits,
  lastInputTokens = 0,
): boolean {
  const used = Math.max(lastInputTokens, estimateTokens(messages))
  return (
    used > limits.contextTokens * 0.75 ||
    messages.length > MAX_MESSAGES_BEFORE_COMPACTION ||
    Buffer.byteLength(JSON.stringify(messages)) > 600_000
  )
}

const SUMMARY_PROMPT = `You compress the history of a coding-agent session so work can continue in a fresh context. Write a precise summary for the agent (not for the user) with these sections:
1. User requests: every request and constraint the user stated, quoted where short.
2. Work done: files inspected, files changed (with what changed), commands run and their results.
3. Current state: what is working, failing tests or errors, and open decisions.
4. Next steps: the remaining work, in order.
Keep file paths, identifiers and error messages exact. Do not invent progress. Do not call tools.`

function transcript(messages: CodeMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      const content = message.content ?? ''
      lines.push(
        `TOOL RESULT: ${content.length > 2000 ? `${content.slice(0, 2000)} …[truncated]` : content}`,
      )
    } else if (message.role === 'assistant') {
      if (message.content) lines.push(`ASSISTANT: ${message.content}`)
      for (const call of message.tool_calls ?? [])
        lines.push(`TOOL CALL ${call.function.name}: ${call.function.arguments.slice(0, 1500)}`)
    } else lines.push(`${message.role.toUpperCase()}: ${message.content ?? ''}`)
  }
  let text = lines.join('\n')
  // Keep the beginning (original request) and the most recent work if it is still too long.
  if (text.length > 100_000)
    text = `${text.slice(0, 30_000)}\n…[middle omitted]…\n${text.slice(-70_000)}`
  return text
}

/** Index where the kept tail starts: a user or assistant message, never a tool result. */
function tailStart(messages: CodeMessage[], keep: number): number {
  let index = Math.max(1, messages.length - keep)
  while (index < messages.length && messages[index]!.role === 'tool') index--
  return Math.max(1, index)
}

export interface CompactionResult {
  compacted: boolean
  summary?: string
  removed: number
  usage: { inputTokens: number; outputTokens: number; chargedMicro: string }
}

/**
 * Replaces older conversation history with a model-written summary, keeping the system prompt,
 * the most recent messages and every assistant tool call paired with its results.
 */
export async function compactMessages(
  provider: CodeProvider,
  messages: CodeMessage[],
  signal: AbortSignal,
  options: { keep?: number; todos?: string } = {},
): Promise<CompactionResult> {
  const usage = { inputTokens: 0, outputTokens: 0, chargedMicro: '0' }
  const start = tailStart(messages, options.keep ?? 6)
  if (start <= 2) return { compacted: false, removed: 0, usage }
  const older = messages.slice(1, start)
  const turn = await provider.turn(
    [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: transcript(older) },
    ],
    [],
    signal,
  )
  usage.inputTokens = turn.usage.inputTokens
  usage.outputTokens = turn.usage.outputTokens
  usage.chargedMicro = turn.chargedMicro
  const summary = turn.message.content?.trim()
  if (!summary) throw new Error('Compaction produced an empty summary')
  const plan = options.todos ? `\n\nCurrent plan:\n${options.todos}` : ''
  messages.splice(1, start - 1, {
    role: 'user',
    content: `[Summary of the earlier conversation, written by the agent to save context]\n${summary}${plan}`,
  })
  return { compacted: true, summary, removed: older.length, usage }
}
