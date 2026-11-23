import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import { stripVTControlCharacters } from 'node:util'
import pc from 'picocolors'
import { apiFor, globals } from '../context.ts'
import { unwrap } from '../api/client.ts'
import { CliError, EXIT } from '../api/errors.ts'
import { printJson } from '../output.ts'
import { accountProvider, directProvider } from '../coding/providers.ts'
import { codingRun } from '../coding/loop.ts'
import { WorkspaceTools } from '../coding/tools.ts'
import { CodeTui } from '../coding/tui.ts'
import { systemPrompt, type AgentMode } from '../coding/prompt.ts'
import { ChangeHistory } from '../coding/snapshots.ts'
import { compactMessages, expandMentions } from '../coding/context.ts'
import { formatTodos } from '../coding/loop.ts'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Permissions, parsePermissionConfig } from '../coding/permissions.ts'
import { SessionStore, type CodingSession } from '../coding/sessions.ts'
import type { ApprovalMode, CodeMessage, CodeProvider } from '../coding/types.ts'
import type { ProgressEvent } from '../coding/loop.ts'
import { configPath, loadConfig, saveConfig } from '../config.ts'

type CodingModel = {
  ref: string
  contextWindow?: number
  modelId: string
  displayName: string
  provider: string
  supportsTools: boolean
}

const unsuitableInteractiveModel = /(?:audio|image|realtime|live)|^chat-latest$/i
const approvalModes = ['prompt', 'read-only', 'auto'] as const

export function parseApprovalMode(value: string): ApprovalMode | undefined {
  return approvalModes.find((mode) => mode === value)
}

const slashCommands = [
  '/model',
  '/plan',
  '/build',
  '/undo',
  '/redo',
  '/permission',
  '/approval',
  '/session',
  '/sessions',
  '/diff',
  '/compact',
  '/new',
  '/help',
  '/exit',
  '/quit',
]

export function slashCompletions(line: string, models: CodingModel[] = []): string[] {
  const candidates = line.startsWith('/model ')
    ? models
        .filter((model) => model.supportsTools && !unsuitableInteractiveModel.test(model.modelId))
        .flatMap((model) => [`/model ${model.modelId}`, `/model ${model.ref}`])
    : line.startsWith('/permission ') || line.startsWith('/approval ')
      ? approvalModes.map(
          (mode) => `${line.startsWith('/approval ') ? '/approval' : '/permission'} ${mode}`,
        )
      : slashCommands
  return [...new Set(candidates.filter((candidate) => candidate.startsWith(line)))]
}

function printSlashHelp(): void {
  process.stderr.write(
    `\nCommands:\n  /model              choose and remember a coding model\n  /model <id>         switch directly by model id or ref\n  /permission         choose prompt, read-only, or auto\n  /plan               switch to the read-only plan agent\n  /build              switch to the build agent (edits and commands)\n  /undo [--force]     revert the agent's file edits from the last turn\n  /redo [--force]     re-apply the last undone edits\n  /session            show the current resumable session\n  /sessions           list saved coding sessions\n  /diff                show the current workspace diff\n  /compact             summarize older conversation to free context\n  /new                 clear the current conversation context\n  /help                show this command list\n  /exit                leave coding mode\n\nResume later with: harness code --resume <session-id>\nTip: type part of a command and press Tab to complete it.\n`,
  )
}

export function preferredCodingModel(models: CodingModel[]): CodingModel | undefined {
  const usable = models.filter(
    (model) => model.supportsTools && !unsuitableInteractiveModel.test(model.modelId),
  )
  return (
    usable.find((model) => model.modelId === 'gpt-4.1') ??
    usable.find((model) => /codex/i.test(model.modelId)) ??
    usable[0]
  )
}

export function resolveCodingModel(
  models: CodingModel[],
  requested?: string,
): CodingModel | undefined {
  const usable = models.filter(
    (model) => model.supportsTools && !unsuitableInteractiveModel.test(model.modelId),
  )
  if (requested) {
    const match = usable.find((model) => model.ref === requested || model.modelId === requested)
    if (match) return match
  }
  return preferredCodingModel(usable)
}

export function registerCode(program: Command): void {
  program
    .command('code [task...]')
    .description('Code in a local project: inspect, edit and run tests with an AI agent')
    .option('--cwd <path>', 'workspace root', '.')
    .option('--backend <backend>', 'harness | direct', 'harness')
    .option('--model <id>', 'AI Harness model ref, or direct model id')
    .option('--base-url <url>', 'direct OpenAI-compatible base URL (env OPENAI_BASE_URL)')
    .option(
      '--api-key-env <name>',
      'environment variable holding the direct API key',
      'OPENAI_API_KEY',
    )
    .option('--approval <mode>', 'prompt | auto | read-only', 'prompt')
    .option(
      '-y, --yes',
      'approve edits, commands and web requests without asking (--approval auto)',
    )
    .option('--agent <mode>', 'build (edit and run) | plan (read-only analysis)', 'build')
    .option('--max-steps <n>', 'maximum model turns per task', '50')
    .option(
      '--context-tokens <n>',
      'model context window used for automatic compaction (default: model metadata or 128000)',
    )
    .option(
      '--max-output-tokens <n>',
      'maximum tokens per model response (harness 64..4096, direct 64..32768)',
      '4096',
    )
    .option('--plain', 'disable the interactive coding UI')
    .option('--resume <id>', 'resume a private local coding session')
    .option('--no-session', 'do not save this coding session')
    .action(
      async (
        words: string[],
        opts: {
          cwd: string
          backend: string
          model?: string
          baseUrl?: string
          apiKeyEnv: string
          approval: string
          yes?: boolean
          agent: string
          maxSteps: string
          contextTokens?: string
          maxOutputTokens: string
          plain?: boolean
          resume?: string
          session: boolean
        },
        cmd: Command,
      ) => {
        if (!['harness', 'direct'].includes(opts.backend) || !parseApprovalMode(opts.approval))
          throw new CliError('Invalid --backend or --approval', { exitCode: EXIT.usage })
        if (opts.agent !== 'build' && opts.agent !== 'plan')
          throw new CliError('--agent must be build or plan', { exitCode: EXIT.usage })
        if (opts.yes) {
          if (cmd.getOptionValueSource('approval') !== 'default' && opts.approval !== 'auto')
            throw new CliError('--yes conflicts with --approval', { exitCode: EXIT.usage })
          opts.approval = 'auto'
        }
        if (
          !/^\d+$/.test(opts.maxSteps) ||
          Number(opts.maxSteps) < 1 ||
          Number(opts.maxSteps) > 200
        )
          throw new CliError('--max-steps must be 1..200', { exitCode: EXIT.usage })
        const maxOutputTokens = Number(opts.maxOutputTokens)
        if (
          !/^\d+$/.test(opts.maxOutputTokens) ||
          maxOutputTokens < 64 ||
          maxOutputTokens > (opts.backend === 'direct' ? 32768 : 4096)
        )
          throw new CliError(
            `--max-output-tokens must be 64..${opts.backend === 'direct' ? 32768 : 4096}`,
            { exitCode: EXIT.usage },
          )
        if (opts.backend === 'harness' && opts.baseUrl)
          throw new CliError('--base-url is for the direct backend', { exitCode: EXIT.usage })
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.apiKeyEnv))
          throw new CliError('Invalid API key environment variable name', { exitCode: EXIT.usage })
        if (
          opts.contextTokens !== undefined &&
          (!/^\d+$/.test(opts.contextTokens) ||
            Number(opts.contextTokens) < 8000 ||
            Number(opts.contextTokens) > 10_000_000)
        )
          throw new CliError('--context-tokens must be 8000..10000000', { exitCode: EXIT.usage })
        const json = Boolean(globals(cmd).json)
        const interactive = words.length === 0
        if (!interactive && !words.join(' ').trim())
          throw new CliError('Coding task must not be empty', { exitCode: EXIT.usage })
        if (interactive && (json || !process.stdin.isTTY))
          throw new CliError('Pass a coding task in scripts/JSON mode', { exitCode: EXIT.usage })
        if (opts.approval === 'prompt' && (!process.stdin.isTTY || json))
          throw new CliError(
            'Choose --yes, --approval auto or --approval read-only in scripts/JSON mode',
            {
              exitCode: EXIT.usage,
            },
          )
        let workspace: WorkspaceTools
        try {
          workspace = await WorkspaceTools.open(opts.cwd)
        } catch {
          throw new CliError('Cannot open the selected workspace directory', {
            exitCode: EXIT.usage,
          })
        }
        const sessions = new SessionStore()
        let session: CodingSession | undefined
        if (opts.resume) {
          try {
            session = await sessions.load(opts.resume)
          } catch (error) {
            throw new CliError(
              error instanceof Error ? error.message : 'Cannot load coding session',
              { exitCode: EXIT.usage },
            )
          }
          if (session.cwd !== workspace.root)
            throw new CliError(`Session belongs to a different workspace: ${session.cwd}`, {
              exitCode: EXIT.usage,
            })
          if (cmd.getOptionValueSource('backend') === 'default') opts.backend = session.backend
          else if (opts.backend !== session.backend)
            throw new CliError(`Session uses the ${session.backend} backend`, {
              exitCode: EXIT.usage,
            })
          opts.model ??= session.model
        }
        let provider: CodeProvider
        let selectedModel: string
        let accountApi: ReturnType<typeof apiFor> | undefined
        let availableModels: CodingModel[] = []
        if (opts.backend === 'direct') {
          const model = opts.model ?? process.env.HARNESS_CODE_MODEL
          if (!model)
            throw new CliError('Direct coding needs --model (or HARNESS_CODE_MODEL)', {
              exitCode: EXIT.usage,
            })
          workspace.protectCredentials([process.env[opts.apiKeyEnv]], [opts.apiKeyEnv])
          selectedModel = model
          provider = directProvider(
            model,
            opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
            process.env[opts.apiKeyEnv],
            maxOutputTokens,
          )
        } else {
          const api = apiFor(cmd)
          accountApi = api
          availableModels = await unwrap(api.client.GET('/api/models'), api.settings.apiUrl)
          const stored = loadConfig()
          const requested = opts.model ?? process.env.HARNESS_CODE_MODEL ?? stored.codeModel
          const resolved = resolveCodingModel(availableModels, requested)
          let model = opts.model ?? process.env.HARNESS_CODE_MODEL ?? resolved?.ref
          if (!model)
            throw new CliError(
              'No tool-capable model is available; configure a model in AI Harness',
              { exitCode: EXIT.usage },
            )
          workspace.protectCredentials([api.settings.token], ['HARNESS_TOKEN'])
          selectedModel = model
          provider = accountProvider(api, model, maxOutputTokens)
        }
        const permissions = new Permissions(
          opts.approval as ApprovalMode,
          parsePermissionConfig(loadConfig().codePermissions),
          opts.agent as AgentMode,
        )
        const contextTokens = () =>
          opts.contextTokens
            ? Number(opts.contextTokens)
            : (availableModels.find((model) => model.ref === selectedModel)?.contextWindow ??
              128_000)
        let userInstructions: string | undefined
        try {
          userInstructions = readFileSync(join(dirname(configPath()), 'AGENTS.md'), 'utf8')
        } catch {
          /* optional */
        }
        const projectContext = workspace.redact(await workspace.context(userInstructions))
        const history = new ChangeHistory(workspace)
        const notes: string[] = []
        const messages: CodeMessage[] = [
          {
            role: 'system',
            content: systemPrompt(permissions.agent, projectContext),
          },
        ]
        if (session) {
          messages.splice(1, 0, ...session.messages.filter((message) => message.role !== 'system'))
        } else if (opts.session) {
          session = sessions.create(
            workspace.root,
            opts.backend as 'harness' | 'direct',
            selectedModel,
          )
        }
        const tui = CodeTui.supported(process.stderr, json, Boolean(opts.plain))
          ? new CodeTui(process.stderr)
          : undefined
        if (tui)
          tui.header({
            workspace: workspace.redact(workspace.root),
            backend: opts.backend,
            model: workspace.redact(selectedModel),
            approval: opts.approval,
            agent: permissions.agent,
            session: session?.id,
          })
        else
          process.stderr.write(
            `Coding workspace: ${workspace.redact(JSON.stringify(workspace.root))}; backend: ${opts.backend}; approval: ${opts.approval}; agent: ${permissions.agent}${session ? `; session: ${session.id}` : ''}\n`,
          )
        const terminal =
          process.stdin.isTTY && !json
            ? createInterface({
                input: process.stdin,
                output: process.stderr,
                completer: (line: string): [string[], string] => [
                  slashCompletions(line, availableModels),
                  line,
                ],
              })
            : undefined
        let current: AbortController | undefined
        const interrupt = () => {
          if (current) current.abort(new DOMException('Canceled', 'AbortError'))
          else terminal?.close()
        }
        process.on('SIGINT', interrupt)
        terminal?.on('SIGINT', interrupt)
        const progress = ({ type, text, final }: ProgressEvent) => {
          if (tui) {
            tui.progress({ type, text: workspace.redact(text), final })
            return
          }
          if (type === 'status') return
          if (type === 'delta') {
            process.stderr.write(workspace.redact(stripVTControlCharacters(text)))
            return
          }
          if (final && !interactive && !json) return
          process.stderr.write(
            `${type === 'text' ? '' : '  '}${workspace.redact(stripVTControlCharacters(text))}\n`,
          )
        }
        try {
          let task = words.join(' ').trim()
          for (;;) {
            if (!task) {
              try {
                task = (await terminal!.question(tui?.prompt() ?? 'code › ')).trim()
              } catch {
                break
              }
            }
            if (!task) continue
            if (interactive && (task === '/exit' || task === '/quit')) break
            if (interactive && (task === '/' || task === '/help')) {
              printSlashHelp()
              task = ''
              continue
            }
            if (interactive && task === '/new') {
              messages.splice(1)
              workspace.changedFiles.clear()
              if (session) {
                session.messages = []
                await sessions.save(session)
              }
              task = ''
              continue
            }
            if (interactive && task === '/session') {
              process.stderr.write(
                session
                  ? `Session: ${session.id}\nResume: harness code --resume ${session.id}\n`
                  : 'Session saving is disabled for this run.\n',
              )
              task = ''
              continue
            }
            if (interactive && task === '/sessions') {
              const saved = await sessions.list()
              if (!saved.length) process.stderr.write('No saved coding sessions yet.\n')
              else {
                process.stderr.write('\nSaved coding sessions:\n')
                for (const item of saved.slice(0, 20))
                  process.stderr.write(
                    `  ${item.id}${item.id === session?.id ? ' (current)' : ''} · ${item.backend} · ${workspace.redact(item.model)} · ${workspace.redact(item.cwd)}\n`,
                  )
                process.stderr.write('\nResume with: harness code --resume <session-id>\n')
              }
              task = ''
              continue
            }
            if (interactive && task === '/diff') {
              const decision = permissions.check('git_diff', {})
              let allowed = decision === 'allow'
              if (decision === 'ask') {
                tui?.approval('git_diff', {})
                allowed = /^y(es)?$/i.test((await terminal!.question('Allow? [y/N] ')).trim())
              }
              if (!allowed) process.stderr.write('Workspace diff denied by permission policy.\n')
              else {
                const diff = await workspace.execute('git_diff', {}, new AbortController().signal)
                if (!diff.ok)
                  process.stderr.write(`Cannot read diff: ${String(diff.stderr ?? diff.error)}\n`)
                else process.stderr.write(`${String(diff.stdout || 'No workspace changes.')}\n`)
              }
              task = ''
              continue
            }
            if (interactive && (task === '/model' || task.startsWith('/model '))) {
              if (!accountApi) {
                process.stderr.write(
                  'Changing models in-session is available with the harness backend.\n',
                )
                task = ''
                continue
              }
              availableModels = await unwrap(
                accountApi.client.GET('/api/models'),
                accountApi.settings.apiUrl,
              )
              const choices = availableModels.filter(
                (model) => model.supportsTools && !unsuitableInteractiveModel.test(model.modelId),
              )
              const requested = task.slice('/model'.length).trim()
              let chosen = requested
                ? choices.find((model) => model.ref === requested || model.modelId === requested)
                : undefined
              if (!requested) {
                process.stderr.write('\nAvailable coding models:\n')
                choices.forEach((model, index) => {
                  const current = model.ref === selectedModel ? ' (current)' : ''
                  process.stderr.write(
                    `  ${index + 1}. ${model.displayName || model.modelId} · ${model.provider}${current}\n`,
                  )
                })
                const answer = (
                  await terminal!.question('Select model number (blank to cancel): ')
                ).trim()
                if (answer) {
                  const number = Number(answer)
                  if (Number.isInteger(number) && number >= 1 && number <= choices.length)
                    chosen = choices[number - 1]
                }
              }
              if (!chosen) {
                process.stderr.write(
                  requested ? `Unknown coding model: ${requested}\n` : 'Canceled.\n',
                )
                task = ''
                continue
              }
              selectedModel = chosen.ref
              provider = accountProvider(accountApi, selectedModel, maxOutputTokens)
              const stored = loadConfig()
              saveConfig({ ...stored, codeModel: selectedModel })
              if (session) {
                session.model = selectedModel
                await sessions.save(session)
              }
              process.stderr.write(
                `Model changed to ${chosen.displayName || chosen.modelId} and saved as the default.\n`,
              )
              task = ''
              continue
            }
            if (
              interactive &&
              (task === '/permission' ||
                task.startsWith('/permission ') ||
                task === '/approval' ||
                task.startsWith('/approval '))
            ) {
              const command = task.startsWith('/approval') ? '/approval' : '/permission'
              const requested = task.slice(command.length).trim()
              let chosen = requested ? parseApprovalMode(requested) : undefined
              if (!requested) {
                process.stderr.write(
                  `\nPermission modes:\n  1. prompt${opts.approval === 'prompt' ? ' (current)' : ''} — ask before writes and commands\n  2. read-only${opts.approval === 'read-only' ? ' (current)' : ''} — deny writes and commands\n  3. auto${opts.approval === 'auto' ? ' (current)' : ''} — allow writes and commands without asking\n`,
                )
                const answer = (
                  await terminal!.question('Select permission number (blank to cancel): ')
                ).trim()
                if (answer) chosen = approvalModes[Number(answer) - 1]
              }
              if (!chosen) {
                process.stderr.write(
                  requested ? `Unknown permission mode: ${requested}\n` : 'Canceled.\n',
                )
                task = ''
                continue
              }
              opts.approval = chosen
              permissions.mode = chosen
              process.stderr.write(
                `Permission changed to ${chosen}${chosen === 'auto' ? ' for this run only' : ''}.\n`,
              )
              task = ''
              continue
            }
            const undoMatch = /^\/(undo|redo)(?:\s+(--force))?$/.exec(task)
            if (interactive && undoMatch) {
              const undo = undoMatch[1] === 'undo'
              const reverted = undo
                ? await history.undo(Boolean(undoMatch[2]))
                : await history.redo(Boolean(undoMatch[2]))
              if (!reverted.ok) {
                process.stderr.write(
                  `${reverted.error}${reverted.conflicts.length ? `: ${reverted.conflicts.map((file) => workspace.redact(file)).join(', ')}` : ''}\n`,
                )
              } else {
                for (const diff of reverted.diffs) progress({ type: 'diff', text: diff })
                process.stderr.write(
                  `${undo ? 'Undid' : 'Redid'} "${workspace.redact(reverted.label ?? '')}": ${reverted.files.map((file) => workspace.redact(file)).join(', ')}\n`,
                )
                notes.push(
                  `[The user ${undo ? 'reverted' : 're-applied'} the file changes from the turn "${reverted.label}" (${reverted.files.join(', ')}). Read files again before editing them.]`,
                )
              }
              task = ''
              continue
            }
            if (interactive && task === '/compact') {
              current = new AbortController()
              try {
                tui?.progress({ type: 'status', text: 'Compacting conversation' })
                const compaction = await compactMessages(provider, messages, current.signal, {
                  keep: 2,
                  todos: formatTodos(workspace.todos),
                })
                tui?.finishTurn()
                process.stderr.write(
                  compaction.compacted
                    ? `Compacted ${compaction.removed} messages into a summary.\n`
                    : 'Nothing to compact yet.\n',
                )
                if (session && compaction.compacted) {
                  session.messages = messages.map((message) => ({ ...message }))
                  await sessions.save(session)
                }
              } catch (error) {
                tui?.finishTurn()
                process.stderr.write(
                  `Compaction failed: ${error instanceof Error ? stripVTControlCharacters(error.message) : 'error'}\n`,
                )
              } finally {
                current = undefined
              }
              task = ''
              continue
            }
            if (interactive && (task === '/plan' || task === '/build')) {
              const mode: AgentMode = task === '/plan' ? 'plan' : 'build'
              permissions.agent = mode
              messages[0] = { role: 'system', content: systemPrompt(mode, projectContext) }
              tui?.notice(
                mode === 'plan'
                  ? 'Plan agent: read-only analysis; edits and commands are disabled.'
                  : 'Build agent: edits and commands follow the permission policy.',
              )
              if (!tui) process.stderr.write(`Switched to the ${mode} agent.\n`)
              task = ''
              continue
            }
            if (interactive && task.startsWith('/')) {
              process.stderr.write(
                `Unknown command: ${task}. Type /help to see available commands.\n`,
              )
              task = ''
              continue
            }
            const mentioned = await expandMentions(task, workspace)
            if (mentioned.attached.length)
              progress({ type: 'notice', text: `Attached ${mentioned.attached.join(', ')}` })
            const content = notes.length
              ? `${notes.splice(0).join('\n')}\n\n${mentioned.content}`
              : mentioned.content
            messages.push({ role: 'user', content: workspace.redact(content) })
            history.begin(task)
            current = new AbortController()
            const result = await codingRun(provider, workspace, messages, {
              maxSteps: Number(opts.maxSteps),
              contextTokens: contextTokens(),
              signal: current.signal,
              approval: opts.approval as ApprovalMode,
              progress,
              permissions,
              confirm: terminal
                ? async (name, args) => {
                    tui?.approval(name, args)
                    const always = permissions.grantLabel(name, args)
                    const question = tui
                      ? `${pc.bold('Allow?')} [y]es / [a]lways for ${always} this session / [N]o `
                      : `Allow ${name === 'git_diff' ? 'workspace git diff (repository filters may execute)' : name} ${JSON.stringify(args)}? [y/a/N] `
                    const answer = (
                      await terminal.question(question, { signal: current!.signal })
                    ).trim()
                    if (/^a(lways)?$/i.test(answer)) return 'always'
                    return /^y(es)?$/i.test(answer)
                  }
                : undefined,
            })
            current = undefined
            await history.commit()
            if (session) {
              session.messages = messages.map((message) => ({ ...message }))
              await sessions.save(session)
            }
            if (json)
              printJson({
                ...result,
                backend: opts.backend,
                cwd: workspace.root,
                ...(session ? { sessionId: session.id } : {}),
              })
            else {
              if (interactive) tui?.finishTurn()
              else tui?.result(result)
              if (result.error) process.stderr.write(`${stripVTControlCharacters(result.error)}\n`)
              if (!interactive && result.summary && !tui)
                process.stdout.write(`${stripVTControlCharacters(result.summary)}\n`)
              if (!interactive) {
                process.stderr.write(
                  `Status: ${result.status}; steps: ${result.steps}; files: ${result.changedFiles.join(', ') || '(none)'}\n`,
                )
                if (session) process.stderr.write(`Session: ${session.id}\n`)
              }
            }
            if (!interactive) {
              if (result.status !== 'completed') process.exitCode = result.exitCode ?? EXIT.error
              break
            }
            if (result.status === 'canceled' || result.status === 'failed') {
              messages.splice(1)
              workspace.changedFiles.clear()
            }
            task = ''
          }
        } finally {
          process.off('SIGINT', interrupt)
          tui?.close()
          terminal?.close()
        }
      },
    )
}
