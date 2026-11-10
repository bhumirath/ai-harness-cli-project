export interface RawSseEvent {
  event: string
  data: string
}

/** Incremental SSE parser (WHATWG event-stream): CRLF, multi-line data, comments, split chunks. */
export class SseParser {
  private buffer = ''
  private event = ''
  private data: string[] = []
  private readonly onEvent: (e: RawSseEvent) => void

  constructor(onEvent: (e: RawSseEvent) => void) {
    this.onEvent = onEvent
  }

  push(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.nextLineEnd()) !== -1) {
      const skip = this.buffer[idx] === '\r' && this.buffer[idx + 1] === '\n' ? 2 : 1
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + skip)
      this.line(line)
    }
  }

  private nextLineEnd(): number {
    const n = this.buffer.indexOf('\n')
    const r = this.buffer.indexOf('\r')
    if (r === -1) return n
    // a lone '\r' at the very end may be the first half of '\r\n' — wait for more input
    if (r === this.buffer.length - 1) return n === -1 ? -1 : Math.min(n, r)
    return n === -1 ? r : Math.min(n, r)
  }

  end(): void {
    if (this.buffer) this.line(this.buffer)
    this.buffer = ''
    this.dispatch()
  }

  private line(line: string): void {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.event = value
    else if (field === 'data') this.data.push(value)
  }

  private dispatch(): void {
    if (this.data.length)
      this.onEvent({ event: this.event || 'message', data: this.data.join('\n') })
    this.event = ''
    this.data = []
  }
}

/** Chat stream events — docs/04-api-contract.md ("SSE events"). */
export type ChatStreamEvent =
  | { event: 'message.created'; data: { userMessageId: string | null; assistantMessageId: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'tool_call'; data: { id: string; name: string; arguments: unknown } }
  | { event: 'tool_result'; data: { id: string; name?: string; ok: boolean; summary?: string } }
  | {
      event: 'approval_required'
      data: { approvals: { id: string; tool: string; arguments: string }[] }
    }
  | { event: 'usage'; data: { tokensIn: number; tokensOut: number; chargedMicro: string } }
  | { event: 'done'; data: { finishReason: string } }
  | { event: 'error'; data: { code: string; message: string } }
  | { event: string; data: unknown }

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const queue: RawSseEvent[] = []
  const parser = new SseParser((e) => queue.push(e))
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) parser.end()
      else parser.push(value)
      while (queue.length) {
        const raw = queue.shift()!
        let data: unknown = raw.data
        try {
          data = JSON.parse(raw.data)
        } catch {
          // keep text
        }
        yield { event: raw.event, data } as ChatStreamEvent
      }
      if (done) return
    }
  } finally {
    reader.releaseLock()
  }
}
