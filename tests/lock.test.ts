import { beforeEach, describe, expect, it, vi } from 'vitest'

// The lock that keeps Ollmost's work in a chat's folders and the chat's code apart (#71, #73, #76), with the check for
// leftover code (a macOS sandbox query, reaper.ts) replaced by a mock.

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: { isEncryptionAvailable: () => false } }))
const reap = vi.fn()
vi.mock('../src/main/runner/reaper', () => ({ reap: (folders: string[]) => reap(folders) }))

type Lock = typeof import('../src/main/runner/lock')
let lock: Lock
let chatVenvDir: (id: string) => string
beforeEach(async () => {
  vi.resetModules()
  lock = await import('../src/main/runner/lock')
  chatVenvDir = (await import('../src/main/runner/python')).chatVenvDir
  reap.mockReset()
  reap.mockImplementation(async (folders: string[]) => ({ stopped: 0, checked: folders }))
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("the lock on a chat's folders", () => {
  it('does the work after stopping leftovers, and lets no code start until the work is done', async () => {
    const order: string[] = []
    reap.mockImplementation(async (folders: string[]) => {
      order.push('check')
      return { stopped: 0, checked: folders }
    })
    let release = () => {}
    const work = lock.quiesce('/w/a', async () => {
      order.push('work')
      await new Promise<void>((resolve) => (release = resolve))
      order.push('work done')
    })
    await tick()
    const starting = lock.codeStarting('/w/a').then(() => order.push('code starts'))
    await tick()
    expect(order).toEqual(['check', 'work'])
    release()
    await Promise.all([work, starting])
    expect(order).toEqual(['check', 'work', 'work done', 'code starts'])
  })

  it('checks both folders a chat’s code may write: its workspace and its Python environment', async () => {
    await lock.quiesce('/w/chat-1', async () => undefined)
    expect(reap).toHaveBeenCalledWith(['/w/chat-1', chatVenvDir('chat-1')])
  })

  it('refuses while code runs; a run’s end checks, and the next work needs no check until code runs again', async () => {
    await lock.codeStarting('/w/b')
    await expect(lock.quiesce('/w/b', async () => 'x')).rejects.toBeInstanceOf(lock.CodeRunningError)
    await lock.codeEnded('/w/b')
    expect(reap).toHaveBeenCalledTimes(1)
    expect(await lock.quiesce('/w/b', async () => 'x')).toBe('x')
    expect(reap).toHaveBeenCalledTimes(1)
    await lock.codeStarting('/w/b')
    await lock.codeEnded('/w/b')
    expect(reap).toHaveBeenCalledTimes(2)
  })

  it('refuses work that waited behind other work while a run queued before it started', async () => {
    let release = () => {}
    const first = lock.quiesce('/w/c', () => new Promise<void>((resolve) => (release = resolve)))
    await tick()
    const starting = lock.codeStarting('/w/c')
    const second = lock.quiesce('/w/c', async () => 'ran')
    release()
    await Promise.all([first, starting])
    await expect(second).rejects.toBeInstanceOf(lock.CodeRunningError)
    await lock.codeEnded('/w/c')
  })

  it('never lets queued work and a queued run overlap, whichever goes first', async () => {
    const events: string[] = []
    let release = () => {}
    const first = lock.quiesce('/w/c2', () => new Promise<void>((resolve) => (release = resolve)))
    await tick()
    const second = lock.quiesce('/w/c2', async () => {
      events.push('work')
      await tick()
      events.push('work done')
    })
    const starting = lock.codeStarting('/w/c2').then(() => events.push('code starts'))
    release()
    await Promise.all([first, starting, second.catch(() => events.push('work refused'))])
    expect([
      ['work', 'work done', 'code starts'],
      ['code starts', 'work refused']
    ]).toContainEqual(events)
    await lock.codeEnded('/w/c2')
  })

  it('keeps a failed check on record, doing no work, and checks again next time', async () => {
    await lock.codeStarting('/w/d')
    reap.mockRejectedValueOnce(new Error('no Python'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await lock.codeEnded('/w/d')
    warn.mockRestore()
    expect(lock.codeMayBeRunning()).toBe(true)
    reap.mockRejectedValueOnce(new Error('no Python'))
    const work = vi.fn(async () => undefined)
    await expect(lock.quiesce('/w/d', work)).rejects.toThrow('no Python')
    expect(work).not.toHaveBeenCalled()
    await lock.quiesce('/w/d', work)
    expect(work).toHaveBeenCalledTimes(1)
    expect(lock.codeMayBeRunning()).toBe(false)
  })

  it('counts a workspace as checked only when its folder was', async () => {
    reap.mockImplementation(async () => ({ stopped: 0, checked: [] }))
    await lock.quiesce('/w/e', async () => undefined)
    await lock.quiesce('/w/e', async () => undefined)
    expect(reap).toHaveBeenCalledTimes(2)
  })

  it('sweeps skip a chat whose code is running; deleting every environment waits for none', async () => {
    await lock.codeStarting('/w/f')
    const quiet: string[][] = []
    await lock.quiesceEvery(['/w/f', '/w/g'], { skipRunning: true, work: async (q) => void quiet.push(q) })
    expect(quiet).toEqual([['/w/g']])
    expect(reap).toHaveBeenLastCalledWith(['/w/g', chatVenvDir('g')])
    await expect(lock.quiesceEvery(['/w/f', '/w/g'], { work: async () => undefined })).rejects.toBeInstanceOf(lock.CodeRunningError)
    await lock.codeEnded('/w/f')
    await lock.quiesceEvery(['/w/f', '/w/g'], { work: async (q) => void quiet.push(q) })
    expect(quiet.at(-1)).toEqual(['/w/f', '/w/g'])
  })
})
