import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
  app: { getPath: () => '' }
}))

const { openDatabase } = await import('../src/main/db/index')
const { createConversation, insertAttachment, insertMessage, linkAttachments } = await import('../src/main/db/conversations')
const { updateSettings } = await import('../src/main/settings')
const { paths } = await import('../src/main/paths')
const { policyFor, PRIVATE_ROOTS, runSandboxed } = await import('../src/main/runner/sandbox')
const workspace = await import('../src/main/runner/workspace')
const tools = await import('../src/main/chat/tools')
const python = await import('../src/main/runner/python')
const { openWith, IMAGE_FILE } = await import('../src/shared/workspace')
const { quarantine, quarantineValue, QUARANTINE_ATTR } = await import('../src/main/quarantine')

const root = mkdtempSync(join(tmpdir(), 'kiln-runner-test-'))
beforeAll(() => {
  openDatabase(':memory:')
  paths.workspaces = join(root, 'workspaces')
  paths.runner = join(root, 'runner')
  updateSettings({ skills: { sources: { ollama: false, claude: false } } })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the sandbox policy', () => {
  const base = { workspace: '/w', home: '/Users/me', readable: ['/Users/me/.claude/skills'], venv: '/Users/me/k/venv' }

  it('hides the home folder except what code needs, and writes only to the workspace, with no network', () => {
    expect(policyFor({ ...base, pypi: false })).toEqual({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: ['/Users/me', '/Users', '/Volumes', '/private/var/folders', '/private/tmp'],
        allowRead: ['/w', '/Users/me/.claude/skills', '/Users/me/k/venv'],
        allowWrite: ['/w'],
        denyWrite: ['/private/tmp/claude']
      }
    })
  })

  // #68: the sandbox allows every read it doesn't deny, and user data isn't only in the home folder.
  it('also hides other accounts, shared and mounted folders, and the temp folders', () => {
    const { denyRead } = policyFor({ ...base, home: '/Volumes/Home/me', pypi: false }).filesystem
    expect(denyRead).toEqual(['/Volumes/Home/me', '/Users', '/Volumes', '/private/var/folders', '/private/tmp'])
    expect(policyFor({ ...base, home: '/Users', pypi: false }).filesystem.denyRead).toEqual(PRIVATE_ROOTS)
  })

  it('opens PyPI, and the Python environment for writing, only when allowed', () => {
    const p = policyFor({ ...base, pypi: true })
    expect(p.network.allowedDomains).toEqual(['pypi.org', 'files.pythonhosted.org'])
    expect(p.filesystem.allowWrite).toEqual(['/w', '/Users/me/k/venv'])
  })
})

describe('workspaces', () => {
  it("copies a chat's attachments into uploads, with unique names", async () => {
    const c = createConversation({ projectId: null, model: 'm', think: null, skills: [] })
    const m = insertMessage({ conversationId: c.id, parentId: null, role: 'user', content: 'data' })
    const files = join(root, 'files')
    mkdirSync(files, { recursive: true })
    for (const [id, text] of [
      ['a1', 'x,y\n1,2\n'],
      ['a2', 'other']
    ]) {
      writeFileSync(join(files, id), text)
      insertAttachment({
        id,
        kind: 'document',
        name: 'data.csv',
        mime: 'text/csv',
        size: text.length,
        path: join(files, id),
        text,
        token_est: 1
      })
    }
    linkAttachments(['a1', 'a2'], m.id)
    const ws = await workspace.prepareWorkspace(c.id)
    expect(ws.uploads).toEqual(['data.csv', 'data (2).csv'])
    expect(readFileSync(join(ws.dir, 'uploads', 'data.csv'), 'utf8')).toBe('x,y\n1,2\n')
    expect(existsSync(join(ws.dir, '.kiln', 'home'))).toBe(true)
  })

  it('lists files that are new or changed, leaving out uploads and Kiln’s own', () => {
    const before = new Map([
      ['same.txt', { size: 1, mtimeMs: 1 }],
      ['edited.txt', { size: 1, mtimeMs: 1 }]
    ])
    const after = new Map([
      ['same.txt', { size: 1, mtimeMs: 1 }],
      ['edited.txt', { size: 2, mtimeMs: 2 }],
      ['chart.png', { size: 9, mtimeMs: 3 }]
    ])
    expect(workspace.changedFiles(before, after)).toEqual([
      { path: 'chart.png', size: 9 },
      { path: 'edited.txt', size: 2 }
    ])
  })

  it('only hands out files inside the workspace, even through a symlink', async () => {
    const id = 'chat-files'
    const dir = workspace.workspaceDir(id)
    mkdirSync(join(dir, 'out'), { recursive: true })
    writeFileSync(join(dir, 'out', 'report.txt'), 'ok')
    writeFileSync(join(root, 'secret.txt'), 'secret')
    symlinkSync(join(root, 'secret.txt'), join(dir, 'link.txt'))
    expect(await workspace.workspaceFile(id, 'out/report.txt')).toMatch(/out\/report\.txt$/)
    expect(await workspace.workspaceFile(id, '../../secret.txt')).toBeNull()
    expect(await workspace.workspaceFile(id, 'link.txt')).toBeNull()
    expect(await workspace.workspaceFile(id, join(dir, 'out', 'report.txt'))).toBeNull()
    expect(await workspace.workspaceFile('../workspaces/chat-files', 'out/report.txt')).toBeNull()
    expect(await workspace.workspaceFile(id, 'out')).toBeNull()
  })
})

// #69: with PyPI allowed, a shared writable environment would let one chat's code run in every other.
describe("Kiln's Python environments", () => {
  const plantPackage = (venv: string, name: string, version: string) =>
    mkdirSync(join(venv, 'lib', 'python3.12', 'site-packages', `${name}-${version}.dist-info`), { recursive: true })

  it("lists the packages installed in the chats' own environments, each once", async () => {
    plantPackage(python.chatVenvDir('chat-a'), 'requests', '2.32.0')
    plantPackage(python.chatVenvDir('chat-a'), 'pip', '24.0')
    plantPackage(python.chatVenvDir('chat-b'), 'pip', '24.0')
    plantPackage(python.chatVenvDir('chat-b'), 'numpy', '2.1.0')
    expect(await python.installedPackages()).toEqual([
      { name: 'numpy', version: '2.1.0' },
      { name: 'pip', version: '24.0' },
      { name: 'requests', version: '2.32.0' }
    ])
    expect(python.venvsExist()).toBe(true)
  })

  it("deletes a chat's environment with the chat, and every environment on reset, without following links", async () => {
    const outside = mkdtempSync(join(tmpdir(), 'kiln-outside-'))
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    plantPackage(python.chatVenvDir('chat-c'), 'six', '1.16.0')
    symlinkSync(outside, join(python.chatVenvDir('chat-c'), 'lib', 'link'))
    await workspace.removeWorkspace('chat-c')
    expect(existsSync(python.chatVenvDir('chat-c'))).toBe(false)

    plantPackage(python.chatVenvDir('chat-d'), 'six', '1.16.0')
    symlinkSync(outside, join(python.chatVenvDir('chat-d'), 'lib', 'link'))
    mkdirSync(join(paths.runner, 'venv', 'bin'), { recursive: true })
    await python.resetVenv()
    expect(existsSync(python.chatVenvsDir())).toBe(false)
    expect(existsSync(join(paths.runner, 'venv'))).toBe(false)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await python.installedPackages()).toEqual([])
    expect(python.venvsExist()).toBe(false)
  })

  it('replaces the old shared environment with one without pip', async (t) => {
    if (!(await python.findPython())) t.skip()
    const legacy = join(paths.runner, 'venv', 'lib', 'python3', 'site-packages')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'sitecustomize.py'), 'print("planted")')
    const base = await python.ensureBaseVenv()
    expect(base).toBe(python.baseVenvDir())
    expect(existsSync(python.venvPython(base))).toBe(true)
    expect(existsSync(join(base, 'bin', 'pip'))).toBe(false)
    expect(existsSync(join(paths.runner, 'venv'))).toBe(false)
  }, 60_000)
})

// A file a run wrote may carry the chat's data, and whatever opens it runs outside the sandbox (#67).
describe('handing out files a run wrote', () => {
  it('previews documents with Quick Look on a Mac, never in the app for their type', () => {
    for (const f of ['report.docx', 'data.xlsx', 'notes.md', 'table.csv', 'out.json', 'chart.png', 'doc.pdf', 'a.txt'])
      expect(openWith(f, 'darwin')).toBe('quick-look')
  })

  it('elsewhere opens only plain text, PDFs and bitmaps', () => {
    for (const f of ['a.txt', 'doc.pdf', 'chart.png', 'photo.JPG', 'anim.gif', 'pic.webp']) expect(openWith(f, 'linux')).toBe('default-app')
    for (const f of ['report.docx', 'deck.pptx', 'data.xlsx', 'notes.md', 'table.csv', 'out.json', 'x.rtf', 'y.odt'])
      expect(openWith(f, 'linux')).toBeNull()
  })

  it('never opens an SVG, a script or an app, though an SVG is still shown inline as an image', () => {
    for (const platform of ['darwin', 'linux', 'win32'])
      for (const f of ['plot.svg', 'run.command', 'x.sh', 'x.py', 'x.html', 'Evil.app', 'x.webloc', 'x.terminal'])
        expect(openWith(f, platform)).toBeNull()
    expect(IMAGE_FILE.test('plot.svg')).toBe(true)
  })

  it('marks handed-out files the way browsers mark downloads', () => {
    expect(quarantineValue(Date.UTC(2026, 0, 1))).toBe(`0081;${(Date.UTC(2026, 0, 1) / 1000).toString(16)};Kiln;`)
  })

  it.runIf(process.platform === 'darwin')('writes the quarantine mark on macOS', async () => {
    const file = join(root, 'handed-out.txt')
    writeFileSync(file, 'x')
    await quarantine(file)
    const { execFileSync } = await import('node:child_process')
    expect(execFileSync('/usr/bin/xattr', ['-p', QUARANTINE_ATTR, file]).toString().trim()).toMatch(/^0081;[0-9a-f]+;Kiln;$/)
    await expect(quarantine(join(root, 'missing.txt'))).rejects.toThrow()
  })
})

// The sandbox itself is macOS's (sandbox-exec); CI runs on Linux.
describe.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))('running code in the sandbox', () => {
  const ws = mkdtempSync(join(tmpdir(), 'kiln-ws-'))
  const fakeHome = mkdtempSync(join(tmpdir(), 'kiln-home-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'kiln-elsewhere-'))
  writeFileSync(join(fakeHome, 'private.txt'), 'private')
  const policy = policyFor({ workspace: ws, home: fakeHome, readable: [], venv: join(root, 'venv'), pypi: false })
  const sandboxed = (command: string, extra: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {}) =>
    runSandboxed({ command, policy, cwd: ws, env: extra.env ?? {}, timeoutMs: extra.timeoutMs ?? 30_000, signal: extra.signal, id: command })

  it('writes in the workspace and nowhere else, and reads nothing it was denied', async () => {
    const ok = await sandboxed('echo made > made.txt && cat made.txt')
    expect(ok).toMatchObject({ code: 0, timedOut: false })
    expect(ok.output.trim()).toBe('made')
    const outside = await sandboxed(`echo x > ${join(elsewhere, 'escape.txt')}`)
    expect(outside.code).not.toBe(0)
    expect(outside.output).toMatch(/Operation not permitted/)
    expect(existsSync(join(elsewhere, 'escape.txt'))).toBe(false)
    const denied = await sandboxed(`cat ${join(fakeHome, 'private.txt')}`)
    expect(denied.output).toMatch(/Operation not permitted/)
  })

  // #68: outside the home folder too. The test folders are in the per-user temp folder (/private/var/folders).
  it('reads nothing in /Users/Shared, the temp folders or other disks, but still its workspace', async () => {
    const shared = join('/Users/Shared', `kiln-test-${process.pid}.txt`)
    const tmp = join('/private/tmp', `kiln-test-${process.pid}.txt`)
    writeFileSync(shared, 'shared')
    writeFileSync(tmp, 'tmp')
    writeFileSync(join(elsewhere, 'draft.txt'), 'draft')
    writeFileSync(join(ws, 'mine.txt'), 'mine')
    try {
      for (const file of [shared, tmp, '/tmp/' + tmp.split('/').at(-1), join(elsewhere, 'draft.txt')]) {
        const r = await sandboxed(`cat "${file}"`)
        expect(r.code, file).not.toBe(0)
        expect(r.output, file).toMatch(/Operation not permitted/)
      }
      expect((await sandboxed('ls /Volumes')).output).toMatch(/Operation not permitted/)
      expect((await sandboxed(`cat ${join(ws, 'mine.txt')}`)).output.trim()).toBe('mine')
    } finally {
      rmSync(shared, { force: true })
      rmSync(tmp, { force: true })
    }
  })

  // sandbox-runtime sets TMPDIR=/tmp/claude and lets every sandbox write there: a folder all chats would share, and
  // (reads being denied in /private/tmp) one whose files couldn't be read back.
  it('gives code its own temp folder, and none shared with other chats', async () => {
    const tmp = join(ws, "it's tmp")
    mkdirSync(tmp, { recursive: true })
    const own = await sandboxed('echo "TMPDIR=$TMPDIR" && echo kept > "$TMPDIR/t" && cat "$TMPDIR/t"', { env: { TMPDIR: tmp } })
    expect(own.code).toBe(0)
    expect(own.output).toBe(`TMPDIR=${tmp}\nkept\n`)
    const shared = await sandboxed('mkdir -p /tmp/claude/kiln-test && echo x > /tmp/claude/kiln-test/f', { env: { TMPDIR: tmp } })
    expect(shared.code).not.toBe(0)
    expect(shared.output).toMatch(/Operation not permitted/)
    expect(existsSync('/tmp/claude/kiln-test/f')).toBe(false)
  })

  it('has no network, and says so', async () => {
    const r = await sandboxed('curl -sS -m 5 https://example.com -o /dev/null')
    expect(r.code).not.toBe(0)
    expect(r.output).toMatch(/deny network-outbound example\.com/)
  })

  it('stops a run at the time limit, background jobs included', async () => {
    const r = await sandboxed('sleep 30 & echo $! > bg.pid; sleep 30', { timeoutMs: 500 })
    expect(r.timedOut).toBe(true)
    const pid = Number(readFileSync(join(ws, 'bg.pid'), 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alive(pid)).toBe(false)
  })

  it('stops a run when the reply is stopped', async () => {
    const controller = new AbortController()
    const run = sandboxed('echo $$ > leader.pid; sleep 30', { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 800))
    controller.abort()
    await expect(run).rejects.toThrow()
  })

  describe('as run_code', () => {
    const ctx = (dir: string) => ({ skills: false, web: false, sources: ['code'], workspace: dir })
    const call = (name: string, args: Record<string, unknown> | string) => ({ function: { name, arguments: args } })

    it('is offered only in chats with the runner on, and asks unless set to Always allow', () => {
      expect((tools.toolsFor({ ...ctx(ws), sources: [] }) ?? []).map((t) => t.function.name)).not.toContain('run_code')
      expect((tools.toolsFor(ctx(ws)) ?? []).map((t) => t.function.name)).toContain('run_code')
      expect(tools.toolGrants(ctx(ws)).has('code')).toBe(true)
      expect(tools.approvalFor(call('run_code', { code: '1' }), ctx(ws))).toBe('ask')
      updateSettings({ runner: { mode: 'allow' } })
      expect(tools.approvalFor(call('run_code', { code: '1' }), ctx(ws))).toBe('auto')
      updateSettings({ runner: { mode: 'off' } })
      expect(tools.toolsFor(ctx(ws))).toBeUndefined()
      updateSettings({ runner: { mode: 'ask' } })
    })

    it('runs Python in its own environment, reports output and the files it wrote', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kiln-run-'))
      const code = "import sys\nprint(6 * 7)\nprint(sys.prefix.endswith('venv'))\nopen('answer.txt', 'w').write('42')"
      const r = await tools.runTool(call('run_code', { language: 'python', code }), ctx(dir))
      expect(r.content).toMatch(/^Exit code 0\.\n\n42\nTrue\n/)
      expect(r.content).toMatch(/Files created or changed:\n- answer\.txt \(2 bytes\)/)
      expect(r.event).toMatchObject({ tool: 'run_code', ok: true, summary: 'import sys', files: [{ path: 'answer.txt', size: 2 }] })
      expect(tools.replayCalls([r.event])[0]).toMatchObject({ name: 'run_code', record: expect.stringMatching(/Exit code 0\. 42/) })
      const failed = await tools.runTool(call('run_code', { language: 'bash', code: 'echo oops >&2; exit 3' }), ctx(dir))
      expect(failed.content).toMatch(/^Exit code 3\.\n\noops/)
      expect(failed.event).toMatchObject({ ok: false, summary: 'exit code 3' })
    }, 120_000)

    // #69: what one chat's code writes into its environment never runs in another chat.
    it('gives each chat that may install packages its own environment, which other chats never run or read', async () => {
      const a = mkdtempSync(join(tmpdir(), 'kiln-run-'))
      const b = mkdtempSync(join(tmpdir(), 'kiln-run-'))
      const plant = [
        // A .pth file's import lines run at every start (a sitecustomize.py can be shadowed by the base Python's).
        'import sys, sysconfig',
        "open(sysconfig.get_paths()['purelib'] + '/zz_planted.pth', 'w').write('import sys; print(\"PLANTED\")\\n')",
        'print(sys.prefix)'
      ].join('\n')
      updateSettings({ runner: { pypi: true } })
      try {
        const planted = await tools.runTool(call('run_code', { language: 'python', code: plant }), ctx(a))
        expect(planted.content).toMatch(/^Exit code 0\./)
        const venvA = python.chatVenvDir(basename(a))
        expect(planted.content).toContain(venvA)
        expect(existsSync(join(venvA, 'bin', 'pip'))).toBe(true)
        expect((await tools.runTool(call('run_code', { language: 'python', code: 'print(1)' }), ctx(a))).content).toMatch(/PLANTED/)

        const other = await tools.runTool(call('run_code', { language: 'python', code: 'import sys\nprint(sys.prefix)' }), ctx(b))
        expect(other.content).toMatch(/^Exit code 0\./)
        expect(other.content).not.toMatch(/PLANTED/)
        expect(other.content).toContain(python.chatVenvDir(basename(b)))
        const peek = await tools.runTool(call('run_code', { language: 'bash', code: `ls "${venvA}"` }), ctx(b))
        expect(peek.content).toMatch(/Operation not permitted/)
      } finally {
        updateSettings({ runner: { pypi: false } })
      }
      // Without PyPI, a chat with no environment of its own uses the shared one, and can't write it.
      const c = mkdtempSync(join(tmpdir(), 'kiln-run-'))
      const shared = await tools.runTool(call('run_code', { language: 'python', code: plant.replace('print(sys.prefix)', '') }), ctx(c))
      expect(shared.content).toMatch(/Operation not permitted/)
      expect(existsSync(python.chatVenvDir(basename(c)))).toBe(false)
      expect((await tools.runTool(call('run_code', { language: 'python', code: 'print(2)' }), ctx(c))).content).not.toMatch(/PLANTED/)
    }, 180_000)

    // pip checks certificates through macOS's trust service, which the sandbox blocks. Needs the network (pypi.org).
    it('installs a package from PyPI into the chat’s own environment', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kiln-run-'))
      mkdirSync(join(dir, '.kiln', 'tmp'), { recursive: true })
      updateSettings({ runner: { pypi: true } })
      try {
        const code = 'pip install -q --disable-pip-version-check --no-deps six && python -c "import six; print(six.__file__)"'
        const r = await tools.runTool(call('run_code', { language: 'bash', code }), ctx(dir))
        expect(r.content).toMatch(/^Exit code 0\./)
        expect(r.content).toContain(join(python.chatVenvDir(basename(dir)), 'lib'))
      } finally {
        updateSettings({ runner: { pypi: false } })
      }
    }, 180_000)

    it("answers gpt-oss's built-in python tool, whose code can arrive as plain text", async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kiln-run-'))
      expect(tools.resolveCall(call('python', 'print(1 + 1)'), ctx(dir))).toMatchObject({ name: 'run_code', via: 'python' })
      const r = await tools.runTool(call('python', 'print(1 + 1)'), ctx(dir))
      expect(r.content).toMatch(/^Exit code 0\.\n\n2/)
      const json = await tools.runTool(call('python', { code: 'print(3)' }), ctx(dir))
      expect(json.content).toMatch(/^Exit code 0\.\n\n3/)
    }, 120_000)
  })
})
