import { describe, expect, it } from 'vitest'
import { hasChildren, spawnGroup, stopAllGroups } from '../src/main/processes'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Start `sh -c script`, where the script prints a background child's pid; resolves with [leader, child]. */
async function startTree(script: string) {
  const proc = spawnGroup('sh', ['-c', script])
  const child = await new Promise<number>((resolve) => proc.child.stdout!.once('data', (d) => resolve(Number(String(d).trim()))))
  return { proc, pids: [proc.child.pid!, child] }
}

const until = async (check: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!check() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20))
  return check()
}

describe('process groups', () => {
  it('stops a process and the children it started', async () => {
    const { proc, pids } = await startTree('sleep 30 & echo $!; wait')
    expect(pids.every(alive)).toBe(true)
    await proc.stop()
    expect(await until(() => !pids.some(alive))).toBe(true)
  })

  it('kills what ignores SIGTERM once the grace period is over', async () => {
    // An ignored signal stays ignored across exec, so the background sleep ignores TERM too.
    const { proc, pids } = await startTree("trap '' TERM; sleep 30 & echo $!; wait")
    const t0 = Date.now()
    await proc.stop(200)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
    expect(await until(() => !pids.some(alive))).toBe(true)
  })

  it('stops what a process left behind when it exits on its own', async () => {
    const { pids } = await startTree('sleep 30 & echo $!')
    expect(await until(() => !pids.some(alive))).toBe(true)
  })

  it('stops everything before quitting', async () => {
    const a = await startTree('sleep 30 & echo $!; wait')
    const b = await startTree('sleep 30 & echo $!; wait')
    expect(hasChildren()).toBe(true)
    await stopAllGroups(500)
    expect(await until(() => ![...a.pids, ...b.pids].some(alive))).toBe(true)
    expect(hasChildren()).toBe(false)
  })

  it('reports a missing command as an error, like spawn', async () => {
    const proc = spawnGroup('kiln-no-such-command-xyz', [])
    const err = await new Promise<Error>((resolve) => proc.child.once('error', resolve))
    expect(err.message).toMatch(/ENOENT/)
    await proc.stop() // nothing to stop
  })
})
