import type { Command } from 'commander'
import pc from 'picocolors'
import { unwrap } from '../api/client.ts'
import { CliError, EXIT } from '../api/errors.ts'
import type { components } from '../api/schema.d.ts'
import { apiFor, globals } from '../context.ts'
import { formatDate, printJson, printTable } from '../output.ts'

function pageLimit(value: string, max: number): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new CliError(`--limit must be an integer from 1 to ${max}`, { exitCode: EXIT.usage })
  }
  return Number(value)
}

function printMessage(message: components['schemas']['MessageDto']): void {
  console.log(`\n${pc.bold(message.role)} ${pc.dim(formatDate(message.createdAt))}`)
  if (typeof message.content === 'string') console.log(message.content)
  else
    for (const part of message.content ?? []) {
      // Do not dump image URLs: data URLs can be huge and signed URLs may carry credentials.
      console.log(part.type === 'image_url' ? '[image]' : (part.text ?? ''))
    }
  if (message.toolCalls?.length) console.log(`Tool calls: ${JSON.stringify(message.toolCalls)}`)
  if (message.toolCallId) console.log(pc.dim(`Tool call: ${message.toolCallId}`))
  if (message.error) console.log(pc.red(message.error))
  if (message.status !== 'complete') console.log(pc.dim(`Status: ${message.status}`))
}

export function registerConversations(program: Command): void {
  const conversations = program.command('conversations').description('Browse conversation history')
  conversations
    .command('ls', { isDefault: true })
    .description('List conversations, newest first')
    .option('-q, --query <text>', 'search titles')
    .option('--cursor <id>', 'nextCursor from the previous page')
    .option('--limit <n>', 'page size (1..100)', '30')
    .action(async (opts: { query?: string; cursor?: string; limit: string }, cmd: Command) => {
      const limit = pageLimit(opts.limit, 100)
      const api = apiFor(cmd)
      const page = await unwrap(
        api.client.GET('/api/conversations', {
          params: { query: { q: opts.query, cursor: opts.cursor, limit } },
        }),
        api.settings.apiUrl,
      )
      if (globals(cmd).json) return printJson(page)
      printTable(
        page.items.map((c) => ({
          id: c.id,
          title: c.title ?? '(untitled)',
          model: c.modelRef,
          updated: formatDate(c.updatedAt),
        })),
        ['id', 'title', 'model', 'updated'],
      )
      if (page.nextCursor)
        process.stderr.write(`More conversations: use --cursor ${page.nextCursor}\n`)
    })
  conversations
    .command('show <id>')
    .description('Show a conversation and its latest messages, oldest first')
    .option('--before <messageId>', 'load messages older than this message')
    .option('--limit <n>', 'message page size (1..200)', '50')
    .action(async (id: string, opts: { before?: string; limit: string }, cmd: Command) => {
      const limit = pageLimit(opts.limit, 200)
      const api = apiFor(cmd)
      const detail = await unwrap(
        api.client.GET('/api/conversations/{id}', {
          params: { path: { id }, query: { before: opts.before, limit } },
        }),
        api.settings.apiUrl,
      )
      if (globals(cmd).json) return printJson(detail)
      console.log(
        `${pc.bold(detail.conversation.title ?? '(untitled)')} ${pc.dim(detail.conversation.id)}`,
      )
      for (const message of detail.messages) printMessage(message)
      if (!detail.messages.length) console.log(pc.dim('(no messages)'))
      if (detail.hasMore && detail.messages[0])
        process.stderr.write(`Older messages: use --before ${detail.messages[0].id}\n`)
    })
}
