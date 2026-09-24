import { describe, expect, it } from 'vitest'
import { normalizeCitations } from '@shared/citations'

describe('normalizeCitations', () => {
  it('turns gpt-oss URL citations into markdown links', () => {
    expect(normalizeCitations('The title is X.【https://www.ollama.com/blog】')).toBe('The title is X. ([ollama.com](https://www.ollama.com/blog))')
  })

  it('drops cursor-style citations that point nowhere', () => {
    expect(normalizeCitations('Prices rose【3†L10-L20】 sharply.')).toBe('Prices rose sharply.')
  })

  it('leaves ordinary text and brackets alone', () => {
    expect(normalizeCitations('A [link](https://a.io) and 【notes】')).toBe('A [link](https://a.io) and 【notes】')
  })
})
