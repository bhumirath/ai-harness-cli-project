import { CODE_TOOLS, EDIT_TOOLS, READ_TOOLS } from './tools.ts'
import type { AgentMode } from './prompt.ts'
import type { ApprovalMode, CodeTool } from './types.ts'

export type Decision = 'allow' | 'ask' | 'deny'
export type PermissionCategory = 'read' | 'edit' | 'bash' | 'webfetch' | 'plan'

/** User-level permission settings (`codePermissions` in the CLI config file). */
export interface PermissionConfig {
  edit?: Decision
  bash?: Decision
  webfetch?: Decision
  /** Command patterns (`*` wildcard) that run without asking, e.g. "pnpm test*". */
  allowCommands?: string[]
  /** Command patterns that are always refused, even in auto mode. */
  denyCommands?: string[]
}

/** Answer from an interactive permission prompt. */
export type ConfirmAnswer = boolean | 'always'

export function toolCategory(name: string): PermissionCategory {
  if (READ_TOOLS.has(name)) return 'read'
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (name === 'web_fetch') return 'webfetch'
  if (name === 'todo_write') return 'plan'
  return 'bash' // run_command, git_diff and anything unknown
}

const decisions: Decision[] = ['allow', 'ask', 'deny']
const isDecision = (value: unknown): value is Decision => decisions.includes(value as Decision)
const SHELL_CONTROL = /[;&|`<>\n\r]|\$\(/

function commandPattern(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** Validates untrusted JSON from the config file; invalid entries are ignored. */
export function parsePermissionConfig(value: unknown): PermissionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const list = (item: unknown) =>
    Array.isArray(item)
      ? item.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
      : undefined
  return {
    ...(isDecision(raw.edit) ? { edit: raw.edit } : {}),
    ...(isDecision(raw.bash) ? { bash: raw.bash } : {}),
    ...(isDecision(raw.webfetch) ? { webfetch: raw.webfetch } : {}),
    ...(list(raw.allowCommands) ? { allowCommands: list(raw.allowCommands) } : {}),
    ...(list(raw.denyCommands) ? { denyCommands: list(raw.denyCommands) } : {}),
  }
}

/**
 * Per-tool permission policy for a coding session. Reads are always allowed; edits, commands and
 * web requests follow the approval mode, user configuration and "always allow" grants made in this
 * session. Model or tool output can never change it.
 */
export class Permissions {
  mode: ApprovalMode
  agent: AgentMode
  private readonly config: PermissionConfig
  private readonly granted = new Set<string>()

  constructor(mode: ApprovalMode, config: PermissionConfig = {}, agent: AgentMode = 'build') {
    this.mode = mode
    this.config = config
    this.agent = agent
  }

  /** Tools offered to the model: the plan agent never sees editing or command tools. */
  tools(): CodeTool[] {
    if (this.agent === 'build') return CODE_TOOLS
    return CODE_TOOLS.filter((tool) =>
      ['read', 'webfetch', 'plan'].includes(toolCategory(tool.function.name)),
    )
  }

  /** The key an "always allow" answer is remembered under. */
  grantKey(name: string, args: Record<string, unknown>): string {
    const category = toolCategory(name)
    if (category === 'edit') return 'edit'
    if (category === 'webfetch') {
      try {
        return `webfetch:${new URL(String(args.url)).host}`
      } catch {
        return 'webfetch:invalid'
      }
    }
    if (name === 'git_diff') return 'bash:git_diff'
    return `bash:${String(args.command ?? '').trim()}`
  }

  /** A human-readable description of what "always" grants, for the permission prompt. */
  grantLabel(name: string, args: Record<string, unknown>): string {
    const key = this.grantKey(name, args)
    if (key === 'edit') return 'all file edits'
    if (key.startsWith('webfetch:')) return `requests to ${key.slice('webfetch:'.length)}`
    if (key === 'bash:git_diff') return 'git diff'
    return 'this exact command'
  }

  grant(name: string, args: Record<string, unknown>): void {
    this.granted.add(this.grantKey(name, args))
  }

  check(name: string, args: Record<string, unknown>): Decision {
    const category = toolCategory(name)
    if (category === 'read' || category === 'plan') return 'allow'
    if (this.agent === 'plan' && category !== 'webfetch') return 'deny'
    if (category === 'bash' && name === 'run_command') {
      const command = String(args.command ?? '').trim()
      if (this.config.denyCommands?.some((pattern) => commandPattern(pattern).test(command)))
        return 'deny'
    }
    if (this.mode === 'read-only') return 'deny'
    if (this.mode === 'auto') return 'allow'
    if (this.granted.has(this.grantKey(name, args))) return 'allow'
    if (category === 'bash' && name === 'run_command') {
      const command = String(args.command ?? '').trim()
      // Patterns never approve compound commands, redirections or substitutions.
      if (
        !SHELL_CONTROL.test(command) &&
        this.config.allowCommands?.some((pattern) => commandPattern(pattern).test(command))
      )
        return 'allow'
    }
    const configured = this.config[category as 'edit' | 'bash' | 'webfetch']
    return configured ?? 'ask'
  }
}
