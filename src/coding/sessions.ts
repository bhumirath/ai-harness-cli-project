import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configPath } from '../config.ts'
import type { CodeMessage } from './types.ts'

export interface CodingSession {
  version: 1
  id: string
  createdAt: string
  updatedAt: string
  cwd: string
  backend: 'harness' | 'direct'
  model: string
  messages: CodeMessage[]
}

const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)

export class SessionStore {
  private readonly directory: string
  constructor(path = join(dirname(configPath()), 'coding-sessions')) {
    this.directory = path
  }

  create(cwd: string, backend: 'harness' | 'direct', model: string): CodingSession {
    const now = new Date().toISOString()
    return {
      version: 1,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      cwd,
      backend,
      model,
      messages: [],
    }
  }

  async load(id: string): Promise<CodingSession> {
    if (!validId(id)) throw new Error('Invalid coding session id')
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'))
    } catch {
      throw new Error('Coding session not found')
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid coding session')
    const value = parsed as Partial<CodingSession>
    if (
      value.version !== 1 ||
      value.id !== id ||
      !Array.isArray(value.messages) ||
      typeof value.cwd !== 'string' ||
      !['harness', 'direct'].includes(value.backend ?? '') ||
      typeof value.model !== 'string'
    )
      throw new Error('Invalid coding session')
    return value as CodingSession
  }

  async list(): Promise<CodingSession[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const sessions = await Promise.all(
      names
        .filter((name) => name.endsWith('.json') && validId(name.slice(0, -5)))
        .map((name) => this.load(name.slice(0, -5)).catch(() => undefined)),
    )
    return sessions
      .filter((session): session is CodingSession => Boolean(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async save(session: CodingSession): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    session.updatedAt = new Date().toISOString()
    const target = join(this.directory, `${session.id}.json`)
    const temporary = join(this.directory, `.${session.id}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
      await chmod(target, 0o600).catch(() => undefined)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
