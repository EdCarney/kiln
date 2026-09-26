import { safeStorage } from 'electron'
import type { McpServer, McpServerInput, ToolPolicy } from '@shared/types'
import { readSetting, writeSetting } from '../db/kv'

// MCP server definitions live in the settings table under their own key, not in Settings: their environment often
// holds tokens (a GitHub PAT, an API key), so it's encrypted with the OS keychain like the ollama.com key, and only
// the variable names ever reach the renderer.

interface StoredServer extends Omit<McpServer, 'envKeys'> {
  /** The environment as JSON, encrypted with safeStorage and base64-encoded; null when there is none. */
  env: string | null
  envKeys: string[]
}

/** A server as Kiln starts it: the stored definition with its environment decrypted. */
export interface ServerConfig extends McpServer {
  env: Record<string, string>
}

const KEY = 'mcpServers'

// Read on every tool lookup during a reply, so kept in memory; every write goes through store().
let cache: StoredServer[] | null = null
const stored = (): StoredServer[] => (cache ??= readSetting<StoredServer[]>(KEY, []))
const store = (servers: StoredServer[]) => {
  writeSetting(KEY, servers)
  cache = servers
}

const publicView = ({ env: _env, ...server }: StoredServer): McpServer => server

function decryptEnv(enc: string | null): Record<string, string> {
  if (!enc) return {}
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64'))) as Record<string, string>
  } catch {
    return {}
  }
}

function encryptEnv(env: Record<string, string>): string | null {
  if (!Object.keys(env).length) return null
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS encryption is unavailable, so Kiln can't store this server's environment.")
  return safeStorage.encryptString(JSON.stringify(env)).toString('base64')
}

/**
 * A server id from its name, used as the prefix of its tool names: lowercase letters, digits and single underscores
 * (so it never contains the `__` that separates it from the tool name), unique among `taken`.
 */
export function serverId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24)
      .replace(/_+$/, '') || 'server'
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`
  return id
}

export function listServers(): McpServer[] {
  return stored().map(publicView)
}

export function getServer(id: string): McpServer | null {
  const s = stored().find((x) => x.id === id)
  return s ? publicView(s) : null
}

export function getServerConfig(id: string): ServerConfig | null {
  const s = stored().find((x) => x.id === id)
  return s ? { ...publicView(s), env: decryptEnv(s.env) } : null
}

function validate(input: McpServerInput): void {
  if (!input.name.trim()) throw new Error('Give the server a name.')
  if (!input.command.trim()) throw new Error('Enter the command that starts the server (for example npx or uvx).')
  for (const key of Object.keys(input.env))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`"${key}" isn't a valid environment variable name.`)
}

/** Add a server, or update one (its id stays the same). Returns the saved server. */
export function saveServer(input: McpServerInput): McpServer {
  validate(input)
  const servers = stored()
  const existing = input.id ? servers.find((s) => s.id === input.id) : undefined
  if (input.id && !existing) throw new Error('That MCP server no longer exists.')
  const env = existing ? decryptEnv(existing.env) : {}
  for (const [key, value] of Object.entries(input.env)) {
    if (value === null) delete env[key]
    else env[key] = value
  }
  const next: StoredServer = {
    id:
      existing?.id ??
      serverId(
        input.name,
        servers.map((s) => s.id)
      ),
    name: input.name.trim(),
    command: input.command.trim(),
    args: input.args.map((a) => a.trim()).filter(Boolean),
    cwd: input.cwd?.trim() || null,
    env: encryptEnv(env),
    envKeys: Object.keys(env).sort(),
    defaultOn: input.defaultOn,
    tools: existing?.tools ?? {}
  }
  store(existing ? servers.map((s) => (s.id === next.id ? next : s)) : [...servers, next])
  return publicView(next)
}

export function removeServer(id: string): void {
  store(stored().filter((s) => s.id !== id))
}

/** How one of a server's tools is offered (Ask when never set). */
export function toolPolicy(server: McpServer, tool: string): ToolPolicy {
  return server.tools[tool] ?? 'ask'
}

export function setToolPolicy(id: string, tool: string, policy: ToolPolicy): McpServer {
  const servers = stored()
  const server = servers.find((s) => s.id === id)
  if (!server) throw new Error('That MCP server no longer exists.')
  const tools = { ...server.tools }
  if (policy === 'ask') delete tools[tool]
  else tools[tool] = policy
  const next = { ...server, tools }
  store(servers.map((s) => (s.id === id ? next : s)))
  return publicView(next)
}
