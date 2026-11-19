import { describe, expect, it } from 'vitest'
import {
  parseApprovalMode,
  preferredCodingModel,
  resolveCodingModel,
  slashCompletions,
} from '../src/commands/code.ts'

const model = (modelId: string, supportsTools = true) => ({
  ref: `byok:credential:${modelId}`,
  modelId,
  displayName: modelId,
  provider: 'openai',
  supportsTools,
})

describe('coding permission selection', () => {
  it.each(['prompt', 'read-only', 'auto'] as const)('accepts %s', (mode) => {
    expect(parseApprovalMode(mode)).toBe(mode)
  })

  it('rejects unknown permission modes', () => {
    expect(parseApprovalMode('always')).toBeUndefined()
  })
})

describe('coding model selection', () => {
  it('prefers a known coding-capable model over chat-latest', () => {
    expect(preferredCodingModel([model('chat-latest'), model('gpt-4.1')])?.modelId).toBe('gpt-4.1')
  })

  it('falls back to a codex model and excludes media/realtime models', () => {
    expect(
      preferredCodingModel([model('gpt-realtime'), model('gpt-audio'), model('gpt-5.3-codex')])
        ?.modelId,
    ).toBe('gpt-5.3-codex')
  })

  it('reuses a saved model ref or id when it is still available', () => {
    const models = [model('gpt-4.1'), model('gpt-5.3-codex')]
    expect(resolveCodingModel(models, models[1]!.ref)?.modelId).toBe('gpt-5.3-codex')
    expect(resolveCodingModel(models, 'gpt-5.3-codex')?.modelId).toBe('gpt-5.3-codex')
  })

  it('falls back safely when a saved model is no longer available', () => {
    expect(resolveCodingModel([model('gpt-4.1')], 'removed-model')?.modelId).toBe('gpt-4.1')
  })
})

describe('coding slash command completion', () => {
  it('suggests commands and permission values', () => {
    expect(slashCompletions('/mo')).toEqual(['/model'])
    expect(slashCompletions('/permission r')).toEqual(['/permission read-only'])
  })

  it('suggests only suitable coding models', () => {
    expect(slashCompletions('/model gpt-', [model('gpt-audio'), model('gpt-4.1')])).toEqual([
      '/model gpt-4.1',
    ])
  })
})
