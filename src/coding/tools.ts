import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import type { CodeTool, ToolResult } from './types.ts'

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
function diffPreview(file: string, before: string, after: string): string {
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
export const CODE_TOOLS: CodeTool[] = [
  definition(
    'list_files',
    'List one workspace directory. Dependency and Git directories are excluded.',
    { path: text },
  ),
  definition(
    'read_file',
    'Read numbered text lines; returns file hash for optimistic writes and relevant instructions.',
    { path: text, startLine: number, endLine: number },
    ['path'],
  ),
  definition(
    'search_files',
    'Search workspace files for literal text. Results are bounded.',
    { query: text, path: text },
    ['query'],
  ),
  definition(
    'write_file',
    'Create text file, or replace an existing file only with its current expectedHash from read_file.',
    { path: text, content: text, expectedHash: text },
    ['path', 'content'],
  ),
  definition(
    'edit_file',
    'Replace exactly one occurrence of oldText with newText; fails if missing or ambiguous.',
    { path: text, oldText: text, newText: text },
    ['path', 'oldText', 'newText'],
  ),
  definition(
    'apply_patch',
    'Safely apply one or more line hunks to an existing text file after read_file. Use patch lines prefixed with space (context), - (remove), or + (add), and start every hunk with @@. This is preferred for focused code edits.',
    { path: text, expectedHash: text, patch: text },
    ['path', 'expectedHash', 'patch'],
  ),
  definition(
    'run_command',
    'Run a shell command in the workspace after permission. Inspect exitCode/output and fix failures.',
    { command: text, timeoutMs: { ...number, maximum: 120000 } },
    ['command'],
  ),
  definition(
    'git_diff',
    'Run bounded Git diff after command approval; repository filters may execute code.',
    {},
  ),
]
export const MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'run_command',
  'git_diff',
])

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

  private readonly seenInstructions = new Map<string, string>()
  private constructor(root: string) {
    this.root = root
  }
  static async open(root: string): Promise<WorkspaceTools> {
    const canonical = await fs.realpath(root)
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('Workspace must be a directory')
    return new WorkspaceTools(canonical)
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
    if (
      segments.some(
        (s) =>
          [
            '.git',
            '.aws',
            '.ssh',
            '.gnupg',
            '.netrc',
            '.git-credentials',
            '.npmrc',
            '.pypirc',
            '.credentials.json',
          ].includes(s) || /^\.env(?:\.|$)|^id_(?:rsa|ed25519)$|\.(?:pem|key)$/i.test(s),
      )
    )
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
      if (SKIP.has(entry.name) || entry.isSymbolicLink() || entry.name.startsWith('.env')) continue
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
      if (!CODE_TOOLS.some((t) => t.function.name === name)) throw new Error('Unknown coding tool')
      if (name === 'run_command') {
        const command = string(args, 'command')
        if (!command.trim() || command.length > 16000) throw new Error('Invalid shell command')
        return await this.command(command, integer(args.timeoutMs, 60000, 120000), signal, true)
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
          if (!SKIP.has(entry.name) && !entry.name.startsWith('.env'))
            entries.push({
              name: entry.name,
              directory: entry.isDirectory(),
              symlink: entry.isSymbolicLink(),
            })
        }
        return { ok: true, entries, truncated }
      }
      if (name === 'search_files') {
        const query = string(args, 'query')
        if (!query || query.length > 1000)
          throw new Error('Search query must be 1..1000 characters')
        const budget = { files: 0, entries: 0 }
        const files = (await fs.stat(file)).isDirectory()
          ? await this.walk(file, 0, budget)
          : [file]
        const matches: { path: string; line: number; text: string }[] = []
        for (const candidate of files) {
          signal.throwIfAborted()
          let content: string
          try {
            content = (await this.read(await this.resolve(path.relative(this.root, candidate))))
              .content
          } catch {
            continue
          }
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++)
            if (lines[i]!.includes(query)) {
              matches.push({
                path: path.relative(this.root, candidate),
                line: i + 1,
                text: lines[i]!.slice(0, 300),
              })
              if (matches.length >= 100) return { ok: true, matches, truncated: true }
            }
        }
        return {
          ok: true,
          matches,
          scannedFiles: files.length,
          truncated: files.length >= 2000 || budget.entries >= 5000,
        }
      }
      if (name === 'read_file') {
        const { content, hash } = await this.read(file)
        const lines = content.split('\n')
        const start = integer(args.startLine, 1, 1_000_000)
        const end = integer(args.endLine, start + 199, 1_000_000)
        if (end < start) throw new Error('endLine must be >= startLine')
        const selected = lines
          .slice(start - 1, Math.min(end, start + 999))
          .map((line, i) => `${start + i}: ${line}`)
          .join('\n')
        return {
          ok: true,
          instructions: await this.instructions(file),
          path: path.relative(this.root, file),
          hash,
          totalLines: lines.length,
          content: selected.slice(0, MAX_OUTPUT),
          truncated: selected.length > MAX_OUTPUT || Math.min(end, start + 999) < lines.length,
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
        const oldText = string(args, 'oldText')
        const newText = string(args, 'newText')
        if (!oldText) throw new Error('oldText must not be empty')
        const current = await this.read(file)
        const first = current.content.indexOf(oldText)
        if (first < 0 || current.content.indexOf(oldText, first + 1) >= 0)
          throw new Error('oldText must match exactly once; read the file again')
        await this.replace(
          file,
          current.content.slice(0, first) + newText + current.content.slice(first + oldText.length),
          current.hash,
          true,
        )
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
  ): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const args = typeof command === 'string' ? [] : command.slice(1)
      const environment = { ...process.env }
      for (const name of Object.keys(environment))
        if (this.excludedEnvironment.has(name.toUpperCase())) delete environment[name]
      const child = spawn(typeof command === 'string' ? command : command[0]!, args, {
        cwd: this.root,
        env: environment,
        shell,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let truncated = false
      let timedOut = false
      const capture = (text: string, target: 'stdout' | 'stderr') => {
        const room = MAX_OUTPUT - stdout.length - stderr.length
        if (text.length > room) truncated = true
        if (target === 'stdout') stdout += text.slice(0, Math.max(0, room))
        else stderr += text.slice(0, Math.max(0, room))
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (data: string) => capture(data, 'stdout'))
      child.stderr.on('data', (data: string) => capture(data, 'stderr'))
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
            stdout,
            stderr,
            truncated,
            timedOut,
          })
      })
      if (signal.aborted) stop()
    })
  }
}
