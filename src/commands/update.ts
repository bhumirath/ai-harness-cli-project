import type { Command } from 'commander'
import { gt, valid } from 'semver'
import { CliError } from '../api/errors.ts'
import { globals } from '../context.ts'
import { printJson } from '../output.ts'
import { VERSION } from '../version.ts'

export async function checkForUpdate(): Promise<{
  current: string
  latest: string
  updateAvailable: boolean
}> {
  let response: Response
  try {
    response = await fetch('https://registry.npmjs.org/@ai-harness%2fcli/latest', {
      headers: { Accept: 'application/json', 'User-Agent': `ai-harness-cli/${VERSION}` },
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw new CliError('Cannot check npm for updates. Check your network and try again.')
  }
  if (response.status === 404) throw new CliError('The CLI has not been published to npm yet.')
  if (!response.ok) throw new CliError(`npm update check failed (HTTP ${response.status}).`)
  const body: unknown = await response.json().catch(() => null)
  const version = body && typeof body === 'object' && 'version' in body ? body.version : undefined
  if (typeof version !== 'string' || !valid(version))
    throw new CliError('npm returned an invalid CLI version.')
  return { current: VERSION, latest: version, updateAvailable: gt(version, VERSION) }
}

export function registerUpdate(program: Command): void {
  program
    .command('update-check')
    .description('Check npm for a newer CLI version (no login needed)')
    .action(async (_opts: unknown, cmd: Command) => {
      const result = await checkForUpdate()
      if (globals(cmd).json) return printJson(result)
      console.log(
        result.updateAvailable
          ? `Update available: ${result.current} → ${result.latest}\nRun: npm install -g @ai-harness/cli@latest`
          : `CLI ${result.current} is up to date with npm latest (${result.latest}).`,
      )
    })
}
