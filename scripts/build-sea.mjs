import { createHash } from 'node:crypto'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import postject from 'postject'

if (process.versions.node.split('.')[0] !== '22')
  throw new Error('Standalone builds require Node 22')
const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const outputIndex = process.argv.indexOf('--output-dir')
if (outputIndex !== -1 && !process.argv[outputIndex + 1])
  throw new Error('--output-dir needs a directory')
const destination =
  outputIndex === -1 ? join(root, 'release', 'bin') : resolve(process.argv[outputIndex + 1])
const temporary = mkdtempSync(join(tmpdir(), 'harness-sea-'))
const filename = `harness-${pkg.version}-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`
const binary = join(destination, filename)
const licenseName = `LICENSES-${process.platform}-${process.arch}.txt`
try {
  execFileSync(process.execPath, [join(root, 'scripts/sync-version.mjs'), '--check'])
  mkdirSync(destination, { recursive: true })
  const bundle = join(temporary, 'cli.cjs')
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/bin.ts'],
    outfile: bundle,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    bundle: true,
    external: ['@napi-rs/keyring'],
    metafile: true,
    legalComments: 'inline',
    define: { 'import.meta.url': '__harnessImportMetaUrl' },
    banner: {
      js: "const __harnessImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
    },
  })
  const blob = join(temporary, 'sea.blob')
  const seaConfig = join(temporary, 'sea.json')
  writeFileSync(
    seaConfig,
    JSON.stringify({
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: 'none',
    }),
  )
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' })
  copyFileSync(process.execPath, binary)
  if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', binary])
  await postject.inject(binary, 'NODE_SEA_BLOB', readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: 'NODE_SEA',
  })
  if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', binary])
  chmodSync(binary, 0o755)

  // Collect Node's full license and licenses from each bundled dependency.
  const nodeLicense = [
    join(dirname(process.execPath), '..', 'LICENSE'),
    join(dirname(process.execPath), 'LICENSE'),
  ].find(existsSync)
  let nodeLicenseText
  if (nodeLicense) nodeLicenseText = readFileSync(nodeLicense, 'utf8')
  else {
    const response = await fetch(
      `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
      { signal: AbortSignal.timeout(10000) },
    )
    if (!response.ok) throw new Error('Cannot obtain the Node distribution license')
    nodeLicenseText = await response.text()
  }
  const notices = [`Node.js ${process.versions.node}\n${nodeLicenseText}`]
  const seen = new Set()
  for (const input of Object.keys(result.metafile.inputs).filter((p) =>
    p.includes('node_modules/'),
  )) {
    let directory = dirname(resolve(root, input))
    while (directory !== dirname(directory)) {
      if (existsSync(join(directory, 'package.json'))) {
        if (!seen.has(directory)) {
          seen.add(directory)
          const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
          const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']
            .map((name) => join(directory, name))
            .find(existsSync)
          if (!license) throw new Error(`Missing license for bundled dependency ${metadata.name}`)
          notices.push(`${metadata.name}@${metadata.version}\n${readFileSync(license, 'utf8')}`)
        }
        break
      }
      directory = dirname(directory)
    }
  }
  writeFileSync(
    join(destination, licenseName),
    notices.join('\n\n----------------------------------------\n\n'),
  )

  // Run a copy from a clean directory so the bundle cannot use this repo's node_modules.
  const isolated = join(temporary, 'smoke')
  mkdirSync(isolated)
  const executable = join(isolated, process.platform === 'win32' ? 'harness.exe' : 'harness')
  copyFileSync(binary, executable)
  chmodSync(executable, 0o755)
  const settings = join(isolated, 'config.json')
  const env = { ...process.env, HARNESS_CONFIG: settings, HARNESS_TOKEN: '', HARNESS_ORG: '' }
  const run = (args) => execFileSync(executable, args, { cwd: isolated, env, encoding: 'utf8' })
  if (run(['--version']).trim() !== pkg.version) throw new Error('Standalone version mismatch')
  for (const args of [['--help'], ['conversations', '--help'], ['completion', 'bash']]) run(args)
  writeFileSync(
    settings,
    JSON.stringify({ token: 'hk_dummy_package', apiUrl: 'http://127.0.0.1:1' }),
    { mode: 0o600 },
  )
  if (JSON.parse(run(['credentials', 'storage', 'file', '--json'])).storage !== 'file')
    throw new Error('Standalone config persistence failed')
  const unavailable = spawnSync(executable, ['credentials', 'storage', 'keychain'], {
    cwd: isolated,
    env,
    encoding: 'utf8',
  })
  if (unavailable.status !== 3 || !unavailable.stderr.includes('OS keychain unavailable'))
    throw new Error('Standalone keychain must fail safely without native addons')
  if (JSON.parse(readFileSync(settings, 'utf8')).token !== 'hk_dummy_package')
    throw new Error('Failed keychain migration changed the saved login')

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== 'Bearer hk_dummy_package') {
      res.statusCode = 401
      res.end('{}')
      return
    }
    res.end(JSON.stringify({ items: [], nextCursor: null }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { stdout } = await promisify(execFile)(
      executable,
      ['--api-url', `http://127.0.0.1:${server.address().port}`, 'conversations', 'ls', '--json'],
      { cwd: isolated, env, timeout: 10000 },
    )
    if (JSON.parse(stdout).items.length !== 0) throw new Error('Standalone API request failed')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
  writeFileSync(join(destination, `${filename}.sha256`), `${digest}  ${filename}\n`)
  console.log(`Standalone built and smoke-tested: ${binary}`)
} catch (error) {
  rmSync(binary, { force: true })
  throw error
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
