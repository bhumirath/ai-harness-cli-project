import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { globToRegExp } from './glob.ts'
import { findRipgrep, matchLines, ripgrepSearch, searchRegExp, type SearchMatch } from './search.ts'
import type { CodeTool, ToolResult } from './types.ts'
import { webFetch, type FetchOptions } from './webfetch.ts'

const SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.venv',
  'vendor',
  '.pnpm-store',
  '.aws',
  '.ssh',
  '.gnupg',
])
const MAX_FILE = 1_000_000
const MAX_OUTPUT = 32_000
const MAX_LINE = 2_000
const MAX_DIFF_LINES = 80
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const string = (args: Record<string, unknown>, name: string) => {
  if (typeof args[name] !== 'string') throw new Error(`${name} must be a string`)
  return args[name] as string
}
const integer = (value: unknown, fallback: number, max: number) => {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max)
    throw new Error(`Expected an integer from 1 to ${max}`)
  return value as number
}
export function diffPreview(file: string, before: string, after: string): string {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
    start++
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const removed = oldLines.slice(start, oldEnd).map((line) => `-${line}`)
  const added = newLines.slice(start, newEnd).map((line) => `+${line}`)
  const changed = [...removed, ...added]
  const visible = changed.slice(0, MAX_DIFF_LINES)
  if (changed.length > visible.length)
    visible.push(`… ${changed.length - visible.length} more changed lines`)
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...visible,
  ].join('\n')
}
function applyTextPatch(content: string, rawPatch: string, expectedPath: string): string {
  if (!rawPatch.trim() || rawPatch.length > 200_000 || rawPatch.includes('\0'))
    throw new Error('Patch must be 1..200000 characters of text')
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = rawPatch.replaceAll('\r\n', '\n').split('\n')
  if (lines[0]?.trim() === '*** Begin Patch') lines.shift()
  if (lines.at(-1)?.trim() === '*** End Patch') lines.pop()
  if (lines.at(-1) === '') lines.pop()
  if (lines[0]?.startsWith('*** Update File:')) {
    const declared = lines.shift()!.slice('*** Update File:'.length).trim().replaceAll('\\', '/')
    if (declared !== expectedPath.replaceAll('\\', '/'))
      throw new Error('Patch path does not match path argument')
  }
  const hunks: { before: string[]; after: string[] }[] = []
  let hunk: { before: string[]; after: string[] } | undefined
  for (const line of lines) {
    if (line.startsWith('@@')) {
      hunk = { before: [], after: [] }
      hunks.push(hunk)
      continue
    }
    if (!hunk) throw new Error('Patch must start with an @@ hunk header')
    if (line === '\\ No newline at end of file') continue
    const marker = line[0]
    if (![' ', '+', '-'].includes(marker ?? ''))
      throw new Error('Each patch line must start with space, +, or -')
    const value = line.slice(1)
    if (marker !== '+') hunk.before.push(value)
    if (marker !== '-') hunk.after.push(value)
  }
  if (!hunks.length || hunks.some((item) => item.before.length === 0))
    throw new Error('Patch needs at least one context or removed line per hunk')
  const output = content.split(/\r?\n/)
  for (const item of hunks) {
    const matches: number[] = []
    for (let index = 0; index <= output.length - item.before.length; index++)
      if (item.before.every((line, offset) => output[index + offset] === line)) matches.push(index)
    if (matches.length !== 1)
      throw new Error(
        matches.length === 0
          ? 'Patch context was not found; read the file again'
          : 'Patch context is ambiguous; include more surrounding lines',
      )
    output.splice(matches[0]!, item.before.length, ...item.after)
  }
  return output.join(newline)
}
const definition = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): CodeTool => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  },
})
const text = { type: 'string' }
const number = { type: 'integer', minimum: 1 }
const bool = { type: 'boolean' }
export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const
export interface TodoItem {
  content: string
  status: (typeof TODO_STATUSES)[number]
}
export const CODE_TOOLS: CodeTool[] = [
  definition(
    'list_files',
    'List one workspace directory. Dependency and Git directories are excluded. Use glob to find files recursively.',
    { path: text },
  ),
  definition(
    'read_file',
    'Read numbered text lines (default first 400 lines, at most 2000 per call; long lines are cut). Returns the file hash for optimistic writes, totalLines, and nextStartLine when more content remains.',
    { path: text, startLine: number, endLine: number },
    ['path'],
  ),
  definition(
    'grep',
    'Search file contents with a regular expression (ripgrep when installed). Returns path, line and text for each match. Use literal=true for plain text, include to filter files by glob (for example "*.ts" or "src/**/*.{ts,tsx}").',
    { pattern: text, path: text, include: text, ignoreCase: bool, literal: bool },
    ['pattern'],
  ),
  definition(
    'glob',
    'Find files by glob pattern (for example "**/*.test.ts"), newest first. Dependency, Git and secret files are excluded.',
    { pattern: text, path: text },
    ['pattern'],
  ),
  definition(
    'write_file',
    'Create a text file, or replace an existing file only with its current expectedHash from read_file. Use for new files or full rewrites.',
    { path: text, content: text, expectedHash: text },
    ['path', 'content'],
  ),
  definition(
    'edit_file',
    'Replace exactly one occurrence of oldText with newText (or every occurrence with replaceAll=true); fails if missing or ambiguous. oldText must match the file exactly, including indentation.',
    { path: text, oldText: text, newText: text, replaceAll: bool },
    ['path', 'oldText', 'newText'],
  ),
  definition(
    'multi_edit',
    'Apply several exact-text edits to one file atomically, in order; each edit works like edit_file on the result of the previous one. Nothing is written if any edit fails.',
    {
      path: text,
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          properties: { oldText: text, newText: text, replaceAll: bool },
          required: ['oldText', 'newText'],
          additionalProperties: false,
        },
      },
    },
    ['path', 'edits'],
  ),
  definition(
    'apply_patch',
    'Safely apply one or more line hunks to an existing text file after read_file. Use patch lines prefixed with space (context), - (remove), or + (add), and start every hunk with @@. This is preferred for focused code edits.',
    { path: text, expectedHash: text, patch: text },
    ['path', 'expectedHash', 'patch'],
  ),
  definition(
    'run_command',
    'Run a shell command after permission (default timeout 120000 ms, max 600000). cwd is a workspace-relative directory. Long output keeps its beginning and end. Inspect exitCode/output and fix failures. Avoid interactive commands.',
    { command: text, cwd: text, timeoutMs: { ...number, maximum: 600000 } },
    ['command'],
  ),
  definition(
    'git_diff',
    'Run bounded Git diff after command approval; repository filters may execute code.',
    {},
  ),
  definition(
    'web_fetch',
    'Fetch a public http(s) URL (documentation, issues, APIs) after permission. HTML is converted to text unless format is "html". Private and loopback addresses are refused; content is truncated to 60000 characters.',
    { url: text, format: { type: 'string', enum: ['text', 'markdown', 'html'] } },
    ['url'],
  ),
  definition(
    'todo_write',
    'Create or update the task plan for multi-step work. Send the complete list every time; keep exactly one item in_progress while working and mark items completed as soon as they are done.',
    {
      todos: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          properties: {
            content: text,
            status: { type: 'string', enum: [...TODO_STATUSES] },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    ['todos'],
  ),
]
/** Tools that read the workspace only. */
export const READ_TOOLS = new Set(['list_files', 'read_file', 'grep', 'glob', 'search_files'])
/** Tools that change files in the workspace. */
export const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch'])
export const MUTATING_TOOLS = new Set([...EDIT_TOOLS, 'run_command', 'git_diff', 'web_fetch'])
/** Executable but not advertised: kept for older transcripts and scripts. */
const LEGACY_TOOLS = new Set(['search_files'])
export const knownTool = (name: string) =>
  LEGACY_TOOLS.has(name) || CODE_TOOLS.some((tool) => tool.function.name === name)

const PROTECTED_NAMES = new Set([
  '.git',
  '.aws',
  '.ssh',
  '.gnupg',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.credentials.json',
])
/** Git metadata and common secret-file names that file tools never read or write. */
export const protectedSegment = (segment: string) =>
  PROTECTED_NAMES.has(segment) ||
  /^\.env(?:\.|$)|^id_(?:rsa|ed25519)$|\.(?:pem|key)$/i.test(segment)

/** Applies exact-text edits in order; throws without partial results when any edit fails. */
export function applyTextEdits(
  content: string,
  edits: { oldText: string; newText: string; replaceAll?: boolean }[],
): string {
  let output = content
  edits.forEach((edit, index) => {
    const label = edits.length > 1 ? `Edit ${index + 1}: ` : ''
    if (!edit.oldText) throw new Error(`${label}oldText must not be empty`)
    if (edit.oldText === edit.newText) throw new Error(`${label}oldText and newText are identical`)
    const first = output.indexOf(edit.oldText)
    if (first < 0)
      throw new Error(
        `${label}oldText was not found; read the file again and match whitespace exactly`,
      )
    if (edit.replaceAll) output = output.replaceAll(edit.oldText, () => edit.newText)
    else {
      if (output.indexOf(edit.oldText, first + 1) >= 0)
        throw new Error(
          `${label}oldText must match exactly once; include more surrounding text or use replaceAll`,
        )
      output = output.slice(0, first) + edit.newText + output.slice(first + edit.oldText.length)
    }
  })
  return output
}

function parseEdits(value: unknown): { oldText: string; newText: string; replaceAll: boolean }[] {
  if (!Array.isArray(value) || !value.length || value.length > 50)
    throw new Error('edits must be an array of 1..50 items')
  return value.map((item: unknown) => {
    const edit = item as Record<string, unknown> | null
    if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string')
      throw new Error('Each edit needs string oldText and newText')
    return { oldText: edit.oldText, newText: edit.newText, replaceAll: edit.replaceAll === true }
  })
}

/** Keeps the beginning and the end of long process output, where errors and summaries live. */
export class BoundedOutput {
  private head = ''
  private tail = ''
  private omitted = 0
  private readonly headLimit: number
  private readonly tailLimit: number
  constructor(limit: number) {
    this.headLimit = Math.floor(limit * 0.3)
    this.tailLimit = Math.floor(limit * 0.7)
  }
  get truncated(): boolean {
    return this.omitted > 0
  }
  push(chunk: string): void {
    if (this.head.length < this.headLimit) {
      const room = this.headLimit - this.head.length
      this.head += chunk.slice(0, room)
      chunk = chunk.slice(room)
    }
    if (!chunk) return
    this.tail += chunk
    if (this.tail.length > this.tailLimit * 2) this.trim()
  }
  private trim(): void {
    const excess = this.tail.length - this.tailLimit
    if (excess > 0) {
      this.omitted += excess
      this.tail = this.tail.slice(excess)
    }
  }
  text(): string {
    this.trim()
    return this.omitted
      ? `${this.head}\n… [${this.omitted} characters of output omitted] …\n${this.tail}`
      : this.head + this.tail
  }
}

export interface WorkspaceOptions {
  /** Web fetch guard override, used by tests to exercise redirects on loopback servers. */
  fetch?: FetchOptions
}
/** Called with the previous file content (undefined for a new file) before every write. */
export type BeforeWrite = (relative: string, previous: string | undefined) => void

export class WorkspaceTools {
  readonly root: string
  readonly changedFiles = new Set<string>()
  private readonly secrets = new Set<string>()
  private readonly excludedEnvironment = new Set<string>(['HARNESS_TOKEN'])
  protectCredentials(values: (string | undefined)[], environment: string[]): void {
    for (const value of values) if (value) this.secrets.add(value)
    for (const name of environment) this.excludedEnvironment.add(name.toUpperCase())
  }
  redact(value: string): string {
    for (const secret of this.secrets) value = value.replaceAll(secret, '[REDACTED]')
    return value
  }
  stringify(value: unknown): string {
    return JSON.stringify(value, (_key, field: unknown) =>
      typeof field === 'string' ? this.redact(field) : field,
    )
  }

  todos: TodoItem[] = []
  beforeWrite: BeforeWrite | undefined
  private readonly seenInstructions = new Map<string, string>()
  private readonly options: WorkspaceOptions
  private constructor(root: string, options: WorkspaceOptions) {
    this.root = root
    this.options = options
  }
  static async open(root: string, options: WorkspaceOptions = {}): Promise<WorkspaceTools> {
    const canonical = await fs.realpath(root)
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Workspace must be a directory')
    return new WorkspaceTools(canonical, options)
  }
  private inside(target: string): void {
    const rel = path.relative(this.root, target)
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
      throw new Error('Path escapes the workspace')
  }
  private async resolve(input: string): Promise<string> {
    if (!input || input.includes('\0')) throw new Error('Invalid workspace path')
    const target = path.resolve(this.root, input)
    this.inside(target)
    const segments = path.relative(this.root, target).split(path.sep)
    if (segments.some(protectedSegment))
      throw new Error('Path is Git metadata or matches an excluded secret-file pattern')
    let existing = target
    const suffix: string[] = []
    for (;;) {
      try {
        const real = await fs.realpath(existing)
        this.inside(real)
        const resolved = path.join(real, ...suffix)
        this.inside(resolved)
        return resolved
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        try {
          if ((await fs.lstat(existing)).isSymbolicLink())
            throw new Error('Broken symlink is not a safe workspace target')
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
        }
        if (existing === this.root) throw error
        suffix.unshift(path.basename(existing))
        existing = path.dirname(existing)
      }
    }
  }
  /** Current text of a workspace file, or undefined when it does not exist. */
  async readText(relative: string): Promise<string | undefined> {
    try {
      return (await this.read(await this.resolve(relative))).content
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  /**
   * Restores a file to `content` (undefined deletes it) for undo/redo. Uses the same workspace and
   * secret-path guards as the model tools, and writes atomically.
   */
  async restoreFile(relative: string, content: string | undefined): Promise<void> {
    const file = await this.resolve(relative)
    if (content === undefined) {
      await fs.rm(file, { force: true })
      return
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    let mode = 0o644
    try {
      mode = (await fs.stat(file)).mode & 0o777
    } catch {
      /* new file */
    }
    const temporary = path.join(path.dirname(file), `.harness-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, content, { mode, flag: 'wx' })
      await fs.rename(temporary, file)
    } finally {
      await fs.rm(temporary, { force: true })
    }
  }
  private async read(file: string): Promise<{ content: string; hash: string }> {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_FILE)
      throw new Error('Expected a text file of at most 1 MB')
    const bytes = await fs.readFile(file)
    if (bytes.length > MAX_FILE || bytes.includes(0))
      throw new Error('Binary or oversized file is not supported')
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw new Error('File is not UTF-8 text')
    }
    return { content, hash: sha(bytes) }
  }
  private async instructions(file: string): Promise<{ path: string; content: string }[]> {
    const target = path.dirname(file)
    const segments = path.relative(this.root, target).split(path.sep).filter(Boolean)
    const directories = [this.root]
    for (const segment of segments) directories.push(path.join(directories.at(-1)!, segment))
    const result: { path: string; content: string }[] = []
    const discovered: [string, string][] = []
    for (const directory of directories) {
      const candidate = path.join(directory, 'AGENTS.md')
      try {
        const real = await this.resolve(candidate)
        const { content, hash } = await this.read(real)
        if (this.seenInstructions.get(candidate) === hash) continue
        if (content.length > 16000)
          throw new Error(
            'Project instructions exceed the per-file limit; provide a smaller focused workspace',
          )
        result.push({ path: path.relative(this.root, candidate), content })
        if (JSON.stringify(result).length > 24000)
          throw new Error(
            'Project instructions exceed the context limit; provide a smaller focused workspace',
          )
        discovered.push([candidate, hash])
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    for (const [candidate, hash] of discovered) this.seenInstructions.set(candidate, hash)
    return result
  }
  async context(): Promise<string> {
    const instructions = await this.instructions(path.join(this.root, '__context__'))
    const files = await this.execute('list_files', { path: '.' }, new AbortController().signal)
    return `Workspace: ${this.root}\nRoot entries: ${JSON.stringify(files)}\nProject instructions:\n${instructions.map((i) => `${i.path}:\n${i.content}`).join('\n\n')}`
  }
  private async replace(
    file: string,
    content: string,
    expected: string | undefined,
    preserveCredentials = false,
  ): Promise<void> {
    if (content.includes('\0') || Buffer.from(content, 'utf8').toString('utf8') !== content)
      throw new Error('File content must be valid UTF-8 text without NUL bytes')
    if (Buffer.byteLength(content) > MAX_FILE) throw new Error('File content exceeds 1 MB')
    let current: { content: string; hash: string } | undefined
    try {
      current = await this.read(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (
      current &&
      !preserveCredentials &&
      [...this.secrets].some((secret) => current.content.includes(secret))
    )
      throw new Error(
        'File contains a protected credential; use a focused edit of non-secret text instead of replacing the file',
      )
    if (current && (!expected || current.hash !== expected))
      throw new Error('File changed or expectedHash is missing; read the file again before writing')
    if (!current && expected) throw new Error('File no longer exists; read the workspace again')
    this.beforeWrite?.(path.relative(this.root, file), current?.content)
    await fs.mkdir(path.dirname(file), { recursive: true })
    if (!current) await fs.writeFile(file, content, { flag: 'wx' })
    else {
      const temporary = path.join(path.dirname(file), `.harness-${randomUUID()}.tmp`)
      const mode = (await fs.stat(file)).mode & 0o777
      try {
        await fs.writeFile(temporary, content, { mode, flag: 'wx' })
        if ((await this.read(file)).hash !== expected)
          throw new Error('File changed while editing; no changes applied')
        if ((await this.resolve(path.relative(this.root, file))) !== file)
          throw new Error('File target changed while editing')
        await fs.rename(temporary, file)
      } finally {
        await fs.rm(temporary, { force: true })
      }
    }
    this.changedFiles.add(path.relative(this.root, file))
  }
  private async walk(
    directory: string,
    depth = 0,
    budget = { files: 0, entries: 0 },
  ): Promise<string[]> {
    if (depth > 12 || budget.files >= 2000 || budget.entries >= 5000) return []
    const files: string[] = []
    for await (const entry of await fs.opendir(directory)) {
      if (++budget.entries > 5000) break
      if (SKIP.has(entry.name) || entry.isSymbolicLink() || protectedSegment(entry.name)) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) files.push(...(await this.walk(full, depth + 1, budget)))
      else if (entry.isFile()) {
        budget.files++
        files.push(full)
      }
      if (budget.files >= 2000) break
    }
    return files
  }
  async execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    signal.throwIfAborted()
    try {
      if (!knownTool(name)) throw new Error('Unknown coding tool')
      if (name === 'run_command') {
        const command = string(args, 'command')
        if (!command.trim() || command.length > 16000) throw new Error('Invalid shell command')
        const cwd = args.cwd === undefined ? this.root : await this.resolve(string(args, 'cwd'))
        if (!(await fs.stat(cwd)).isDirectory()) throw new Error('cwd must be a directory')
        return await this.command(
          command,
          integer(args.timeoutMs, 120000, 600000),
          signal,
          true,
          cwd,
        )
      }
      if (name === 'git_diff')
        return await this.command(
          [
            'git',
            '--no-pager',
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--',
            '.',
            ':(exclude)**/.env*',
            ':(exclude)**/*.pem',
            ':(exclude)**/*.key',
          ],
          10000,
          signal,
          false,
        )
      if (name === 'web_fetch') {
        const format = args.format === undefined ? 'markdown' : string(args, 'format')
        if (!['text', 'markdown', 'html'].includes(format))
          throw new Error('format must be text, markdown or html')
        const url = string(args, 'url')
        if (url.length > 4000) throw new Error('URL is too long')
        const fetched = await webFetch(
          url,
          format as 'text' | 'markdown' | 'html',
          signal,
          this.options.fetch,
        )
        return { ...fetched }
      }
      if (name === 'todo_write') {
        if (!Array.isArray(args.todos) || args.todos.length > 50)
          throw new Error('todos must be an array of at most 50 items')
        const todos = args.todos.map((item: unknown) => {
          const todo = item as Partial<TodoItem> | null
          if (
            !todo ||
            typeof todo.content !== 'string' ||
            !todo.content.trim() ||
            todo.content.length > 500 ||
            !TODO_STATUSES.includes(todo.status as TodoItem['status'])
          )
            throw new Error('Each todo needs content (1..500 chars) and a valid status')
          return { content: todo.content.trim(), status: todo.status! }
        })
        this.todos = todos
        return {
          ok: true,
          todos,
          remaining: todos.filter((t) => t.status === 'pending' || t.status === 'in_progress')
            .length,
        }
      }
      const file = await this.resolve(args.path === undefined ? '.' : string(args, 'path'))
      if (name === 'list_files') {
        const entries: { name: string; directory: boolean; symlink: boolean }[] = []
        let examined = 0
        let truncated = false
        for await (const entry of await fs.opendir(file)) {
          if (++examined > 1000 || entries.length >= 200) {
            truncated = true
            break
          }
          if (!SKIP.has(entry.name) && !protectedSegment(entry.name))
            entries.push({
              name: entry.name,
              directory: entry.isDirectory(),
              symlink: entry.isSymbolicLink(),
            })
        }
        entries.sort(
          (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
        )
        return { ok: true, entries, truncated }
      }
      if (name === 'glob') {
        const pattern = string(args, 'pattern')
        const regex = globToRegExp(pattern)
        const budget = { files: 0, entries: 0 }
        const files = await this.walk(file, 0, budget)
        const matched: { path: string; mtime: number }[] = []
        for (const candidate of files) {
          signal.throwIfAborted()
          const relativeToBase = path.relative(file, candidate).replaceAll('\\', '/')
          if (!regex.test(relativeToBase)) continue
          const stat = await fs.stat(candidate).catch(() => undefined)
          matched.push({ path: path.relative(this.root, candidate), mtime: stat?.mtimeMs ?? 0 })
        }
        matched.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
        return {
          ok: true,
          files: matched.slice(0, 200).map((item) => item.path),
          count: matched.length,
          truncated: matched.length > 200 || files.length >= 2000 || budget.entries >= 5000,
        }
      }
      if (name === 'grep' || name === 'search_files') {
        const legacy = name === 'search_files'
        const pattern = string(args, legacy ? 'query' : 'pattern')
        const literal = legacy || args.literal === true
        const ignoreCase = args.ignoreCase === true
        const include = args.include === undefined ? undefined : string(args, 'include')
        const includeRegex = include ? globToRegExp(include) : undefined
        const regex = searchRegExp(pattern, literal, ignoreCase)
        const rg = findRipgrep()
        if (rg) {
          try {
            const found = await ripgrepSearch(rg, {
              root: this.root,
              target: file,
              pattern,
              include,
              ignoreCase,
              literal,
              maxMatches: 100,
              signal,
            })
            const matches = found.matches.filter(
              (match) => !match.path.split(/[\\/]/).some(protectedSegment),
            )
            return { ok: true, matches, truncated: found.truncated, engine: 'ripgrep' }
          } catch (error) {
            signal.throwIfAborted()
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        const budget = { files: 0, entries: 0 }
        const files = (await fs.stat(file)).isDirectory()
          ? await this.walk(file, 0, budget)
          : [file]
        const matches: SearchMatch[] = []
        for (const candidate of files) {
          signal.throwIfAborted()
          const relative = path.relative(this.root, candidate)
          if (includeRegex && !includeRegex.test(relative.replaceAll('\\', '/'))) continue
          let content: string
          try {
            content = (await this.read(await this.resolve(relative))).content
          } catch {
            continue
          }
          const lines = content.split('\n')
          for (const line of matchLines(content, regex, 100 - matches.length)) {
            matches.push({ path: relative, line, text: lines[line - 1]!.slice(0, 300) })
          }
          if (matches.length >= 100)
            return { ok: true, matches, truncated: true, engine: 'builtin' }
        }
        return {
          ok: true,
          matches,
          scannedFiles: files.length,
          truncated: files.length >= 2000 || budget.entries >= 5000,
          engine: 'builtin',
        }
      }
      if (name === 'read_file') {
        const { content, hash } = await this.read(file)
        const lines = content.split('\n')
        const start = integer(args.startLine, 1, 1_000_000)
        const end = Math.min(integer(args.endLine, start + 399, 1_000_000), start + 1999)
        if (end < start) throw new Error('endLine must be >= startLine')
        let selected = ''
        let last = start - 1
        for (let index = start - 1; index < Math.min(end, lines.length); index++) {
          const raw = lines[index]!
          const line = `${index + 1}: ${raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)}… [line truncated]` : raw}\n`
          if (selected.length + line.length > MAX_OUTPUT) break
          selected += line
          last = index + 1
        }
        const more = last < lines.length
        return {
          ok: true,
          instructions: await this.instructions(file),
          path: path.relative(this.root, file),
          hash,
          totalLines: lines.length,
          content: selected.replace(/\n$/, ''),
          truncated: more,
          ...(more ? { nextStartLine: last + 1 } : {}),
        }
      }
      const instructions = await this.instructions(file)
      if (instructions.length)
        return {
          ok: false,
          error: 'Read and follow these project instructions, then retry the edit',
          instructions,
        }
      let before = ''
      try {
        before = (await this.read(file)).content
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (name === 'write_file') {
        const content = string(args, 'content')
        const expected = args.expectedHash === undefined ? undefined : string(args, 'expectedHash')
        await this.replace(file, content, expected)
      } else if (name === 'apply_patch') {
        const expected = string(args, 'expectedHash')
        const current = await this.read(file)
        if (current.hash !== expected)
          throw new Error('File changed since read_file; read it again before applying a patch')
        const updated = applyTextPatch(
          current.content,
          string(args, 'patch'),
          path.relative(this.root, file),
        )
        if (updated === current.content) throw new Error('Patch does not change the file')
        await this.replace(file, updated, current.hash, true)
      } else {
        const edits =
          name === 'multi_edit'
            ? parseEdits(args.edits)
            : [
                {
                  oldText: string(args, 'oldText'),
                  newText: string(args, 'newText'),
                  replaceAll: args.replaceAll === true,
                },
              ]
        const current = await this.read(file)
        await this.replace(file, applyTextEdits(current.content, edits), current.hash, true)
      }
      const relative = path.relative(this.root, file)
      const updated = await this.read(file)
      return {
        ok: true,
        path: relative,
        hash: updated.hash,
        diff: diffPreview(relative, before, updated.content),
      }
    } catch (error) {
      signal.throwIfAborted()
      return { ok: false, error: error instanceof Error ? error.message : 'Coding tool failed' }
    }
  }
  private command(
    command: string | string[],
    timeoutMs: number,
    signal: AbortSignal,
    shell: boolean,
    cwd = this.root,
  ): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const args = typeof command === 'string' ? [] : command.slice(1)
      const environment = { ...process.env }
      for (const name of Object.keys(environment))
        if (this.excludedEnvironment.has(name.toUpperCase())) delete environment[name]
      const child = spawn(typeof command === 'string' ? command : command[0]!, args, {
        cwd,
        env: environment,
        shell,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const out = new BoundedOutput(MAX_OUTPUT * 0.65)
      const err = new BoundedOutput(MAX_OUTPUT * 0.35)
      let timedOut = false
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (data: string) => out.push(data))
      child.stderr.on('data', (data: string) => err.push(data))
      const stop = () => {
        if (!child.pid) return
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          })
          killer.on('error', () => child.kill())
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill()
          }
        }
      }
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      signal.addEventListener('abort', stop, { once: true })
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', stop)
      }
      child.on('error', (error) => {
        cleanup()
        reject(error)
      })
      child.on('close', (code) => {
        cleanup()
        if (signal.aborted) reject(signal.reason)
        else
          resolve({
            ok: code === 0 && !timedOut,
            exitCode: code,
            stdout: out.text(),
            stderr: err.text(),
            truncated: out.truncated || err.truncated,
            timedOut,
          })
      })
      if (signal.aborted) stop()
    })
  }
}
