// Limits on what a tool puts into the conversation. Kept out of tools.ts so providers can import them without an
// import cycle (tools.ts imports the providers).

/** The most any one tool result may add to the request, about 6K tokens. */
export const TOOL_RESULT_CHARS = 24_000

/** Cut text to `max` characters, saying how much was left out. */
export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters cut]` : text
}
