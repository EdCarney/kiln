import { randomUUID } from 'node:crypto'

export const uid = (): string => randomUUID()

let last = 0
/** Strictly increasing ms timestamp, so rows written in the same tick still sort correctly. */
export function now(): number {
  const t = Date.now()
  last = t > last ? t : last + 1
  return last
}

/** Rough token count; good enough for capacity meters and history trimming. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
