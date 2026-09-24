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
  /** Still running (web requests take a few seconds); replaced by the final event at the same index. */
  pending?: boolean
}

export interface MessageStats {
  promptTokens?: number
  completionTokens?: number
  durationMs?: number
  tokensPerSecond?: number
  thinkingMs?: number
  truncatedHistory?: number
  /** Estimated USD for the requests behind this reply; null when the model's price is unknown. */
  costUsd?: number | null
  /** Token counts were estimated (e.g. the reply was stopped). */
  estimated?: boolean
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
  usage: ChatUsage
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

export interface ModelPrice {
  /** USD per million tokens. */
  input: number
  cachedInput: number | null
  output: number
}

export interface PriceTable {
  prices: Record<string, ModelPrice>
  /** When the table was read from ollama.com/pricing (or the bundled snapshot date). */
  updatedAt: number
  source: 'ollama.com' | 'bundled'
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
  /** Published cloud price, if known. Local models are free. */
  price: ModelPrice | null
}

export interface ModelListResult {
  models: ModelInfo[]
  error: string | null
}

// ---- Usage & cost ---------------------------------------------------------

export interface UsageWindow {
  id: string
  label: string
  /** Fraction of the window's allowance used, 0–1. */
  usage: number
  periodMs: number | null
  /** Next reset, when known (Ollama's API doesn't report it). */
  resetAt: number | null
  resetSource: 'configured' | 'detected' | null
  /** Requests per model in this window, across every app using the account. */
  models: Array<{ name: string; requests: number }>
}

export interface AccountUsage {
  plan: string | null
  windows: UsageWindow[]
  spend: {
    cost: number
    label: string
    /**
     * 'credits': worked out from the monthly window's share of the plan's credit pool (credit plans
     * report no dollar figure). 'activity': Ollama's own cost figure.
     */
    source: 'credits' | 'activity'
    /** Size of the monthly credit pool, for "$0.54 of $60". */
    pool: number | null
    periodStart: number | null
    periodEnd: number | null
    models: Array<{ model: string; cost: number }>
  } | null
  fetchedAt: number
  /** Set when there's no API key, so the UI can prompt for one. */
  needsKey: boolean
  error: string | null
}

export interface TokenTotals {
  promptTokens: number
  completionTokens: number
  /** Null when some usage came from a cloud model without a known price. */
  costUsd: number | null
  /** At least one request had no token counts (e.g. stopped mid-stream) and was estimated. */
  estimated: boolean
}

export interface ChatUsage extends TokenTotals {
  byModel: Array<TokenTotals & { model: string; requests: number }>
  /** Tokens the most recent request sent + received, for a context-window meter. */
  lastContextTokens: number | null
}

export interface UsageSummary {
  days: number
  total: TokenTotals & { requests: number }
  byModel: Array<TokenTotals & { model: string; requests: number }>
  byDay: Array<{ day: string; costUsd: number; tokens: number }>
}

// ---- Debugger traces -----------------------------------------------------

export type TraceKind = 'chat' | 'title' | 'tool' | 'replay'
export type TraceStatus = 'running' | 'ok' | 'error' | 'aborted'

export interface TraceSummary {
  id: string
  conversationId: ID | null
  messageId: ID | null
  kind: TraceKind
  model: string | null
  /** Tool-loop round within a turn (0-based), for chat traces. */
  round: number | null
  status: TraceStatus
  startedAt: number
  durationMs: number | null
  promptTokens: number | null
  completionTokens: number | null
  costUsd: number | null
  /** One-line description: tool call, first words of the reply, error. */
  summary: string
}

export interface TraceTiming {
  /** Time until Ollama's first response byte. */
  ttfbMs: number | null
  /** Time until the first thinking or content token. */
  firstTokenMs: number | null
  totalMs: number | null
  /** Ollama's own durations (from the final chunk). */
  loadMs: number | null
  promptEvalMs: number | null
  evalMs: number | null
}

export interface TraceDetail extends TraceSummary {
  endpoint: string
  /** The exact body sent, with image bytes replaced by size placeholders. */
  request: unknown
  response: {
    content?: string
    thinking?: string
    toolCalls?: unknown[]
    /** Ollama's final chunk (stats, done_reason) without the message. */
    final?: unknown
    /** For tool traces: what was returned to the model. */
    result?: string
    error?: string
    chunks?: number
  }
  timing: TraceTiming
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
  'success',
  'warn',
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
  /** Web search and page reading through Ollama's web API (needs an ollama.com API key). */
  web: { enabled: boolean }
  /** Record every request for the debugger window. */
  debug: { record: boolean }
  /** Hover cards on links; `previews` fetches page title/image from this Mac (off by default for privacy). */
  links: { previews: boolean }
  usage: {
    /** Show quota and chat cost in the title bar. */
    showInHeader: boolean
    /** Which quota window the title bar shows ('auto' picks the longest one reported). */
    headerWindow: string
    /** Known reset moments per window, set by the user or detected from a usage drop. */
    anchors: Record<string, { at: number; source: 'configured' | 'detected' } | null>
    /** Day of month a credit-based plan refreshes. */
    monthlyDay: number | null
    /** Monthly credit pool in USD; null uses the plan's published size. */
    poolUsd: number | null
  }
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
  | { type: 'tool'; conversationId: ID; messageId: ID; index: number; event: ToolEvent }
  | { type: 'done'; conversationId: ID; message: Message; artifacts: Artifact[]; conversation: Conversation; usage: ChatUsage }
  | { type: 'error'; conversationId: ID; messageId: ID; error: string }
  | { type: 'title'; conversationId: ID; title: string }

export type FileSource = { path: string } | { name: string; mime: string; data: ArrayBuffer }
