import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { artifactExtension, slugify } from '@shared/artifactParser'
import { EVENT_CHANNELS, type KilnApi } from '@shared/ipc'
import { BUILTIN_THEMES } from '@shared/themes'
import type { ThemeDef } from '@shared/types'
import { edit, regenerate, send, stop } from './chat/service'
import { addArtifactVersion, getArtifact, listAllArtifacts, listArtifacts } from './db/artifacts'
import {
  deleteConversation,
  deletePendingAttachment,
  getConversation,
  insertAttachment,
  listConversations,
  listMessages,
  search,
  updateConversation
} from './db/conversations'
import { deleteCustomTheme, listCustomThemes, saveCustomTheme } from './db/kv'
import {
  createProject,
  deleteProject,
  deleteProjectFile,
  getProject,
  insertProjectFile,
  listProjectFiles,
  listProjects,
  updateProject
} from './db/projects'
import { ingestAll, removeFiles } from './files/ingest'
import { getModelInfo, listModels, setModelOverrides } from './ollama/models'
import { paths } from './paths'
import { stageArtifact } from './protocols'
import { getSettings, setApiKey, updateSettings } from './settings'
import {
  deleteSkill,
  duplicateSkill,
  getSkill,
  invalidateSkills,
  listSkills,
  revealSkill,
  saveSkill,
  setSkillEnabled,
  watchSkills
} from './skills/library'

type Impl = { [G in Exclude<keyof KilnApi, 'events' | 'files'>]: KilnApi[G] }

function broadcastSkillsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(EVENT_CHANNELS.skills)
}

const impl: Impl = {
  app: {
    info: async () => ({ version: app.getVersion(), dataDir: paths.data, platform: process.platform }),
    setNativeTheme: async (mode, background) => {
      nativeTheme.themeSource = mode
      for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(background)
    },
    openExternal: async (url) => {
      if (/^(https?|mailto):/i.test(url)) await shell.openExternal(url)
    },
    openDataFolder: async () => void (await shell.openPath(paths.data))
  },

  settings: {
    get: async () => getSettings(),
    update: async (patch) => {
      const before = getSettings().skills.sources
      const next = updateSettings(patch)
      if (JSON.stringify(before) !== JSON.stringify(next.skills.sources)) {
        invalidateSkills()
        watchSkills(broadcastSkillsChanged)
        broadcastSkillsChanged()
      }
      return next
    },
    setApiKey: async (key) => {
      setApiKey(key)
      return getSettings()
    }
  },

  models: {
    list: (refresh) => listModels(refresh),
    info: (name) => getModelInfo(name),
    setOverrides: (name, overrides) => setModelOverrides(name, overrides)
  },

  projects: {
    list: async () => listProjects(),
    get: async (id) => getProject(id),
    create: async (input) => createProject(input),
    update: async (id, patch) => updateProject(id, patch),
    delete: async (id) => removeFiles(deleteProject(id)),
    files: async (id) => listProjectFiles(id),
    addFiles: async (id, sources) => {
      const { ok, errors } = await ingestAll(sources)
      const added = ok.map((f) => {
        if (f.kind === 'image') {
          errors.push(`${f.name}: images can't be project knowledge yet. Attach them to a message instead.`)
          void removeFiles([f.path])
          return null
        }
        return insertProjectFile({
          id: f.id,
          project_id: id,
          name: f.name,
          mime: f.mime,
          size: f.size,
          path: f.path,
          text: f.text,
          token_est: f.tokenEst
        })
      })
      return { added: added.filter((f) => f !== null), errors }
    },
    removeFile: async (fileId) => {
      const path = deleteProjectFile(fileId)
      if (path) await removeFiles([path])
    }
  },

  conversations: {
    list: async (opts) => listConversations(opts),
    get: async (id) => {
      const conversation = getConversation(id)
      return conversation ? { conversation, messages: listMessages(id), artifacts: listArtifacts(id) } : null
    },
    update: async (id, patch) => updateConversation(id, patch),
    delete: async (id) => {
      stop(id)
      await removeFiles(deleteConversation(id))
    },
    search: async (q) => search(q)
  },

  chat: {
    send: async (req) => send(req),
    regenerate: (id, opts) => regenerate(id, opts),
    edit: (messageId, content, opts) => edit(messageId, content, opts),
    stop: async (id) => stop(id)
  },

  attachments: {
    ingest: async (sources) => {
      const { ok, errors } = await ingestAll(sources)
      const added = ok.map((f) =>
        insertAttachment({
          id: f.id,
          kind: f.kind,
          name: f.name,
          mime: f.mime,
          size: f.size,
          path: f.path,
          text: f.text,
          token_est: f.tokenEst
        })
      )
      return { added, errors }
    },
    pick: async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled ? [] : res.filePaths.map((path) => ({ path }))
    },
    remove: async (id) => {
      const path = deletePendingAttachment(id)
      if (path) await removeFiles([path])
    }
  },

  artifacts: {
    list: async () => listAllArtifacts(),
    stage: async (type, content) => stageArtifact(type, content),
    save: async (title, type, language, content) => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { defaultPath: `${slugify(title)}.${artifactExtension(type, language)}` }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return false
      await writeFile(res.filePath, content)
      return true
    },
    createFromBlock: async (input) => {
      const existing = new Set(listArtifacts(input.conversationId).map((a) => a.identifier))
      let identifier = slugify(input.title)
      for (let n = 2; existing.has(identifier); n++) identifier = `${slugify(input.title)}-${n}`
      const id = addArtifactVersion({ ...input, identifier })
      return getArtifact(id)!
    }
  },

  skills: {
    list: () => listSkills(),
    get: (id) => getSkill(id),
    save: (input) => saveSkill(input),
    delete: (id) => deleteSkill(id),
    duplicate: (id) => duplicateSkill(id),
    setEnabled: async (id, enabled) => setSkillEnabled(id, enabled),
    reveal: (id) => revealSkill(id)
  },

  themes: {
    list: async () => [...BUILTIN_THEMES, ...listCustomThemes()],
    save: async (theme) => {
      if (BUILTIN_THEMES.some((t) => t.id === theme.id)) throw new Error('Built-in themes are read-only; save a copy instead.')
      saveCustomTheme(theme)
      return { ...theme, builtin: false }
    },
    delete: async (id) => deleteCustomTheme(id),
    exportTheme: async (theme) => {
      const res = await dialog.showSaveDialog({ defaultPath: `${slugify(theme.name)}.kiln-theme.json` })
      if (res.canceled || !res.filePath) return false
      const { builtin: _builtin, ...rest } = theme
      await writeFile(res.filePath, JSON.stringify(rest, null, 2))
      return true
    },
    importTheme: async () => {
      const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Theme', extensions: ['json'] }] })
      if (res.canceled || !res.filePaths[0]) return null
      const { readFile } = await import('node:fs/promises')
      const parsed = JSON.parse(await readFile(res.filePaths[0], 'utf8')) as Partial<ThemeDef>
      if (!parsed.light || !parsed.dark || !parsed.name) throw new Error('That file is not a Kiln theme.')
      const base = BUILTIN_THEMES[0]
      const theme: ThemeDef = {
        id: `custom-${Date.now().toString(36)}`,
        name: parsed.name,
        builtin: false,
        light: { ...base.light, ...parsed.light },
        dark: { ...base.dark, ...parsed.dark },
        fonts: { ...base.fonts, ...parsed.fonts },
        radius: typeof parsed.radius === 'number' ? parsed.radius : base.radius
      }
      saveCustomTheme(theme)
      return theme
    }
  }
}

export function registerIpc(): void {
  for (const [group, methods] of Object.entries(impl)) {
    for (const [name, fn] of Object.entries(methods as Record<string, (...args: unknown[]) => unknown>)) {
      ipcMain.handle(`${group}:${name}`, (_event, ...args) => fn(...args))
    }
  }
  watchSkills(broadcastSkillsChanged)
}
