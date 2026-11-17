import { defaultCommand } from './completion.ts'
import * as p from '@clack/prompts'
import type { Command } from 'commander'
import { createApi, unwrap } from '../api/client.ts'
import { CliError, EXIT } from '../api/errors.ts'
import { loadConfig, saveConfig } from '../config.ts'
import { globals, settingsFor } from '../context.ts'
import { printJson, printTable } from '../output.ts'

export function registerOrgs(program: Command): void {
  const orgs = program.command('orgs').description('List organizations and choose a default')
  async function memberships(cmd: Command) {
    const settings = settingsFor(cmd)
    // Membership discovery must still work after losing access to the saved organization.
    const api = createApi({ ...settings, orgId: undefined })
    const me = await unwrap(api.client.GET('/api/me'), settings.apiUrl)
    return { me, current: settings.orgId ?? me.currentOrgId }
  }
  defaultCommand(orgs, 'ls')
    .description('List your organization memberships')
    .action(async (_opts: unknown, cmd: Command) => {
      const { me, current } = await memberships(cmd)
      if (globals(cmd).json) return printJson({ items: me.orgs, currentOrgId: current })
      printTable(
        me.orgs.map((org) => ({
          id: org.id,
          name: org.name,
          role: org.role,
          current: org.id === current ? '*' : '',
        })),
        ['id', 'name', 'role', 'current'],
      )
    })
  orgs
    .command('use [organization]')
    .description('Save an organization by id or exact name; omit to pick interactively')
    .action(async (ref: string | undefined, _opts: unknown, cmd: Command) => {
      if (!ref && (globals(cmd).json || !process.stdin.isTTY || !process.stdout.isTTY)) {
        throw new CliError(
          'Pass an organization id or name in scripts; use `harness orgs ls` to list them.',
          { exitCode: EXIT.usage },
        )
      }
      const { me, current } = await memberships(cmd)
      if (!me.orgs.length)
        throw new CliError('You have no organization memberships.', { exitCode: EXIT.usage })
      let selected: string
      if (ref) {
        const exact = me.orgs.find((org) => org.id === ref)
        const matches = exact
          ? [exact]
          : me.orgs.filter((org) => org.name.toLocaleLowerCase() === ref.toLocaleLowerCase())
        if (matches.length !== 1)
          throw new CliError(
            matches.length
              ? `Organization name "${ref}" is ambiguous; use its id.`
              : `No organization "${ref}". Run \`harness orgs ls\`.`,
            { exitCode: EXIT.usage },
          )
        selected = matches[0]!.id
      } else {
        const choice = await p.select({
          message: 'Default organization',
          initialValue: me.orgs.some((o) => o.id === current) ? current : undefined,
          options: me.orgs.map((org) => ({
            value: org.id,
            label: org.name,
            hint: `${org.role} · ${org.id}`,
          })),
        })
        if (p.isCancel(choice))
          throw new CliError('Organization selection canceled.', { exitCode: EXIT.error })
        selected = String(choice)
      }
      const org = me.orgs.find((o) => o.id === selected)
      if (!org) throw new CliError('Invalid organization selection.', { exitCode: EXIT.usage })
      saveConfig({ ...loadConfig(), orgId: org.id, agentId: undefined })
      if (globals(cmd).json) return printJson(org)
      console.log(`Default organization: ${org.name} (${org.id})`)
      if (globals(cmd).org || process.env.HARNESS_ORG)
        process.stderr.write('The --org flag or HARNESS_ORG still overrides this saved default.\n')
    })
}
