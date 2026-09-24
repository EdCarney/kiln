import type {
  AccountUsage,
  Artifact,
  ArtifactSummary,
  ArtifactType,
  Attachment,
  ChatEvent,
  Conversation,
  ConversationDetail,
  FileSource,
  ID,
  ModelInfo,
  ModelListResult,
  ModelOverrides,
  PriceTable,
  Project,
  ProjectFile,
  SearchHit,
  SendRequest,
  SendResult,
  Settings,
  Skill,
  SkillDetail,
  ThemeDef,
  ThinkSetting,
  TraceDetail,
  TraceSummary,
  UsageSummary
} from './types'

/** A link's page preview; image and icon are data: URLs. */
export interface LinkPreview {
  url: string
  title: string | null
  description: string | null
  siteName: string | null
  image: string | null
  icon: string | null
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

export interface ConversationPatch {
  title?: string
  pinned?: boolean
  projectId?: ID | null
  model?: string | null
  think?: ThinkSetting | null
  skills?: string[]
  instructions?: string
}

export interface SkillInput {
  id?: string
  name: string
  description: string
  body: string
}

/**
 * The renderer-facing API. Every method maps 1:1 to an `ipcMain.handle` channel
 * named `<group>:<method>` (see `src/main/ipc.ts` and `src/preload/index.ts`).
 */
export interface KilnApi {
  app: {
    info(): Promise<{ version: string; dataDir: string; platform: string }>
    setNativeTheme(mode: 'system' | 'light' | 'dark', background: string): Promise<void>
    openExternal(url: string): Promise<void>
    openDataFolder(): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: DeepPartial<Settings>): Promise<Settings>
    setApiKey(key: string | null): Promise<Settings>
  }
  models: {
    list(refresh?: boolean): Promise<ModelListResult>
    info(name: string): Promise<ModelInfo>
    setOverrides(name: string, overrides: ModelOverrides): Promise<ModelInfo>
  }
  projects: {
    list(): Promise<Project[]>
    get(id: ID): Promise<Project | null>
    create(input: { name: string; description?: string }): Promise<Project>
    update(id: ID, patch: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'pinned'>>): Promise<Project>
    delete(id: ID): Promise<void>
    files(id: ID): Promise<ProjectFile[]>
    addFiles(id: ID, sources: FileSource[]): Promise<{ added: ProjectFile[]; errors: string[] }>
    removeFile(fileId: ID): Promise<void>
  }
  conversations: {
    list(opts?: { projectId?: ID; limit?: number }): Promise<Conversation[]>
    get(id: ID): Promise<ConversationDetail | null>
    update(id: ID, patch: ConversationPatch): Promise<Conversation>
    delete(id: ID): Promise<void>
    search(query: string): Promise<SearchHit[]>
  }
  chat: {
    send(req: SendRequest): Promise<SendResult>
    /** Re-run the last assistant turn, optionally on a different model. */
    regenerate(conversationId: ID, opts: { model: string; think: ThinkSetting | null }): Promise<SendResult>
    /** Replace a user message's text, drop everything after it, and re-run. */
    edit(messageId: ID, content: string, opts: { model: string; think: ThinkSetting | null }): Promise<SendResult>
    stop(conversationId: ID): Promise<void>
  }
  attachments: {
    ingest(sources: FileSource[]): Promise<{ added: Attachment[]; errors: string[] }>
    pick(): Promise<FileSource[]>
    remove(id: ID): Promise<void>
  }
  artifacts: {
    list(): Promise<ArtifactSummary[]>
    /** Stage HTML/SVG for the sandboxed frame; returns an artifact:// URL. */
    stage(type: ArtifactType, content: string): Promise<string>
    save(title: string, type: ArtifactType, language: string | null, content: string): Promise<boolean>
    createFromBlock(input: {
      conversationId: ID
      messageId: ID
      title: string
      type: ArtifactType
      language: string | null
      content: string
    }): Promise<Artifact>
  }
  skills: {
    list(): Promise<Skill[]>
    get(id: string): Promise<SkillDetail | null>
    save(input: SkillInput): Promise<Skill>
    delete(id: string): Promise<void>
    duplicate(id: string): Promise<Skill>
    setEnabled(id: string, enabled: boolean): Promise<void>
    reveal(id: string | null): Promise<void>
  }
  themes: {
    list(): Promise<ThemeDef[]>
    save(theme: ThemeDef): Promise<ThemeDef>
    delete(id: string): Promise<void>
    exportTheme(theme: ThemeDef): Promise<boolean>
    importTheme(): Promise<ThemeDef | null>
  }
  usage: {
    /** Quota windows and recent spend from ollama.com (needs an API key). */
    account(refresh?: boolean): Promise<AccountUsage>
    /** Kiln's own ledger of requests over the last N days. */
    summary(days: number): Promise<UsageSummary>
    /** Last raw /api/usage response, for troubleshooting the undocumented endpoint. */
    raw(): Promise<{ at: number; json: unknown } | null>
    prices(): Promise<PriceTable>
    refreshPrices(): Promise<PriceTable>
  }
  links: {
    /** Title, description, image and icon for a link (null when previews are off or unavailable). */
    preview(url: string): Promise<LinkPreview | null>
  }
  debug: {
    /** Open (or focus) the debugger window, showing this conversation. */
    open(conversationId: ID | null): Promise<void>
    list(conversationId: ID | null): Promise<TraceSummary[]>
    get(id: string): Promise<TraceDetail | null>
    clear(conversationId: ID | null): Promise<void>
    exportTraces(conversationId: ID | null): Promise<boolean>
    /** Re-send an edited request (non-streaming). Recorded as a 'replay' trace; nothing is added to the chat. */
    replay(conversationId: ID | null, body: unknown): Promise<TraceDetail>
    /** The endpoint Kiln talks to, and whether it needs an API key (for curl export). */
    target(): Promise<{ chatEndpoint: string; needsKey: boolean }>
    inspectApp(): Promise<void>
  }
  events: {
    onChat(cb: (e: ChatEvent) => void): () => void
    onTrace(cb: (e: TraceEvent) => void): () => void
    onDebugFocus(cb: (conversationId: ID | null) => void): () => void
    onSkillsChanged(cb: () => void): () => void
    onMenu(cb: (action: string) => void): () => void
  }
  files: {
    /** Resolve a dropped File to its on-disk path (empty for pasted data). */
    pathFor(file: File): string
  }
}

/** Channel names for the invoke-style methods, derived from the API shape. */
export const INVOKE_CHANNELS = {
  app: ['info', 'setNativeTheme', 'openExternal', 'openDataFolder'],
  settings: ['get', 'update', 'setApiKey'],
  models: ['list', 'info', 'setOverrides'],
  projects: ['list', 'get', 'create', 'update', 'delete', 'files', 'addFiles', 'removeFile'],
  conversations: ['list', 'get', 'update', 'delete', 'search'],
  chat: ['send', 'regenerate', 'edit', 'stop'],
  attachments: ['ingest', 'pick', 'remove'],
  artifacts: ['list', 'stage', 'save', 'createFromBlock'],
  skills: ['list', 'get', 'save', 'delete', 'duplicate', 'setEnabled', 'reveal'],
  themes: ['list', 'save', 'delete', 'exportTheme', 'importTheme'],
  usage: ['account', 'summary', 'raw', 'prices', 'refreshPrices'],
  debug: ['open', 'list', 'get', 'clear', 'exportTraces', 'replay', 'target', 'inspectApp'],
  links: ['preview']
} as const satisfies { [G in Exclude<keyof KilnApi, 'events' | 'files'>]: ReadonlyArray<keyof KilnApi[G]> }

export const EVENT_CHANNELS = {
  chat: 'event:chat',
  skills: 'event:skills',
  menu: 'event:menu',
  trace: 'event:trace',
  debugFocus: 'event:debug-focus'
} as const

export type TraceEvent = { type: 'upsert'; trace: TraceSummary } | { type: 'cleared'; conversationId: ID | null }
