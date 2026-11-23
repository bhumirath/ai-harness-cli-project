import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'

const MAX_BYTES = 2_000_000
const MAX_CHARS = 60_000
const MAX_REDIRECTS = 5

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0) >>> 0
}
function inV4(address: string, base: string, bits: number): boolean {
  const shift = 32 - bits
  return ipv4Number(address) >>> shift === ipv4Number(base) >>> shift
}
const privateV4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return privateV4.some(([base, bits]) => inV4(address, base, bits))
  if (kind !== 6) return true
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '')
  const mapped =
    /^(?:0*:)*:?(?:ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ??
    /^::(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) return isPrivateAddress(mapped[1]!)
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (hexMapped) {
    const high = parseInt(hexMapped[1]!, 16)
    const low = parseInt(hexMapped[2]!, 16)
    return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  if (lower === '::' || lower === '::1') return true
  const first = parseInt(lower.split(':')[0] || '0', 16)
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site local (deprecated)
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    lower.startsWith('64:ff9b:') || // NAT64 can reach IPv4 private ranges
    lower.startsWith('2001:db8:') ||
    first === 0
  )
}

export interface FetchOptions {
  /** Returns true when the resolved address must not be contacted. Defaults to isPrivateAddress. */
  isBlocked?: (address: string, hostname: string) => boolean
  timeoutMs?: number
}

export interface FetchResult {
  ok: boolean
  url: string
  status: number
  contentType: string
  content: string
  truncated: boolean
  error?: string
}

/** Converts HTML into readable plain text without executing or loading anything. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, '$2 ($1)')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(
      /<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/pre|\/section|\/article|p|div|tr|pre)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const value = Number(code)
      return value > 0 && value < 0x110000 ? String.fromCodePoint(value) : ''
    })
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function validateUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are allowed')
  if (url.username || url.password) throw new Error('URLs with embedded credentials are refused')
  return url
}

/**
 * Fetches a public web page with strict limits. Every hop (including redirects) resolves DNS through
 * a guarded lookup, so a hostname cannot rebind to a loopback/private address after validation.
 */
export async function webFetch(
  rawUrl: string,
  format: 'text' | 'markdown' | 'html',
  signal: AbortSignal,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const isBlocked = options.isBlocked ?? ((address: string) => isPrivateAddress(address))
  let url = validateUrl(rawUrl)
  const agent = new Agent({
    connect: {
      lookup(hostname, lookupOptions, callback) {
        dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
          if (error) return callback(error, '', 0)
          const list = addresses as unknown as LookupAddress[]
          const blocked = list.find((item) => isBlocked(item.address, hostname))
          if (blocked || !list.length)
            return callback(
              Object.assign(new Error('Refusing to fetch a private or loopback address'), {
                code: 'EBLOCKED',
              }),
              '',
              0,
            )
          if ((lookupOptions as { all?: boolean }).all)
            return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list)
          callback(null, list[0]!.address, list[0]!.family)
        })
      },
    },
  })
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const combined = AbortSignal.any([signal, timeout])
  try {
    for (let hop = 0; ; hop++) {
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      if (hostname === 'localhost' || hostname.endsWith('.localhost'))
        throw new Error('Refusing to fetch a private or loopback address')
      if (isIP(hostname) && isBlocked(hostname, hostname))
        throw new Error('Refusing to fetch a private or loopback address')
      let response: Awaited<ReturnType<typeof undiciFetch>>
      try {
        response = await undiciFetch(url, {
          dispatcher: agent,
          redirect: 'manual',
          signal: combined,
          headers: {
            'User-Agent': 'harness-cli-webfetch',
            Accept:
              format === 'html'
                ? 'text/html,*/*;q=0.8'
                : 'text/markdown,text/plain,text/html;q=0.9,*/*;q=0.5',
          },
        })
      } catch (error) {
        signal.throwIfAborted()
        const cause = (error as { cause?: { code?: string; message?: string } }).cause
        if (cause?.code === 'EBLOCKED') throw new Error(cause.message)
        if (timeout.aborted) throw new Error('Web request timed out')
        throw new Error('Web request failed')
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || hop >= MAX_REDIRECTS) throw new Error('Too many or invalid redirects')
        url = validateUrl(new URL(location, url).toString())
        continue
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (/^(image|audio|video)\/|application\/(octet-stream|zip|pdf)/i.test(contentType)) {
        await response.body?.cancel()
        throw new Error(`Unsupported content type: ${contentType}`)
      }
      const parts: Uint8Array[] = []
      let size = 0
      let truncated = false
      if (response.body) {
        const reader = response.body.getReader()
        for (;;) {
          const item = await reader.read()
          if (item.done) break
          size += item.value.byteLength
          if (size > MAX_BYTES) {
            truncated = true
            parts.push(item.value.subarray(0, item.value.byteLength - (size - MAX_BYTES)))
            await reader.cancel()
            break
          }
          parts.push(item.value)
        }
      }
      let content = Buffer.concat(parts).toString('utf8')
      if (format !== 'html' && /html/i.test(contentType)) content = htmlToText(content)
      if (content.length > MAX_CHARS) {
        content = content.slice(0, MAX_CHARS)
        truncated = true
      }
      return {
        ok: response.ok,
        url: url.toString(),
        status: response.status,
        contentType,
        content,
        truncated,
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
      }
    }
  } finally {
    await agent.close().catch(() => undefined)
  }
}
