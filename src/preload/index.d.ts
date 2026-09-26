import type { OllmostApi } from '../shared/ipc'

declare global {
  interface Window {
    ollmost: OllmostApi
  }
}

export {}
