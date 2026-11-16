# AI Harness CLI (`harness`)

Talk to your always-on AI agents from the terminal.

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
replacement. Keychain behavior has unit/integration coverage, including a real unavailable-store
check on Linux; successful native storage still needs validation on desktop macOS/Windows/Linux.

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
# PowerShell 7.3+: add to $PROFILE (preserves empty native arguments)
harness completion powershell | Out-String | Invoke-Expression
```

Completion suggests commands, subcommands and flags. It does not complete account data or option
values, read saved credentials, or contact the API. Bash execution is tested on Linux; the other
shell scripts need native platform verification.

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
No registry publish or release tag has been created in this session. Update notices and standalone
binaries remain part of CLI-006; native keychain dependencies need to be considered for binaries.

Development: see `AGENTS.md`.
