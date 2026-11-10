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

Development: see `AGENTS.md`.
