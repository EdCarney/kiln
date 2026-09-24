import { create } from 'zustand'
import type { AccountUsage } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from './app'

interface UsageState {
  account: AccountUsage | null
  loading: boolean
  load: (refresh?: boolean) => Promise<void>
}

export const useUsage = create<UsageState>((set) => ({
  account: null,
  loading: false,
  load: async (refresh = false) => {
    set({ loading: true })
    try {
      const account = await api.usage.account(refresh)
      set({ account })
      // The main process may have dated a reset from this reading; pick up the new schedule.
      if (account.windows.some((w) => w.resetSource === 'detected')) await useApp.getState().loadSettings()
    } finally {
      set({ loading: false })
    }
  }
}))

const POLL_MS = 2 * 60_000
let afterReply: ReturnType<typeof setTimeout> | null = null

/** Keep quota numbers live: poll while visible, and re-check shortly after each reply finishes. */
export function startUsagePolling(): () => void {
  void useUsage.getState().load()
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void useUsage.getState().load(true)
  }, POLL_MS)
  const offChat = api.events.onChat((e) => {
    if (e.type !== 'done') return
    if (afterReply) clearTimeout(afterReply)
    // Ollama's counters lag a little behind the request, so wait a few seconds.
    afterReply = setTimeout(() => void useUsage.getState().load(true), 4000)
  })
  return () => {
    clearInterval(timer)
    offChat()
  }
}
