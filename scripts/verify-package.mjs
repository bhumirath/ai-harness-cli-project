import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const manager = process.env.npm_execpath
if (!manager) throw new Error('Run this check with pnpm verify:package')
const temporary = mkdtempSync(join(tmpdir(), 'harness-package-'))
const outputIndex = process.argv.indexOf('--output-dir')
if (outputIndex !== -1 && !process.argv[outputIndex + 1])
  throw new Error('--output-dir needs a directory')
const destination = outputIndex === -1 ? temporary : resolve(process.argv[outputIndex + 1])
function pnpm(args, cwd) {
  execFileSync(process.execPath, [manager, ...args], { cwd, stdio: 'inherit' })
}
try {
  mkdirSync(destination, { recursive: true })
  pnpm(['pack', '--pack-destination', destination], root)
  const archive = join(destination, `ai-harness-cli-${pkg.version}.tgz`)
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true }))
  // Verify the portable file-storage CLI even on hosts without a native keychain backend.
  pnpm(['add', '--ignore-scripts', '--no-optional', '--lockfile=false', archive], temporary)
  const bin = join(temporary, 'node_modules', '@ai-harness', 'cli', 'dist', 'bin.js')
  const version = execFileSync(process.execPath, [bin, '--version'], {
    encoding: 'utf8',
    cwd: temporary,
  }).trim()
  if (version !== pkg.version)
    throw new Error(`Packed version ${version} does not match ${pkg.version}`)
  for (const args of [
    ['--help'],
    ['orgs', '--help'],
    ['conversations', '--help'],
    ['completion', 'bash'],
  ]) {
    execFileSync(process.execPath, [bin, ...args], { cwd: temporary, stdio: 'pipe' })
  }
  const configFile = join(temporary, 'config.json')
  writeFileSync(
    configFile,
    JSON.stringify({ token: 'hk_dummy_package', apiUrl: 'http://127.0.0.1:1' }),
    { mode: 0o600 },
  )
  const storage = execFileSync(
    process.execPath,
    [bin, 'credentials', 'storage', 'file', '--json'],
    {
      cwd: temporary,
      encoding: 'utf8',
      env: { ...process.env, HARNESS_CONFIG: configFile },
    },
  )
  if (JSON.parse(storage).storage !== 'file') throw new Error('Packed file token storage failed')
  console.log(`Packed CLI ${version} installs and runs without native optional dependencies.`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
