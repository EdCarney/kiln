import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { elapsedMs, hasChildren, spawnGroup, stopAllGroups, trackProcesses } from '../src/main/processes'

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

describe('cleaning up after a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiln-pidfile-'))
  const recorded = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as Array<{ pgid: number }>).map((r) => r.pgid)

  /** A group started the way Kiln starts one, but not tracked: what a crashed run leaves behind. Resolves with its pids. */
  async function orphan() {
    const child = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const bg = await new Promise<number>((resolve) => child.stdout!.once('data', (d) => resolve(Number(String(d).trim()))))
    return { pgid: child.pid!, pids: [child.pid!, bg] }
  }

  it('keeps a file of the groups that are running', async () => {
    const file = join(dir, 'live.json')
    expect(await trackProcesses(file)).toBe(0)
    const { proc } = await startTree('sleep 30 & echo $!; wait')
    expect(recorded(file)).toEqual([proc.child.pid])
    await proc.stop()
    expect(recorded(file)).toEqual([])
  })

  it('stops the groups an earlier run recorded and left running', async () => {
    const left = await orphan()
    const file = join(dir, 'crashed.json')
    writeFileSync(file, JSON.stringify([{ pgid: left.pgid, startedAt: Date.now() - 2_000, command: 'sh' }]))
    expect(await trackProcesses(file)).toBe(1)
    expect(await until(() => !left.pids.some(alive))).toBe(true)
    expect(recorded(file)).toEqual([])
  })

  it("leaves alone a group id that can't be Kiln's any more", async () => {
    const other = await orphan()
    const file = join(dir, 'stale.json')
    // Recorded before this Mac started, and recorded after the processes now using that id had started.
    writeFileSync(
      file,
      JSON.stringify([
        { pgid: other.pgid, startedAt: 0, command: 'sh' },
        { pgid: other.pgid, startedAt: Date.now() + 60_000, command: 'sh' }
      ])
    )
    expect(await trackProcesses(file)).toBe(0)
    expect(other.pids.every(alive)).toBe(true)
    process.kill(-other.pgid, 'SIGKILL')
  })

  it("reads ps's elapsed times", () => {
    expect(elapsedMs('05:07')).toBe(307_000)
    expect(elapsedMs('1:02:03')).toBe(3_723_000)
    expect(elapsedMs('2-00:00:01')).toBe(172_801_000)
  })
})
