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

- Status: IN_PROGRESS — GitHub Release + Homebrew complete; npm intentionally disabled (O-10)
- Description: npm org/scope `@ai-harness` (owner, O-10), `pnpm publish` from CI on tag, update
  notice, single-file binaries (Node SEA) for macOS/Windows/Linux, Homebrew/Scoop later.
- Acceptance criteria:
  - [ ] `npx @ai-harness/cli --version` works from the registry
- Progress: local pack/install smoke check passes without native optional dependencies; version sync,
  prepack build, CI package checks and tag-triggered OIDC release workflow ready. Nothing published.
  Owner created the GitHub repository on 2026-11-17; origin is configured. Needs GitHub
  authentication plus npm publishing access/bootstrap/trusted publisher (O-10).
  Update notice implemented in CLI-014. SEA binaries for Linux/macOS/Windows are published in
  GitHub Release v0.3.1 and Homebrew distribution is live. npm remains disabled because the
  configured package name belongs to an unrelated project.

### CLI-007 · Nice to have

- Status: IN_PROGRESS (codex, 2026-11-16) — features implemented; native platform validation pending
- Description: shell completion (`harness completion bash|zsh|fish|powershell`), OS keychain for the
  token, `harness chat` markdown rendering, `harness conversations ls|show`, `--org` picker.
- Progress: implemented history (CLI-009), completion (CLI-010), org picker (CLI-011), Markdown
  (CLI-012) and keychain (CLI-013). Remaining validation: successful native keychain storage on
  macOS/Windows, Windows PowerShell cmd-shim execution, and interactive Zsh ZLE behavior.
  Linux Secret Service write/read/migration/logout and Bash/Zsh/Fish adapters pass (CLI-016);
  real PowerShell 7.4 on Linux also passes, including legacy argument passing (CLI-018).

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

- Status: DONE (2026-11-19)
- Acceptance criteria:
  - [x] Build Node 22 SEA from bundled CLI on native Linux/macOS/Windows runners.
  - [x] Native Linux executable smoke-tested without node_modules; keychain unavailable errors stay safe.
  - [x] CI builds/smoke-tests each native platform and publishes downloadable artifacts.

- Verified by successful native workflow run 44438783340 and release v0.3.1: Linux x64, macOS
  arm64 and Windows x64 binaries, SHA-256 checksums and per-platform license manifests.

### CLI-016 · Native Linux completion and keychain validation

- Status: DONE (2026-11-17)
- Depends on: CLI-010, CLI-013
- Acceptance criteria:
  - [x] Repeatable isolated environment exercises Bash/Zsh/Fish completion in their own shells.
  - [x] Real Linux Secret Service write/read/migration/logout succeeds without logging tokens.
  - [x] Regressions found by native checks are fixed, with checks runnable locally and in CI.

### CLI-017 · Complete help and implicit default-command options

- Status: DONE (2026-11-17)
- Acceptance criteria:
  - [x] Completion includes built-in help and default `ls` options without typing `ls`.
  - [x] Required option values are skipped and sibling command options do not leak.
  - [x] Unit and native Bash/Zsh/Fish checks cover the repaired contexts.

### CLI-018 · PowerShell completion validation and argument transport

- Status: DONE (2026-11-18)
- Acceptance criteria:
  - [x] Test generated script through the real PowerShell completion engine.
  - [x] Quoted words and trailing empty arguments survive native/cmd-shim transport.
  - [x] Regression coverage and repeatable Docker/Windows CI smoke checks.
- Progress: fixed quoted command/current words and added encoded argument transport. PowerShell
  7.4 on Linux passes quoted, empty and Thai words in Legacy/Standard/Windows argument modes.
  Windows shim and native binary checks passed in GitHub Actions run 44041626782.

## MC2 — Local coding agent (D-012)

Contract/parallel ownership: `../ai-harness-doc-project/docs/12-coding-cli.md`.

### CLI-019 · Existing CI portability regressions

- Status: DONE (2026-11-18)
- Description: fixed macOS ANSI-sensitive long-line test and Windows CRLF version check. CRLF
  normalization, LF checkout policy and ANSI-insensitive assertion pass locally and in CI runs
  44041579936 (matrix CI) and 44041626782 (native standalone binaries).

### CLI-020 · Local workspace coding tools

- Status: DONE (2026-11-17)
- Acceptance criteria:
  - [x] Bounded list/read/search/write/edit/command/git-diff tools, canonical workspace guards and optimistic edits.
  - [x] Permission/cancel hooks and fixture tests; preserve concurrent user edits.

### CLI-021 · Coding model adapters

- Status: DONE (2026-11-17)
- Depends on: BE-097 for account mode
- Acceptance criteria:
  - [x] Account mode uses generated coding API types; direct mode uses an OpenAI-compatible key/endpoint.
  - [x] No SaaS keychain read in direct mode; no provider key upload to SaaS; bounded errors/timeouts.

### CLI-022 · Coding command and iterative tool loop

- Status: DONE (2026-11-17)
- Depends on: CLI-020, CLI-021
- Acceptance criteria:
  - [x] `harness code` interactive/one-shot, shared tool loop and prompt/auto/read-only approvals.
  - [x] Cancellation, limits, meaningful exit codes and clean final JSON.

### CLI-023 · Project instructions and coding integration tests

- Status: DONE (2026-11-17)
- Depends on: CLI-020, CLI-022
- Acceptance criteria:
  - [x] Project AGENTS.md context and relevant nested instructions.
  - [x] Mock model inspect/edit/test/final workflow through both backends; traversal, stale edit and denied-action tests.

### CLI-024 · Persistent coding sessions/resume

- Status: DONE (2026-11-18)
- Depends on: CLI-022
- Description: profile-local private transcripts, resume by id, no API keys in stored data.
- Acceptance criteria:
  - [x] Atomic mode-0600 transcripts, workspace/backend/model binding and traversal-safe ids.
  - [x] `--resume <id>`, `--no-session`, JSON session id, `/new` reset and regression tests.

### CLI-025 · Coding terminal UI

- Status: DONE (2026-11-18)
- Depends on: CLI-022
- Description: vendor-style, keyboard-first coding UI while retaining stable plain and JSON modes.
- Acceptance criteria:
  - [x] TTY-only header, thinking state, tool/result rows, permission cards and final usage summary.
  - [x] Safe model rendering, Ctrl+C compatibility, `--plain`, piped/JSON fallback and UI tests.

### CLI-026 · Coding provider token streaming

- Status: DONE (2026-11-18)
- Depends on: CLI-025, BE-097
- Description: incremental model text/tool-call streaming behind the existing provider interface,
  including account and direct backends without weakening context or tool-call validation.
- Acceptance criteria:
  - [x] Direct OpenAI-compatible SSE text/tool-call assembly with response bounds and final validation.
  - [x] Account SSE endpoint streams normalized deltas and returns authoritative usage/charge.
  - [x] TUI/plain incremental rendering without duplicating the final model response.

## MC3 — Microsoft Forms local automation (superseded)

Contract and safety requirements: `../ai-harness-doc-project/docs/13-microsoft-forms-agent.md`.

### CLI-027 · Microsoft Forms native browser spike

- Status: CANCELED (2026-11-19) — superseded by hosted web worker D-013
- Description: validate visible Playwright inspection/fill/review on native macOS and Windows before
  committing to a backend API. Microsoft credentials and browser profiles remain local.
- Acceptance criteria:
  - [ ] Inspect and fill supported question types in owned fixture forms; stop before Submit.
  - [ ] Personal and work/school login, MFA/CAPTCHA handoff and form-change behavior documented.
  - [ ] Native macOS and Windows demos/tests; no credential, cookie or answer leakage.

### CLI-028 · Forms local runner and review workflow

- Status: CANCELED (2026-11-19) — superseded by hosted web worker D-013
- Depends on: CLI-027
- Acceptance criteria:
  - [ ] `forms inspect/run` semantic schema, mappings, fingerprint and visible review-before-submit.
  - [ ] Persistent local browser profile, safe navigation/file rules and redacted audit evidence.
  - [ ] Clear unsupported/headless errors and JSON for read commands.

### CLI-029 · Forms scheduled runner

- Status: CANCELED (2026-11-19) — superseded by hosted web worker D-013
- Depends on: CLI-028, BE-099
- Acceptance criteria:
  - [ ] Paired runner receives idempotent scheduled work and reports durable run states.
  - [ ] Native macOS/Windows start-at-login installation, pause/resume and missed-run behavior.

### CLI-030 · Forms controlled auto-submit

- Status: CANCELED (2026-11-19) — superseded by hosted web worker D-013
- Depends on: CLI-029
- Acceptance criteria:
  - [ ] Explicit non-persistent auto-submit permission; changed schemas always pause.
  - [ ] Duplicate and unknown-after-submit recovery; native end-to-end tests with owned forms.

## MC4 — Coding CLI follow-ups

### CLI-031 · Remember the selected coding model

- Status: DONE (2026-11-19)
- Depends on: CLI-022
- Acceptance criteria:
  - [x] `/model` saves the selected account model as the machine's coding default.
  - [x] New `harness code` sessions reuse the saved model when it remains available.
  - [x] Flags and environment variables retain precedence; removed models fall back safely.

### CLI-032 · Visible edits and discoverable coding sessions

- Status: DONE (2026-11-19)
- Depends on: CLI-024, CLI-025
- Acceptance criteria:
  - [x] Successful file edits stream a bounded redacted `-`/`+` diff in rich and plain modes.
  - [x] The header shows the active session; `/session` and `/sessions` expose resume instructions.
  - [x] `/diff` shows the bounded workspace Git diff under the existing permission policy.
