import type { components } from '../api/schema.d.ts'
export type CodeMessage = components['schemas']['CodingMessageDto']
export type CodeTool = components['schemas']['CodingToolDefinitionDto']
export type CodeTurn = components['schemas']['CodingTurnResponseDto']
export interface CodeProvider {
  turn(
    messages: CodeMessage[],
    tools: CodeTool[],
    signal: AbortSignal,
    onTextDelta?: (text: string) => void,
  ): Promise<CodeTurn>
}
export type ApprovalMode = 'prompt' | 'auto' | 'read-only'
export interface ToolResult {
  ok: boolean
  [key: string]: unknown
}
