import type { Api } from '../api/client.ts'
import { unwrap } from '../api/client.ts'
import { CliError, EXIT } from '../api/errors.ts'
import { readSse } from '../api/sse.ts'
import type { CodeMessage, CodeProvider, CodeTool, CodeTurn } from './types.ts'

export function accountProvider(api: Api, model: string): CodeProvider {
  return {
    async turn(messages, tools, signal, onTextDelta) {
      const body = { modelRef: model, messages, tools, maxOutputTokens: 2048 }
      if (!onTextDelta)
        return unwrap(api.client.POST('/api/coding/turn', { body, signal }), api.settings.apiUrl)
      for await (const event of api.stream('/api/coding/stream', body, signal)) {
        if (event.event === 'delta') {
          const data = record(event.data)
          if (typeof data.text === 'string') onTextDelta(data.text)
        } else if (event.event === 'done') return event.data as CodeTurn
        else if (event.event === 'error') throw new CliError('Coding model request failed')
      }
      throw new CliError('Coding model stream ended without a final response')
    },
  }
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0)
export function directProvider(model: string, baseUrl: string, key?: string): CodeProvider {
  let url: URL
  try {
    url = new URL(baseUrl.replace(/\/+$/, '') + '/chat/completions')
  } catch {
    throw new CliError('Invalid direct provider base URL', { exitCode: EXIT.usage })
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new CliError(
      'Direct base URL must be HTTP(S), without embedded credentials/query/fragment',
      { exitCode: EXIT.usage },
    )
  return {
    async turn(
      messages: CodeMessage[],
      tools: CodeTool[],
      signal: AbortSignal,
      onTextDelta?: (text: string) => void,
    ): Promise<CodeTurn> {
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages,
            tools,
            max_tokens: 2048,
            stream: Boolean(onTextDelta),
            ...(onTextDelta ? { stream_options: { include_usage: true } } : {}),
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        })
      } catch {
        signal.throwIfAborted()
        throw new CliError('Cannot reach the direct model provider, or its request timed out')
      }
      if (!response.ok)
        throw new CliError(`Direct model request failed (HTTP ${response.status})`, {
          exitCode:
            response.status === 401 || response.status === 403
              ? EXIT.auth
              : response.status === 402
                ? EXIT.payment
                : EXIT.error,
        })
      if (!response.body) throw new CliError('Direct provider returned no response body')
      let raw: unknown
      if (onTextDelta && response.headers.get('content-type')?.includes('text/event-stream')) {
        let size = 0
        let content = ''
        let finishReason = 'stop'
        let usage: unknown = {}
        const calls = new Map<
          number,
          { id: string; type: 'function'; function: { name: string; arguments: string } }
        >()
        for await (const event of readSse(response.body)) {
          if (event.data === '[DONE]') break
          size += JSON.stringify(event.data).length
          if (size > 2_000_000) throw new CliError('Direct provider response exceeds 2 MB')
          const data = record(event.data)
          if (data.error) throw new CliError('Direct model stream failed')
          if (data.usage) usage = data.usage
          const choice = record(Array.isArray(data.choices) ? data.choices[0] : undefined)
          const delta = record(choice.delta)
          if (typeof delta.content === 'string') {
            content += delta.content
            onTextDelta(delta.content)
          }
          for (const item of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const part = record(item)
            const index = typeof part.index === 'number' ? part.index : 0
            const fn = record(part.function)
            const call = calls.get(index) ?? {
              id: '',
              type: 'function' as const,
              function: { name: '', arguments: '' },
            }
            if (typeof part.id === 'string') call.id = part.id
            if (typeof fn.name === 'string') call.function.name += fn.name
            if (typeof fn.arguments === 'string') call.function.arguments += fn.arguments
            calls.set(index, call)
          }
          if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
        }
        raw = {
          choices: [
            {
              message: {
                role: 'assistant',
                content: content || null,
                ...(calls.size
                  ? {
                      tool_calls: [...calls.entries()]
                        .sort(([a], [b]) => a - b)
                        .map(([, call]) => call),
                    }
                  : {}),
              },
              finish_reason: finishReason,
            },
          ],
          usage,
        }
      } else {
        const reader = response.body.getReader()
        const parts: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            const item = await reader.read()
            if (item.done) break
            size += item.value.byteLength
            if (size > 2_000_000) {
              await reader.cancel()
              throw new CliError('Direct provider response exceeds 2 MB')
            }
            parts.push(item.value)
          }
        } finally {
          reader.releaseLock()
        }
        try {
          raw = JSON.parse(Buffer.concat(parts).toString('utf8'))
        } catch {
          throw new CliError('Direct provider returned invalid JSON')
        }
      }
      const data = record(raw)
      const choice = record(Array.isArray(data.choices) ? data.choices[0] : undefined)
      const source = record(choice.message)
      if (
        source.role !== 'assistant' ||
        (source.content !== null &&
          typeof source.content !== 'string' &&
          source.content !== undefined)
      )
        throw new CliError('Direct provider returned an invalid assistant message')
      const message: CodeMessage = {
        role: 'assistant',
        content: typeof source.content === 'string' ? source.content : null,
      }
      if (source.tool_calls !== undefined) {
        if (!Array.isArray(source.tool_calls) || source.tool_calls.length > 16)
          throw new CliError('Direct provider returned invalid tool calls')
        message.tool_calls = source.tool_calls.map((rawCall) => {
          const call = record(rawCall)
          const fn = record(call.function)
          if (
            typeof call.id !== 'string' ||
            !call.id ||
            call.id.length > 200 ||
            call.type !== 'function' ||
            typeof fn.name !== 'string' ||
            !fn.name ||
            fn.name.length > 100 ||
            typeof fn.arguments !== 'string' ||
            fn.arguments.length > 120000
          )
            throw new CliError('Direct provider returned an invalid tool call')
          return {
            id: call.id,
            type: 'function',
            function: { name: fn.name, arguments: fn.arguments },
          }
        })
      }
      const usage = record(data.usage)
      const details = record(usage.prompt_tokens_details)
      return {
        message,
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
        usage: {
          inputTokens: count(usage.prompt_tokens),
          outputTokens: count(usage.completion_tokens),
          cachedInputTokens: count(details.cached_tokens),
        },
        chargedMicro: '0',
      }
    },
  }
}
