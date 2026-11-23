import { diffPreview, type WorkspaceTools } from './tools.ts'

interface FileChange {
  /** Content before the change set; undefined means the file did not exist. */
  before: string | undefined
  /** Content after the change set; undefined means the file was deleted. */
  after: string | undefined
}
export interface ChangeSet {
  label: string
  files: Map<string, FileChange>
}
export interface RevertResult {
  ok: boolean
  label?: string
  files: string[]
  diffs: string[]
  conflicts: string[]
  error?: string
}

const MAX_SETS = 50

/**
 * Undo/redo history for file edits made by the coding tools. Every user turn is one change set.
 * Before each write the workspace reports the previous content; the final content is captured
 * when the turn ends. Changes made by shell commands are not tracked.
 */
export class ChangeHistory {
  private readonly undoStack: ChangeSet[] = []
  private readonly redoStack: ChangeSet[] = []
  private current: ChangeSet | undefined
  private readonly workspace: WorkspaceTools

  constructor(workspace: WorkspaceTools) {
    this.workspace = workspace
    workspace.beforeWrite = (relative, previous) => this.record(relative, previous)
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  begin(label: string): void {
    this.current = { label: label.replace(/\s+/g, ' ').slice(0, 80), files: new Map() }
  }

  private record(relative: string, previous: string | undefined): void {
    this.current ??= { label: 'edit', files: new Map() }
    if (!this.current.files.has(relative))
      this.current.files.set(relative, { before: previous, after: previous })
  }

  /** Captures final contents and pushes the change set when it changed any file. */
  async commit(): Promise<void> {
    const set = this.current
    this.current = undefined
    if (!set?.files.size) return
    for (const [relative, change] of set.files)
      change.after = await this.workspace.readText(relative).catch(() => undefined)
    for (const [relative, change] of set.files)
      if (change.before === change.after) set.files.delete(relative)
    if (!set.files.size) return
    this.undoStack.push(set)
    if (this.undoStack.length > MAX_SETS) this.undoStack.shift()
    this.redoStack.length = 0
  }

  async undo(force = false): Promise<RevertResult> {
    return this.move(this.undoStack, this.redoStack, 'before', force)
  }

  async redo(force = false): Promise<RevertResult> {
    return this.move(this.redoStack, this.undoStack, 'after', force)
  }

  private async move(
    from: ChangeSet[],
    to: ChangeSet[],
    target: 'before' | 'after',
    force: boolean,
  ): Promise<RevertResult> {
    const set = from.at(-1)
    if (!set)
      return {
        ok: false,
        files: [],
        diffs: [],
        conflicts: [],
        error: target === 'before' ? 'Nothing to undo' : 'Nothing to redo',
      }
    const expectedKey = target === 'before' ? 'after' : 'before'
    const conflicts: string[] = []
    const current = new Map<string, string | undefined>()
    for (const [relative, change] of set.files) {
      const text = await this.workspace.readText(relative)
      current.set(relative, text)
      if (text !== change[expectedKey]) conflicts.push(relative)
    }
    if (conflicts.length && !force)
      return {
        ok: false,
        label: set.label,
        files: [...set.files.keys()],
        diffs: [],
        conflicts,
        error: 'Files changed since the agent edited them; use --force to overwrite those changes',
      }
    const diffs: string[] = []
    for (const [relative, change] of set.files) {
      await this.workspace.restoreFile(relative, change[target])
      diffs.push(diffPreview(relative, current.get(relative) ?? '', change[target] ?? ''))
    }
    from.pop()
    to.push(set)
    return { ok: true, label: set.label, files: [...set.files.keys()], diffs, conflicts }
  }
}
