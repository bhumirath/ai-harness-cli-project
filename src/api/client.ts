import createClient, { type Client } from 'openapi-fetch'
import type { Settings } from '../config.ts'
import { VERSION } from '../version.ts'
import { CliError, EXIT } from './errors.ts'
import type { paths } from './schema.d.ts'
import { readSse, type ChatStreamEvent } from './sse.ts'

export type ApiClient = Client<paths>

export interface Api {
  client: ApiClient
  settings: Settings
  /** POST that answers with an SSE stream (chat). */
  stream(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent>
}

function headers(settings: Settings, requireAuth: boolean): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': `ai-harness-cli/${VERSION}` }
  if (settings.token) h.Authorization = `Bearer ${settings.token}`
  else if (requireAuth) {
    throw new CliError('Not logged in — run `harness login`', { exitCode: EXIT.auth })
  }
  if (settings.orgId) h['X-Org-Id'] = settings.orgId
  return h
}

export function createApi(settings: Settings, opts: { requireAuth?: boolean } = {}): Api {
  const h = headers(settings, opts.requireAuth ?? true)
  const client = createClient<paths>({ baseUrl: settings.apiUrl, headers: h })
  return {
    client,
    settings,
    async *stream(path, body, signal) {
      let res: Response
      try {
        res = await fetch(`${settings.apiUrl}${path}`, {
          method: 'POST',
          headers: { ...h, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal,
        })
      } catch (err) {
        throw networkError(settings.apiUrl, err)
      }
      if (!res.ok || !res.body) {
        throw CliError.fromResponse(res.status, await res.json().catch(() => null))
      }
      yield* readSse(res.body)
    },
  }
}

export function networkError(apiUrl: string, err: unknown): CliError {
  const reason =
    err instanceof Error
      ? err.cause instanceof Error
        ? err.cause.message
        : err.message
      : String(err)
  return new CliError(`Cannot reach ${apiUrl} (${reason}). Check --api-url / HARNESS_API_URL.`)
}

/**
 * Unwraps an openapi-fetch result: returns data or throws a CliError with the API message.
 * Usage: `const me = await unwrap(api.client.GET('/api/me'))`
 */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
  apiUrl?: string,
): Promise<T> {
  let r: { data?: T; error?: unknown; response: Response }
  try {
    r = await call
  } catch (err) {
    throw networkError(apiUrl ?? 'the API', err)
  }
  if (!r.response.ok) throw CliError.fromResponse(r.response.status, r.error)
  return r.data as T
}
