// Which files a code run wrote Ollmost will show or hand to other apps. A file a run wrote may carry the chat's data, and
// whatever opens it runs outside the sandbox: an app that runs a document's scripts, or loads its remote images and
// templates, could send that data out (#67). So on a Mac, Ollmost previews files with Quick Look instead of opening them
// in the app that handles the type; elsewhere it opens only types whose usual apps do neither.

/** Documents, data and images a run's output may be previewed as (never SVG: it can hold scripts and remote links). */
export const OPENABLE_FILE = /\.(txt|md|csv|tsv|json|pdf|png|jpe?g|gif|webp|docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i

/** What's opened in its default app where Quick Look isn't available: plain text, PDFs and bitmaps. */
export const DEFAULT_APP_FILE = /\.(txt|pdf|png|jpe?g|gif|webp)$/i

/** Images the chat previews inline (as `<img>`, which runs no scripts and loads nothing else, SVG included). */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i

/** How Ollmost opens a file a run wrote on this platform, or null when it won't. */
export function openWith(path: string, platform: string): 'quick-look' | 'default-app' | null {
  if (!OPENABLE_FILE.test(path)) return null
  if (platform === 'darwin') return 'quick-look'
  return DEFAULT_APP_FILE.test(path) ? 'default-app' : null
}
