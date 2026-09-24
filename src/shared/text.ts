/**
 * Models (gpt-oss especially) write "Sept 23" with U+202F NARROW NO-BREAK SPACE and use other
 * typographic spaces that the bundled Inter and Source Serif 4 fonts don't include. Chromium then
 * falls back to a font where they render almost zero-width, so words run together ("Sept23").
 * Swap them for spaces those fonts do have: non-breaking ones stay non-breaking (U+00A0).
 * U+3000 (ideographic space) is left alone; CJK fallback fonts draw it correctly.
 */
const NON_BREAKING = /[  ]/g
const BREAKING = /[  -    ]/g

export function normalizeSpaces(text: string): string {
  return text.replace(NON_BREAKING, ' ').replace(BREAKING, ' ')
}
