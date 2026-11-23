import { CliError, EXIT } from '../api/errors.ts'
import { WorkspaceTools, knownTool, type TodoItem } from './tools.ts'
import { compactMessages, needsCompaction } from './context.ts'
import { Permissions, toolCategory, type ConfirmAnswer } from './permissions.ts'
import type { ApprovalMode, CodeMessage, CodeProvider, ToolResult } from './types.ts'

export interface CodeResult {
  status: 'completed' | 'max_steps' | 'canceled' | 'failed'
  error?: string
  exitCode?: number
  steps: number
  changedFiles: string[]
  summary: string
  usage: { inputTokens: number; outputTokens: number; chargedMicro: string }
}
export interface RunOptions {
  maxSteps: number
  signal: AbortSignal
  approval: ApprovalMode
  /** Session permission policy; defaults to one derived from `approval`. */
  permissions?: Permissions
  confirm?: (name: string, args: Record<string, unknown>) => Promise<ConfirmAnswer>
  /**
   * Project check command (type checker/linter) run after steps that edited files; its result is
   * attached to the last edit result. It needs command permission like any other command.
   */
  checkCommand?: string
  /** Model context window in tokens; older history is summarized near the limit (default 128k). */
  contextTokens?: number
  progress?: (event: ProgressEvent) => void
}
export interface ProgressEvent {
  type: 'status' | 'delta' | 'text' | 'tool' | 'result' | 'diff' | 'todo' | 'notice'
  text: string
  final?: boolean
}
const TODO_MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]', cancelled: '[-]' }
export function formatTodos(todos: TodoItem[]): string {
  return todos.map((todo) => `${TODO_MARK[todo.status]} ${todo.content}`).join('\n')
}
function addUsage(
  result: CodeResult,
  usage: { inputTokens: number; outputTokens: number; chargedMicro: string },
): void {
  result.usage.inputTokens += usage.inputTokens
  result.usage.outputTokens += usage.outputTokens
  result.usage.chargedMicro = (
    BigInt(result.usage.chargedMicro) + BigInt(usage.chargedMicro)
  ).toString()
}
export async function codingRun(
  provider: CodeProvider,
  workspace: WorkspaceTools,
  messages: CodeMessage[],
  options: RunOptions,
): Promise<CodeResult> {
  const result: CodeResult = {
    status: 'max_steps',
    steps: 0,
    changedFiles: [],
    summary: '',
    usage: { inputTokens: 0, outputTokens: 0, chargedMicro: '0' },
  }
  const permissions = options.permissions ?? new Permissions(options.approval)
  let lastInputTokens = 0
  let checkDisabled = false
  /** Runs the check command and attaches diagnostics; returns false when permission is denied. */
  const runCheck = async (target: CodeMessage): Promise<boolean> => {
    const args = { command: options.checkCommand!, timeoutMs: 300_000 }
    let decision = permissions.check('run_command', args)
    if (decision === 'ask') {
      const answer = await options.confirm?.('run_command', args)
      if (answer === 'always') permissions.grant('run_command', args)
      decision = answer ? 'allow' : 'deny'
    }
    if (decision !== 'allow') {
      options.progress?.({ type: 'notice', text: 'Post-edit check skipped for this run.' })
      return false
    }
    options.progress?.({ type: 'tool', text: `check ${JSON.stringify({ command: args.command })}` })
    const check = await workspace.execute('run_command', args, options.signal)
    options.progress?.({
      type: 'result',
      text: check.ok ? 'check: done' : `check: failed (exit ${String(check.exitCode)})`,
    })
    const output = `${String(check.stdout ?? '')}${String(check.stderr ?? check.error ?? '')}`
    let previous: Record<string, unknown> = {}
    try {
      previous = JSON.parse(target.content ?? '{}') as Record<string, unknown>
    } catch {
      /* keep an empty object */
    }
    target.content = workspace.stringify({
      ...previous,
      diagnostics: {
        command: args.command,
        ok: check.ok,
        exitCode: check.exitCode,
        output: output.length > 6000 ? `…${output.slice(-6000)}` : output,
        note: check.ok
          ? 'Project check passed after this step.'
          : 'Project check failed after this step; fix the reported problems.',
      },
    })
    return true
  }
  try {
    for (let step = 0; step < options.maxSteps; step++) {
      options.signal.throwIfAborted()
      if (
        needsCompaction(
          messages,
          { contextTokens: options.contextTokens ?? 128_000 },
          lastInputTokens,
        )
      ) {
        options.progress?.({ type: 'status', text: 'Compacting conversation' })
        try {
          const compaction = await compactMessages(provider, messages, options.signal, {
            todos: formatTodos(workspace.todos),
          })
          addUsage(result, compaction.usage)
          if (compaction.compacted) {
            lastInputTokens = 0
            options.progress?.({
              type: 'notice',
              text: `Compacted ${compaction.removed} earlier messages into a summary to stay within the model context.`,
            })
          }
        } catch (error) {
          options.signal.throwIfAborted()
          options.progress?.({
            type: 'notice',
            text: `Compaction failed (${error instanceof Error ? error.message : 'error'}); truncating older tool output instead.`,
          })
        }
      }
      // Keep tool-call/result pairs intact; compress older tool content before exceeding the API cap.
      if (JSON.stringify(messages).length > 180000) {
        for (const message of messages.slice(0, -12))
          if (message.role === 'tool' && (message.content?.length ?? 0) > 800) {
            let previous: Record<string, unknown> = {}
            try {
              previous = JSON.parse(message.content!) as Record<string, unknown>
            } catch {
              /* legacy plain tool output */
            }
            message.content =
              Array.isArray(previous.instructions) && previous.instructions.length
                ? workspace.stringify({
                    ok: previous.ok,
                    path: previous.path,
                    instructions: previous.instructions,
                    content: '[older file output truncated]',
                  })
                : message.content!.slice(0, 700) + '\n[older tool output truncated]'
          }
      }
      if (messages.length > 190 || Buffer.byteLength(JSON.stringify(messages)) > 700000)
        throw new CliError('Coding context limit reached; start a new task')
      const sanitize = (message: CodeMessage): CodeMessage => ({
        ...message,
        content: typeof message.content === 'string' ? workspace.redact(message.content) : null,
        ...(message.tool_calls
          ? {
              tool_calls: message.tool_calls.map((call) => ({
                ...call,
                function: {
                  ...call.function,
                  arguments: workspace.redact(call.function.arguments),
                },
              })),
            }
          : {}),
      })
      messages.splice(0, messages.length, ...messages.map(sanitize))
      options.progress?.({ type: 'status', text: `Thinking · turn ${step + 1}` })
      let streamed = false
      const tools = permissions.tools()
      const turn = await provider.turn(messages, tools, options.signal, (text) => {
        streamed = true
        options.progress?.({ type: 'delta', text })
      })
      turn.message = sanitize(turn.message)
      options.signal.throwIfAborted()
      result.steps++
      lastInputTokens = turn.usage.inputTokens
      addUsage(result, { ...turn.usage, chargedMicro: turn.chargedMicro })
      if (turn.message.role !== 'assistant')
        throw new CliError('Model did not return an assistant turn')
      messages.push(turn.message)
      if (turn.message.content) {
        result.summary = turn.message.content
        if (!streamed)
          options.progress?.({
            type: 'text',
            text: turn.message.content,
            final: !turn.message.tool_calls?.length,
          })
      }
      const calls = turn.message.tool_calls ?? []
      if (!calls.length) {
        if (
          ['length', 'content_filter', 'error'].includes(turn.finishReason) ||
          !turn.message.content?.trim()
        )
          throw new CliError(`Model did not finish a complete response (${turn.finishReason})`)
        result.status = 'completed'
        return result
      }
      if (calls.length > 16) throw new CliError('Too many model tool calls in one step')
      const ids = new Set<string>()
      let lastEdit: CodeMessage | undefined
      for (const call of calls) {
        options.signal.throwIfAborted()
        if (ids.has(call.id)) throw new CliError('Model returned duplicate tool call ids')
        ids.add(call.id)
        let output: ToolResult
        let args: Record<string, unknown> = {}
        try {
          const parsed: unknown = JSON.parse(call.function.arguments)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('Tool arguments must be a JSON object')
          args = parsed as Record<string, unknown>
          const known = knownTool(call.function.name)
          if (!known) throw new Error('Unknown coding tool')
          if (
            !tools.some((tool) => tool.function.name === call.function.name) &&
            call.function.name !== 'search_files'
          )
            throw new Error(
              `${call.function.name} is not available in ${permissions.agent} mode; the user can switch with /build`,
            )
          options.progress?.({
            type: 'tool',
            text: `${call.function.name} ${JSON.stringify(args).slice(0, 1000)}`,
          })
          let decision = permissions.check(call.function.name, args)
          if (decision === 'ask') {
            const answer = await options.confirm?.(call.function.name, args)
            if (answer === 'always') permissions.grant(call.function.name, args)
            decision = answer ? 'allow' : 'deny'
          }
          output =
            decision === 'allow'
              ? await workspace.execute(call.function.name, args, options.signal)
              : {
                  ok: false,
                  error:
                    permissions.agent === 'plan' && toolCategory(call.function.name) !== 'webfetch'
                      ? 'Plan mode is read-only; describe the change instead. The user can switch with /build'
                      : 'Action denied by local approval policy; do not retry without user permission',
                }
        } catch (error) {
          options.signal.throwIfAborted()
          output = {
            ok: false,
            error: error instanceof Error ? error.message : 'Invalid tool request',
          }
        }
        options.progress?.({
          type: 'result',
          text: output.ok
            ? `${call.function.name}: done`
            : `${call.function.name}: ${String(output.error)}`,
        })
        if (output.ok && typeof output.diff === 'string')
          options.progress?.({ type: 'diff', text: output.diff })
        if (output.ok && call.function.name === 'todo_write')
          options.progress?.({ type: 'todo', text: formatTodos(workspace.todos) })
        const serialized = workspace.stringify(output)
        messages.push({
          role: 'tool',
          content:
            serialized.length > 64000
              ? workspace.stringify({
                  ok: output.ok,
                  truncated: true,
                  instructions: output.instructions,
                  preview: serialized.slice(0, 30000),
                })
              : serialized,
          tool_call_id: call.id,
        })
        if (output.ok && toolCategory(call.function.name) === 'edit') lastEdit = messages.at(-1)
      }
      if (lastEdit && options.checkCommand && !checkDisabled)
        checkDisabled = !(await runCheck(lastEdit))
    }
    return result
  } catch (error) {
    if (options.signal.aborted) {
      result.status = 'canceled'
      return result
    }
    result.status = 'failed'
    result.error = error instanceof Error ? error.message : 'Coding execution failed'
    result.exitCode = error instanceof CliError ? error.exitCode : EXIT.error
    return result
  } finally {
    result.changedFiles = [...workspace.changedFiles].sort()
  }
}
