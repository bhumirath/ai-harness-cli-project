import type { Api } from './api/client.ts'
import { unwrap } from './api/client.ts'
import { CliError, EXIT } from './api/errors.ts'
import type { components } from './api/schema.d.ts'

export type Agent = components['schemas']['AgentDto']

/** Finds an agent by id, exact name or name prefix (case-insensitive); default = first agent. */
export async function resolveAgent(api: Api, ref?: string): Promise<Agent> {
  const agents = await unwrap(api.client.GET('/api/agents'), api.settings.apiUrl)
  if (agents.length === 0) {
    throw new CliError('You have no agents yet — create one in the web app first.', {
      exitCode: EXIT.usage,
    })
  }
  const wanted = ref ?? api.settings.agentId
  if (!wanted) return agents[0]!
  const lower = wanted.toLowerCase()
  const match =
    agents.find((a) => a.id === wanted) ??
    agents.find((a) => a.name.toLowerCase() === lower) ??
    agents.find((a) => a.name.toLowerCase().startsWith(lower))
  if (!match) {
    throw new CliError(`No agent "${wanted}". Available: ${agents.map((a) => a.name).join(', ')}`, {
      exitCode: EXIT.usage,
    })
  }
  return match
}
