import type { Command } from 'commander'
import pc from 'picocolors'
import { unwrap, type Api } from '../api/client.ts'
import { CliError, EXIT } from '../api/errors.ts'
import { resolveAgent } from '../agents.ts'
import { apiFor, globals } from '../context.ts'
import { formatCredits, printJson, printTable } from '../output.ts'

/** Picks a model: --model, else the free model, else the first available one. */
async function pickModel(api: Api, wanted?: string): Promise<string> {
  if (wanted) return wanted
  const models = await unwrap(api.client.GET('/api/models'), api.settings.apiUrl)
  const m = models.find((x) => x.free) ?? models[0]
  if (!m) {
    throw new CliError('No model available — add an API key in the web app or pass --model', {
      exitCode: EXIT.usage,
    })
  }
  return m.ref
}

/** Accepts a share token or a full link (…/t/<token>). */
export function shareToken(input: string): string {
  const m = /(?:\/t\/)?([A-Za-z0-9_-]{16,64})\/?$/.exec(input.trim())
  if (!m) throw new CliError('Not a share link or token', { exitCode: EXIT.usage })
  return m[1]!
}

export function registerTemplates(program: Command): void {
  const tpl = program
    .command('templates')
    .description('Ready-made agents (news digest, inbox digest, …)')
  tpl
    .command('ls', { isDefault: true })
    .description('List templates')
    .action(async (_o: unknown, cmd: Command) => {
      const api = apiFor(cmd, { requireAuth: false })
      const list = await unwrap(api.client.GET('/api/agent-templates'), api.settings.apiUrl)
      if (globals(cmd).json) return printJson(list)
      printTable(
        list.map((t) => ({
          id: t.id,
          name: t.name.th,
          schedule: t.schedule?.text ?? '',
          tools: t.tools.join(','),
        })),
        ['id', 'name', 'schedule', 'tools'],
        40,
      )
    })
  tpl
    .command('use')
    .argument('<id>', 'template id (see `harness templates`)')
    .option('-m, --model <ref>', 'model ref (default: Free model, else the first available)')
    .option('-n, --name <name>', 'agent name')
    .option('-s, --schedule', 'also create the suggested schedule')
    .description('Create an agent from a template')
    .action(
      async (
        id: string,
        opts: { model?: string; name?: string; schedule?: boolean },
        cmd: Command,
      ) => {
        const api = apiFor(cmd)
        const r = await unwrap(
          api.client.POST('/api/agent-templates/{id}/use', {
            params: { path: { id } },
            body: {
              modelRef: await pickModel(api, opts.model),
              ...(opts.name ? { name: opts.name } : {}),
              withSchedule: !!opts.schedule,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          }),
          api.settings.apiUrl,
        )
        if (globals(cmd).json) return printJson(r)
        console.log(pc.green(`✓ Agent "${r.agent.name}" created`) + pc.dim(` (${r.agent.id})`))
        if (r.job) console.log(pc.dim(`  scheduled: ${r.job.description} → ${r.job.deliverTo}`))
        if (r.droppedTools.length) {
          console.log(pc.yellow(`  not included (plan/connection): ${r.droppedTools.join(', ')}`))
        }
      },
    )

  program
    .command('share')
    .argument('<agent>', 'agent id or name')
    .option('--stop', 'stop sharing')
    .description('Share an agent as a public template link (instructions become public)')
    .action(async (ref: string, opts: { stop?: boolean }, cmd: Command) => {
      const api = apiFor(cmd)
      const agent = await resolveAgent(api, ref)
      if (opts.stop) {
        await unwrap(
          api.client.DELETE('/api/agents/{id}/share', { params: { path: { id: agent.id } } }),
          api.settings.apiUrl,
        )
        console.log('Sharing stopped.')
        return
      }
      const r = await unwrap(
        api.client.POST('/api/agents/{id}/share', { params: { path: { id: agent.id } } }),
        api.settings.apiUrl,
      )
      const base = api.settings.apiUrl.replace(/\/api\/?$/, '')
      const link = `${base}/t/${r.token}`
      if (globals(cmd).json) return printJson({ token: r.token, link })
      console.log(link)
      console.error(
        pc.dim(
          'Anyone with the link sees the name, description, instructions and tools (not models or keys).',
        ),
      )
    })

  program
    .command('import')
    .argument('<link>', 'share link or token')
    .option('-m, --model <ref>', 'model ref (default: Free model, else the first available)')
    .description('Add a shared agent to your account')
    .action(async (link: string, opts: { model?: string }, cmd: Command) => {
      const api = apiFor(cmd)
      const token = shareToken(link)
      const r = await unwrap(
        api.client.POST('/api/shared-agents/{token}/import', {
          params: { path: { token } },
          body: { modelRef: await pickModel(api, opts.model) },
        }),
        api.settings.apiUrl,
      )
      if (globals(cmd).json) return printJson(r)
      console.log(pc.green(`✓ Added "${r.agent.name}"`) + pc.dim(` (${r.agent.id})`))
      if (r.droppedTools.length)
        console.log(pc.yellow(`  not included: ${r.droppedTools.join(', ')}`))
    })

  program
    .command('invite')
    .description('Your referral link')
    .action(async (_o: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      const r = await unwrap(api.client.GET('/api/referrals'), api.settings.apiUrl)
      if (globals(cmd).json) return printJson(r)
      console.log(r.link)
      console.log(pc.dim(`invited ${r.invited} · rewarded ${r.rewarded}`))
      if (r.enabled) {
        console.log(
          pc.dim(
            `friend gets ${formatCredits(r.friendMicro)} credits on their first payment; you get ${formatCredits(r.rewardMicro)}`,
          ),
        )
      }
    })
}
