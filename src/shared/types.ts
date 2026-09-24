// Domain types shared by the main process, preload bridge and renderer.

export type ID = string

export interface Project {
  id: ID
  name: string
  description: string
  instructions: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  conversationCount?: number
}

export interface ProjectFile {
  id: ID
  projectId: ID
  name: string
  mime: string
  size: number
  tokenEstimate: number
  createdAt: number
}

/** What the user picked in the composer. Mapped per model by `toOllamaThink`. */
export type ThinkSetting = 'off' | 'on' | 'low' | 'medium' | 'high'

export interface Conversation {
  id: ID
  projectId: ID | null
  title: string
  model: string | null
  think: ThinkSetting | null
  /** Skill ids the user picked (/ or the + menu); applied to every reply. */
  skills: string[]
  /** Skill ids the model loaded itself; kept for later turns but applied only where relevant. */
  autoSkills: string[]
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export type Role = 'user' | 'assistant'

export interface Attachment {
  id: ID
  messageId: ID | null
  kind: 'image' | 'document'
  name: string
  mime: string
  size: number
  tokenEstimate: number
  /** Extraction produced no usable text (e.g. a scanned PDF). */
  textless: boolean
}

export interface ToolEvent {
  tool: string
  args: Record<string, unknown>
  ok: boolean
  summary: string
}

export interface MessageStats {
  promptTokens?: number
  completionTokens?: number
  durationMs?: number
  tokensPerSecond?: number
  thinkingMs?: number
  truncatedHistory?: number
}

export interface Message {
  id: ID
  conversationId: ID
  parentId: ID | null
  role: Role
  content: string
  thinking: string | null
  model: string | null
  attachments: Attachment[]
  toolEvents: ToolEvent[]
  stats: MessageStats | null
  error: string | null
  createdAt: number
}

export type ArtifactType = 'markdown' | 'code' | 'html' | 'svg' | 'mermaid'

export interface ArtifactVersion {
  id: ID
  artifactId: ID
  messageId: ID | null
  version: number
  content: string
  createdAt: number
}

export interface Artifact {
  id: ID
  conversationId: ID
  identifier: string
  type: ArtifactType
  title: string
  language: string | null
  createdAt: number
  updatedAt: number
  versions: ArtifactVersion[]
}

export interface ArtifactSummary {
  id: ID
  conversationId: ID
  conversationTitle: string
  projectId: ID | null
  identifier: string
  type: ArtifactType
  title: string
  language: string | null
  versionCount: number
  updatedAt: number
}

export interface ConversationDetail {
  conversation: Conversation
  messages: Message[]
  artifacts: Artifact[]
}

export interface SearchHit {
  conversationId: ID
  title: string
  snippet: string
  updatedAt: number
}

// ---- Models -------------------------------------------------------------

export type ThinkProfile =
  | { kind: 'none' }
  | { kind: 'toggle' }
  | { kind: 'always'; note?: string }
  | { kind: 'levels'; canDisable: boolean }

export interface ModelOverrides {
  think?: ThinkProfile['kind']
  artifacts?: boolean
  autoSkills?: boolean
}

export interface ModelInfo {
  name: string
  /** Cloud models run on ollama.com; local ones on this machine. */
  location: 'cloud' | 'local'
  installed: boolean
  capabilities: string[]
  contextLength: number | null
  family: string | null
  parameterSize: string | null
  overrides: ModelOverrides
}

export interface ModelListResult {
  models: ModelInfo[]
  error: string | null
}

// ---- Skills -------------------------------------------------------------

export type SkillSource = 'app' | 'ollama' | 'claude'

export interface Skill {
  id: string
  name: string
  description: string
  source: SkillSource
  dir: string
  readOnly: boolean
  hasScripts: boolean
  enabled: boolean
  files: string[]
}

export interface SkillDetail extends Skill {
  body: string
}

// ---- Theming ------------------------------------------------------------

export const PALETTE_KEYS = [
  'canvas',
  'sidebar',
  'panel',
  'hover',
  'bubble',
  'code',
  'fg',
  'muted',
  'subtle',
  'line',
  'lineStrong',
  'accent',
  'accentFg',
  'accentSoft',
  'danger',
  'synKeyword',
  'synString',
  'synComment',
  'synFunction',
  'synConstant',
  'synPunctuation'
] as const

export type PaletteKey = (typeof PALETTE_KEYS)[number]
export type Palette = Record<PaletteKey, string>

export interface ThemeDef {
  id: string
  name: string
  builtin: boolean
  light: Palette
  dark: Palette
  fonts: { ui: string; reading: string; mono: string }
  radius: number
}

// ---- Settings -----------------------------------------------------------

export interface Settings {
  userName: string
  preferences: string
  connection: { mode: 'local' | 'direct'; host: string; hasApiKey: boolean }
  defaultModel: string | null
  titleModel: string | null
  showCloudCatalog: boolean
  localNumCtx: number
  appearance: {
    themeId: string
    mode: 'system' | 'light' | 'dark'
    fontSize: number
    chatWidth: number
    responseFont: 'reading' | 'ui'
  }
  artifacts: { enabled: boolean; allowCdn: boolean }
  /** `disabled` turns off app/Ollama skills; Claude skills are off unless listed in `enabledImports`. */
  skills: { sources: { ollama: boolean; claude: boolean }; disabled: string[]; enabledImports: string[]; autoLoad: boolean }
}

// ---- Chat streaming -----------------------------------------------------

export interface SendRequest {
  conversationId: ID | null
  projectId: ID | null
  content: string
  attachmentIds: ID[]
  model: string
  think: ThinkSetting | null
  skills: string[]
}

export interface SendResult {
  conversation: Conversation
  userMessage: Message | null
  assistantMessageId: ID
}

export type ChatEvent =
  | { type: 'delta'; conversationId: ID; messageId: ID; content?: string; thinking?: string }
  | { type: 'tool'; conversationId: ID; messageId: ID; event: ToolEvent }
  | { type: 'done'; conversationId: ID; message: Message; artifacts: Artifact[]; conversation: Conversation }
  | { type: 'error'; conversationId: ID; messageId: ID; error: string }
  | { type: 'title'; conversationId: ID; title: string }

export type FileSource = { path: string } | { name: string; mime: string; data: ArrayBuffer }
