#!/usr/bin/env node
import { EXIT } from './api/errors.ts'
import { main } from './index.ts'

main().then(
  (code) => process.exit(code),
  () => process.exit(EXIT.error),
)
