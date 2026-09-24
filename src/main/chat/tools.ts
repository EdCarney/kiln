import type { ToolEvent } from '@shared/types'
import type { OllamaTool, ToolCall } from '../ollama/client'
import { findSkillByName, getSkill, readSkillFile } from '../skills/library'
import { errorMessage } from '../util'

export const SKILL_TOOLS: OllamaTool[] = [
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        'Load the full instructions of a skill from the available skills list. Call this before starting a task that matches a skill description.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The exact skill name from the list' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_skill_file',
      description: 'Read a supporting file (reference, template, example) that belongs to a loaded skill.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name' },
          path: { type: 'string', description: 'Path of the file inside the skill folder, e.g. references/guide.md' }
        },
        required: ['name', 'path']
      }
    }
  }
]

export interface ToolResult {
  content: string
  event: ToolEvent
  /** Skill id to add to the conversation's active skills, so later turns keep it. */
  loadedSkillId?: string
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

export async function runTool(call: ToolCall): Promise<ToolResult> {
  const name = call.function.name
  const args = argsOf(call)
  const skillName = String(args.name ?? '')
  try {
    if (name === 'load_skill') {
      const skill = await findSkillByName(skillName)
      if (!skill) throw new Error(`No enabled skill named "${skillName}"`)
      const detail = (await getSkill(skill.id))!
      const extra = skill.files.length ? `\n\nSupporting files: ${skill.files.slice(0, 40).join(', ')}` : ''
      const scripts = skill.hasScripts
        ? '\n\n[This app cannot execute scripts. Where the skill says to run one, produce the result directly instead.]'
        : ''
      return {
        content: `${detail.body}${extra}${scripts}`,
        event: { tool: name, args, ok: true, summary: skill.name },
        loadedSkillId: skill.id
      }
    }
    if (name === 'read_skill_file') {
      const skill = await findSkillByName(skillName)
      if (!skill) throw new Error(`No enabled skill named "${skillName}"`)
      const path = String(args.path ?? '')
      return {
        content: await readSkillFile(skill, path),
        event: { tool: name, args, ok: true, summary: `${skill.name}/${path}` }
      }
    }
    throw new Error(`Unknown tool "${name}"`)
  } catch (err) {
    const message = errorMessage(err)
    return { content: `Error: ${message}`, event: { tool: name, args, ok: false, summary: message } }
  }
}
