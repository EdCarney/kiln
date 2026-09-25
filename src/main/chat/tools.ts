import type { ToolEvent } from '@shared/types'
import type { OllamaTool, ToolCall } from '../ollama/client'
import { errorMessage } from '../util'
import type { PastToolCall } from './assemble'
import { capText, TOOL_RESULT_CHARS } from './results'
import { skillTools } from './skillTools'
import { webTools } from './webTools'

/** What a request's tools let the model do. Decides what the prompt and error messages say Kiln can't do. */
export type ToolGrant = 'web' | 'code'

/** What this request offers, and the reply it belongs to. */
export interface ToolContext {
  skills: boolean
  web: boolean
  /** The folder tools act in, for a later Code mode. Nothing uses it yet. */
  workspace: string | null
  /** The reply's stop signal: long-running tools are cancelled with it. */
  signal?: AbortSignal
}

/** A tool's run also knows what the whole request grants (a skill with scripts needs to know if code can run). */
export type RunContext = ToolContext & { grants: ReadonlySet<ToolGrant> }

export interface ToolResult {
  content: string
  event: ToolEvent
  /** Skill id to add to the conversation's active skills, so later turns keep it. */
  loadedSkillId?: string
  /** The model called a tool Kiln doesn't provide (often a web or code tool it saw in training). */
  unknown?: boolean
}

/** A call matched to the provider that runs it. `via` is the name the model used when it called an alias. */
export interface ResolvedCall {
  provider: ToolProvider
  name: string
  via: string | null
  args: Record<string, unknown>
}

/** A group of tools: the built-in skill and web tools now, MCP servers and a code runner later (#31). */
export interface ToolProvider {
  id: string
  /** The tools offered with this request; none when the provider is off. */
  tools(ctx: ToolContext): OllamaTool[]
  /** What these tools let the model do while they're offered. */
  grants?: ToolGrant[]
  /** A sentence for the unknown-tool reply that points the model at these tools. */
  hint?: string
  /**
   * Claim a call to a name nothing offers (gpt-oss's `browser.open`): return the offered tool it maps to, or
   * null. Only asked after exact names, so an alias can never shadow a real tool such as an MCP server's `fetch`.
   */
  alias?(name: string, args: Record<string, unknown>): string | null
  /** What to show while the call runs. */
  pending(call: ResolvedCall): ToolEvent
  /** Run the call. Throwing is fine: the error goes back to the model (a stop is re-thrown instead). */
  run(call: ResolvedCall, ctx: RunContext): Promise<ToolResult>
  /** What later turns keep of a finished call; null or absent keeps nothing. */
  replay?(event: ToolEvent): PastToolCall | null
  /** Whether a call runs straight away. Only 'auto' until #31 adds asking first. */
  approval: 'auto'
}

const BUILT_IN: ToolProvider[] = [skillTools, webTools]
let registered: ToolProvider[] = []

/** Add a provider; returns a function that removes it. */
export function registerToolProvider(provider: ToolProvider): () => void {
  registered = [...registered, provider]
  return () => {
    registered = registered.filter((p) => p !== provider)
  }
}

const providers = (): ToolProvider[] => [...BUILT_IN, ...registered]
const active = (ctx: ToolContext) => providers().filter((p) => p.tools(ctx).length > 0)

/** Every tool offered with this request, each name once (the first provider to offer a name keeps it). */
export function toolsFor(ctx: ToolContext): OllamaTool[] | undefined {
  const byName = new Map<string, OllamaTool>()
  for (const tool of providers().flatMap((p) => p.tools(ctx))) if (!byName.has(tool.function.name)) byName.set(tool.function.name, tool)
  return byName.size ? [...byName.values()] : undefined
}

export function toolGrants(ctx: ToolContext): Set<ToolGrant> {
  return new Set(active(ctx).flatMap((p) => p.grants ?? []))
}

/** What Kiln can't do with this request's tools, for an error shown to the user; null when it can do both. */
export function missingAbilities(grants: ReadonlySet<ToolGrant>): string | null {
  const missing = [!grants.has('web') && 'browse the web', !grants.has('code') && 'run code'].filter(Boolean)
  return missing.length ? `Kiln can't ${missing.join(' or ')}.` : null
}

function argsOf(call: ToolCall): Record<string, unknown> {
  const raw = call.function.arguments
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return raw ?? {}
}

/** Match a call to its provider: exact names first, then aliases. Null when nothing offers it. */
export function resolveCall(call: ToolCall, ctx: ToolContext): ResolvedCall | null {
  const name = call.function.name
  const args = argsOf(call)
  const offering = active(ctx)
  const exact = offering.find((p) => p.tools(ctx).some((t) => t.function.name === name))
  if (exact) return { provider: exact, name, via: null, args }
  for (const provider of offering) {
    const target = provider.alias?.(name, args)
    if (target) return { provider, name: target, via: name, args }
  }
  return null
}

/**
 * gpt-oss and others are trained with built-in browser/python tools and will guess at names like
 * "web.run" or "browser.open". A bare "unknown tool" makes them try the next name, so say plainly
 * what exists and what can't be done.
 */
function unknownToolMessage(name: string, ctx: ToolContext, grants: ReadonlySet<ToolGrant>): string {
  const available = (toolsFor(ctx) ?? []).map((t) => t.function.name)
  const list = available.length ? `The only tools available are ${available.join(', ')}.` : 'No tools are available.'
  const web = grants.has('web')
  const code = grants.has('code')
  const lacks =
    !web && !code
      ? 'Kiln has no internet access, browser, web search or code execution.'
      : !web
        ? 'Kiln has no internet access, browser or web search.'
        : !code
          ? 'Kiln cannot run code.'
          : ''
  const limits = [...active(ctx).flatMap((p) => p.hint ?? []), lacks].filter(Boolean).join(' ')
  return `Error: there is no tool named "${name}". ${list} ${limits} Don't try other tool names. Answer the user directly and tell them plainly what you can't do.`
}

// What a tool card can show of a result: enough to see what came back, without storing whole pages per call.
const PREVIEW_CHARS = 1500
const preview = (content: string) => (content.length > PREVIEW_CHARS ? `${content.slice(0, PREVIEW_CHARS)}…` : content)

/** A call that was still running when the reply stopped: show it as stopped, not spinning forever. */
export function settleToolEvent(e: ToolEvent): ToolEvent {
  return e.pending ? { ...e, pending: false, ok: false, summary: `${e.summary} (stopped)` } : e
}

/** What to show while a call runs, before its result is known. */
export function pendingEvent(call: ToolCall, ctx: ToolContext): ToolEvent {
  const resolved = resolveCall(call, ctx)
  if (resolved) return resolved.provider.pending(resolved)
  return { tool: call.function.name, args: argsOf(call), ok: true, pending: true, summary: call.function.name, unknown: true }
}

export async function runTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const grants = toolGrants(ctx)
  const resolved = resolveCall(call, ctx)
  if (!resolved) {
    const name = call.function.name
    return {
      content: unknownToolMessage(name, ctx, grants),
      event: { tool: name, args: argsOf(call), ok: false, summary: name, unknown: true },
      unknown: true
    }
  }
  let result: ToolResult
  try {
    result = await resolved.provider.run(resolved, { ...ctx, grants })
  } catch (err) {
    if (ctx.signal?.aborted) throw err
    const message = errorMessage(err)
    result = { content: `Error: ${message}`, event: { tool: resolved.name, args: resolved.args, ok: false, summary: message } }
  }
  return { ...result, content: capText(result.content, TOOL_RESULT_CHARS), event: { preview: preview(result.content), ...result.event } }
}

/** The finished calls behind a reply that later turns keep, in brief, as each tool's provider decides. */
export function replayCalls(events: ToolEvent[]): PastToolCall[] {
  return events.flatMap((e) => {
    if (!e.ok || e.pending) return []
    for (const p of providers()) {
      const past = p.replay?.(e)
      if (past) return [past]
    }
    return []
  })
}
