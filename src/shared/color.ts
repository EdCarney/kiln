/** Colour maths for theme tokens: parsing, alpha compositing and WCAG contrast. */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** Parse #rgb, #rrggbb, #rrggbbaa, rgb() or rgba(); null for anything else. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim()
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 }
  }
  const fn = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i)
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4])
    return { r: +fn[1], g: +fn[2], b: +fn[3], a: Math.min(1, Math.max(0, alpha)) }
  }
  return null
}

function mustParse(value: string): Rgba {
  const c = parseColor(value)
  if (!c) throw new Error(`Not a colour: ${value}`)
  return c
}

/** Paint `top` over an opaque `bottom`, as the screen shows it. */
export function composite(top: string, bottom: string): Rgba {
  const t = mustParse(top)
  const b = mustParse(bottom)
  const mix = (x: number, y: number) => x * t.a + y * (1 - t.a)
  return { r: mix(t.r, b.r), g: mix(t.g, b.g), b: mix(t.b, b.b), a: 1 }
}

export function toHex({ r, g, b }: Rgba): string {
  return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`
}

/** A possibly translucent token as the opaque colour it shows over `over`. */
export function flatten(value: string, over: string): string {
  return toHex(composite(value, over))
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 2 contrast ratio (1–21) of `fg` on `bg`; translucent colours are composited first. */
export function contrast(fg: string, bg: string, base = '#ffffff'): number {
  const back = composite(bg, base)
  const front = composite(fg, toHex(back))
  const [hi, lo] = [luminance(front), luminance(back)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Whichever candidate reads best on `bg`: e.g. white or a dark ink for text on a status colour. */
export function readableOn(bg: string, candidates: string[]): string {
  return candidates.reduce((best, c) => (contrast(c, bg) > contrast(best, bg) ? c : best))
}
