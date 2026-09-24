/**
 * gpt-oss is trained to cite as 【https://…】 (and, with its own browser tool, 【3†L10-L20】).
 * Turn URL citations into ordinary markdown links and drop the cursor-style ones, which point at
 * nothing outside that tool.
 */
export function normalizeCitations(text: string): string {
  return text
    .replace(/【\s*(https?:\/\/[^\s】]+)\s*】/g, (_m, url: string) => {
      let host = url
      try {
        host = new URL(url).hostname.replace(/^www\./, '')
      } catch {
        /* keep the raw URL as the label */
      }
      return ` ([${host}](${url}))`
    })
    .replace(/【[^】\n]*†[^】\n]*】/g, '')
}
