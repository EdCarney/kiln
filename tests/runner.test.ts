import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const { policyFor, runSandboxed } = await import('../src/main/runner/sandbox')
const workspace = await import('../src/main/runner/workspace')
const tools = await import('../src/main/chat/tools')

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
        denyRead: ['/Users/me'],
        allowRead: ['/w', '/Users/me/.claude/skills', '/Users/me/k/venv'],
        allowWrite: ['/w'],
        denyWrite: []
      }
    })
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

// The sandbox itself is macOS's (sandbox-exec); CI runs on Linux.
describe.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))('running code in the sandbox', () => {
  const ws = mkdtempSync(join(tmpdir(), 'kiln-ws-'))
  const fakeHome = mkdtempSync(join(tmpdir(), 'kiln-home-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'kiln-elsewhere-'))
  writeFileSync(join(fakeHome, 'private.txt'), 'private')
  const policy = policyFor({ workspace: ws, home: fakeHome, readable: [], venv: join(root, 'venv'), pypi: false })
  const sandboxed = (command: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    runSandboxed({ command, policy, cwd: ws, env: {}, timeoutMs: extra.timeoutMs ?? 30_000, signal: extra.signal, id: command })

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
