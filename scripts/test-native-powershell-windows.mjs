import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('This check exercises the Windows cmd shim')
const root = fileURLToPath(new URL('..', import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'harness-powershell-'))
try {
  // Match the npm Windows shim, including its legacy handling of empty native arguments.
  const escapePath = (value) => value.replaceAll('%', '%%')
  writeFileSync(
    join(temporary, 'harness.cmd'),
    `@echo off\r\n"${escapePath(process.execPath)}" "${escapePath(join(root, 'dist', 'bin.js'))}" %*\r\n`,
  )
  execFileSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-File', join(root, 'test/native/powershell.ps1')],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, PATH: `${temporary}${delimiter}${process.env.PATH ?? ''}` },
    },
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
