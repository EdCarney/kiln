import type { KilnApi } from '../shared/ipc'

declare global {
  interface Window {
    kiln: KilnApi
  }
}

export {}
