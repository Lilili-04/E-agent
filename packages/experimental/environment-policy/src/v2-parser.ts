/** Structural units retain every original character, including line endings. */
import { createHash } from 'node:crypto'

/** An addressable original-text unit. */
export interface SourceUnit {
  id: string
  document_id: string
  sequence: number
  kind: 'article' | 'heading' | 'paragraph'
  label: string
  section_path: string
  text: string
  line_start: number
  line_end: number
}

const number = '[零〇一二三四五六七八九十百千万两0-9]+'
const article = new RegExp(`^(第${number}条(?:之${number})?)(?![\\d一二三四五六七八九十])`, 'u')
const chapter = new RegExp(`^(第${number}[编章节])`, 'u')

/** Normalize Arabic or Chinese article selectors.
 * @param label - Article label such as 第26条 or 第二十六条.
 * @returns Comparable numeric article key, preserving inserted article suffixes.
 */
export function articleKey(label: string): string {
  return label.replace(/[零〇一二三四五六七八九十百千万两]+/gu, (value) => {
    const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
    const scales: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 }
    let total = 0; let current = 0
    for (const char of value) {
      const digit = digits[char]
      const scale = scales[char]
      if (digit !== undefined) current = current * 10 + digit
      else if (scale !== undefined) { total += (current || 1) * scale; current = 0 }
    }
    return String(total + current)
  }).replace(/\s/gu, '')
}

/** Split legal articles before generic Markdown headings; keep full clauses and exact source text.
 * @param documentId - Immutable document version ID.
 * @param source - Original Markdown.
 * @returns Ordered units whose concatenation exactly equals source.
 */
export function sourceUnits(documentId: string, source: string): SourceUnit[] {
  const lines = source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)?.filter(Boolean) ?? []
  const units: SourceUnit[] = []
  let start = 0
  let kind: SourceUnit['kind'] = 'paragraph'
  let label = ''
  let section = ''
  let unitSection = ''
  function flush(end: number) {
    if (end <= start) return
    const text = lines.slice(start, end).join('')
    const sequence = units.length
    units.push({
      id: `u-${createHash('sha256').update(`${documentId}:${sequence}:${text}`).digest('hex').slice(0, 24)}`,
      document_id: documentId, sequence, kind, label, section_path: unitSection,
      text, line_start: start + 1, line_end: end,
    })
    start = end
  }
  for (const [i, line] of lines.entries()) {
    const raw = line.trim()
    const plain = raw.replace(/^#{1,6}\s*/u, '').replace(/^\*\*|\*\*$/gu, '').trim()
    const clause = plain.match(article)
    const heading = !clause && (chapter.test(plain) || /^#{1,6}\s/u.test(raw))
    if (clause || heading) {
      flush(i)
      kind = clause ? 'article' : 'heading'
      label = clause?.[1] ?? plain
      if (heading) section = plain
      unitSection = section
    } else if (i > start && kind !== 'article' && lines[i - 1]?.trim() === '' && raw !== '') {
      flush(i); kind = 'paragraph'; label = ''; unitSection = section
    } else if (kind === 'heading' && raw !== '' && i > start) {
      flush(i); kind = 'paragraph'; label = ''; unitSection = section
    }
  }
  flush(lines.length)
  return units
}
