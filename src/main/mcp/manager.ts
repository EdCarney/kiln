import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer, McpStatus, McpToolInfo } from '@shared/types'
import { childEnv } from '../env'
import { errorMessage, estimateTokens } from '../util'
import { getServer, getServerConfig, listServers, reviewTrust } from './config'
import { ProcessTransport } from './transport'

// Connections to the MCP servers, started when a chat that uses one opens or sends. A server keeps running until
// it's stopped, edited or removed, or Kiln quits. One that exits on its own is marked with the reason, and the next
// use tries again.

const CONNECT_TIMEOUT_MS = 60_000 // the first `npx -y` can download the server
const CALL_TIMEOUT_MS = 120_000 // reset whenever the server reports progress
const CLIENT = { name: 'Kiln', version: '1.0' }

interface Connection {
  status: McpStatus
  client: Client | null
  tools: Tool[]
  transport: ProcessTransport | null
  /** stderr of the latest start, kept after the server stops so a failure can be read. */
  log: string[]
  starting: Promise<void> | null
  /** The generation `starting` belongs to: a stop or restart since then means it must not be reused. */
  startingGeneration: number
  /** The transport of a start still connecting, so a stop can close it rather than let it run on. */
  connecting: ProcessTransport | null
  /** Bumped by every start and stop, so a start that was overtaken leaves things alone. */
  generation: number
}

const connections = new Map<string, Connection>()
const listeners = new Set<(statuses: McpStatus[]) => void>()

const stopped = (id: string): McpStatus => ({ id, state: 'stopped', error: null, tools: [], serverInfo: null })

function connection(id: string): Connection {
  let c = connections.get(id)
  if (!c) {
    c = {
      status: stopped(id),
      client: null,
      tools: [],
      transport: null,
      log: [],
      starting: null,
      startingGeneration: 0,
      connecting: null,
      generation: 0
    }
    connections.set(id, c)
  }
  return c
}

/** Tell listeners every server's state (also after servers are added or removed). */
export function notify(): void {
  const all = statuses()
  for (const cb of listeners) cb(all)
}

function update(c: Connection, patch: Partial<McpStatus>): void {
  c.status = { ...c.status, ...patch }
  notify()
}

const toolInfo = (t: Tool): McpToolInfo => ({
  name: t.name,
  title: t.title ?? t.annotations?.title ?? null,
  description: t.description ?? '',
  tokens: estimateTokens(JSON.stringify({ name: t.name, description: t.description, parameters: t.inputSchema }))
})

/**
 * What a tool is, as a hash: everything the model and the user are shown about it (title, description, input schema,
 * annotations). Trust is given to one fingerprint; a server that changes the tool changes it (#64).
 */
export function fingerprintOf(t: Tool): string {
  const shown = { title: t.title ?? null, description: t.description ?? '', inputSchema: t.inputSchema, annotations: t.annotations ?? null }
  return createHash('sha256').update(JSON.stringify(shown)).digest('hex')
}

/** A running server's tool as it is now, for trusting it; null when the server isn't running or has no such tool. */
export function toolFingerprint(id: string, tool: string): string | null {
  const t = connections.get(id)?.tools.find((x) => x.name === tool)
  return t ? fingerprintOf(t) : null
}

/** Take a server's tool list (at start, or when it says the list changed), putting changed trusted tools back on Ask. */
function setTools(c: Connection, tools: Tool[]): void {
  c.tools = tools
  reviewTrust(c.status.id, new Map(tools.map((t) => [t.name, fingerprintOf(t)])))
  update(c, { tools: tools.map(toolInfo) })
}

/** Every configured server's state, in the order they were added. */
export function statuses(): McpStatus[] {
  return listServers().map((s) => connections.get(s.id)?.status ?? stopped(s.id))
}

export function onStatusChange(cb: (statuses: McpStatus[]) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** A connected server's tools, with its definition. Empty when it isn't running. */
export function readyTools(): Array<{ server: McpServer; tools: Tool[] }> {
  return listServers().flatMap((server) => {
    const c = connections.get(server.id)
    return c?.client && c.status.state === 'ready' ? [{ server, tools: c.tools }] : []
  })
}

function lastLine(transport: ProcessTransport): string {
  return transport.log.at(-1)?.trim() ?? ''
}

function exitMessage(transport: ProcessTransport): string {
  const how = transport.exit?.signal ? ` (${transport.exit.signal})` : transport.exit?.code ? ` (exit code ${transport.exit.code})` : ''
  const last = lastLine(transport)
  return `The server stopped${how}.${last ? ` It said: ${last}` : ''}`
}

function startError(err: unknown, command: string, transport: ProcessTransport): string {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT')
    return `Couldn't find "${command}". Check that it's installed and on your login shell's PATH.`
  if (transport.exit) return exitMessage(transport)
  const message = errorMessage(err)
  if (/timed out/i.test(message)) return `The server didn't finish starting within ${CONNECT_TIMEOUT_MS / 1000} seconds.`
  const last = lastLine(transport)
  return last ? `${message} It said: ${last}` : message
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS })
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor && tools.length < 1000)
  return tools
}

/** Start a server as `generation`, which connect() has already claimed, so a later stop or restart always overtakes it. */
async function start(id: string, c: Connection, generation: number): Promise<void> {
  const config = getServerConfig(id)
  if (!config) return
  update(c, { state: 'starting', error: null, tools: [], serverInfo: null })
  const env = await childEnv(config.env)
  if (c.generation !== generation) return // stopped while the environment was worked out
  const transport = new ProcessTransport({ command: config.command, args: config.args, cwd: config.cwd ?? homedir(), env })
  c.log = transport.log
  c.connecting = transport
  const client = new Client(CLIENT, {
    listChanged: {
      tools: {
        onChanged: (err, tools) => {
          if (!err && tools && c.client === client) setTools(c, tools)
        }
      }
    }
  })
  // Only a server that was running gets here by surprise; a failed start is reported below.
  client.onclose = () => {
    if (c.client !== client) return
    c.client = null
    c.transport = null
    c.tools = []
    update(c, { state: 'error', error: exitMessage(transport), tools: [] })
  }
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
    const tools = await listAllTools(client)
    if (c.generation !== generation) return void (await client.close())
    c.client = client
    c.transport = transport
    setTools(c, tools)
    const info = client.getServerVersion()
    update(c, { state: 'ready', serverInfo: info ? { name: info.name, version: info.version } : null })
  } catch (err) {
    await transport.close().catch(() => undefined)
    if (c.generation === generation) update(c, { state: 'error', error: startError(err, config.command, transport) })
  } finally {
    if (c.connecting === transport) c.connecting = null
  }
}

/** Start a server if it isn't running (or starting). Resolves once it's ready or has failed; never rejects. */
export function connect(id: string): Promise<void> {
  const c = connection(id)
  if (c.client && c.status.state === 'ready') return Promise.resolve()
  // A start that a stop or restart overtook is finishing for nothing: begin a new one rather than wait on it.
  if (c.starting && c.startingGeneration === c.generation) return c.starting
  const generation = ++c.generation
  const starting: Promise<void> = start(id, c, generation).finally(() => {
    if (c.starting === starting) c.starting = null
  })
  c.starting = starting
  c.startingGeneration = generation
  return starting
}

/**
 * Start the servers a reply needs, waiting up to `waitMs`. Returns a line for each one that isn't ready, for the
 * reply to mention. Servers that were removed are skipped.
 */
export async function ensure(ids: string[], waitMs: number): Promise<string[]> {
  const present = ids.filter((id) => getServer(id))
  let timer: NodeJS.Timeout | undefined
  await Promise.race([Promise.all(present.map(connect)), new Promise((r) => (timer = setTimeout(r, waitMs)))])
  clearTimeout(timer)
  return present.flatMap((id) => {
    const { state, error } = connection(id).status
    const name = getServer(id)!.name
    if (state === 'ready') return []
    if (state === 'starting') return [`${name} was still starting.`]
    return [`${name} couldn't start: ${error ?? 'unknown error'}`]
  })
}

export async function stop(id: string): Promise<void> {
  const c = connections.get(id)
  if (!c) return
  c.generation++
  const client = c.client
  // A start still connecting is stopped too, so its process doesn't run on (with an old command or secrets).
  const connecting = c.connecting
  c.client = null
  c.transport = null
  c.connecting = null
  c.tools = []
  update(c, stopped(id))
  await Promise.all([client?.close().catch(() => undefined), connecting?.close().catch(() => undefined)])
}

export async function restart(id: string): Promise<void> {
  await stop(id)
  await connect(id)
}

/** Forget a server that was removed from the config. */
export async function forget(id: string): Promise<void> {
  await stop(id)
  connections.delete(id)
  notify()
}

export async function stopAll(): Promise<void> {
  await Promise.all([...connections.keys()].map(stop))
}

/** What a server last wrote to stderr (its latest start). */
export const serverLog = (id: string): string[] => [...(connections.get(id)?.log ?? [])]

/** Whether a server is running or starting, so an edit should restart it. */
export const isActive = (id: string): boolean => {
  const state = connections.get(id)?.status.state
  return state === 'ready' || state === 'starting'
}

/** Call a tool on a running server. Stop cancels it (the server is told); progress reports keep it from timing out. */
export async function callTool(id: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  const client = connections.get(id)?.client
  if (!client) throw new Error(`${getServer(id)?.name ?? 'The MCP server'} isn't running.`)
  const result = await client.callTool({ name: tool, arguments: args }, undefined, {
    signal,
    timeout: CALL_TIMEOUT_MS,
    resetTimeoutOnProgress: true,
    onprogress: () => undefined
  })
  return result as CallToolResult
}
