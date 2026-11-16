import { hostname } from 'node:os'
import type { Command } from 'commander'
import pc from 'picocolors'
import { createApi, networkError, unwrap } from '../api/client.ts'
import { CliError, EXIT } from '../api/errors.ts'
import { clearConfig, loadConfig, resolveSettings, saveConfig } from '../config.ts'
import { apiFor, globals } from '../context.ts'
import { formatCredits, printJson } from '../output.ts'
import { savedToken, saveLogin } from '../login-store.ts'
import { deleteKeychainToken } from '../keychain.ts'
import { openBrowser, sleep } from '../platform.ts'

interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUrl: string
  verificationUrlComplete: string
  expiresIn: number
  interval: number
}

/** Polls `/api/auth/device/token` per RFC 8628 (interval, slow_down, expiry). Exported for tests. */
export async function pollDeviceToken(
  apiUrl: string,
  dc: Pick<DeviceCode, 'deviceCode' | 'interval' | 'expiresIn'>,
  deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<{ token: string; tokenInfo: { id: string; name: string } }> {
  const doFetch = deps.fetch ?? fetch
  const wait = deps.sleep ?? sleep
  const now = deps.now ?? Date.now
  const deadline = now() + dc.expiresIn * 1000
  let interval = Math.max(1, dc.interval) * 1000
  while (now() < deadline) {
    await wait(interval)
    let res: Response
    try {
      res = await doFetch(`${apiUrl}/api/auth/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: dc.deviceCode }),
      })
    } catch {
      continue // transient network error: keep polling until expiry
    }
    const body: unknown = await res.json().catch(() => null)
    if (res.ok) return body as { token: string; tokenInfo: { id: string; name: string } }
    const err = CliError.fromResponse(res.status, body)
    if (err.code === 'AUTHORIZATION_PENDING') continue
    if (err.code === 'SLOW_DOWN') {
      interval += 5000
      continue
    }
    if (err.code === 'DENIED')
      throw new CliError('Login was denied in the browser.', { exitCode: EXIT.auth })
    if (err.code === 'EXPIRED') break
    throw err
  }
  throw new CliError('The login code expired — run `harness login` again.', { exitCode: EXIT.auth })
}

export function registerAuth(program: Command): void {
  program
    .command('login')
    .description('Sign in (opens the browser to approve this device)')
    .option('--token <token>', 'use an existing access token (hk_…) instead of the browser')
    .option('--keychain', 'store the token in the OS keychain')
    .option('--no-keychain', 'store the token in the config file (0600)')
    .option('--no-browser', 'only print the URL')
    .action(
      async (opts: { token?: string; browser: boolean; keychain?: boolean }, cmd: Command) => {
        const g = globals(cmd)
        // Starting a new login must not require unlocking an old or missing keychain entry.
        const stored = loadConfig()
        const settings = resolveSettings({ apiUrl: g.apiUrl, org: g.org }, process.env, {
          ...stored,
          token: undefined,
          keychainRef: undefined,
        })

        if (opts.token) {
          if (!opts.token.startsWith('hk_')) {
            throw new CliError('Access tokens start with hk_', { exitCode: EXIT.usage })
          }
          const api = createApi({ ...settings, token: opts.token })
          const info = await unwrap(api.client.GET('/api/tokens/current'), settings.apiUrl)
          saveLogin(
            { ...stored, apiUrl: settings.apiUrl, tokenId: info.id },
            opts.token,
            opts.keychain ?? Boolean(stored.keychainRef),
          )
          console.log(pc.green(`✓ Logged in with token "${info.name}"`))
          return
        }

        let res: Response
        try {
          res = await fetch(`${settings.apiUrl}/api/auth/device/code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientName: `harness CLI on ${hostname()}`.slice(0, 80) }),
          })
        } catch (err) {
          throw networkError(settings.apiUrl, err)
        }
        const body: unknown = await res.json().catch(() => null)
        if (!res.ok) throw CliError.fromResponse(res.status, body)
        const dc = body as DeviceCode

        console.log()
        console.log(`  Your code: ${pc.bold(pc.cyan(dc.userCode))}`)
        console.log(`  Approve at: ${pc.underline(dc.verificationUrlComplete)}`)
        console.log(
          pc.dim(
            `  (check that the code in the browser matches — expires in ${Math.round(dc.expiresIn / 60)} min)`,
          ),
        )
        console.log()
        if (opts.browser && process.stdout.isTTY) openBrowser(dc.verificationUrlComplete)
        process.stdout.write(pc.dim('Waiting for approval… (Ctrl+C to cancel)\n'))

        const issued = await pollDeviceToken(settings.apiUrl, dc)
        saveLogin(
          { ...stored, apiUrl: settings.apiUrl, tokenId: issued.tokenInfo.id },
          issued.token,
          opts.keychain ?? Boolean(stored.keychainRef),
        )
        const me = await unwrap(
          createApi({ ...settings, token: issued.token }).client.GET('/api/me'),
        )
        console.log(pc.green(`✓ Logged in as ${me.user.email}`))
      },
    )

  program
    .command('logout')
    .description('Revoke this device’s token and forget it')
    .action(async () => {
      const stored = loadConfig()
      const token = savedToken(stored)
      if (token && stored.tokenId) {
        const api = createApi(resolveSettings({}, {}, { ...stored, token, keychainRef: undefined }))
        try {
          await unwrap(
            api.client.DELETE('/api/tokens/{id}', { params: { path: { id: stored.tokenId } } }),
            api.settings.apiUrl,
          )
        } catch (error) {
          // Already revoked/deleted tokens can still be forgotten locally.
          if (!(error instanceof CliError) || (error.status !== 401 && error.status !== 404))
            throw error
        }
      }
      if (stored.keychainRef) deleteKeychainToken(stored.keychainRef)
      const { apiUrl } = stored
      clearConfig()
      if (apiUrl) saveConfig({ apiUrl })
      console.log('Logged out.')
    })

  program
    .command('credentials')
    .description('Manage local token storage')
    .command('storage <backend>')
    .description('Move the saved token to file or keychain storage')
    .action((backend: string, _opts: unknown, cmd: Command) => {
      if (backend !== 'file' && backend !== 'keychain')
        throw new CliError('Storage must be file or keychain', { exitCode: EXIT.usage })
      const stored = loadConfig()
      const token = savedToken(stored)
      if (!token)
        throw new CliError('No saved login — run `harness login` first.', { exitCode: EXIT.auth })
      saveLogin(stored, token, backend === 'keychain')
      if (globals(cmd).json) printJson({ storage: backend })
      else console.log(`Token storage: ${backend}`)
    })

  program
    .command('whoami')
    .description('Show the signed-in account, plan and balance')
    .action(async (_opts: unknown, cmd: Command) => {
      const api = apiFor(cmd)
      const me = await unwrap(api.client.GET('/api/me'), api.settings.apiUrl)
      if (globals(cmd).json) return printJson(me)
      const org = me.orgs.find((o) => o.id === me.currentOrgId)
      console.log(`${pc.bold(me.user.name)} <${me.user.email}>`)
      console.log(`Org:     ${org?.name ?? me.currentOrgId}${org ? pc.dim(` (${org.role})`) : ''}`)
      console.log(`Plan:    ${me.plan}`)
      console.log(`Credits: ${formatCredits(me.wallet.balanceMicro)}`)
      if (me.freeQuota.limit > 0) {
        console.log(`Free AI: ${me.freeQuota.used}/${me.freeQuota.limit} today`)
      }
      console.log(pc.dim(`API:     ${api.settings.apiUrl}`))
    })
}
