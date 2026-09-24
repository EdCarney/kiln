import type { Skill } from '@shared/types'
import type { OllamaMessage } from '../ollama/client'
import { estimateTokens } from '../util'
import {
  artifactsPrompt,
  basePrompt,
  documentBlock,
  loadedSkillsPrompt,
  preferencesPrompt,
  projectPrompt,
  selectedSkillsPrompt,
  skillIndexPrompt
} from './prompts'

export interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
  thinking?: string | null
  documents: Array<{ name: string; text: string }>
  /** Base64 images; only filled when the model has vision. */
  images: string[]
  /** Names of images the current model can't see. */
  hiddenImages: string[]
}

export type SkillText = { name: string; body: string; files: string[]; hasScripts: boolean }

export interface AssembleInput {
  model: string
  contextLength: number | null
  userName: string
  preferences: string
  date: Date
  artifacts: { enabled: boolean; allowCdn: boolean }
  project: { name: string; instructions: string } | null
  knowledge: Array<{ name: string; text: string }>
  skillIndex: Skill[]
  /** Skills the user picked: applied to every reply. */
  selectedSkills: SkillText[]
  /** Skills the model loaded earlier: applied where relevant. */
  loadedSkills: SkillText[]
  history: HistoryTurn[]
}

export interface Assembled {
  messages: OllamaMessage[]
  /** Oldest turns dropped to fit the context window. */
  droppedTurns: number
  estimatedTokens: number
}

const IMAGE_TOKENS = 1600
const DEFAULT_CONTEXT = 128_000

export function buildSystemPrompt(input: AssembleInput): string {
  const parts = [basePrompt({ userName: input.userName, model: input.model, date: input.date })]
  if (input.preferences.trim()) parts.push(preferencesPrompt(input.preferences))
  if (input.project) parts.push(projectPrompt(input.project))
  if (input.knowledge.length)
    parts.push(
      `<project_knowledge>\nThe user added these files to the project. Use them when relevant.\n${input.knowledge
        .map((k) => documentBlock(k.name, k.text))
        .join('\n')}\n</project_knowledge>`
    )
  if (input.artifacts.enabled) parts.push(artifactsPrompt(input.artifacts.allowCdn))
  if (input.skillIndex.length) parts.push(skillIndexPrompt(input.skillIndex))
  if (input.loadedSkills.length) parts.push(loadedSkillsPrompt(input.loadedSkills))
  if (input.selectedSkills.length) parts.push(selectedSkillsPrompt(input.selectedSkills))
  return parts.join('\n\n')
}

function turnToMessage(turn: HistoryTurn): OllamaMessage {
  if (turn.role === 'assistant') return { role: 'assistant', content: turn.content }
  const docs = turn.documents.map((d) => documentBlock(d.name, d.text, 'attachment'))
  const hidden = turn.hiddenImages.map(
    (n) => `[The user attached an image, “${n}”, but the current model can't see images.]`
  )
  const content = [...docs, ...hidden, turn.content].filter(Boolean).join('\n\n')
  return turn.images.length ? { role: 'user', content, images: turn.images } : { role: 'user', content }
}

function turnTokens(turn: HistoryTurn): number {
  return (
    estimateTokens(turn.content) +
    turn.documents.reduce((n, d) => n + estimateTokens(d.text), 0) +
    turn.images.length * IMAGE_TOKENS
  )
}

export function assemble(input: AssembleInput): Assembled {
  const system = buildSystemPrompt(input)
  const context = input.contextLength ?? DEFAULT_CONTEXT
  const reserve = Math.min(16_000, Math.floor(context / 4))
  const budget = context - reserve - estimateTokens(system)

  // Walk backwards so the newest turns always survive; always keep the final user turn.
  const kept: HistoryTurn[] = []
  let used = 0
  for (let i = input.history.length - 1; i >= 0; i--) {
    const cost = turnTokens(input.history[i])
    if (kept.length > 0 && used + cost > budget) break
    kept.unshift(input.history[i])
    used += cost
  }
  // Never start the replay on an assistant turn.
  while (kept.length > 1 && kept[0].role === 'assistant') {
    used -= turnTokens(kept[0])
    kept.shift()
  }

  return {
    messages: [{ role: 'system', content: system }, ...kept.map(turnToMessage)],
    droppedTurns: input.history.length - kept.length,
    estimatedTokens: used + estimateTokens(system)
  }
}
