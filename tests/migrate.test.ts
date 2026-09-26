import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// The migration's keychain use is faked, as in mcp.test.ts: Electron isn't running under vitest.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  shell: {},
  app: { getPath: () => '' }
}))

const migrate = await import('../src/main/migrate')

/** A folder holding "Kiln" (with a kiln.db) and room for "Ollmost" next to it, as in Application Support. */
function appSupport(): { kiln: string; ollmost: string } {
  const root = mkdtempSync(join(tmpdir(), 'migrate-'))
  const kiln = join(root, 'Kiln')
  mkdirSync(join(kiln, 'files'), { recursive: true })
  writeFileSync(join(kiln, 'kiln.db'), 'db')
  writeFileSync(join(kiln, 'files', 'a.png'), 'png')
  return { kiln, ollmost: join(root, 'Ollmost') }
}

const sleepers: Array<ReturnType<typeof spawn>> = []
const livePid = () => {
  const child = spawn('sleep', ['30'])
  sleepers.push(child)
  return child.pid!
}
afterAll(() => sleepers.forEach((c) => c.kill()))

describe('moving Kiln’s data folder', () => {
  it('moves it, drops Kiln’s lock files and leaves a marker', () => {
    const { kiln, ollmost } = appSupport()
    symlinkSync('Mac-999999', join(kiln, 'SingletonLock'))
    symlinkSync('/nonexistent/socket', join(kiln, 'SingletonSocket'))
    expect(migrate.moveKilnData(ollmost)).toEqual({ state: 'moved' })
    expect(existsSync(kiln)).toBe(false)
    expect(existsSync(join(ollmost, 'files', 'a.png'))).toBe(true)
    expect(readdirSync(ollmost).filter((n) => n.startsWith('Singleton'))).toEqual([])
    expect(existsSync(join(ollmost, migrate.MARKER))).toBe(true)
  })

  it('does nothing when the new folder exists, or Kiln left no database', () => {
    const { kiln, ollmost } = appSupport()
    mkdirSync(ollmost)
    expect(migrate.moveKilnData(ollmost)).toEqual({ state: 'none' })
    expect(existsSync(kiln)).toBe(true)
    // A fresh install: no Kiln folder next to it.
    const fresh = join(mkdtempSync(join(tmpdir(), 'migrate-')), 'Ollmost')
    expect(migrate.moveKilnData(fresh)).toEqual({ state: 'none' })
  })

  it('does nothing while the app itself is still called Kiln', () => {
    const { kiln } = appSupport()
    expect(migrate.moveKilnData(kiln)).toEqual({ state: 'none' })
  })

  it('waits while Kiln is running, creating nothing', () => {
    const { kiln, ollmost } = appSupport()
    const pid = livePid()
    symlinkSync(`Mac-${pid}`, join(kiln, 'SingletonLock'))
    expect(migrate.moveKilnData(ollmost, { isKiln: () => true })).toEqual({ state: 'kiln-running', pid })
    expect(existsSync(ollmost)).toBe(false)
    expect(existsSync(join(kiln, 'kiln.db'))).toBe(true)
  })

  it('moves anyway when the lock is stale: a dead pid, or one another program now has', () => {
    const a = appSupport()
    symlinkSync('Mac-999999', join(a.kiln, 'SingletonLock'))
    expect(migrate.moveKilnData(a.ollmost, { isKiln: () => true }).state).toBe('moved')
    const b = appSupport()
    symlinkSync(`Mac-${livePid()}`, join(b.kiln, 'SingletonLock'))
    // The real check: `sleep` is not Kiln.
    expect(migrate.moveKilnData(b.ollmost).state).toBe('moved')
  })

  it('reports a failed move and leaves everything as it was', () => {
    const { kiln, ollmost } = appSupport()
    const parent = join(kiln, '..')
    chmodSync(parent, 0o555)
    try {
      const result = migrate.moveKilnData(ollmost)
      expect(result.state).toBe('failed')
      expect(existsSync(ollmost)).toBe(false)
      expect(existsSync(join(kiln, 'kiln.db'))).toBe(true)
    } finally {
      chmodSync(parent, 0o755)
    }
  })
})

describe('waiting for Kiln to quit', () => {
  it('goes on once Kiln has quit, closing the message', async () => {
    let running = true
    setTimeout(() => (running = false), 50)
    const shown = (signal: AbortSignal) => new Promise((resolve) => signal.addEventListener('abort', resolve))
    expect(await migrate.waitForKiln(() => running, shown, 10)).toBe(true)
  })

  it('stops when the user quits instead', async () => {
    expect(
      await migrate.waitForKiln(
        () => true,
        async () => undefined,
        10
      )
    ).toBe(false)
  })
})
