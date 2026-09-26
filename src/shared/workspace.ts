// Which files a code run wrote Kiln will hand to other apps or show. Opening runs whatever app handles the type,
// outside the sandbox, so it's never a script or an app; anything else can still be shown in Finder or saved.

/** Documents, data and images a run's output may be opened as. */
export const OPENABLE_FILE = /\.(txt|md|csv|tsv|json|pdf|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i

/** Images the chat previews inline. */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i
