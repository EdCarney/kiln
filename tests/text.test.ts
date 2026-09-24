import { describe, expect, it } from 'vitest'
import { normalizeSpaces } from '@shared/text'

describe('normalizeSpaces', () => {
  it('keeps gpt-oss narrow no-break spaces non-breaking but visible', () => {
    // The exact sequence from a gpt-oss reply: "of Sept 23 – Sept 29 2026" with U+202F throughout.
    expect(normalizeSpaces('of Sept 23 – Sept')).toBe('of Sept 23 – Sept')
  })

  it('turns other typographic spaces the fonts lack into plain spaces', () => {
    expect(normalizeSpaces('a b c d')).toBe('a b c d')
  })

  it('leaves ordinary text, thin spaces and ideographic spaces alone', () => {
    expect(normalizeSpaces('plain text here　日本')).toBe('plain text here　日本')
  })
})
