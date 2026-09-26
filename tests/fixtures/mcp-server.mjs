// A small MCP server for tests and the e2e run: `node tests/fixtures/mcp-server.mjs`. It speaks stdio like any local
// server, and its tools exercise what Kiln has to handle (slow calls, errors, images, a changing tool list).
import { spawn } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

if (process.env.FIXTURE_CRASH_ON_START) {
  console.error('fixture: missing FIXTURE_TOKEN, giving up')
  process.exit(3)
}

const server = new McpServer({ name: 'kiln-fixture', version: '1.2.3' })
const text = (t) => ({ content: [{ type: 'text', text: t }] })

server.registerTool('echo', { description: 'Repeat the given text back.', inputSchema: { text: z.string() } }, ({ text: t }) =>
  text(`echo: ${t}`)
)

server.registerTool(
  'lookup_codename',
  {
    title: 'Look up a codename',
    description: "Look up a project's internal codename. The only way to learn a codename.",
    inputSchema: { project: z.string().describe('The project name') }
  },
  ({ project }) => text(`The internal codename for project ${project} is BLUE KESTREL.`)
)

server.registerTool(
  'slow',
  { description: 'Wait, then answer (stops early when cancelled).', inputSchema: { ms: z.number() } },
  async ({ ms }, extra) => {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      extra.signal.addEventListener('abort', () => {
        clearTimeout(t)
        console.error('fixture: slow was cancelled')
        resolve()
      })
    })
    return text('slow: done')
  }
)

server.registerTool('fail', { description: 'Always fails.' }, () => ({
  content: [{ type: 'text', text: 'the fixture failed on purpose' }],
  isError: true
}))

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
server.registerTool('image', { description: 'Returns a picture and a caption.' }, () => ({
  content: [
    { type: 'text', text: 'A tiny picture:' },
    { type: 'image', data: PNG, mimeType: 'image/png' }
  ]
}))

server.registerTool('structured', { description: 'Returns only structured content.' }, () => ({
  content: [],
  structuredContent: { answer: 42 }
}))

server.registerTool(
  'pick',
  { description: 'Takes a string or a number.', inputSchema: { value: z.union([z.string(), z.number()]) } },
  ({ value }) => text(`picked ${typeof value} ${value}`)
)

server.registerTool('env', { description: 'Read an environment variable.', inputSchema: { name: z.string() } }, ({ name }) =>
  text(process.env[name] ?? '(unset)')
)

server.registerTool('spawn_child', { description: 'Start a long-running child process; returns its pid.' }, () => {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' })
  return text(String(child.pid))
})

server.registerTool('add_tool', { description: 'Add a tool named extra.' }, () => {
  server.registerTool('extra', { description: 'Added at runtime.' }, () => text('extra: here'))
  return text('added')
})

server.registerTool('crash', { description: 'Exit with an error.' }, () => {
  console.error('fixture: crashing on purpose')
  setTimeout(() => process.exit(2), 10)
  return text('crashing')
})

await server.connect(new StdioServerTransport())
console.error('fixture: ready')
