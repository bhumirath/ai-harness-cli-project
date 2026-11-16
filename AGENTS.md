# AGENTS.md — ai-harness-cli-project (CLI)

**First read `../ai-harness-doc-project/AGENTS.md`, `../ai-harness-doc-project/HANDOFF.md` and
`../ai-harness-doc-project/docs/10-cli.md`.** This file adds CLI-specific rules.

## Stack

Node 22 · TypeScript 5.9 strict (ESM, NodeNext, run/compiled with `.ts` imports rewritten) ·
commander · @clack/prompts · openapi-fetch · picocolors · Vitest · oxlint + Prettier. pnpm.

## Commands

```bash
pnpm install
pnpm dev --help                 # run from source (node --experimental-strip-types)
HARNESS_API_URL=http://localhost:13000 pnpm dev login   # against the compose stack
API_URL=http://localhost:13000 pnpm gen:api                 # regenerate src/api/schema.d.ts
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Use `HARNESS_CONFIG=/tmp/x/config.json` to keep test logins away from your real config.

## Rules

- Thin client: no business logic; every call goes through the generated OpenAPI types
  (`src/api/schema.d.ts` — never hand-write API types; regenerate after backend changes).
- The token is a secret: only in the config file (mode 0600), the opt-in OS keychain, or `HARNESS_TOKEN`; never print or log it. Keychain mode must not silently fall back to plaintext storage.
- Money: micro-credit strings → `formatCredits` (BigInt). No floats.
- `--json` on every read command must print one valid JSON document to stdout and nothing else;
  progress/warnings go to stderr.
- Exit codes: 0 ok · 1 error · 2 usage · 3 auth · 4 payment (`src/api/errors.ts`).
- Works on macOS, Linux and Windows (no shell-specific behaviour; paths via `node:path`).
- Routes marked `@SessionOnly()` in the backend (payments, secrets, admin, token creation) are not
  available to the CLI by design (D-010) — link to the web app instead.

## Tasks

`TASKS.md` in this repo. Protocol in `../ai-harness-doc-project/AGENTS.md`.
