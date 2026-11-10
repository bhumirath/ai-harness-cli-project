import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApi } from '../src/api/client.ts'
import { CliError, EXIT } from '../src/api/errors.ts'
import { SseParser, type RawSseEvent } from '../src/api/sse.ts'
import { pollDeviceToken } from '../src/commands/auth.ts'
import { streamTurn } from '../src/commands/chat.ts'
import { loadConfig, resolveSettings, saveConfig } from '../src/config.ts'
import { formatCredits } from '../src/output.ts'

describe('SseParser', () => {
  it('handles split chunks, CRLF, multi-line data and comments', () => {
    const got: RawSseEvent[] = []
    const p = new SseParser((e) => got.push(e))
    p.push('event: delta\r')
    p.push('\ndata: {"text":"สวั')
    p.push('สดี"}\r\n\r\n: keep-alive\n\ndata: a\ndata: b\n')
    p.end()
    expect(got).toEqual([
      { event: 'delta', data: '{"text":"สวัสดี"}' },
      { event: 'message', data: 'a\nb' },
    ])
  })
})

describe('formatCredits', () => {
  it('formats micro-credits with BigInt and rounding', () => {
    expect(formatCredits('0')).toBe('0.00')
    expect(formatCredits('1234567890')).toBe('1,234.57')
    expect(formatCredits('-5000')).toBe('-0.01')
    expect(formatCredits(12345n, 4)).toBe('0.0123')
  })
})

describe('config', () => {
  it('saves with mode 0600 and resolves flags > env > file > default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-'))
    const path = join(dir, 'sub', 'config.json')
    saveConfig({ apiUrl: 'https://file.example/', token: 'hk_file', orgId: 'o-file' }, path)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    const stored = loadConfig(path)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(stored)

    expect(resolveSettings({}, {}, stored)).toMatchObject({
      apiUrl: 'https://file.example',
      token: 'hk_file',
      orgId: 'o-file',
    })
    expect(
      resolveSettings({}, { HARNESS_API_URL: 'http://env:1', HARNESS_TOKEN: 'hk_env' }, stored),
    ).toMatchObject({
      apiUrl: 'http://env:1',
      token: 'hk_env',
    })
    expect(
      resolveSettings(
        { apiUrl: 'http://flag', org: 'o-flag' },
        { HARNESS_API_URL: 'http://env' },
        stored,
      ),
    ).toMatchObject({
      apiUrl: 'http://flag',
      orgId: 'o-flag',
    })
    expect(loadConfig(join(dir, 'missing.json'))).toEqual({})
  })
})

describe('CliError.fromResponse', () => {
  it('maps API errors to exit codes', () => {
    expect(
      CliError.fromResponse(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }).exitCode,
    ).toBe(EXIT.auth)
    const pay = CliError.fromResponse(402, {
      error: { code: 'CREDITS_EXHAUSTED', message: 'Top up' },
    })
    expect([pay.exitCode, pay.code, pay.message]).toEqual([
      EXIT.payment,
      'CREDITS_EXHAUSTED',
      'Top up',
    ])
    expect(CliError.fromResponse(500, null).message).toBe('HTTP 500')
  })
})

describe('pollDeviceToken', () => {
  const res = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  const err = (code: string) => res(400, { error: { code, message: code } })

  it('waits through pending, backs off on slow_down, returns the token', async () => {
    const replies = [
      err('AUTHORIZATION_PENDING'),
      err('SLOW_DOWN'),
      res(200, { token: 'hk_x', tokenInfo: { id: 't', name: 'CLI' } }),
    ]
    const waits: number[] = []
    let clock = 0
    const r = await pollDeviceToken(
      'http://api',
      { deviceCode: 'd', interval: 5, expiresIn: 600 },
      {
        fetch: () => replies.shift()!,
        sleep: (ms) => {
          waits.push(ms)
          clock += ms
          return Promise.resolve()
        },
        now: () => clock,
      },
    )
    expect(r.token).toBe('hk_x')
    expect(waits).toEqual([5000, 5000, 10000])
  })

  it('stops on denied and on expiry', async () => {
    const deps = { sleep: () => Promise.resolve(), now: () => 0 }
    await expect(
      pollDeviceToken(
        'http://api',
        { deviceCode: 'd', interval: 1, expiresIn: 60 },
        { ...deps, fetch: () => err('DENIED') },
      ),
    ).rejects.toThrow(/denied/)
    await expect(
      pollDeviceToken(
        'http://api',
        { deviceCode: 'd', interval: 1, expiresIn: 60 },
        { ...deps, fetch: () => err('EXPIRED') },
      ),
    ).rejects.toThrow(/expired/)
  })
})

describe('streamTurn (against a local SSE server)', () => {
  let server: Server
  let url = ''
  let lastAuth: string | undefined
  let lastBody = ''
  beforeAll(async () => {
    server = createServer((req, r) => {
      lastAuth = req.headers.authorization
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        lastBody = body
        if (req.url?.includes('broke')) {
          r.writeHead(402, { 'content-type': 'application/json' })
          r.end(JSON.stringify({ error: { code: 'CREDITS_EXHAUSTED', message: 'Top up first' } }))
          return
        }
        r.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (event: string, data: unknown) =>
          r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        send('message.created', { userMessageId: 'u', assistantMessageId: 'a' })
        send('tool_call', { id: 'c1', name: 'send_email', arguments: {} })
        send('approval_required', {
          approvals: [{ id: 'ap1', tool: 'send_email', arguments: '{"to":"a@b.c"}' }],
        })
        send('delta', { text: 'สวัส' })
        send('delta', { text: 'ดี' })
        send('usage', { tokensIn: 10, tokensOut: 2, chargedMicro: '1500' })
        send('done', { finishReason: 'waiting_approval' })
        r.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('collects text, usage and pending approvals and sends the token', async () => {
    const api = createApi({ apiUrl: url, token: 'hk_test' })
    const r = await streamTurn(
      api,
      '/api/conversations/c/messages',
      { content: [{ type: 'text', text: 'hi' }] },
      { quiet: true },
    )
    expect(r).toMatchObject({
      text: 'สวัสดี',
      finishReason: 'waiting_approval',
      tokensIn: 10,
      tokensOut: 2,
    })
    expect(r.chargedMicro).toBe(1500n)
    expect(r.approvals).toEqual([{ id: 'ap1', tool: 'send_email', arguments: '{"to":"a@b.c"}' }])
    expect(lastAuth).toBe('Bearer hk_test')
    expect(JSON.parse(lastBody)).toEqual({ content: [{ type: 'text', text: 'hi' }] })
  })

  it('turns a 402 into a payment exit code', async () => {
    const api = createApi({ apiUrl: url, token: 'hk_test' })
    await expect(streamTurn(api, '/broke', {}, { quiet: true })).rejects.toMatchObject({
      exitCode: EXIT.payment,
      code: 'CREDITS_EXHAUSTED',
    })
  })

  it('refuses to run without a token', () => {
    expect(() => createApi({ apiUrl: url })).toThrow(/harness login/)
  })
})
