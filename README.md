# AI Harness CLI (`harness`)

Code in local projects and work with your always-on AI agents from the terminal.

```bash
npm i -g @ai-harness/cli        # (not published yet — see TASKS CLI-006)
harness login                    # opens the browser to approve this device
harness ask "สรุปข่าว AI วันนี้ 5 ข้อ"
git diff | harness ask "review this diff"
harness chat -a "News bot"       # interactive, streaming; /new, /exit
harness schedules add "ทุกวัน 7 โมงเช้า" "สรุปข่าวให้หน่อย" --to line
harness agents run "News bot" "check the price of BTC" --wait
harness approvals                # actions waiting for your OK
harness balance && harness usage --days 7
```

Every read command supports `--json`. Scripts/CI: `HARNESS_TOKEN=hk_… harness ask …`
(create a token in the web app → Settings → CLI & tokens).

| Env               | Meaning                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `HARNESS_API_URL` | API base URL (e.g. `http://localhost:13000` for the dev stack)                        |
| `HARNESS_TOKEN`   | access token (overrides the stored login)                                             |
| `HARNESS_ORG`     | organization id                                                                       |
| `HARNESS_CONFIG`  | config file path (default `~/.config/ai-harness/config.json`, `%APPDATA%` on Windows) |

Exit codes: 0 ok · 1 error · 2 usage · 3 not logged in / token invalid · 4 out of credits / plan limit.

## Coding agent

```bash
# Account models: use a ref from harness models
harness code "Fix the failing test and verify it" --cwd ./project --model <model-ref>

# Interactive session (type /new or /exit)
harness code --cwd ./project

# Direct provider: SaaS login/keychain is not loaded
export OPENAI_API_KEY=...
harness code "Add pagination and test it" --cwd ./project --backend direct --model <model-id>

# Keyless local OpenAI-compatible endpoint
harness code "Review this project" --cwd ./project --backend direct --base-url http://localhost:11434/v1 --model <model-id> --approval read-only

# Automation: explicitly grant actions and receive one final JSON result
harness code "Fix the bug and run tests" --cwd ./project --backend direct --model <model-id> --approval auto --max-steps 20 --json
```

Coding mode can list/read/search a workspace, make guarded text edits, create files, run test/shell
commands, inspect Git diff and iterate over model tool calls. It loads root/nested AGENTS.md, rejects
file traversal/symlink escapes, checks stale edits and bounds tool output/time/steps. Common secret
file patterns and Git metadata are excluded from file tools.

Default `--approval prompt` asks before writes and command execution (including Git diff, whose
repository filters can execute programs). `read-only` denies these; `auto` grants standing permission.
Shell commands run with your user permissions and workspace cwd; file-tool path guards are not an OS
shell sandbox. Noninteractive/JSON callers choose `auto` or `read-only` explicitly. Ctrl+C stops the
current model/tool operation; existing edits remain in place.

Account mode uses existing BYOK/platform models, entitlements, quotas and usage accounting. Direct
mode uses an OpenAI-compatible endpoint (`--base-url` / `OPENAI_BASE_URL`) and key environment variable
(`--api-key-env`, default OPENAI_API_KEY); the direct key is not sent to AI Harness. Direct native
Anthropic/Gemini protocols are follow-ups; they are available through the account gateway. Known CLI auth values are redacted from model/tool text,
and the CLI's selected auth environment variable is not inherited by test/shell commands. If a
project needs its own provider key for tests, use a separate variable for the coding agent key.
This does not isolate shell commands from other credentials accessible to your OS user.

This first coding mode has in-memory task history and per-step text/tool progress. Persistent resume
and richer TUI/token streaming are follow-up tasks. Once execution starts, JSON includes status,
summary/error, changed files and usage; configuration/auth failures before startup follow normal CLI
stderr/exit behavior. The model's final answer is not a substitute for reviewing its changes/tests.
Full contract and parallel-AI ownership: hub `docs/12-coding-cli.md` and `TASKS.md`.

## Token storage

The default stores a token in the config file with mode `0600`. To use the OS credential store:

```bash
harness login --keychain
harness credentials storage keychain    # migrate an existing saved login, no API call
harness credentials storage file        # explicitly return to file storage
harness login --no-keychain             # new file login, even if the old keychain is unavailable
```

Keychain mode stores only an opaque entry reference in JSON. It uses macOS Keychain, Windows
Credential Manager, or a persistent Secret Service on Linux (for example GNOME Keyring/KWallet).
Linux needs an unlocked Secret Service and a session D-Bus; headless servers can use file storage
or `HARNESS_TOKEN`. A missing native binding, locked store, or missing entry produces an error and
never falls back to a plaintext file automatically. Flag/environment tokens override keychain lookup.
The native binding is optional so file storage still works on unsupported platforms.

Logout revokes the saved login against its saved API endpoint before removing the local credential.
A revocation/network failure preserves the login so you can retry. Config updates use atomic
replacement. Keychain behavior has unit/integration coverage, including real write/read/migration/logout in an isolated Linux Secret Service and an
unavailable-store check. Native macOS/Windows keychain validation is still pending.

## Organization selection

```bash
harness orgs ls --json
harness orgs use                 # interactive picker
harness orgs use <id-or-name>    # scripts: id or unique exact name
```

The selection is saved locally and clears the default agent from the previous organization.
`--org` and `HARNESS_ORG` still override the saved default. Listing/selection can repair a stale
saved organization even after you lose membership.

## Terminal Markdown

```bash
harness chat --markdown
harness ask "Write a short guide" --markdown
```

Opt in to formatting headings, bold text, inline/fenced code, bullet lists, quotes and links.
The current line is buffered until a newline, a tool event or the end of the reply; very long lines
are flushed as plain text to keep output moving. This is a small renderer, not full CommonMark.
JSON output retains the original Markdown and never includes terminal formatting. Without this
flag, text streams directly as before.

## Conversation history

```bash
harness conversations ls --query "meeting" --limit 20
harness conversations ls --cursor <nextCursor> --json
harness conversations show <conversationId>
harness conversations show <conversationId> --before <firstMessageId> --limit 100 --json
harness chat -c <conversationId>    # continue an existing conversation
```

Lists return one page, newest conversation first. Message pages show the latest messages in
chronological order; `--before` loads older messages. Human output prints pagination hints to stderr.
`--json` preserves the API response, including `nextCursor` / `hasMore` and full message content.
Images are shown as `[image]` in human output.

## Shell completion

After installing the CLI (or putting its built executable on PATH), load the script in your shell:

```bash
# Bash: add to ~/.bashrc
source <(harness completion bash)

# Zsh: after `autoload -Uz compinit; compinit` in ~/.zshrc
source <(harness completion zsh)

# Fish: add to ~/.config/fish/config.fish
harness completion fish | source
```

```powershell
# PowerShell 7.3+: add to $PROFILE
harness completion powershell | Out-String | Invoke-Expression
```

Completion suggests commands, subcommands and flags, including built-in help and implicit
list-command options such as `conversations --limit` without typing `ls`. It does not complete account data or option
values, read saved credentials, or contact the API. Bash/Zsh/Fish adapter execution is tested on Linux; Fish uses its completion engine and Zsh
tests token handling with a compadd stub (interactive ZLE remains untested). PowerShell 7.4
is tested on Linux through its completion engine, including legacy argument passing, quoted
words and Thai organization names. The adapter encodes its argument list to preserve empty
words through Windows npm `.cmd` shims; actual Windows execution remains pending CI.

## Release preparation (CLI-006)

The package has been packed, installed in a clean temporary project, and smoke-tested locally:

```bash
pnpm verify:package
```

This also checks that file-storage commands work without optional native keychain dependencies.
`pnpm build` checks the CLI version against `package.json`; `pnpm version patch` updates both files.

Before the first registry release, the owner must create the intended GitHub repository
`bhumirath/ai-harness-cli-project`, ensure publishing access to the npm scope `@ai-harness`, and
bootstrap the package if npm requires an initial authenticated publish. Configure npm Trusted
Publishing for that repository and `.github/workflows/release.yml` (Node 22, npm 11, OIDC).
The package's `repository.url` must match the actual repository.

Once those are configured, pushing a `v<package-version>` tag runs checks, installs and verifies
the tarball, and publishes that same archive. Stable versions use `latest`; prereleases use `next`.
Provenance is generated automatically where npm supports it (public source repositories).
No registry publish or release tag has been created in this session.

### Update checks

```bash
harness update-check
harness update-check --json
```

This explicitly checks the npm `latest` tag with a five-second timeout and shows an upgrade notice.
It needs no login and sends no token; ordinary commands never make update-check requests.

### Standalone binaries

```bash
pnpm build:sea
```

Builds for the current host with Node 22 SEA, bundles JavaScript dependencies, includes dependency
licenses and a SHA-256 checksum, then smoke-tests a copy in an empty directory with no Node on PATH.
The smoke check covers CLI help/version/completion, local credentials, an authenticated HTTP request,
and safe failure when native keychain addons are absent.

Standalone binaries support file/env token storage. Use the npm distribution for native OS keychain
support. The binary workflow (`binaries.yml`, tags or manual dispatch) builds native Linux/macOS/Windows
artifacts. Linux x64 has been built and tested locally; macOS/Windows CI runs are still pending.
macOS builds receive an ad-hoc signature; Windows builds are unsigned. Signing/notarization with
owner certificates is not configured.

Development: see `AGENTS.md`.

## Native Linux verification

```bash
pnpm test:native:linux
```

Requires Docker on Linux. The isolated container installs Bash/Zsh/Fish, D-Bus and GNOME Keyring;
mounts only the built CLI, dependencies, package metadata and native tests as read-only; and uses
a disposable home/config/keyring. It never reads or changes the host desktop keyring. Tests cover
command prefixes, empty completion words, global option values and real keychain migration/logout.
The native-linux CI job runs the same check.

PowerShell completion also has an isolated Linux test:

```bash
pnpm test:native:powershell
```

On Windows CI, `pnpm test:native:powershell:windows` runs the same cases through a real
`.cmd` wrapper matching npm's shim. This Windows check is configured but has not run locally.
