import { describe, expect, it } from 'vitest'
import { parseServersJson } from '../src/shared/mcpImport'

describe('reading MCP server JSON', () => {
  it('reads the mcpServers snippet READMEs and Claude use', () => {
    const { servers, skipped } = parseServersJson(
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
          github: { command: 'docker', args: ['run', '-i', 'ghcr.io/github/github-mcp-server'], env: { GITHUB_TOKEN: 'x' } },
          notes: { type: 'stdio', command: 'uvx', args: ['notes-mcp'], cwd: '/Users/me' }
        }
      })
    )
    expect(skipped).toEqual([])
    expect(servers).toEqual([
      { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: {}, cwd: null },
      { name: 'github', command: 'docker', args: ['run', '-i', 'ghcr.io/github/github-mcp-server'], env: { GITHUB_TOKEN: 'x' }, cwd: null },
      { name: 'notes', command: 'uvx', args: ['notes-mcp'], env: {}, cwd: '/Users/me' }
    ])
  })

  it("reads VS Code's servers, a bare map, and a lone definition named after its package", () => {
    expect(parseServersJson('{"servers": {"a": {"type": "stdio", "command": "node", "args": ["a.js"]}}}').servers[0].name).toBe('a')
    expect(parseServersJson('{"b": {"command": "uvx", "args": ["mcp-server-fetch"]}}').servers[0].name).toBe('b')
    expect(parseServersJson('{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory@1.2.0"]}').servers[0].name).toBe(
      'server-memory'
    )
    expect(parseServersJson('{"command": "uvx", "args": ["mcp-server-fetch"]}').servers[0].name).toBe('mcp-server-fetch')
    expect(parseServersJson('{"command": "node", "args": ["/path/to/server.js"]}').servers[0].name).toBe('node')
  })

  it('leaves out remote servers and broken entries, saying why', () => {
    const { servers, skipped } = parseServersJson(
      JSON.stringify({
        mcpServers: {
          remote: { type: 'http', url: 'https://example.com/mcp' },
          sse: { url: 'https://example.com/sse' },
          nocmd: { args: ['x'] },
          badargs: { command: 'npx', args: 'x' },
          badenv: { command: 'npx', env: { N: 1 } },
          ok: { command: 'npx' }
        }
      })
    )
    expect(servers.map((s) => s.name)).toEqual(['ok'])
    expect(skipped).toEqual([
      expect.stringMatching(/^remote: remote \(http\) servers aren't supported/),
      expect.stringMatching(/^sse: remote \(http\) servers aren't supported.*mcp-remote/),
      'nocmd: no command',
      'badargs: args must be a list of strings',
      'badenv: env values must be strings'
    ])
  })

  it('says what is wrong with text that holds no servers', () => {
    expect(() => parseServersJson('{"mcpServers": {')).toThrow(/isn't valid JSON/)
    expect(() => parseServersJson('[1, 2]')).toThrow(/JSON object/)
    expect(() => parseServersJson('{"mcpServers": {}}')).toThrow(/No MCP server definitions/)
  })
})
