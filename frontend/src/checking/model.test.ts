import { describe, expect, it } from 'vitest'
import type { ProviderInfo } from '../types'
import { effectiveModel } from './model'

const providers: ProviderInfo[] = [
  {
    name: 'ollama',
    available: true,
    models: ['gemma4:12b', 'qwen3.5:2b'],
    default_model: 'gemma4:12b',
    allowed: true,
  },
  {
    name: 'claude',
    available: false,
    models: [],
    default_model: 'claude-sonnet-5',
    allowed: true,
  },
]

describe('effectiveModel', () => {
  it('keeps an explicitly chosen model that exists', () => {
    expect(effectiveModel('qwen3.5:2b', 'ollama', providers)).toBe('qwen3.5:2b')
  })

  it('falls back to the provider default when nothing is chosen', () => {
    expect(effectiveModel(null, 'ollama', providers)).toBe('gemma4:12b')
  })

  it('replaces a chosen model that is no longer installed', () => {
    expect(effectiveModel('deleted-model', 'ollama', providers)).toBe('gemma4:12b')
  })

  it('uses the default when the provider reports no model list', () => {
    expect(effectiveModel(null, 'claude', providers)).toBe('claude-sonnet-5')
  })

  it('passes the chosen model through for unknown providers', () => {
    expect(effectiveModel('x', 'unknown', providers)).toBe('x')
  })
})
