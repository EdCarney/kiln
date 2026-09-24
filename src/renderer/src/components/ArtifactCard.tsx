import { Code, FileText, Globe, Image, Workflow } from 'lucide-react'
import type { Segment } from '@shared/artifactParser'
import type { Artifact, ArtifactType } from '@shared/types'
import { cn } from '@/lib/format'
import { useArtifactPanel } from '@/stores/artifactPanel'
import { Spinner } from './ui'

export const ARTIFACT_META: Record<ArtifactType, { label: string; icon: typeof Code }> = {
  markdown: { label: 'Document', icon: FileText },
  code: { label: 'Code', icon: Code },
  html: { label: 'Web page', icon: Globe },
  svg: { label: 'Image', icon: Image },
  mermaid: { label: 'Diagram', icon: Workflow }
}

type ArtifactSegment = Extract<Segment, { kind: 'artifact' }>

interface Props {
  segment: ArtifactSegment
  messageId: string
  /** How many earlier segments in this message share the identifier. */
  occurrence: number
  artifacts: Artifact[]
  streaming: boolean
}

export function ArtifactCard({ segment, messageId, occurrence, artifacts, streaming }: Props) {
  const panel = useArtifactPanel()
  const artifact = artifacts.find((a) => a.identifier === segment.identifier)
  const version = artifact?.versions.filter((v) => v.messageId === messageId)[occurrence]
  const generating = streaming && !segment.complete
  const meta = ARTIFACT_META[segment.type]
  const Icon = meta.icon

  const isOpen =
    panel.open &&
    ((panel.live?.messageId === messageId && panel.live.identifier === segment.identifier) ||
      (!!artifact && panel.artifactId === artifact.id && (panel.version ?? artifact.versions.length) === version?.version))

  const open = () => {
    if (streaming) panel.openLive(messageId, segment.identifier)
    else if (artifact) panel.openArtifact(artifact.id, version?.version ?? null)
  }

  const detail = [
    meta.label,
    segment.type === 'code' && segment.language,
    artifact && artifact.versions.length > 1 && version && `Version ${version.version}`
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <button
      onClick={open}
      className={cn(
        'my-3 flex w-full max-w-md items-center gap-3 rounded-kiln border bg-panel p-2 pr-4 text-left font-ui transition-colors hover:border-line-strong',
        isOpen ? 'border-line-strong' : 'border-line'
      )}
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas text-muted">
        {generating ? <Spinner /> : <Icon className="size-5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{segment.title}</span>
        <span className="block truncate text-xs text-subtle">{generating ? 'Writing…' : detail}</span>
      </span>
    </button>
  )
}
