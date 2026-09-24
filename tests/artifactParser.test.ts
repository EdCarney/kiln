import { describe, expect, it } from 'vitest'
import { parseMessage } from '@shared/artifactParser'

const doc = `Here is the plan.

<artifact identifier="trip-plan" type="markdown" title="Trip plan">
# Day 1
Walk around.
</artifact>

Let me know if you want changes.`

describe('parseMessage', () => {
  it('splits prose and a complete artifact', () => {
    const segs = parseMessage(doc)
    expect(segs.map((s) => s.kind)).toEqual(['text', 'artifact', 'text'])
    const a = segs[1]
    expect(a).toMatchObject({ identifier: 'trip-plan', type: 'markdown', title: 'Trip plan', complete: true })
    expect(a.kind === 'artifact' && a.content).toBe('# Day 1\nWalk around.')
  })

  it('returns plain text when there is no artifact', () => {
    expect(parseMessage('just words')).toEqual([{ kind: 'text', text: 'just words' }])
  })

  it('treats an unclosed tag as an in-progress artifact', () => {
    const segs = parseMessage('Intro\n<artifact identifier="x" type="code" language="python" title="X">\nprint(1)\n', true)
    expect(segs[1]).toMatchObject({ kind: 'artifact', complete: false, language: 'python' })
    expect(segs[1].kind === 'artifact' && segs[1].content).toBe('print(1)\n')
  })

  it('hides a partially streamed opening tag', () => {
    for (const tail of ['<', '<art', '<artifact', '<artifact identifier="a" ty']) {
      const segs = parseMessage(`Sure thing.\n${tail}`, true)
      expect(segs).toEqual([{ kind: 'text', text: 'Sure thing.\n' }])
    }
  })

  it('keeps a lone < in finished prose', () => {
    expect(parseMessage('a < b', false)).toEqual([{ kind: 'text', text: 'a < b' }])
  })

  it('does not hide streamed prose that merely contains <', () => {
    expect(parseMessage('if x < y then', true)).toEqual([{ kind: 'text', text: 'if x < y then' }])
  })

  it('hides a partially streamed closing tag', () => {
    const segs = parseMessage('<artifact identifier="x" type="html" title="X"><p>hi</p></artif', true)
    expect(segs[0].kind === 'artifact' && segs[0].content).toBe('<p>hi</p>')
  })

  it('strips code fences inside the artifact', () => {
    const segs = parseMessage('<artifact identifier="s" type="code" language="js" title="S">\n```js\nconst a = 1\n```\n</artifact>')
    expect(segs[0].kind === 'artifact' && segs[0].content).toBe('const a = 1')
  })

  it('removes a code fence wrapped around the whole tag', () => {
    const segs = parseMessage('Here:\n```xml\n<artifact identifier="d" type="svg" title="D"><svg/></artifact>\n```\nDone.')
    expect(segs.map((s) => s.kind)).toEqual(['text', 'artifact', 'text'])
    expect(segs[0].kind === 'text' && segs[0].text).not.toContain('```')
    expect(segs[2].kind === 'text' && segs[2].text).not.toContain('```')
  })

  it('accepts Claude-style antArtifact tags and MIME types', () => {
    const segs = parseMessage('<antArtifact identifier="p" type="text/html" title="Page"><h1>x</h1></antArtifact>')
    expect(segs[0]).toMatchObject({ kind: 'artifact', type: 'html', complete: true })
  })

  it('handles several artifacts and invents identifiers when missing', () => {
    const segs = parseMessage(
      '<artifact type="mermaid" title="Flow">graph TD; A-->B</artifact> and <artifact type="mermaid" title="Flow">graph TD; B-->C</artifact>'
    )
    const ids = segs.filter((s) => s.kind === 'artifact').map((s) => s.kind === 'artifact' && s.identifier)
    expect(ids).toEqual(['flow', 'flow-2'])
  })

  it('maps react artifacts to jsx code and unknown types to code', () => {
    const r = parseMessage('<artifact identifier="r" type="application/vnd.ant.react" title="R">x</artifact>')[0]
    expect(r).toMatchObject({ type: 'code', language: 'jsx' })
    const u = parseMessage('<artifact identifier="u" type="python" title="U">x</artifact>')[0]
    expect(u).toMatchObject({ type: 'code', language: 'python' })
  })
})
