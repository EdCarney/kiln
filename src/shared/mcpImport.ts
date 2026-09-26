// Reading MCP server definitions in the JSON that server READMEs and other apps use:
//   {"mcpServers": {"name": {"command": "npx", "args": [...], "env": {...}}}}  (Claude Desktop, Claude Code, Cursor)
//   {"servers": {...}}                                                        (VS Code)
//   {"name": {"command": ...}}  or a single {"command": ...}

export interface ImportedServer {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string | null
}

export interface ParsedServers {
  servers: ImportedServer[]
  /** Entries that were left out, each as "name: why". */
  skipped: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A name for a lone definition: the package it runs (`@scope/server-foo` → server-foo), else the command. */
function nameFor(def: Record<string, unknown>): string {
  const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : []
  const pkg = args.find((a) => !a.startsWith('-') && /^(@[\w.-]+\/)?[\w.-]+(@[\w.^~-]+)?$/.test(a) && /[a-z]/i.test(a))
  const base = (pkg ?? String(def.command ?? 'server'))
    .replace(/@[\w.^~-]+$/, '')
    .split('/')
    .pop()!
  return base || 'server'
}

function readServer(name: string, def: unknown): ImportedServer | string {
  if (!isObject(def)) return `${name}: not a server definition`
  const type = typeof def.type === 'string' ? def.type.toLowerCase() : 'stdio'
  if (typeof def.url === 'string' || (type !== 'stdio' && type !== 'local'))
    return `${name}: remote (${type === 'stdio' ? 'http' : type}) servers aren't supported. Run it through a local bridge such as mcp-remote.`
  if (typeof def.command !== 'string' || !def.command.trim()) return `${name}: no command`
  if (def.args !== undefined && (!Array.isArray(def.args) || def.args.some((a) => typeof a !== 'string')))
    return `${name}: args must be a list of strings`
  if (def.env !== undefined && (!isObject(def.env) || Object.values(def.env).some((v) => typeof v !== 'string')))
    return `${name}: env values must be strings`
  return {
    name,
    command: def.command.trim(),
    args: (def.args as string[] | undefined) ?? [],
    env: (def.env as Record<string, string> | undefined) ?? {},
    cwd: typeof def.cwd === 'string' && def.cwd.trim() ? def.cwd.trim() : null
  }
}

/** Read server definitions from JSON text. Throws when it isn't JSON or holds no definitions at all. */
export function parseServersJson(text: string): ParsedServers {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("That isn't valid JSON. Paste the whole snippet, including the outer { }.")
  }
  if (!isObject(data)) throw new Error('Expected a JSON object with MCP server definitions.')
  const entries: Array<[string, unknown]> = isObject(data.mcpServers)
    ? Object.entries(data.mcpServers)
    : isObject(data.servers)
      ? Object.entries(data.servers)
      : typeof data.command === 'string' || typeof data.url === 'string'
        ? [[nameFor(data), data]]
        : Object.entries(data).filter(([, v]) => isObject(v))
  if (!entries.length) throw new Error('No MCP server definitions found in that JSON.')
  const servers: ImportedServer[] = []
  const skipped: string[] = []
  for (const [name, def] of entries) {
    const read = readServer(name, def)
    if (typeof read === 'string') skipped.push(read)
    else servers.push(read)
  }
  return { servers, skipped }
}
