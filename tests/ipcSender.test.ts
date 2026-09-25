import { describe, expect, it } from 'vitest'
import { type AppPages, isAppFrame } from '../src/main/ipcSender'

const packaged: AppPages = { file: 'file:///Applications/Kiln.app/Contents/Resources/app.asar/out/renderer/index.html', devOrigin: null }
const dev: AppPages = { file: 'file:///Users/me/kiln/out/renderer/index.html', devOrigin: 'http://localhost:5173' }
const top = (url: string) => ({ url, parent: null })

describe('isAppFrame', () => {
  it("accepts the app's own page in a top-level frame, including the debugger's #hash", () => {
    expect(isAppFrame(top(packaged.file), packaged)).toBe(true)
    expect(isAppFrame(top(`${packaged.file}#debug?c=abc`), packaged)).toBe(true)
  })

  it('refuses the same page in a subframe', () => {
    expect(isAppFrame({ url: packaged.file, parent: {} }, packaged)).toBe(false)
  })

  it('refuses other pages and schemes', () => {
    expect(isAppFrame(top('file:///Users/me/Downloads/evil.html'), packaged)).toBe(false)
    expect(isAppFrame(top('artifact://frame/abc'), packaged)).toBe(false)
    expect(isAppFrame(top('https://example.com/'), packaged)).toBe(false)
    expect(isAppFrame(top('about:blank'), packaged)).toBe(false)
    expect(isAppFrame(top('not a url'), packaged)).toBe(false)
  })

  it('refuses a frame that has gone (Electron passes null)', () => {
    expect(isAppFrame(null, packaged)).toBe(false)
    expect(isAppFrame(undefined, packaged)).toBe(false)
  })

  it('accepts the dev server only when running unpackaged, and only its origin', () => {
    expect(isAppFrame(top('http://localhost:5173/#debug'), dev)).toBe(true)
    expect(isAppFrame(top('http://localhost:5173/'), packaged)).toBe(false)
    expect(isAppFrame(top('http://localhost:5174/'), dev)).toBe(false)
    expect(isAppFrame(top(dev.file), dev)).toBe(true)
  })

  it('compares paths exactly, spaces and all', () => {
    const spaced: AppPages = { file: 'file:///Users/me/My%20Apps/Kiln.app/out/renderer/index.html', devOrigin: null }
    expect(isAppFrame(top('file:///Users/me/My%20Apps/Kiln.app/out/renderer/index.html'), spaced)).toBe(true)
    expect(isAppFrame(top('file:///Users/me/My%20Apps/Kiln.app/out/renderer/other.html'), spaced)).toBe(false)
  })
})
