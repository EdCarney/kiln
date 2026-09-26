import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { EVENT_CHANNELS } from '@shared/ipc'

let debugWindow: BrowserWindow | null = null

/**
 * The debugger is the same renderer bundle loaded at #debug, in its own window, so it shares the
 * preload bridge and theme but can sit on another screen while you chat.
 */
export function openDebugWindow(conversationId: string | null, background: string): void {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.webContents.send(EVENT_CHANNELS.debugFocus, conversationId)
    debugWindow.show()
    debugWindow.focus()
    return
  }
  debugWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: 'Ollmost Debugger',
    backgroundColor: background,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  debugWindow.once('ready-to-show', () => debugWindow?.show())
  debugWindow.on('closed', () => (debugWindow = null))
  const hash = `debug${conversationId ? `?c=${encodeURIComponent(conversationId)}` : ''}`
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void debugWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  else void debugWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}
