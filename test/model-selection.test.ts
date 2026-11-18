import { describe, expect, it } from 'vitest'
import { parseApprovalMode, preferredCodingModel } from '../src/commands/code.ts'

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
})
