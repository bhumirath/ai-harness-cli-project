/**
 * Minimal, dependency-free glob matcher for workspace-relative POSIX paths.
 * Supports `**`, `*`, `?`, `[...]` character classes and `{a,b}` alternatives.
 * A pattern without `/` matches the basename anywhere (like `.gitignore` and ripgrep `--glob`).
 */
export function globToRegExp(pattern: string): RegExp {
  if (!pattern || pattern.length > 500 || pattern.includes('\0'))
    throw new Error('Glob pattern must be 1..500 characters')
  let glob = pattern.replaceAll('\\', '/')
  if (glob.startsWith('./')) glob = glob.slice(2)
  const anywhere = !glob.includes('/')
  let source = ''
  let braces = 0
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/'
        source += slashAfter ? '(?:.*/)?' : '.*'
        i += slashAfter ? 2 : 1
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else if (char === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end === -1) source += '\\['
      else {
        let body = glob.slice(i + 1, end).replace(/\\/g, '\\\\')
        if (body.startsWith('!')) body = `^${body.slice(1)}`
        source += `[${body}]`
        i = end
      }
    } else if (char === '{') {
      braces++
      source += '(?:'
    } else if (char === '}' && braces > 0) {
      braces--
      source += ')'
    } else if (char === ',' && braces > 0) source += '|'
    else source += char.replace(/[.+^$()|\\]/g, '\\$&')
  }
  if (braces > 0) throw new Error('Unbalanced braces in glob pattern')
  return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${source}$`)
}

export function matchesGlob(relativePath: string, pattern: string | RegExp): boolean {
  const regex = typeof pattern === 'string' ? globToRegExp(pattern) : pattern
  return regex.test(relativePath.replaceAll('\\', '/'))
}
