import * as HoverCard from '@radix-ui/react-hover-card'
import { ExternalLink, Globe, Mail, TriangleAlert } from 'lucide-react'
import { type MouseEvent, type ReactNode, useEffect, useState } from 'react'
import type { LinkPreview } from '@shared/ipc'
import { hostnameOf, middleTruncate, mismatchedLinkText } from '@shared/links'
import { api } from '@/lib/api'
import { cn } from '@/lib/format'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'

const isWeb = (href: string) => /^https?:\/\//i.test(href)

/** A part of the card that acts as the link: image, site, title, URL and footer (never the excerpt). */
function CardLink({
  href,
  openable,
  onFollow,
  className,
  label,
  children
}: {
  href: string
  openable: boolean
  onFollow: (e: MouseEvent) => void
  className?: string
  label?: string
  children: ReactNode
}) {
  return openable ? (
    <a href={href} onClick={onFollow} aria-label={label} className={cn('block text-inherit no-underline', className)}>
      {children}
    </a>
  ) : (
    <div className={className}>{children}</div>
  )
}

/**
 * A link that shows where it goes on hover: hostname and full URL always, plus the page's title,
 * description and image when link previews are turned on (they're fetched from this Mac, so opt-in).
 */
export function LinkCard({ href, text, children }: { href: string; text: string; children: ReactNode }) {
  const previewsOn = useApp((s) => !!s.settings?.links.previews)
  // The chat the link is shown in (a reply, or one of its artifacts); the main process decides whether it may preview.
  const conversationId = useChat((s) => s.conversation?.id ?? null)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<LinkPreview | null | 'loading' | 'none'>(null)

  useEffect(() => {
    if (!open || !previewsOn || preview !== null || !isWeb(href)) return
    setPreview('loading')
    void api.links
      .preview(href, conversationId)
      .then((p) => setPreview(p ?? 'none'))
      .catch(() => setPreview('none'))
  }, [open, previewsOn, preview, href, conversationId])

  const host = hostnameOf(href)
  const mismatch = mismatchedLinkText(text, href)
  const rich = preview && typeof preview === 'object' ? preview : null
  const mail = href.startsWith('mailto:')
  const openable = isWeb(href) || mail

  const follow = (e: MouseEvent) => {
    e.preventDefault()
    setOpen(false)
    if (openable) void api.app.openExternal(href)
  }

  return (
    <HoverCard.Root open={open} openDelay={250} closeDelay={120} onOpenChange={setOpen}>
      <HoverCard.Trigger asChild>
        <a href={href} onClick={follow}>
          {children}
        </a>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-[320px] overflow-hidden rounded-kiln border border-line bg-panel font-ui text-fg shadow-[0_8px_30px_rgba(0,0,0,0.18)]"
          data-testid="link-card"
        >
          {rich?.image && (
            <CardLink href={href} openable={openable} onFollow={follow} label={`Open ${host ?? 'link'}`} className="border-b border-line">
              <img src={rich.image} alt="" className="block max-h-40 w-full object-cover transition-opacity hover:opacity-90" />
            </CardLink>
          )}
          <div className="space-y-1.5 p-3">
            <CardLink href={href} openable={openable} onFollow={follow} className="group/site flex items-center gap-2 text-[13px]">
              {rich?.icon ? (
                <img src={rich.icon} alt="" className="size-4 shrink-0 rounded-sm" />
              ) : mail ? (
                <Mail className="size-4 shrink-0 text-subtle" />
              ) : (
                <Globe className="size-4 shrink-0 text-subtle" />
              )}
              <span className="truncate font-medium group-hover/site:underline">
                {rich?.siteName ?? host ?? (mail ? href.slice(7) : href)}
              </span>
            </CardLink>
            {rich?.title && (
              <CardLink
                href={href}
                openable={openable}
                onFollow={follow}
                className="line-clamp-2 text-[13px] font-semibold leading-snug hover:text-accent hover:underline"
              >
                {rich.title}
              </CardLink>
            )}
            {rich?.description && <div className="selectable line-clamp-3 text-xs leading-relaxed text-muted">{rich.description}</div>}
            {preview === 'loading' && (
              <div className="space-y-1.5" aria-label="Loading preview">
                <div className="h-3 w-3/4 animate-pulse rounded bg-hover" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-hover" />
              </div>
            )}
            <CardLink
              href={href}
              openable={openable}
              onFollow={follow}
              className="break-all font-mono text-[11px] leading-snug text-subtle hover:text-accent hover:underline"
            >
              {middleTruncate(href, 110)}
            </CardLink>
            {mismatch && (
              <div className="flex items-start gap-1.5 rounded-md bg-hover px-2 py-1.5 text-[11px] text-warn">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                <span>
                  The link text says {mismatch}, but it opens {host}.
                </span>
              </div>
            )}
            <CardLink
              href={href}
              openable={openable}
              onFollow={follow}
              className="flex w-fit items-center gap-1 pt-0.5 text-[11px] text-subtle hover:text-accent"
            >
              <ExternalLink className="size-3" />
              {mail ? 'Opens your mail app' : isWeb(href) ? 'Opens in your browser' : "This link can't be opened"}
            </CardLink>
          </div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  )
}
