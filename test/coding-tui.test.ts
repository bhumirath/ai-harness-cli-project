import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { CodeTui } from '../src/coding/tui.ts'

function terminal(tty = true) {
  let output = ''
  return {
    stream: {
      isTTY: tty,
      columns: 72,
      write(text: string) {
        output += text
        return true
      },
    },
    text: () => stripVTControlCharacters(output),
  }
}

describe('coding terminal UI', () => {
  it('only enables the rich UI on an interactive terminal', () => {
    const tty = terminal(true)
    const pipe = terminal(false)
    expect(CodeTui.supported(tty.stream, false, false)).toBe(true)
    expect(CodeTui.supported(tty.stream, true, false)).toBe(false)
    expect(CodeTui.supported(tty.stream, false, true)).toBe(false)
    expect(CodeTui.supported(pipe.stream, false, false)).toBe(false)
  })

  it('renders workspace, tools, approval and the final usage summary', () => {
    const out = terminal()
    const ui = new CodeTui(out.stream)
    ui.header({
      workspace: '/work/project',
      backend: 'direct',
      model: 'test-model',
      approval: 'prompt',
      session: '00000000-0000-4000-8000-000000000000',
    })
    ui.progress({ type: 'tool', text: 'read_file {"path":"src/index.ts"}' })
    ui.progress({ type: 'result', text: 'read_file: done' })
    ui.progress({
      type: 'diff',
      text: '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,1 +1,1 @@\n-old\n+new',
    })
    ui.approval('run_command', { command: 'pnpm test' })
    ui.progress({ type: 'text', text: '**Fixed** the failing test.', final: true })
    ui.result({
      status: 'completed',
      steps: 3,
      changedFiles: ['src/index.ts'],
      summary: 'Fixed the failing test.',
      usage: { inputTokens: 1200, outputTokens: 300, chargedMicro: '250000' },
    })
    const rendered = out.text()
    expect(rendered).toContain('AI HARNESS')
    expect(rendered).toContain('/work/project')
    expect(rendered).toContain('session 00000000-0000-4000-8000-000000000000')
    expect(rendered).toContain('read_file')
    expect(rendered).toContain('src/index.ts')
    expect(rendered).toContain('Changes')
    expect(rendered).toContain('-old')
    expect(rendered).toContain('+new')
    expect(rendered).toContain('PERMISSION')
    expect(rendered).toContain('pnpm test')
    expect(rendered).toContain('Completed')
    expect(rendered).toContain('1,200 in / 300 out')
    expect(rendered).toContain('0.25 credits')
  })

  it('animates thinking without keeping the process alive and strips model escapes', () => {
    vi.useFakeTimers()
    const out = terminal()
    const ui = new CodeTui(out.stream)
    ui.progress({ type: 'status', text: 'Thinking' })
    vi.advanceTimersByTime(160)
    ui.progress({ type: 'text', text: '\u001b]52;c;clipboard\u0007safe' })
    ui.close()
    expect(out.text()).toContain('Thinking')
    expect(out.text()).toContain('safe')
    expect(out.text()).not.toContain('clipboard')
    vi.useRealTimers()
  })
})
