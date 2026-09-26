import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { type GroupProcess, spawnGroup } from '../processes'

// The SDK's StdioClientTransport kills only the process it started, and `npx some-server` runs the real server as a
// grandchild. This transport speaks the same newline-delimited JSON-RPC but starts the server through the process
// supervisor, so closing it stops the whole tree. It also keeps the server's stderr for error messages and the log.

const LOG_LINES = 200
const LINE_CHARS = 2_000

export interface ServerProcess {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export class ProcessTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  /** The last lines the server wrote to stderr. */
  readonly log: string[] = []
  /** How the server exited, once it has. */
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null

  private proc: GroupProcess | null = null
  private readonly buffer = new ReadBuffer()
  private partial = ''

  constructor(private readonly server: ServerProcess) {}

  start(): Promise<void> {
    if (this.proc) throw new Error('ProcessTransport already started')
    return new Promise((resolve, reject) => {
      const proc = spawnGroup(this.server.command, this.server.args, { cwd: this.server.cwd, env: this.server.env })
      this.proc = proc
      const { child } = proc
      child.once('error', (err) => {
        reject(err)
        this.onerror?.(err)
      })
      child.once('spawn', () => resolve())
      child.once('close', (code, signal) => {
        this.exit = { code, signal }
        this.proc = null
        this.onclose?.()
      })
      child.stdout!.on('data', (chunk: Buffer) => {
        try {
          this.buffer.append(chunk)
        } catch (err) {
          // Over 10 MB without a newline: not a server Ollmost can talk to.
          this.onerror?.(err as Error)
          void this.close()
          return
        }
        for (;;) {
          let message: JSONRPCMessage | null
          try {
            message = this.buffer.readMessage()
          } catch (err) {
            // A line that isn't JSON-RPC (a server printing to stdout by mistake): report it and read on.
            this.onerror?.(err as Error)
            continue
          }
          if (!message) break
          this.onmessage?.(message)
        }
      })
      child.stderr!.on('data', (chunk: Buffer) => this.addLog(chunk.toString()))
      child.stdin!.on('error', (err) => this.onerror?.(err))
    })
  }

  private addLog(text: string): void {
    const lines = (this.partial + text).split('\n')
    this.partial = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) this.log.push(line.slice(0, LINE_CHARS))
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES)
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.proc?.child.stdin
      if (!stdin?.writable) return reject(new Error('The MCP server is not running.'))
      if (stdin.write(serializeMessage(message))) resolve()
      else stdin.once('drain', resolve)
    })
  }

  /** Close stdin (a well-behaved server exits on that), then stop the process group. */
  async close(): Promise<void> {
    const proc = this.proc
    this.buffer.clear()
    if (!proc) return
    const closed = new Promise<void>((resolve) => proc.child.once('close', () => resolve()))
    proc.child.stdin?.end()
    await Promise.race([closed, new Promise((r) => setTimeout(r, 500))])
    await proc.stop()
  }
}
