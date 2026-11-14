# TASKS — ai-harness-cli-project

Protocol: `../ai-harness-doc-project/AGENTS.md`. Plan: `../ai-harness-doc-project/docs/10-cli.md`.

## MC — CLI

### CLI-001 · Scaffold

- Status: DONE (2026-11-10)
- Acceptance criteria:
  - [x] TS/ESM, commander, lint/typecheck/test/build, CI (Linux/macOS/Windows), `pnpm gen:api`
  - [x] Config file (0600) with flags > env > file precedence; `--api-url`, `--org`, `--json`

### CLI-002 · Auth

- Status: DONE (2026-11-10)
- Depends on: BE-070, FE-070 (web `/device` page; until it exists approve with
  `POST /api/auth/device/approve`)
- Acceptance criteria:
  - [x] `harness login` device flow (pending / slow_down / denied / expired), `--token`, `HARNESS_TOKEN`
  - [x] `whoami`; `logout` revokes the token server-side
  - [x] Verified live against the compose stack (2026-11-10)

### CLI-003 · Chat

- Status: DONE (2026-11-10)
- Acceptance criteria:
  - [x] `harness chat` REPL with streaming, tool lines, cost, /new, Ctrl+C stops a reply
  - [x] `harness ask` one-shot + stdin, `--json`, approvals prompt (y/N) then `/continue`;
        non-interactive → tells the user to approve elsewhere, exit 1
  - [ ] Live test with a real model (only unit-tested against a fake SSE server so far)

### CLI-004 · Agents, runs, schedules

- Status: DONE (2026-11-10)
- Acceptance criteria:
  - [x] `agents ls|show|run [--wait]`, `runs ls|show`, `schedules ls|add|toggle|rm` (Thai/English parse)

### CLI-005 · Approvals, inbox, memory, models, money, tokens

- Status: DONE (2026-11-10)
- Acceptance criteria:
  - [x] `approvals ls|approve|reject`, `inbox [--unread] [--read-all]`, `memory ls|add|rm`, `models`,
        `balance`, `usage --days --by`, `tokens ls|revoke`

### CLI-008 · Templates, sharing, invites, free tier
- Status: DONE (2026-11-14)
- Description: `harness templates [ls]`, `templates use <id> [--model] [--name] [--schedule]`,
  `harness share <agent> [--stop]`, `harness import <link|token>`, `harness invite`; default model =
  the Free model if offered; FREE_QUOTA_EXCEEDED → exit 4 with reset time; whoami shows the free quota.
- Acceptance criteria:
  - [x] unit tests (share-link parsing, quota error); `templates` verified live against the dev API

### CLI-006 · Packaging + release

- Status: TODO
- Description: npm org/scope `@ai-harness` (owner, O-10), `pnpm publish` from CI on tag, update
  notice, single-file binaries (Node SEA) for macOS/Windows/Linux, Homebrew/Scoop later.
- Acceptance criteria:
  - [ ] `npx @ai-harness/cli --version` works from the registry

### CLI-007 · Nice to have

- Status: TODO
- Description: shell completion (`harness completion bash|zsh|fish|powershell`), OS keychain for the
  token, `harness chat` markdown rendering, `harness conversations ls|show`, `--org` picker.
