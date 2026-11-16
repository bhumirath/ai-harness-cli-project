import { stripVTControlCharacters } from 'node:util'
import pc from 'picocolors'

/** Terminal text cannot move the cursor, change the window title or write terminal clipboard data. */
function safe(text: string): string {
  // eslint-disable-next-line no-control-regex -- Deliberately remove terminal control characters.
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

function inline(text: string): string {
  // Tokenize code before emphasis so code samples remain literal.
  return text.replace(
    /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\(([^)]+)\)/g,
    (
      _all,
      code: string | undefined,
      bold: string | undefined,
      under: string | undefined,
      label: string | undefined,
      url: string | undefined,
    ) => {
      if (code !== undefined) return pc.cyan(code)
      if (bold !== undefined || under !== undefined) return pc.bold(bold ?? under ?? '')
      return `${pc.underline(label ?? '')} (${url ?? ''})`
    },
  )
}

/** A small, line-oriented Markdown renderer. Raw model text is retained separately by streamTurn. */
export class MarkdownStream {
  private pending = ''
  private fence: { marker: string; length: number } | undefined
  private longLine = false
  private readonly write: (text: string) => void
  constructor(write: (text: string) => void) {
    this.write = write
  }

  push(chunk: string): void {
    this.pending += chunk
    let newline: number
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      this.line(this.pending.slice(0, newline).replace(/\r$/, ''))
      this.write('\n')
      this.pending = this.pending.slice(newline + 1)
      this.longLine = false
    }
    // Long paragraphs must still make visible progress even without a newline.
    if (this.pending.length >= 8192) {
      this.write(safe(this.pending))
      this.pending = ''
      this.longLine = true
    }
  }

  flush(): void {
    if (this.pending) {
      this.line(this.pending)
      this.pending = ''
      this.longLine = true
    }
  }

  private line(raw: string): void {
    const text = safe(raw)
    if (this.longLine) {
      this.write(text)
      return
    }
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text)
    if (this.fence) {
      if (
        fence &&
        fence[1]![0] === this.fence.marker &&
        fence[1]!.length >= this.fence.length &&
        !fence[2]!.trim()
      ) {
        this.fence = undefined
      } else this.write(pc.cyan(text))
      return
    }
    if (fence) {
      this.fence = { marker: fence[1]![0]!, length: fence[1]!.length }
      if (fence[2]!.trim()) this.write(pc.dim(`[${fence[2]!.trim()}]`))
      return
    }
    const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(text)
    if (heading) {
      this.write(pc.bold(inline(heading[1]!)))
      return
    }
    const quote = /^ {0,3}>\s?(.*)$/.exec(text)
    if (quote) {
      this.write(pc.dim(`│ ${inline(quote[1]!)}`))
      return
    }
    this.write(inline(text.replace(/^(\s*)[-*+]\s+/, '$1• ')))
  }
}
