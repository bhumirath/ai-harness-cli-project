import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

if (process.platform !== 'linux') throw new Error('Use a Linux Docker host for test:native:linux')
const root = fileURLToPath(new URL('..', import.meta.url))
const image = 'ai-harness-cli-native-test'
execFileSync('docker', ['build', '--quiet', '-t', image, '-f', 'test/native/Dockerfile', '.'], {
  cwd: root,
  stdio: 'inherit',
})
const mounts = ['dist', 'node_modules', 'test/native', 'package.json'].flatMap((path) => [
  '--mount',
  `type=bind,src=${join(root, path)},dst=/project/${path},readonly`,
])
execFileSync('docker', ['run', '--rm', ...mounts, image], { cwd: root, stdio: 'inherit' })
