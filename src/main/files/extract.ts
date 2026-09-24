import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_TEXT_CHARS = 600_000

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml'
}

export const MODEL_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function mimeFor(name: string, fallback = 'application/octet-stream'): string {
  const ext = extname(name).toLowerCase()
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext]
  return fallback && fallback !== 'application/octet-stream' ? fallback : 'text/plain'
}

export class UnsupportedFileError extends Error {}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192)
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++
  }
  return sample.length > 0 && suspicious / sample.length > 0.1
}

function cap(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[… truncated: file continues for ${text.length - MAX_TEXT_CHARS} more characters]`
    : text
}

async function extractPdf(buf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true })
  const doc = await task.promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    let line = ''
    const lines: string[] = []
    for (const item of content.items) {
      if (!('str' in item)) continue
      line += item.str
      if (item.hasEOL) {
        lines.push(line)
        line = ''
      }
    }
    if (line) lines.push(line)
    pages.push(`--- Page ${i} ---\n${lines.join('\n').trim()}`)
  }
  await task.destroy()
  const text = pages.join('\n\n')
  // A scanned PDF yields only page markers.
  return text.replace(/--- Page \d+ ---/g, '').trim() ? text : ''
}

async function extractDocx(buf: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const { value } = await (mammoth.default ?? mammoth).extractRawText({ buffer: buf })
  return value.trim()
}

async function extractXlsx(buf: Buffer): Promise<string> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  const out: string[] = []
  wb.eachSheet((sheet) => {
    out.push(`## Sheet: ${sheet.name}`)
    let n = 0
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (n++ >= 5000) return
      const cells = (row.values as unknown[]).slice(1).map((v) => {
        if (v == null) return ''
        if (typeof v === 'object') {
          const o = v as { result?: unknown; text?: unknown; richText?: Array<{ text: string }> }
          if (o.richText) return o.richText.map((r) => r.text).join('')
          if (o.result !== undefined) return String(o.result)
          if (o.text !== undefined) return String(o.text)
          if (v instanceof Date) return v.toISOString().slice(0, 10)
        }
        return String(v)
      })
      out.push(cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
    })
    if (n > 5000) out.push(`[… ${n - 5000} more rows]`)
  })
  return out.join('\n')
}

/** Returns extracted text, '' when a known format has no text layer, or throws for unsupported binaries. */
export async function extractText(buf: Buffer, mime: string, name: string): Promise<string> {
  if (mime === 'application/pdf') return cap(await extractPdf(buf))
  if (mime.includes('wordprocessingml')) return cap(await extractDocx(buf))
  if (mime.includes('spreadsheetml')) return cap(await extractXlsx(buf))
  if (/\.(doc|xls|ppt|pptx|key|pages|numbers|zip|dmg)$/i.test(name))
    throw new UnsupportedFileError(`${name}: this file type isn't supported yet. Try PDF, DOCX, XLSX or plain text.`)
  if (looksBinary(buf)) throw new UnsupportedFileError(`${name}: looks like a binary file, which can't be read as text.`)
  return cap(buf.toString('utf8'))
}
