import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The pages allowed to call into the main process: the renderer bundle, and the dev server when unpackaged. */
export interface AppPages {
  /** file:// URL of the renderer's index.html (the main window and the debugger window, which adds a #hash). */
  file: string
  /** Origin of the dev server (electron-vite dev), or null in a packaged app. */
  devOrigin: string | null
}

export function appPages(isPackaged: boolean): AppPages {
  const dev = !isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  return {
    file: pathToFileURL(join(__dirname, '../renderer/index.html')).href,
    devOrigin: dev ? new URL(dev).origin : null
  }
}

/**
 * Whether an IPC call comes from one of Ollmost's own windows: a top-level frame showing the app's page. Artifact
 * frames can't reach the bridge anyway; this closes the door on anything else (a subframe, a page the window
 * was somehow navigated to) before IPC can approve tools or start processes (#31).
 */
export function isAppFrame(frame: { url: string; parent: unknown } | null | undefined, pages: AppPages): boolean {
  if (!frame || frame.parent) return false
  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    return false
  }
  if (url.protocol === 'file:') return url.pathname === new URL(pages.file).pathname
  return pages.devOrigin !== null && url.origin === pages.devOrigin
}
