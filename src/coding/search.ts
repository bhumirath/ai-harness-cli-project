import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

export interface SearchMatch {
  path: string
  line: number
  text: string
}

/** Directories and secret-file patterns that searches never descend into or report. */
export const SEARCH_EXCLUDES = [
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
]
const SECRET_GLOBS = [
  '.env*',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_ed25519',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.credentials.json',
]

let ripgrep: string | null | undefined
/**
 * Locates `rg` on PATH once. `HARNESS_RIPGREP=0` disables it; `HARNESS_RIPGREP=<path>` selects a
 * specific binary (tests and troubleshooting).
 */
export function findRipgrep(): string | undefined {
  const override = process.env.HARNESS_RIPGREP
  if (override === '0') return undefined
  if (override) return override
  if (ripgrep !== undefined) return ripgrep ?? undefined
  ripgrep = null
  const names = process.platform === 'win32' ? ['rg.exe'] : ['rg']
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
    for (const name of names) {
      const candidate = path.join(directory, name)
      try {
        accessSync(candidate, constants.X_OK)
        ripgrep = candidate
        return candidate
      } catch {
        /* keep looking */
      }
    }
  return undefined
}

export interface RipgrepOptions {
  root: string
  target: string
  pattern: string
  include?: string
  ignoreCase: boolean
  literal: boolean
  maxMatches: number
  signal: AbortSignal
}

/** Runs ripgrep with JSON output; symlinks are not followed and secrets are excluded. */
export function ripgrepSearch(
  binary: string,
  options: RipgrepOptions,
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  const args = ['--json', '--hidden', '--no-follow', '--max-columns', '400', '--max-filesize', '1M']
  for (const name of [...SEARCH_EXCLUDES, ...SECRET_GLOBS]) args.push('--glob', `!${name}`)
  if (options.include) args.push('--glob', options.include)
  if (options.ignoreCase) args.push('--ignore-case')
  if (options.literal) args.push('--fixed-strings')
  args.push('--regexp', options.pattern, '--', path.relative(options.root, options.target) || '.')
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const matches: SearchMatch[] = []
    let truncated = false
    let buffer = ''
    let stderr = ''
    const stop = () => child.kill()
    options.signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => {
      truncated = true
      stop()
    }, 30_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data: string) => {
      if (stderr.length < 2000) stderr += data
    })
    child.stdout.on('data', (data: string) => {
      buffer += data
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (matches.length >= options.maxMatches) continue
        try {
          const event = JSON.parse(line) as {
            type: string
            data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } }
          }
          if (event.type !== 'match' || !event.data?.path?.text) continue
          matches.push({
            path: path.normalize(event.data.path.text),
            line: event.data.line_number ?? 0,
            text: (event.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 300),
          })
          if (matches.length >= options.maxMatches) {
            truncated = true
            stop()
          }
        } catch {
          /* ignore partial or non-JSON lines */
        }
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', stop)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', stop)
      if (options.signal.aborted) return reject(options.signal.reason)
      // Exit code 1 means "no matches"; 2 means an error (for example an invalid regex).
      if (code === 2 && !matches.length)
        return reject(
          new Error(`Search failed: ${stderr.trim().slice(0, 300) || 'invalid pattern'}`),
        )
      resolve({ matches, truncated })
    })
  })
}

/** Builds a regular expression for the built-in search. */
export function searchRegExp(pattern: string, literal: boolean, ignoreCase: boolean): RegExp {
  if (!pattern || pattern.length > 1000)
    throw new Error('Search pattern must be 1..1000 characters')
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern
  try {
    return new RegExp(source, ignoreCase ? 'i' : '')
  } catch {
    throw new Error('Invalid regular expression')
  }
}

const context = vm.createContext({})
/**
 * Returns 1-based matching line numbers. The regex runs under a VM timeout so a catastrophic
 * pattern from the model cannot hang the CLI.
 */
export function matchLines(content: string, regex: RegExp, limit: number): number[] {
  context.regex = regex
  context.content = content
  context.limit = limit
  try {
    const lines = vm.runInContext(
      `(() => { const out = []; const lines = content.split('\\n');
        for (let i = 0; i < lines.length && out.length < limit; i++)
          if (regex.test(lines[i].length > 4000 ? lines[i].slice(0, 4000) : lines[i])) out.push(i + 1);
        return out })()`,
      context,
      { timeout: 2000 },
    ) as number[]
    return Array.from(lines)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
      throw new Error('Search pattern is too expensive; simplify the regular expression')
    throw error
  } finally {
    context.content = ''
  }
}
