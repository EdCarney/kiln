import { join } from 'node:path'
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, nativeTheme, shell } from 'electron'
import { EVENT_CHANNELS } from '@shared/ipc'
import { currentBackground, currentThemeSource } from './background'
import { openDatabase } from './db/index'
import { settleStaleTraces } from './debug/traces'
import { staleAttachmentPaths } from './db/conversations'
import { removeFiles } from './files/ingest'
import { registerIpc } from './ipc'
import { initPaths, paths } from './paths'
import { handleProtocols, registerSchemes } from './protocols'
import { refreshPrices } from './usage/pricing'

app.setName('Kiln')
// Tests and experiments can point Kiln at a throwaway data folder.
if (process.env.KILN_USER_DATA) app.setPath('userData', process.env.KILN_USER_DATA)
registerSchemes()

if (!app.requestSingleInstanceLock()) app.quit()

let mainWindow: BrowserWindow | null = null

function sendMenu(action: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  win?.webContents.send(EVENT_CHANNELS.menu, action)
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-chat') },
        { label: 'Search Chats…', accelerator: 'CmdOrCtrl+K', click: () => sendMenu('search') },
        { label: 'Open Debugger', accelerator: 'CmdOrCtrl+Shift+D', click: () => sendMenu('debugger') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('toggle-sidebar') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 500,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: currentBackground(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

// Lock down navigation: the app never navigates away, links open in the browser,
// and sandboxed artifact frames can't navigate anywhere but their own artifact:// page.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !event.url.startsWith('artifact:') && event.url !== 'about:blank') event.preventDefault()
  })
})

app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.focus()
})

app.whenReady().then(async () => {
  initPaths()
  openDatabase(paths.db)
  settleStaleTraces()
  await removeFiles(staleAttachmentPaths(Date.now() - 24 * 60 * 60 * 1000))
  handleProtocols()
  registerIpc()
  nativeTheme.themeSource = currentThemeSource()
  buildMenu()
  createWindow()
  // Keep per-token prices current (at most daily); the bundled snapshot covers offline starts.
  void refreshPrices()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
