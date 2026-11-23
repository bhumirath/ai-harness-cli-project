import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_COMMANDS,
  expandTemplate,
  helpText,
  loadCustomCommands,
  parseCommandFile,
} from '../src/coding/slash.ts'
import { WorkspaceTools } from '../src/coding/tools.ts'
import { slashCompletions } from '../src/commands/code.ts'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-slash-'))
  temporary.push(root)
  return root
}

describe('slash commands', () => {
  it('lists every required built-in command', () => {
    const names = BUILTIN_COMMANDS.map((command) => command.name)
    for (const name of [
      '/help',
      '/model',
      '/sessions',
      '/new',
      '/undo',
      '/redo',
      '/compact',
      '/plan',
      '/build',
      '/init',
      '/exit',
    ])
      expect(names).toContain(name)
    expect(slashCompletions('/un')).toEqual(['/undo'])
    expect(slashCompletions('/in')).toEqual(['/init'])
  })

  it('parses front matter and expands arguments', () => {
    expect(parseCommandFile('---\ndescription: "Run tests"\n---\nRun $ARGUMENTS now')).toEqual({
      description: 'Run tests',
      template: 'Run $ARGUMENTS now',
    })
    expect(parseCommandFile('Just text\n')).toEqual({ description: '', template: 'Just text' })
    expect(expandTemplate('Fix $1 in $2; all: $ARGUMENTS', 'bug src/a.ts')).toBe(
      'Fix bug in src/a.ts; all: bug src/a.ts',
    )
    expect(expandTemplate('Review the code', 'focus on errors')).toBe(
      'Review the code\n\nfocus on errors',
    )
    expect(expandTemplate('Review $ARGUMENTS', '')).toBe('Review ')
  })

  it('loads project and user commands; project wins and built-ins cannot be overridden', async () => {
    const root = await directory()
    const user = await directory()
    await mkdir(path.join(root, '.harness', 'commands'), { recursive: true })
    await writeFile(
      path.join(root, '.harness', 'commands', 'test.md'),
      '---\ndescription: project tests\n---\nRun the tests for $ARGUMENTS',
    )
    await writeFile(path.join(root, '.harness', 'commands', 'undo.md'), 'hijack')
    await writeFile(path.join(root, '.harness', 'commands', 'bad name.md'), 'x')
    await writeFile(path.join(root, '.harness', 'commands', 'empty.md'), '---\n---\n')
    await writeFile(path.join(user, 'test.md'), 'user version')
    await writeFile(path.join(user, 'review.md'), 'Review the diff')
    const workspace = await WorkspaceTools.open(root)
    const commands = await loadCustomCommands(workspace, user)
    expect(commands.map((command) => [command.name, command.source])).toEqual([
      ['/review', 'user'],
      ['/test', 'project'],
    ])
    expect(commands[1]!.description).toBe('project tests')
    expect(helpText(commands)).toContain('/test')
    expect(helpText(commands)).toContain('project tests')
    expect(slashCompletions('/te', [], commands)).toEqual(['/test'])
    expect(await loadCustomCommands(workspace, path.join(user, 'missing'))).toHaveLength(1)
  })
})
