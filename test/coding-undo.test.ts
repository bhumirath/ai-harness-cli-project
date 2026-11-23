import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChangeHistory } from '../src/coding/snapshots.ts'
import { WorkspaceTools } from '../src/coding/tools.ts'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-undo-'))
  temporary.push(root)
  const workspace = await WorkspaceTools.open(root)
  return { root, workspace, history: new ChangeHistory(workspace) }
}
const signal = () => new AbortController().signal

describe('undo/redo of agent edits', () => {
  it('reverts and re-applies all edits of one turn, including created files', async () => {
    const { root, workspace, history } = await fixture()
    await writeFile(path.join(root, 'a.txt'), 'one\n')
    history.begin('first task')
    await workspace.execute(
      'edit_file',
      { path: 'a.txt', oldText: 'one', newText: 'two' },
      signal(),
    )
    await workspace.execute(
      'edit_file',
      { path: 'a.txt', oldText: 'two', newText: 'three' },
      signal(),
    )
    await workspace.execute('write_file', { path: 'new/b.txt', content: 'b' }, signal())
    await history.commit()
    expect(history.canUndo).toBe(true)

    const undone = await history.undo()
    expect(undone.ok).toBe(true)
    expect(undone.label).toBe('first task')
    expect(undone.files.sort()).toEqual(['a.txt', path.join('new', 'b.txt')].sort())
    expect(undone.diffs.join('\n')).toContain('-three')
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\n')
    await expect(access(path.join(root, 'new', 'b.txt'))).rejects.toThrow()

    const redone = await history.redo()
    expect(redone.ok).toBe(true)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('three\n')
    expect(await readFile(path.join(root, 'new', 'b.txt'), 'utf8')).toBe('b')
    expect((await history.redo()).error).toBe('Nothing to redo')
  })

  it('undoes turns in reverse order and a new turn clears redo', async () => {
    const { root, workspace, history } = await fixture()
    await writeFile(path.join(root, 'a.txt'), '1')
    for (const [from, to] of [
      ['1', '2'],
      ['2', '3'],
    ]) {
      history.begin(`set ${to}`)
      await workspace.execute('edit_file', { path: 'a.txt', oldText: from, newText: to }, signal())
      await history.commit()
    }
    await history.undo()
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('2')
    history.begin('other')
    await workspace.execute('edit_file', { path: 'a.txt', oldText: '2', newText: 'X' }, signal())
    await history.commit()
    expect(history.canRedo).toBe(false)
    await history.undo()
    await history.undo()
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('1')
  })

  it('refuses to overwrite user changes made after the agent edit unless forced', async () => {
    const { root, workspace, history } = await fixture()
    await writeFile(path.join(root, 'a.txt'), 'agent')
    history.begin('task')
    await workspace.execute(
      'edit_file',
      { path: 'a.txt', oldText: 'agent', newText: 'edited' },
      signal(),
    )
    await history.commit()
    await writeFile(path.join(root, 'a.txt'), 'user change')
    const refused = await history.undo()
    expect(refused.ok).toBe(false)
    expect(refused.conflicts).toEqual(['a.txt'])
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('user change')
    expect((await history.undo(true)).ok).toBe(true)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('agent')
  })

  it('ignores turns without file changes and failed edits', async () => {
    const { root, workspace, history } = await fixture()
    await writeFile(path.join(root, 'a.txt'), 'x')
    history.begin('read only')
    await workspace.execute('read_file', { path: 'a.txt' }, signal())
    await workspace.execute('edit_file', { path: 'a.txt', oldText: 'nope', newText: 'y' }, signal())
    await history.commit()
    expect(history.canUndo).toBe(false)
    expect((await history.undo()).error).toBe('Nothing to undo')
  })
})
