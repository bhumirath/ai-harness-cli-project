#!/usr/bin/env node
import { EXIT } from './api/errors.ts'
import { main } from './index.ts'
import { configureTlsRoots } from './tls.ts'

configureTlsRoots()

main().then(
  (code) => process.exit(code),
  () => process.exit(EXIT.error),
)
