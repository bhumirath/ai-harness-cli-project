import { createInterface } from 'node:readline/promises'
import * as p from '@clack/prompts'
import type { Command } from 'commander'
import pc from 'picocolors'
import { unwrap, type Api } from '../api/client.ts'
import { CliError, EXIT } from '../api/errors.ts'
import { resolveAgent } from '../agents.ts'
import { apiFor, globals } from '../context.ts'
import { formatCredits, printJson } from '../output.ts'
import { MarkdownStream } from '../markdown.ts'
import { readStdin } from '../platform.ts'

export interface TurnResult {
  text: string
  finishReason: string
  approvals: { id: string; tool: string; arguments: string }[]
  chargedMicro: bigint
  tokensIn: number
  tokensOut: number
}

/** Streams one reply; renders to the terminal unless `quiet`. */
export async function streamTurn(
  api: Api,
  path: string,
  body: unknown,
  opts: { quiet?: boolean; signal?: AbortSignal; markdown?: boolean } = {},
): Promise<TurnResult> {
  const out: TurnResult = {
    text: '',
    finishReason: 'stop',
    approvals: [],
    chargedMicro: 0n,
    tokensIn: 0,
    tokensOut: 0,
  }
  const write = (s: string) => {
    if (!opts.quiet) process.stdout.write(s)
  }
  const markdown = opts.markdown && !opts.quiet ? new MarkdownStream(write) : undefined
  try {
    for await (const e of api.stream(path, body, opts.signal)) {
      const d = e.data as Record<string, unknown>
      switch (e.event) {
        case 'delta':
          out.text += String(d.text ?? '')
          if (markdown) markdown.push(String(d.text ?? ''))
          else write(String(d.text ?? ''))
          break
        case 'tool_call':
          markdown?.flush()
          write(pc.dim(`\n⚙ ${String(d.name)}…`))
          break
        case 'tool_result':
          markdown?.flush()
          write(
            d.ok ? pc.dim(` ✓${d.summary ? ` ${String(d.summary)}` : ''}\n`) : pc.yellow(' ✗\n'),
          )
          break
        case 'approval_required':
          out.approvals = (d.approvals as TurnResult['approvals']) ?? []
          break
        case 'usage':
          out.chargedMicro += BigInt(String(d.chargedMicro ?? '0'))
          out.tokensIn += Number(d.tokensIn ?? 0)
          out.tokensOut += Number(d.tokensOut ?? 0)
          break
        case 'done':
          out.finishReason = String(d.finishReason ?? 'stop')
          break
        case 'error':
          throw new CliError(String(d.message ?? 'The model failed'), {
            code: String(d.code ?? ''),
            exitCode: d.code === 'CREDITS_EXHAUSTED' ? EXIT.payment : EXIT.error,
          })
      }
    }
  } finally {
    markdown?.flush()
    if (out.text && !out.text.endsWith('\n')) write('\n')
  }
  return out
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** Asks the user about each pending tool call; returns false if not interactive. */
type Ask = (question: string) => Promise<string>

async function decideApprovals(
  api: Api,
  approvals: TurnResult['approvals'],
  ask?: Ask,
): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  for (const a of approvals) {
    let approve: boolean
    if (ask) {
      console.log(pc.yellow(`\nThe agent wants to run ${pc.bold(a.tool)}:`))
      console.log(pc.dim(prettyArgs(a.arguments)))
      approve = /^y(es)?$/i.test((await ask(`Allow ${a.tool}? [y/N] `)).trim())
    } else {
      p.note(prettyArgs(a.arguments), `The agent wants to run ${pc.bold(a.tool)}`)
      approve = (await p.confirm({ message: `Allow ${a.tool}?`, initialValue: false })) === true
    }
    const path = approve ? '/api/approvals/{id}/approve' : '/api/approvals/{id}/reject'
    await unwrap(api.client.POST(path, { params: { path: { id: a.id } } }), api.settings.apiUrl)
  }
  return true
}

/** Sends a message and keeps going through approval pauses. */
async function converse(
  api: Api,
  conversationId: string,
  text: string,
  opts: { quiet?: boolean; signal?: AbortSignal; ask?: Ask; markdown?: boolean },
): Promise<TurnResult> {
  let r = await streamTurn(
    api,
    `/api/conversations/${conversationId}/messages`,
    { content: [{ type: 'text', text }] },
    opts,
  )
  const total = { ...r }
  while (r.approvals.length) {
    if (!(await decideApprovals(api, r.approvals, opts.ask))) {
      process.stderr.write(
        pc.yellow(
          `Waiting for approval of ${r.approvals.map((a) => a.tool).join(', ')} — run \`harness approvals\` or open the web inbox.\n`,
        ),
      )
      break
    }
    r = await streamTurn(api, `/api/conversations/${conversationId}/continue`, {}, opts)
    total.text += r.text
    total.finishReason = r.finishReason
    total.approvals = r.approvals
    total.chargedMicro += r.chargedMicro
    total.tokensIn += r.tokensIn
    total.tokensOut += r.tokensOut
  }
  return total
}

async function newConversation(api: Api, agentId: string): Promise<string> {
  const c = await unwrap(
    api.client.POST('/api/conversations', { body: { agentId } }),
    api.settings.apiUrl,
  )
  return c.id
}

export function registerChat(program: Command): void {
  program
    .command('ask')
    .description('Ask once and print the answer (stdin is appended: cat log | harness ask "why?")')
    .argument('[question...]', 'your question')
    .option('-a, --agent <agent>', 'agent id or name (default: first agent)')
    .option('-c, --conversation <id>', 'continue an existing conversation')
    .option('--markdown', 'format Markdown as lines arrive (buffers the current line)')
    .action(
      async (
        words: string[],
        opts: { agent?: string; conversation?: string; markdown?: boolean },
        cmd: Command,
      ) => {
        const json = globals(cmd).json
        const stdin = (await readStdin()).trim()
        const question = [words.join(' ').trim(), stdin].filter(Boolean).join('\n\n')
        if (!question)
          throw new CliError('Nothing to ask — pass a question or pipe text in.', {
            exitCode: EXIT.usage,
          })
        const api = apiFor(cmd)
        const conversationId =
          opts.conversation ??
          (await newConversation(api, (await resolveAgent(api, opts.agent)).id))
        const r = await converse(api, conversationId, question, {
          quiet: json,
          markdown: opts.markdown,
        })
        if (json) {
          printJson({
            conversationId,
            text: r.text,
            finishReason: r.finishReason,
            pendingApprovals: r.approvals,
            usage: {
              tokensIn: r.tokensIn,
              tokensOut: r.tokensOut,
              chargedMicro: r.chargedMicro.toString(),
            },
          })
        }
        if (r.approvals.length) process.exitCode = EXIT.error
      },
    )

  program
    .command('chat')
    .description('Interactive chat with an agent (/new, /exit)')
    .option('-a, --agent <agent>', 'agent id or name (default: first agent)')
    .option('-c, --conversation <id>', 'continue an existing conversation')
    .option('--markdown', 'format Markdown as lines arrive (buffers the current line)')
    .action(
      async (opts: { agent?: string; conversation?: string; markdown?: boolean }, cmd: Command) => {
        if (!process.stdin.isTTY)
          throw new CliError('`chat` needs a terminal — use `harness ask` in scripts.', {
            exitCode: EXIT.usage,
          })
        const api = apiFor(cmd)
        const agent = await resolveAgent(api, opts.agent)
        let conversationId = opts.conversation ?? (await newConversation(api, agent.id))
        console.log(
          pc.dim(
            `Chatting with ${pc.bold(agent.name)} · /new for a new conversation · /exit to quit`,
          ),
        )

        const rl = createInterface({ input: process.stdin, output: process.stdout })
        let current: AbortController | null = null
        rl.on('SIGINT', () => {
          if (current) {
            current.abort()
            process.stdout.write(pc.dim('\n(stopped)\n'))
          } else {
            rl.close()
          }
        })
        try {
          for (;;) {
            let line: string
            try {
              line = (await rl.question(pc.cyan('› '))).trim()
            } catch {
              break // closed
            }
            if (!line) continue
            if (line === '/exit' || line === '/quit') break
            if (line === '/new') {
              conversationId = await newConversation(api, agent.id)
              console.log(pc.dim('New conversation.'))
              continue
            }
            if (line === '/help') {
              console.log(pc.dim('/new  new conversation · /exit  quit · Ctrl+C stops a reply'))
              continue
            }
            current = new AbortController()
            try {
              const r = await converse(api, conversationId, line, {
                signal: current.signal,
                markdown: opts.markdown,
                ask: (q) => rl.question(pc.yellow(q)),
              })
              if (r.chargedMicro > 0n)
                console.log(pc.dim(`  ${formatCredits(r.chargedMicro, 4)} credits`))
            } catch (err) {
              if (current.signal.aborted) continue
              if (err instanceof CliError && err.exitCode !== EXIT.error) throw err
              console.error(pc.red(err instanceof Error ? err.message : String(err)))
            } finally {
              current = null
            }
          }
        } finally {
          rl.close()
        }
      },
    )
}
