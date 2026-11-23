import { CliError, EXIT } from '../api/errors.ts'
import { CODE_TOOLS, MUTATING_TOOLS, WorkspaceTools, knownTool, type TodoItem } from './tools.ts'
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
  confirm?: (name: string, args: Record<string, unknown>) => Promise<boolean>
  progress?: (event: ProgressEvent) => void
}
export interface ProgressEvent {
  type: 'status' | 'delta' | 'text' | 'tool' | 'result' | 'diff' | 'todo'
  text: string
  final?: boolean
}
const TODO_MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]', cancelled: '[-]' }
export function formatTodos(todos: TodoItem[]): string {
  return todos.map((todo) => `${TODO_MARK[todo.status]} ${todo.content}`).join('\n')
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
  try {
    for (let step = 0; step < options.maxSteps; step++) {
      options.signal.throwIfAborted()
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
      const turn = await provider.turn(messages, CODE_TOOLS, options.signal, (text) => {
        streamed = true
        options.progress?.({ type: 'delta', text })
      })
      turn.message = sanitize(turn.message)
      options.signal.throwIfAborted()
      result.steps++
      result.usage.inputTokens += turn.usage.inputTokens
      result.usage.outputTokens += turn.usage.outputTokens
      result.usage.chargedMicro = (
        BigInt(result.usage.chargedMicro) + BigInt(turn.chargedMicro)
      ).toString()
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
          options.progress?.({
            type: 'tool',
            text: `${call.function.name} ${JSON.stringify(args).slice(0, 1000)}`,
          })
          let allowed = true
          if (MUTATING_TOOLS.has(call.function.name))
            allowed =
              options.approval === 'auto' ||
              (options.approval === 'prompt' &&
                Boolean(await options.confirm?.(call.function.name, args)))
          output = allowed
            ? await workspace.execute(call.function.name, args, options.signal)
            : {
                ok: false,
                error:
                  'Action denied by local approval policy; do not retry without user permission',
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
      }
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
