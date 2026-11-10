// Regenerates src/api/schema.d.ts from the running backend's OpenAPI document.
// Usage: API_URL=http://localhost:13000 pnpm gen:api   (default http://localhost:3000)
import { execFileSync } from 'node:child_process'

const base = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '')
const url = `${base}/api/docs-json`
console.log(`Generating API types from ${url}`)
execFileSync(
  'pnpm',
  ['exec', 'openapi-typescript', url, '--output', 'src/api/schema.d.ts', '--root-types'],
  {
    stdio: 'inherit',
  },
)
execFileSync('pnpm', ['exec', 'prettier', '--write', 'src/api/schema.d.ts'], { stdio: 'inherit' })
