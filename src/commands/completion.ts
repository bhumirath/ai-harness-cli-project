import type { Command, Option } from 'commander'
import { CliError, EXIT } from '../api/errors.ts'

const defaultCommands = new WeakMap<Command, Command>()

/** Keep completion metadata alongside registration, without relying on Commander internals. */
export function defaultCommand(parent: Command, name: string): Command {
  const child = parent.command(name, { isDefault: true })
  defaultCommands.set(parent, child)
  return child
}

function optionsFor(command: Command): Option[] {
  return [
    ...command.createHelp().visibleOptions(command),
    ...(command.parent ? optionsFor(command.parent) : []),
  ]
}

function matchOption(
  options: Option[],
  word: string,
): { option: Option; attached: boolean } | undefined {
  for (const option of options) {
    if (option.long === word.split('=')[0] || option.short === word)
      return { option, attached: word.includes('=') }
    if (
      option.short &&
      (option.required || option.optional) &&
      word.startsWith(option.short) &&
      word.length > option.short.length
    )
      return { option, attached: true }
  }
  return undefined
}

/** Only inspect Commander metadata: completion must never load credentials or call the API. */
export function completionCandidates(program: Command, words: string[]): string[] {
  const prefix = words.at(-1) ?? ''
  let command = program
  let value = false
  let positional = false
  for (const word of words.slice(0, -1)) {
    if (value) {
      value = false
      continue
    }
    if (word === '--') return []
    if (word.startsWith('-')) {
      let match = matchOption(optionsFor(command), word)
      if (!match) {
        const fallback = defaultCommands.get(command)
        if (fallback) {
          match = matchOption(fallback.createHelp().visibleOptions(fallback), word)
          if (match) command = fallback
        }
      }
      if (match && !match.attached) value = match.option.required || match.option.optional
      continue
    }
    const child = command.commands.find((c) => c.name() === word || c.aliases().includes(word))
    if (child && !positional) command = child
    else positional = true
  }
  if (value) return []
  const fallback = defaultCommands.get(command)
  const flags = [
    ...optionsFor(command),
    ...(fallback ? fallback.createHelp().visibleOptions(fallback) : []),
  ]
    .filter((o) => !o.hidden)
    .flatMap((o) => [o.short, o.long].filter((v): v is string => Boolean(v)))
  const names =
    positional || prefix.startsWith('-')
      ? []
      : command
          .createHelp()
          .visibleCommands(command)
          .filter((c) => !c.name().startsWith('__'))
          .flatMap((c) => [c.name(), ...c.aliases()])
  return [...new Set([...names, ...flags])].filter((s) => s.startsWith(prefix)).sort()
}

const scripts: Record<string, string[]> = {
  bash: [
    '_harness_complete() {',
    '  local candidate',
    '  COMPREPLY=()',
    '  while IFS= read -r candidate; do',
    '    [[ -n "$candidate" ]] && COMPREPLY+=("$candidate")',
    '  done < <(harness __complete -- "${COMP_WORDS[@]:1:COMP_CWORD}")',
    '}',
    'complete -F _harness_complete harness',
  ],
  zsh: [
    '#compdef harness',
    '_harness_complete() {',
    '  local -a candidates',
    '  candidates=("${(@f)$(harness __complete -- "${words[@]:1:$((CURRENT-1))}")}")',
    '  (( ${#candidates} )) && compadd -- "${candidates[@]}"',
    '}',
    'compdef _harness_complete harness',
  ],
  fish: [
    'function __harness_candidates',
    '  set -l words (commandline -opc)',
    '  set -l current (commandline -ct)',
    '  harness __complete -- $words[2..-1] "$current"',
    'end',
    "complete -c harness -f -a '(__harness_candidates)'",
  ],
  powershell: [
    'Register-ArgumentCompleter -Native -CommandName harness -ScriptBlock {',
    '  param($wordToComplete, $commandAst, $cursorPosition)',
    '  $elements = @($commandAst.CommandElements | Select-Object -Skip 1 | Where-Object { $_.Extent.StartOffset -lt $cursorPosition })',
    '  $words = @($elements | ForEach-Object { $_.Extent.Text })',
    '  if ($wordToComplete) {',
    '    if ($words.Count) { $words[$words.Count - 1] = $wordToComplete }',
    '  } else { $words += "" }',
    '  harness __complete -- @words | ForEach-Object {',
    '    [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)',
    '  }',
    '}',
  ],
}

export function registerCompletion(program: Command): void {
  program
    .command('__complete [words...]', { hidden: true })
    .allowUnknownOption()
    .action((words: string[]) => {
      const candidates = completionCandidates(program, words)
      if (candidates.length) process.stdout.write(`${candidates.join('\n')}\n`)
    })
  program
    .command('completion <shell>')
    .description('Print shell completion script: bash | zsh | fish | powershell')
    .action((shell: string) => {
      if (!Object.hasOwn(scripts, shell))
        throw new CliError('Shell must be bash, zsh, fish or powershell', { exitCode: EXIT.usage })
      process.stdout.write(`${scripts[shell]!.join('\n')}\n`)
    })
}
