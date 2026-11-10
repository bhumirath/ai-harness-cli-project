import type { Command } from 'commander'
import pc from 'picocolors'
import { unwrap, type Api } from '../api/client.ts'
import { CliError, EXIT } from '../api/errors.ts'
import type { components } from '../api/schema.d.ts'
import { resolveAgent } from '../agents.ts'
import { apiFor, globals } from '../context.ts'
import { formatCredits, formatDate, printJson, printTable } from '../output.ts'
import { sleep } from '../platform.ts'

type Run = components['schemas']['AgentRunDto']
type Job = components['schemas']['ScheduledJobDto']
const DELIVER = ['web', 'email', 'line', 'telegram'] as const
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'waiting_approval'])

/** Prints JSON with --json, otherwise calls `human`. */
function emit(cmd: Command, data: unknown, human: () => void): void {
  if (globals(cmd).json) printJson(data)
  else human()
}

async function allJobs(api: Api): Promise<(Job & { agentName: string })[]> {
  const agents = await unwrap(api.client.GET('/api/agents'), api.settings.apiUrl)
  const lists = await Promise.all(
    agents.map(async (a) =>
      (
        await unwrap(
          api.client.GET('/api/agents/{agentId}/jobs', { params: { path: { agentId: a.id } } }),
        )
      ).map((j) => ({ ...j, agentName: a.name })),
    ),
  )
  return lists.flat()
}

async function findJob(api: Api, id: string) {
  const job = (await allJobs(api)).find((j) => j.id === id || j.id.startsWith(id))
  if (!job) throw new CliError(`No scheduled job ${id}`, { exitCode: EXIT.usage })
  return job
}

function printRun(r: Run): void {
  const color = r.status === 'succeeded' ? pc.green : r.status === 'failed' ? pc.red : pc.yellow
  console.log(`${pc.bold('Run')} ${r.id}  ${color(r.status)}  ${pc.dim(formatDate(r.createdAt))}`)
  if (r.result) console.log(`\n${r.result}\n`)
  if (r.error) console.log(pc.red(r.error))
  console.log(
    pc.dim(`tokens ${r.tokensIn}/${r.tokensOut} · ${formatCredits(r.costMicro, 4)} credits`),
  )
}

export function registerResources(program: Command): void {
  // ---- agents ----
  const agents = program.command('agents').description('List, inspect and run agents')
  agents
    .command('ls', { isDefault: true })
    .description('List agents')
    .action(async (_o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      const list = await unwrap(api.client.GET('/api/agents'), api.settings.apiUrl)
      emit(cmd, list, () =>
        printTable(
          list.map((a) => ({
            id: a.id,
            name: a.name,
            model: a.modelRef,
            tools: a.tools.join(','),
          })),
          ['id', 'name', 'model', 'tools'],
        ),
      )
    })
  agents
    .command('show')
    .argument('<agent>', 'id or name')
    .description('Show an agent')
    .action(async (ref: string, _o: unknown, cmd: Command) => {
      const a = await resolveAgent(apiFor(cmd), ref)
      emit(cmd, a, () => {
        console.log(`${pc.bold(a.name)} ${pc.dim(a.id)}`)
        if (a.description) console.log(a.description)
        console.log(`Model:   ${a.modelRef}`)
        console.log(`Tools:   ${a.tools.join(', ') || '-'}`)
        console.log(`Auto-OK: ${a.autoApprovedTools.join(', ') || '-'}`)
        console.log(`Memory:  ${a.memoryEnabled ? 'on' : 'off'}`)
      })
    })
  agents
    .command('run')
    .argument('<agent>', 'id or name')
    .argument('<prompt...>', 'task for the agent')
    .option('-w, --wait', 'wait for the result')
    .description('Start a background run')
    .action(async (ref: string, words: string[], opts: { wait?: boolean }, cmd: Command) => {
      const api = apiFor(cmd)
      const agent = await resolveAgent(api, ref)
      let run = await unwrap(
        api.client.POST('/api/agents/{id}/runs', {
          params: { path: { id: agent.id } },
          body: { prompt: words.join(' ') },
        }),
        api.settings.apiUrl,
      )
      if (opts.wait) {
        if (!globals(cmd).json) process.stderr.write(pc.dim('Running…\n'))
        while (!TERMINAL.has(run.status)) {
          await sleep(2000)
          run = await unwrap(
            api.client.GET('/api/agent-runs/{id}', { params: { path: { id: run.id } } }),
          )
        }
        if (run.status === 'failed') process.exitCode = EXIT.error
      }
      emit(cmd, run, () =>
        opts.wait ? printRun(run) : console.log(`Started run ${run.id} (${run.status})`),
      )
    })

  // ---- runs ----
  const runs = program.command('runs').description('Background runs')
  runs
    .command('ls', { isDefault: true })
    .option('-a, --agent <agent>', 'agent id or name')
    .description('Recent runs of an agent')
    .action(async (opts: { agent?: string }, cmd: Command) => {
      const api = apiFor(cmd)
      const agent = await resolveAgent(api, opts.agent)
      const list = await unwrap(
        api.client.GET('/api/agents/{id}/runs', { params: { path: { id: agent.id } } }),
      )
      emit(cmd, list, () =>
        printTable(
          list.map((r) => ({
            id: r.id,
            status: r.status,
            trigger: r.trigger,
            prompt: r.prompt,
            credits: formatCredits(r.costMicro, 4),
            created: formatDate(r.createdAt),
          })),
          ['id', 'status', 'trigger', 'prompt', 'credits', 'created'],
          40,
        ),
      )
    })
  runs
    .command('show')
    .argument('<runId>')
    .description('Show a run and its result')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      const run = await unwrap(
        api.client.GET('/api/agent-runs/{id}', { params: { path: { id } } }),
        api.settings.apiUrl,
      )
      emit(cmd, run, () => printRun(run))
    })

  // ---- schedules ----
  const sched = program.command('schedules').description('Scheduled jobs ("every day at 7:00 …")')
  sched
    .command('ls', { isDefault: true })
    .description('List scheduled jobs of all agents')
    .action(async (_o: unknown, cmd: Command) => {
      const list = await allJobs(apiFor(cmd))
      emit(cmd, list, () =>
        printTable(
          list.map((j) => ({
            id: j.id,
            agent: j.agentName,
            when: j.description,
            on: j.enabled ? 'yes' : 'no',
            to: j.deliverTo,
            next: formatDate(j.nextRunAt),
            prompt: j.prompt,
          })),
          ['id', 'agent', 'when', 'on', 'to', 'next', 'prompt'],
          36,
        ),
      )
    })
  sched
    .command('add')
    .argument('<when>', 'e.g. "ทุกวัน 7 โมงเช้า" or "every monday 9am"')
    .argument('<prompt...>', 'what the agent should do')
    .option('-a, --agent <agent>', 'agent id or name')
    .option('--to <channel>', `deliver to: ${DELIVER.join(' | ')}`, 'web')
    .option('--tz <timezone>', 'IANA timezone (default: this computer)')
    .description('Create a scheduled job from plain Thai/English')
    .action(
      async (
        when: string,
        words: string[],
        opts: { agent?: string; to: string; tz?: string },
        cmd: Command,
      ) => {
        if (!(DELIVER as readonly string[]).includes(opts.to)) {
          throw new CliError(`--to must be one of ${DELIVER.join(', ')}`, { exitCode: EXIT.usage })
        }
        const api = apiFor(cmd)
        const agent = await resolveAgent(api, opts.agent)
        const timezone = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
        const parsed = await unwrap(
          api.client.POST('/api/agents/{agentId}/jobs/parse', {
            params: { path: { agentId: agent.id } },
            body: { text: when, timezone },
          }),
          api.settings.apiUrl,
        )
        const job = await unwrap(
          api.client.POST('/api/agents/{agentId}/jobs', {
            params: { path: { agentId: agent.id } },
            body: {
              prompt: words.join(' '),
              cron: parsed.cron,
              timezone: parsed.timezone,
              description: parsed.description,
              deliverTo: opts.to as (typeof DELIVER)[number],
            },
          }),
        )
        emit(cmd, job, () =>
          console.log(
            pc.green(`✓ ${agent.name}: ${job.description}`) +
              pc.dim(` · next ${formatDate(job.nextRunAt)} · id ${job.id}`),
          ),
        )
      },
    )
  sched
    .command('toggle')
    .argument('<id>')
    .description('Turn a job on/off')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      const job = await findJob(api, id)
      const updated = await unwrap(
        api.client.PATCH('/api/agents/{agentId}/jobs/{id}', {
          params: { path: { agentId: job.agentId, id: job.id } },
          body: { enabled: !job.enabled },
        }),
      )
      emit(cmd, updated, () =>
        console.log(`${updated.description}: ${updated.enabled ? 'on' : 'off'}`),
      )
    })
  sched
    .command('rm')
    .argument('<id>')
    .description('Delete a job')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      const job = await findJob(api, id)
      await unwrap(
        api.client.DELETE('/api/agents/{agentId}/jobs/{id}', {
          params: { path: { agentId: job.agentId, id: job.id } },
        }),
      )
      console.log('Deleted.')
    })

  // ---- approvals ----
  const approvals = program.command('approvals').description('Actions waiting for your OK')
  approvals
    .command('ls', { isDefault: true })
    .description('Pending approvals')
    .action(async (_o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      const list = await unwrap(
        api.client.GET('/api/approvals', { params: { query: { status: 'pending' } } }),
        api.settings.apiUrl,
      )
      emit(cmd, list, () =>
        printTable(
          list.map((a) => ({
            id: a.id,
            tool: a.toolName,
            arguments: a.arguments,
            expires: formatDate(a.expiresAt),
          })),
          ['id', 'tool', 'arguments', 'expires'],
        ),
      )
    })
  for (const action of ['approve', 'reject'] as const) {
    approvals
      .command(action)
      .argument('<id>')
      .description(
        action === 'approve' ? 'Allow the action (the run continues)' : 'Refuse the action',
      )
      .action(async (id: string, _o: unknown, cmd: Command) => {
        const api = apiFor(cmd)
        const path =
          action === 'approve' ? '/api/approvals/{id}/approve' : '/api/approvals/{id}/reject'
        const r = await unwrap(
          api.client.POST(path, { params: { path: { id } } }),
          api.settings.apiUrl,
        )
        emit(cmd, r, () => console.log(action === 'approve' ? pc.green('Approved.') : 'Rejected.'))
      })
  }

  // ---- inbox ----
  program
    .command('inbox')
    .description('Notifications (run results, reminders…)')
    .option('-u, --unread', 'only unread')
    .option('--read-all', 'mark everything read')
    .action(async (opts: { unread?: boolean; readAll?: boolean }, cmd: Command) => {
      const api = apiFor(cmd)
      if (opts.readAll) {
        await unwrap(api.client.POST('/api/notifications/read-all'), api.settings.apiUrl)
        console.log('All read.')
        return
      }
      const page = await unwrap(
        api.client.GET('/api/notifications', {
          params: { query: { unread: opts.unread ? 'true' : undefined, limit: 30 } },
        }),
        api.settings.apiUrl,
      )
      emit(cmd, page, () => {
        for (const n of page.items) {
          const dot = n.readAt ? ' ' : pc.cyan('●')
          console.log(`${dot} ${pc.bold(n.title)} ${pc.dim(formatDate(n.createdAt))}`)
          if (n.body) console.log(`  ${n.body.split('\n').slice(0, 4).join('\n  ')}`)
        }
        if (page.items.length === 0) console.log(pc.dim('(empty)'))
      })
    })

  // ---- memory ----
  const memory = program.command('memory').description('What your agents remember about you')
  memory
    .command('ls', { isDefault: true })
    .option('-q, --query <text>', 'search')
    .description('List memories')
    .action(async (opts: { query?: string }, cmd: Command) => {
      const api = apiFor(cmd)
      const list = await unwrap(
        api.client.GET('/api/memories', { params: { query: { q: opts.query } } }),
        api.settings.apiUrl,
      )
      emit(cmd, list, () =>
        printTable(
          list.map((m) => ({
            id: m.id,
            kind: m.kind,
            content: m.content,
            created: formatDate(m.createdAt),
          })),
          ['id', 'kind', 'content', 'created'],
          70,
        ),
      )
    })
  memory
    .command('add')
    .argument('<fact...>')
    .description('Remember a fact')
    .action(async (words: string[], _o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      const created = await unwrap(
        api.client.POST('/api/memories', { body: { content: words.join(' ') } }),
        api.settings.apiUrl,
      )
      emit(cmd, created, () =>
        console.log(created.length ? pc.green('Remembered.') : 'Already known.'),
      )
    })
  memory
    .command('rm')
    .argument('<id>')
    .description('Forget one memory')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      await unwrap(
        api.client.DELETE('/api/memories/{id}', { params: { path: { id } } }),
        api.settings.apiUrl,
      )
      console.log('Forgotten.')
    })

  // ---- models / money ----
  program
    .command('models')
    .description('Models you can use (your keys + platform)')
    .action(async (_o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      const list = await unwrap(api.client.GET('/api/models'), api.settings.apiUrl)
      emit(cmd, list, () =>
        printTable(
          list.map((m) => ({
            ref: m.ref,
            name: m.displayName ?? m.modelId,
            source: m.source,
            key: m.credentialLabel ?? '',
          })),
          ['ref', 'name', 'source', 'key'],
          70,
        ),
      )
    })
  program
    .command('balance')
    .description('Credit balance (1 credit = ฿1)')
    .action(async (_o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      const w = await unwrap(api.client.GET('/api/billing/wallet'), api.settings.apiUrl)
      emit(cmd, w, () => console.log(`${formatCredits(w.balanceMicro)} credits`))
    })
  program
    .command('usage')
    .description('Usage and cost')
    .option('--days <n>', 'look back N days', '30')
    .option('--by <group>', 'day | model', 'day')
    .action(async (opts: { days: string; by: string }, cmd: Command) => {
      const days = Number.parseInt(opts.days, 10)
      if (!Number.isFinite(days) || days < 1 || days > 366)
        throw new CliError('--days must be 1..366', { exitCode: EXIT.usage })
      if (opts.by !== 'day' && opts.by !== 'model')
        throw new CliError('--by must be day or model', { exitCode: EXIT.usage })
      const api = apiFor(cmd)
      const to = new Date()
      const from = new Date(to.getTime() - (days - 1) * 86_400_000)
      const ymd = (d: Date) => d.toISOString().slice(0, 10)
      const u = await unwrap(
        api.client.GET('/api/usage', {
          params: { query: { from: ymd(from), to: ymd(to), groupBy: opts.by as 'day' | 'model' } },
        }),
        api.settings.apiUrl,
      )
      emit(cmd, u, () => {
        printTable(
          u.series as unknown as Record<string, unknown>[],
          Object.keys((u.series[0] ?? {}) as object),
        )
        console.log(pc.dim(JSON.stringify(u.totals)))
      })
    })

  // ---- tokens ----
  const tokens = program
    .command('tokens')
    .description('Access tokens (create new ones in the web app)')
  tokens
    .command('ls', { isDefault: true })
    .description('List your access tokens')
    .action(async (_o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      const list = await unwrap(api.client.GET('/api/tokens'), api.settings.apiUrl)
      emit(cmd, list, () =>
        printTable(
          list.map((t) => ({
            id: t.id,
            name: t.name,
            token: `${t.prefix}…${t.last4}`,
            'last used': formatDate(t.lastUsedAt),
            expires: formatDate(t.expiresAt) || 'never',
          })),
          ['id', 'name', 'token', 'last used', 'expires'],
        ),
      )
    })
  tokens
    .command('revoke')
    .argument('<id>')
    .description('Revoke a token')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      await unwrap(
        api.client.DELETE('/api/tokens/{id}', { params: { path: { id } } }),
        api.settings.apiUrl,
      )
      console.log('Revoked.')
    })
}
