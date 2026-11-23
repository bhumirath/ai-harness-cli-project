import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspaceTools } from './tools.ts'

export interface SlashCommandInfo {
  name: string
  usage: string
  description: string
}

export const BUILTIN_COMMANDS: SlashCommandInfo[] = [
  { name: '/model', usage: '/model [id]', description: 'choose and remember a coding model' },
  {
    name: '/permission',
    usage: '/permission [mode]',
    description: 'choose prompt, read-only, or auto (alias /approval)',
  },
  { name: '/approval', usage: '', description: '' },
  { name: '/plan', usage: '/plan', description: 'switch to the read-only plan agent' },
  {
    name: '/build',
    usage: '/build',
    description: 'switch to the build agent (edits and commands)',
  },
  {
    name: '/undo',
    usage: '/undo [--force]',
    description: "revert the agent's file edits from the last turn",
  },
  { name: '/redo', usage: '/redo [--force]', description: 're-apply the last undone edits' },
  { name: '/diff', usage: '/diff', description: 'show the current workspace Git diff' },
  {
    name: '/compact',
    usage: '/compact',
    description: 'summarize older conversation to free context',
  },
  { name: '/init', usage: '/init', description: 'create or improve AGENTS.md for this project' },
  { name: '/session', usage: '/session', description: 'show the current resumable session' },
  { name: '/sessions', usage: '/sessions', description: 'list saved coding sessions' },
  { name: '/new', usage: '/new', description: 'start a new conversation (clears context)' },
  { name: '/help', usage: '/help', description: 'show this command list' },
  { name: '/exit', usage: '/exit', description: 'leave coding mode (alias /quit)' },
  { name: '/quit', usage: '', description: '' },
]

export interface CustomCommand {
  name: string
  description: string
  template: string
  source: 'project' | 'user'
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/i
const MAX_TEMPLATE = 20_000

/** Splits optional `---` front matter (only `description:` is used) from the template body. */
export function parseCommandFile(text: string): { description: string; template: string } {
  const normalized = text.replace(/^﻿/, '').replaceAll('\r\n', '\n')
  const match = /^---\n([\s\S]*?)\n?---(?:\n|$)([\s\S]*)$/.exec(normalized)
  if (!match) return { description: '', template: normalized.trim() }
  const description = /^description:\s*(.+)$/m.exec(match[1]!)?.[1]?.trim() ?? ''
  return { description: description.replace(/^["']|["']$/g, ''), template: match[2]!.trim() }
}

/** Substitutes `$ARGUMENTS` (all arguments) and `$1`..`$9` (whitespace-separated arguments). */
export function expandTemplate(template: string, args: string): string {
  const parts = args.trim() ? args.trim().split(/\s+/) : []
  let used = false
  const expanded = template
    .replace(/\$ARGUMENTS/g, () => {
      used = true
      return args.trim()
    })
    .replace(/\$([1-9])/g, (_m, index: string) => {
      used = true
      return parts[Number(index) - 1] ?? ''
    })
  return !used && args.trim() ? `${expanded}\n\n${args.trim()}` : expanded
}

async function loadDirectory(
  directory: string,
  source: 'project' | 'user',
  read: (file: string) => Promise<string | undefined>,
): Promise<CustomCommand[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const commands: CustomCommand[] = []
  for (const file of names.sort()) {
    if (!file.endsWith('.md')) continue
    const name = file.slice(0, -3)
    if (!NAME.test(name)) continue
    const text = await read(path.join(directory, file)).catch(() => undefined)
    if (text === undefined || text.length > MAX_TEMPLATE) continue
    const parsed = parseCommandFile(text)
    if (!parsed.template) continue
    commands.push({ name: `/${name}`, ...parsed, source })
  }
  return commands
}

/**
 * Loads custom commands from `<workspace>/.harness/commands/*.md` and the user's
 * `<config dir>/commands/*.md`. Project commands win over user commands; built-ins cannot be
 * overridden. Commands only produce prompt text; they cannot change permissions.
 */
export async function loadCustomCommands(
  workspace: WorkspaceTools,
  userDirectory?: string,
): Promise<CustomCommand[]> {
  const builtins = new Set(BUILTIN_COMMANDS.map((command) => command.name))
  const project = await loadDirectory(
    path.join(workspace.root, '.harness', 'commands'),
    'project',
    (file) => workspace.readText(path.relative(workspace.root, file)),
  )
  const user = userDirectory
    ? await loadDirectory(userDirectory, 'user', (file) => readFile(file, 'utf8'))
    : []
  const result = new Map<string, CustomCommand>()
  for (const command of [...user, ...project])
    if (!builtins.has(command.name)) result.set(command.name, command)
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function helpText(custom: CustomCommand[] = []): string {
  const rows = BUILTIN_COMMANDS.filter((command) => command.usage).map(
    (command) => `  ${command.usage.padEnd(20)} ${command.description}`,
  )
  const customRows = custom.map(
    (command) =>
      `  ${command.name.padEnd(20)} ${command.description || `custom ${command.source} command`}`,
  )
  return `\nCommands:\n${rows.join('\n')}\n${customRows.length ? `\nCustom commands:\n${customRows.join('\n')}\n` : ''}\nMention files with @path to attach them. Resume later with: harness code --resume <session-id>\nTip: type part of a command and press Tab to complete it.\n`
}

export const INIT_PROMPT = `Analyze this codebase and create an AGENTS.md file at the workspace root for future coding agents (or improve the existing AGENTS.md/CLAUDE.md content without losing project-specific rules). Include, in about 20-40 concise lines:
1. Build, lint, type-check and test commands, especially how to run a single test.
2. Code style: imports, formatting, types, naming, error handling and other conventions you can verify in the code.
3. A short architecture overview of the main directories.
Inspect package manifests, configuration files, existing docs and representative source files first; do not invent commands that do not exist. If AGENTS.md exists, read it before editing.`
