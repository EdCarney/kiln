import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { extractText, mimeFor, UnsupportedFileError } from '../src/main/files/extract'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name))

describe('extractText', () => {
  it('reads PDF text with page markers', async () => {
    const text = await extractText(fixture('sample.pdf'), 'application/pdf', 'sample.pdf')
    expect(text).toContain('--- Page 1 ---')
    expect(text).toContain('quick brown fox')
  })

  it('reads DOCX text', async () => {
    const text = await extractText(fixture('sample.docx'), mimeFor('sample.docx'), 'sample.docx')
    expect(text).toContain('quick brown fox')
  })

  it('flattens XLSX sheets to CSV', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Budget')
    ws.addRow(['Item', 'Cost'])
    ws.addRow(['Coffee, beans', 12.5])
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    const text = await extractText(buf, mimeFor('b.xlsx'), 'b.xlsx')
    expect(text).toBe('## Sheet: Budget\nItem,Cost\n"Coffee, beans",12.5')
  })

  it('decodes plain text and code', async () => {
    expect(await extractText(Buffer.from('print("hi")'), mimeFor('a.py'), 'a.py')).toBe('print("hi")')
  })

  it('rejects binaries and legacy Office formats', async () => {
    await expect(extractText(Buffer.from([0, 1, 2, 3]), 'application/octet-stream', 'blob.bin')).rejects.toBeInstanceOf(
      UnsupportedFileError
    )
    await expect(extractText(Buffer.from('x'), 'application/msword', 'old.doc')).rejects.toBeInstanceOf(UnsupportedFileError)
  })
})
