import { stripVTControlCharacters } from 'node:util'
import pc from 'picocolors'
import { MarkdownStream } from '../markdown.ts'
import { formatCredits } from '../output.ts'
import type { CodeResult, ProgressEvent } from './loop.ts'

interface TerminalOutput {
  readonly columns?: number
  readonly isTTY?: boolean
  write(text: string): unknown
}

export interface TuiHeader {
  workspace: string
  backend: string
  model: string
  approval: string
  agent?: string
  session?: string
}

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function clean(text: string): string {
  // eslint-disable-next-line no-control-regex -- Terminal control bytes must not reach the UI.
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

function compact(value: unknown, max = 100): string {
  const raw = clean(typeof value === 'string' ? value : JSON.stringify(value))
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** A scrollback-friendly coding UI: rich enough for humans, deterministic for logs and tests. */
export class CodeTui {
  private spinner: NodeJS.Timeout | undefined
  private frame = 0
  private status = ''
  private streaming = false
  private readonly output: TerminalOutput

  constructor(output: TerminalOutput) {
    this.output = output
  }

  static supported(output: TerminalOutput, json: boolean, plain: boolean): boolean {
    return Boolean(output.isTTY && !json && !plain)
  }

  header(info: TuiHeader): void {
    const permission =
      info.approval === 'prompt'
        ? 'ask before changes'
        : info.approval === 'read-only'
          ? 'read only'
          : 'auto approve'
    this.panel(`${pc.bold('AI HARNESS')} ${pc.dim('· CODE')}`, [
      `${pc.cyan('⌂')}  ${compact(info.workspace, this.width() - 8)}`,
      `${pc.magenta('◇')}  ${compact(info.model, this.width() - 8)}`,
      `${pc.green('●')}  ${info.backend}   ${pc.dim('·')}   ${permission}${info.agent ? `   ${pc.dim('·')}   ${info.agent} agent` : ''}`,
      ...(info.session ? [`${pc.blue('◫')}  session ${compact(info.session, 36)}`] : []),
    ])
    this.output.write(
      `  ${pc.dim('/help')} commands   ${pc.dim('Tab')} suggestions   ${pc.dim('Ctrl+C')} cancel\n`,
    )
  }

  prompt(): string {
    this.stopSpinner()
    return `\n${pc.bold(pc.cyan('harness'))} ${pc.bold('❯')} `
  }

  progress(event: ProgressEvent): void {
    if (event.type === 'status') {
      this.startSpinner(event.text)
      return
    }
    this.stopSpinner()
    if (event.type === 'delta') {
      this.streaming = true
      this.output.write(clean(event.text))
      return
    }
    if (this.streaming) {
      this.output.write('\n')
      this.streaming = false
    }
    if (event.type === 'tool') {
      const space = event.text.indexOf(' ')
      const name = space === -1 ? event.text : event.text.slice(0, space)
      let detail = space === -1 ? '' : event.text.slice(space + 1)
      try {
        const args = JSON.parse(detail) as Record<string, unknown>
        detail = compact(
          args.command ?? args.path ?? args.url ?? args.query ?? args.pattern ?? args,
          this.width() - name.length - 10,
        )
      } catch {
        detail = compact(detail, this.width() - name.length - 10)
      }
      const glyph = /^(read|list|search|grep|glob|git_diff|todo)/.test(name)
        ? pc.cyan('●')
        : /^(write|edit|multi_edit|apply_patch)/.test(name)
          ? pc.yellow('◆')
          : pc.magenta('▶')
      this.output.write(`  ${glyph} ${pc.bold(name)}${detail ? `  ${pc.dim(detail)}` : ''}\n`)
      return
    }
    if (event.type === 'result') {
      const failed = event.text.includes(': done') ? false : event.text.includes(': ')
      this.output.write(
        `  ${failed ? pc.red('×') : pc.green('✓')} ${pc.dim(compact(event.text))}\n`,
      )
      return
    }
    if (event.type === 'notice') {
      this.notice(event.text)
      return
    }
    if (event.type === 'todo') {
      this.output.write(`${pc.bold('  Plan')}\n`)
      for (const line of clean(event.text).split('\n')) {
        const rendered = line.startsWith('[x]')
          ? pc.green(line)
          : line.startsWith('[~]')
            ? pc.yellow(line)
            : pc.dim(line)
        this.output.write(`    ${rendered}\n`)
      }
      return
    }
    if (event.type === 'diff') {
      this.output.write(`${pc.bold('  Changes')}\n`)
      for (const line of clean(event.text).split('\n')) {
        const rendered = line.startsWith('+')
          ? pc.green(line)
          : line.startsWith('-')
            ? pc.red(line)
            : pc.dim(line)
        this.output.write(`  ${rendered}\n`)
      }
      return
    }
    if (event.text.trim()) {
      this.output.write('\n')
      const markdown = new MarkdownStream((text) => this.output.write(text))
      markdown.push(clean(event.text))
      markdown.flush()
      this.output.write('\n')
    }
  }

  approval(name: string, args: Record<string, unknown>): void {
    this.stopSpinner()
    const detail =
      name === 'git_diff'
        ? 'workspace git diff (repository filters may execute)'
        : compact(args.command ?? args.url ?? args.path ?? args, this.width() - 6)
    this.panel(
      `${pc.yellow('PERMISSION')} ${pc.dim('· review before continuing')}`,
      [`${pc.bold(name)}`, pc.dim(detail)],
      pc.yellow,
    )
  }

  result(result: CodeResult): void {
    this.stopSpinner()
    const ok = result.status === 'completed'
    const files = result.changedFiles.length ? result.changedFiles.join(', ') : '(none)'
    const charge = formatCredits(result.usage.chargedMicro)
    this.box(
      [
        `${ok ? pc.green('✓ Completed') : pc.red(`× ${result.status}`)}  ${pc.dim(`${result.steps} model turns`)}`,
        `${pc.dim('files')}   ${compact(files, this.width() - 12)}`,
        `${pc.dim('tokens')}  ${result.usage.inputTokens.toLocaleString()} in / ${result.usage.outputTokens.toLocaleString()} out    ${pc.dim('cost')} ${charge} credits`,
      ],
      ok ? pc.green : pc.red,
    )
  }

  notice(text: string): void {
    this.stopSpinner()
    this.output.write(`  ${pc.cyan('ℹ')} ${clean(text)}\n`)
  }

  finishTurn(): void {
    this.stopSpinner()
  }

  close(): void {
    this.stopSpinner()
  }

  private startSpinner(status: string): void {
    this.stopSpinner()
    this.status = clean(status)
    const draw = () => {
      this.output.write(
        `\r\u001b[2K${pc.cyan(frames[this.frame++ % frames.length]!)} ${pc.dim(this.status)}`,
      )
    }
    draw()
    this.spinner = setInterval(draw, 80)
    this.spinner.unref()
  }

  private stopSpinner(): void {
    if (!this.spinner) return
    clearInterval(this.spinner)
    this.spinner = undefined
    this.output.write('\r\u001b[2K')
  }

  private width(): number {
    return Math.max(48, Math.min(88, (this.output.columns ?? 80) - 2))
  }

  private box(lines: string[], color: (text: string) => string = pc.cyan): void {
    const width = this.width()
    const edge = color(`─`.repeat(width - 2))
    this.output.write(`${color('╭')}${edge}${color('╮')}\n`)
    for (const line of lines) {
      const visible = stripVTControlCharacters(line)
      const clipped = visible.length > width - 4 ? `${visible.slice(0, width - 5)}…` : line
      const pad = Math.max(0, width - 4 - stripVTControlCharacters(clipped).length)
      this.output.write(`${color('│')} ${clipped}${' '.repeat(pad)} ${color('│')}\n`)
    }
    this.output.write(`${color('╰')}${edge}${color('╯')}\n`)
  }

  private panel(title: string, lines: string[], color: (text: string) => string = pc.cyan): void {
    const width = this.width()
    const visibleTitle = stripVTControlCharacters(title)
    const remaining = Math.max(1, width - visibleTitle.length - 5)
    this.output.write(`${color('╭─')} ${title} ${color('─'.repeat(remaining))}${color('╮')}\n`)
    for (const line of lines) {
      const visible = stripVTControlCharacters(line)
      const clipped = visible.length > width - 4 ? `${visible.slice(0, width - 5)}…` : line
      const pad = Math.max(0, width - 4 - stripVTControlCharacters(clipped).length)
      this.output.write(`${color('│')} ${clipped}${' '.repeat(pad)} ${color('│')}\n`)
    }
    this.output.write(`${color('╰')}${color('─'.repeat(width - 2))}${color('╯')}\n`)
  }
}
