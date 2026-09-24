import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Production-only CSP: the dev server needs inline scripts for React Fast Refresh.
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: kiln:",
  "font-src 'self' data:",
  "frame-src artifact:",
  "connect-src 'self' kiln:"
].join('; ')

function injectCsp(): Plugin {
  return {
    name: 'kiln-inject-csp',
    apply: 'build',
    transformIndexHtml: (html: string) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}" />`)
  }
}

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: { resolve: { alias: shared } },
  preload: { resolve: { alias: shared } },
  renderer: {
    resolve: { alias: { ...shared, '@': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss(), injectCsp()]
  }
})
