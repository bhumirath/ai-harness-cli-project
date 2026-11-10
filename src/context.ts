import type { Command } from 'commander'
import { createApi, type Api } from './api/client.ts'
import { resolveSettings, type Settings } from './config.ts'

export interface GlobalOpts {
  apiUrl?: string
  org?: string
  json?: boolean
}

export function globals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals<GlobalOpts>()
}

export function settingsFor(cmd: Command): Settings {
  const g = globals(cmd)
  return resolveSettings({ apiUrl: g.apiUrl, org: g.org })
}

export function apiFor(cmd: Command, opts: { requireAuth?: boolean } = {}): Api {
  return createApi(settingsFor(cmd), opts)
}
