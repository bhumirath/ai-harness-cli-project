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

- Status: IN_PROGRESS (codex, 2026-11-16) — preparing release locally; registry/repository setup still needs O-10
- Description: npm org/scope `@ai-harness` (owner, O-10), `pnpm publish` from CI on tag, update
  notice, single-file binaries (Node SEA) for macOS/Windows/Linux, Homebrew/Scoop later.
- Acceptance criteria:
  - [ ] `npx @ai-harness/cli --version` works from the registry
- Progress: local pack/install smoke check passes without native optional dependencies; version sync,
  prepack build, CI package checks and tag-triggered OIDC release workflow ready. Nothing published.
  Needs O-10 (GitHub repository + npm publishing access/bootstrap/trusted publisher).
  Update notice implemented in CLI-014. Linux SEA built/tested in CLI-015; macOS/Windows
  native workflow execution and registry publication remain pending.

### CLI-007 · Nice to have

- Status: IN_PROGRESS (codex, 2026-11-16) — features implemented; native platform validation pending
- Description: shell completion (`harness completion bash|zsh|fish|powershell`), OS keychain for the
  token, `harness chat` markdown rendering, `harness conversations ls|show`, `--org` picker.
- Progress: implemented history (CLI-009), completion (CLI-010), org picker (CLI-011), Markdown
  (CLI-012) and keychain (CLI-013). Remaining validation: successful native keychain storage on
  desktop macOS/Windows/Linux and native zsh/fish/PowerShell completion. Linux unavailable-store
  behavior and Bash execution are tested.

### CLI-009 · Conversation history (from CLI-007)

- Status: DONE (2026-11-16)
- Depends on: CLI-002
- Acceptance criteria:
  - [x] `conversations ls` supports title search and cursor pagination; `show <id>` supports older-message pagination.
  - [x] Human-readable text/image/tool/error output and unchanged API JSON with `--json`.
  - [x] Integration tests cover requests, pagination, authentication and errors.

### CLI-010 · Shell completion (from CLI-007)

- Status: DONE (2026-11-16)
- Acceptance criteria:
  - [x] `completion bash|zsh|fish|powershell` emits installable scripts without authentication.
  - [x] Completion follows command/subcommand options and skips option values; never calls the API.
  - [x] Tests cover completion context and generated Bash script execution.

### CLI-011 · Organization selection (from CLI-007)

- Status: DONE (2026-11-16)
- Acceptance criteria:
  - [x] `orgs ls` shows memberships and current selection; `orgs use [id|name]` saves a default.
  - [x] Interactive picker, clear errors in scripts, cancellation leaves config unchanged.
  - [x] Stale org selection can be repaired; flags/env keep precedence; tests and CLI checks pass.

### CLI-012 · Terminal Markdown (from CLI-007)

- Status: DONE (2026-11-16)
- Acceptance criteria:
  - [x] Opt-in `chat/ask --markdown` styles common Markdown while preserving raw text and JSON.
  - [x] Code blocks, headings, lists and links render safely; partial responses survive errors/abort.
  - [x] Streaming tests cover chunk boundaries and interleaved tool events.

### CLI-013 · OS credential storage (from CLI-007)

- Status: DONE (2026-11-16)
- Acceptance criteria:
  - [x] Opt-in keychain login and migration from/to file storage; no token in JSON config in keychain mode.
  - [x] Native keychain on macOS/Windows, persistent Secret Service on Linux, no silent fallback.
  - [x] Logout removes the stored credential; failures/cancellation do not destroy the previous login.
  - [x] Tests cover precedence, migration, cleanup and unavailable stores without logging tokens.

### CLI-014 · Update notice (from CLI-006)

- Status: DONE (2026-11-16)
- Acceptance criteria:
  - [x] Explicit `update-check` reports newer npm latest versions, with clean JSON mode.
  - [x] Fixed registry endpoint, timeout, no credentials/config reads, helpful unpublished/network errors.

### CLI-015 · Standalone executable (from CLI-006)

- Status: IN_PROGRESS (codex, 2026-11-16)
- Acceptance criteria:
  - [x] Build Node 22 SEA from bundled CLI on native Linux/macOS/Windows runners.
  - [x] Native Linux executable smoke-tested without node_modules; keychain unavailable errors stay safe.
  - [ ] CI builds/smoke-tests each native platform and publishes downloadable artifacts.

- CLI-015 progress: Linux x64 binary built and smoke-tested with no node_modules or Node on PATH,
  including authenticated HTTP and credential persistence. Native CI workflow + license/checksum
  artifacts configured; macOS/Windows execution pending a Git remote and Actions run.
