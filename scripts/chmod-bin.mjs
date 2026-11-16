// Makes dist/bin.js executable after tsc (keeps the shebang from src/bin.ts).
import { chmodSync } from 'node:fs'
chmodSync(new URL('../dist/bin.js', import.meta.url), 0o755)
