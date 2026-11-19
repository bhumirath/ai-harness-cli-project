import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../src/coding/sessions.ts'

const temporary: string[] = []
afterEach(async () =>
  Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true }))),
)

describe('private coding sessions', () => {
  it('atomically saves and resumes a private transcript without credentials', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-session-'))
    temporary.push(root)
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = store.create('/project', 'direct', 'model')
    session.messages.push(
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'done' },
    )
    await store.save(session)
    const loaded = await store.load(session.id)
    expect(loaded).toMatchObject({
      id: session.id,
      cwd: '/project',
      backend: 'direct',
      model: 'model',
    })
    expect(loaded.messages).toHaveLength(2)
    expect((await store.list()).map((item) => item.id)).toEqual([session.id])
    if (process.platform !== 'win32')
      expect((await stat(path.join(root, 'sessions', `${session.id}.json`))).mode & 0o777).toBe(
        0o600,
      )
    expect(await readFile(path.join(root, 'sessions', `${session.id}.json`), 'utf8')).not.toContain(
      'apiKey',
    )
    await chmod(path.join(root, 'sessions', `${session.id}.json`), 0o600)
  })

  it('rejects invalid and missing ids without path traversal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-session-'))
    temporary.push(root)
    const store = new SessionStore(path.join(root, 'sessions'))
    await expect(store.load('../../secret')).rejects.toThrow('Invalid coding session id')
    await expect(store.load('00000000-0000-4000-8000-000000000000')).rejects.toThrow('not found')
    expect(await new SessionStore(path.join(root, 'missing')).list()).toEqual([])
  })
})
