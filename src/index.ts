import { Command, CommanderError } from 'commander'
import pc from 'picocolors'
import { CliError, EXIT } from './api/errors.ts'
import { registerAuth } from './commands/auth.ts'
import { registerCode } from './commands/code.ts'
import { registerCompletion } from './commands/completion.ts'
import { registerConversations } from './commands/conversations.ts'
import { registerChat } from './commands/chat.ts'
import { registerOrgs } from './commands/orgs.ts'
import { registerResources } from './commands/resources.ts'
import { registerUpdate } from './commands/update.ts'
import { registerTemplates } from './commands/templates.ts'
import { VERSION } from './version.ts'

export function buildProgram(): Command {
  const program = new Command()
    .name('harness')
    .description('AI Harness — coding and always-on AI agents, from your terminal')
    .version(VERSION, '-v, --version')
    .option('--api-url <url>', 'API base URL (env HARNESS_API_URL)')
    .option('--org <id>', 'organization id (env HARNESS_ORG)')
    .option('--json', 'machine-readable output')
    .showHelpAfterError()
    .exitOverride()
  registerAuth(program)
  registerChat(program)
  registerResources(program)
  registerOrgs(program)
  registerConversations(program)
  registerTemplates(program)
  registerUpdate(program)
  registerCode(program)
  registerCompletion(program)
  program.addHelpText(
    'after',
    `
Examples:
  $ harness login
  $ harness code "Fix the failing tests" --cwd .
  $ harness ask "สรุปข่าว AI วันนี้ 5 ข้อ"
  $ git diff | harness ask "review this diff"
  $ harness templates use morning-news --schedule
  $ harness chat -a "News bot"
  $ harness schedules add "ทุกวัน 7 โมงเช้า" "สรุปข่าวให้หน่อย" --to line`,
  )
  return program
}

export async function main(argv = process.argv): Promise<number> {
  const program = buildProgram()
  try {
    await program.parseAsync(argv)
    return typeof process.exitCode === 'number' ? process.exitCode : EXIT.ok
  } catch (err) {
    if (err instanceof CommanderError) {
      // help/version print and "exit" with code 0; parse errors are usage errors
      return err.exitCode === 0 ? EXIT.ok : EXIT.usage
    }
    if (err instanceof CliError) {
      process.stderr.write(`${pc.red('Error:')} ${err.message}\n`)
      return err.exitCode
    }
    if (err instanceof Error && err.name === 'AbortError') return EXIT.error
    process.stderr.write(
      `${pc.red('Unexpected error:')} ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return EXIT.error
  }
}
