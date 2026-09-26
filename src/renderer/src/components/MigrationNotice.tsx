import { useEffect, useState } from 'react'
import { type MigrationNoticeView, NOTICE_API_KEY, NOTICE_BODY, NOTICE_TITLE, noticeServers } from '@shared/migration'
import { Button } from '@/components/ui'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'

/** Once, after the move from the old app (#60): what came along, and what needs entering again. */
export function MigrationNotice() {
  const navigate = useApp((s) => s.navigate)
  const [notice, setNotice] = useState<MigrationNoticeView | null>(null)
  useEffect(() => {
    api.app
      .migrationNotice()
      .then(setNotice)
      .catch(() => undefined)
  }, [])
  if (!notice) return null
  const dismiss = () => {
    setNotice(null)
    void api.app.dismissMigrationNotice()
  }
  return (
    <div data-testid="migration-notice" className="mb-4 space-y-2 rounded-ollmost border border-line bg-panel p-4 text-sm">
      <div>
        <div className="font-medium">{NOTICE_TITLE}</div>
        <div className="mt-1 text-muted">{NOTICE_BODY}</div>
      </div>
      {notice.apiKey && (
        <div className="flex items-center justify-between gap-3">
          <span>{NOTICE_API_KEY}</span>
          <Button size="sm" onClick={() => navigate({ name: 'settings', tab: 'usage' })}>
            Open Settings
          </Button>
        </div>
      )}
      {notice.servers.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <span>{noticeServers(notice.servers)}</span>
          <Button size="sm" onClick={() => navigate({ name: 'settings', tab: 'tools' })}>
            Open Tools
          </Button>
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
