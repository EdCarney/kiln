import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loginPath, mergePath, readLoginPath } from '../src/main/env'

const dir = mkdtempSync(join(tmpdir(), 'kiln-env-'))

/** A stand-in login shell: runs the command Kiln passes (after -ilc) with the given script around it. */
function fakeShell(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('readLoginPath', () => {
  it("reads PATH from the shell's environment, ignoring whatever its startup files print", async () => {
    const shell = fakeShell('noisy', `echo 'Welcome back!'\nPATH=/opt/tools/bin:/usr/bin; export PATH\neval "$2"\necho 'bye'`)
    expect(await readLoginPath(shell)).toBe('/opt/tools/bin:/usr/bin')
  })

  it('still reads it when a startup file fails and the shell exits non-zero', async () => {
    const shell = fakeShell('grumpy', `PATH=/opt/tools/bin:/usr/bin; export PATH\neval "$2"\nexit 3`)
    expect(await readLoginPath(shell)).toBe('/opt/tools/bin:/usr/bin')
  })

  it('gives up on a shell that hangs', async () => {
    const shell = fakeShell('stuck', 'sleep 10')
    const started = Date.now()
    expect(await readLoginPath(shell, 200)).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('returns null for a shell that does not exist', async () => {
    expect(await readLoginPath(join(dir, 'no-such-shell'))).toBeNull()
  })

  it('works with the real login shell', async () => {
    const path = await readLoginPath(process.env.SHELL || '/bin/sh', 10_000)
    expect(path).toMatch(/\/usr\/bin/)
  })
})

describe('loginPath', () => {
  it("puts the login shell's PATH first and keeps Kiln's own after it", async () => {
    const shell = fakeShell('login', `PATH=/opt/tools/bin:/usr/bin; export PATH\neval "$2"`)
    expect(await loginPath({ shell, basePath: '/usr/bin:/bin' })).toBe('/opt/tools/bin:/usr/bin:/bin')
  })

  it('falls back to the usual tool folders that exist when the shell fails', async () => {
    const homebrew = join(dir, 'homebrew', 'bin')
    mkdirSync(homebrew, { recursive: true })
    const path = await loginPath({
      shell: fakeShell('broken', 'exit 1'),
      basePath: '/usr/bin:/bin',
      fallbackDirs: [homebrew, join(dir, 'missing', 'bin')]
    })
    expect(path).toBe(`/usr/bin:/bin:${homebrew}`)
  })
})

describe('mergePath', () => {
  it('keeps the first of each directory and drops empty entries', () => {
    expect(mergePath('/a:/b:', '/b:/c', null, undefined, '::/a:/d')).toBe('/a:/b:/c:/d')
  })
})
