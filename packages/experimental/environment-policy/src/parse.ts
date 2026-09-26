import { createHash } from 'node:crypto'

/** A structural unit produced from one Markdown source document. */
export type ContentUnitKind =
  | 'article'
  | 'attachment'
  | 'chapter'
  | 'generic-block'
  | 'heading'
  | 'image-reference'
  | 'list-item'
  | 'paragraph'
  | 'section'
  | 'table'

/** A parser quality flag that does not prevent the source from being indexed. */
export type ParseQualityFlag =
  | 'attachment-only'
  | 'empty-content'
  | 'no-article'
  | 'no-heading'
  | 'unstructured-document'

/** A source-relative line span with one-based inclusive boundaries. */
export interface SourceSpan {
  readonly lineStart: number
  readonly lineEnd: number
}

/** One deterministic content unit retained for later indexing and evidence. */
export interface ContentUnit extends SourceSpan {
  readonly unitId: string
  readonly kind: ContentUnitKind
  readonly label?: string
  readonly parentUnitId?: string
  readonly sectionPath: readonly string[]
  readonly text: string
  readonly textHash: string
}

/** The complete deterministic parse result for one source document. */
export interface ParsedDocument {
  readonly parserVersion: 1
  readonly sourceId: string
  readonly documentSpan: SourceSpan
  readonly units: readonly ContentUnit[]
  readonly quality: readonly ParseQualityFlag[]
}

const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/
const ARTICLE_PATTERN = /^\s*(第[一二三四五六七八九十百千万零〇\d]+条)(?:\s+(.*))?$/
const LIST_PATTERN = /^\s*((?:[-*+])|(?:[（(][一二三四五六七八九十百千万零〇\d]+[）)])|(?:[一二三四五六七八九十百千万零〇\d]+[、.)])|(?:\d+[、.)]))\s+(.+)$/
const ATTACHMENT_PATTERN = /^附件(?:\s*[:：].*)?$/
const TABLE_PATTERN = /^\s*\|.*\|\s*$/
const IMAGE_PATTERN = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/
const FENCE_PATTERN = /^\s*```/

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

function sectionKind(text: string): 'chapter' | 'section' | 'heading' {
  if (/^第[一二三四五六七八九十百千万零〇\d]+章(?:\s|$)/.test(text)) return 'chapter'
  if (/^第[一二三四五六七八九十百千万零〇\d]+节(?:\s|$)/.test(text)) return 'section'
  return 'heading'
}

function unitId(sourceId: string, kind: ContentUnitKind, span: SourceSpan, label: string | undefined, text: string): string {
  const identity = [sourceId, kind, span.lineStart, span.lineEnd, label ?? '', sha256(text)].join('\0')
  return `unit-${sha256(identity).slice(0, 24)}`
}

function makeUnit(
  sourceId: string,
  kind: ContentUnitKind,
  lines: readonly string[],
  lineStart: number,
  lineEnd: number,
  sectionPath: readonly string[],
  label?: string,
  parentUnitId?: string,
): ContentUnit {
  const text = lines.slice(lineStart - 1, lineEnd).join('\n')
  const span = { lineStart, lineEnd }
  return {
    ...span,
    unitId: unitId(sourceId, kind, span, label, text),
    kind,
    ...(label === undefined ? {} : { label }),
    ...(parentUnitId === undefined ? {} : { parentUnitId }),
    sectionPath: [...sectionPath],
    text,
    textHash: sha256(text),
  }
}

function structuralStart(line: string): boolean {
  return HEADING_PATTERN.test(line) || ARTICLE_PATTERN.test(line) || ATTACHMENT_PATTERN.test(line)
}

function scanTable(lines: readonly string[], start: number): number {
  let end = start
  while (end < lines.length && (TABLE_PATTERN.test(lines[end] ?? '') || isBlank(lines[end] ?? ''))) end++
  while (end > start && isBlank(lines[end - 1] ?? '')) end--
  return end
}

function scanParagraph(lines: readonly string[], start: number): number {
  let end = start
  while (end < lines.length && !isBlank(lines[end] ?? '') && !structuralStart(lines[end] ?? '')) end++
  return end
}

/**
 * Parse one source Markdown string without changing or completing its text.
 * @param sourceId - stable content source identifier.
 * @param markdown - authoritative Markdown text.
 * @returns parsed units and structural quality flags.
 */
export function parsePolicyMarkdown(sourceId: string, markdown: string): ParsedDocument {
  const lines = markdown.split(/\r?\n/)
  const units: ContentUnit[] = []
  const sectionStack: Array<{ depth: number; label: string }> = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const lineNumber = index + 1
    if (isBlank(line)) {
      index++
      continue
    }

    const heading = HEADING_PATTERN.exec(line)
    if (heading !== null) {
      const depth = heading[1]?.length ?? 1
      const label = heading[2]?.trim() ?? ''
      while (sectionStack.at(-1) !== undefined && (sectionStack.at(-1)?.depth ?? 0) >= depth) sectionStack.pop()
      const kind = ATTACHMENT_PATTERN.test(label) ? 'attachment' : sectionKind(label)
      const sectionPath = sectionStack.map(entry => entry.label)
      units.push(makeUnit(sourceId, kind, lines, lineNumber, lineNumber, sectionPath, label))
      sectionStack.push({ depth, label })
      index++
      continue
    }

    const article = ARTICLE_PATTERN.exec(line)
    if (article !== null) {
      const label = article[1]
      const start = lineNumber
      let endIndex = index + 1
      while (endIndex < lines.length && !structuralStart(lines[endIndex] ?? '')) endIndex++
      while (endIndex > index + 1 && isBlank(lines[endIndex - 1] ?? '')) endIndex--
      units.push(makeUnit(sourceId, 'article', lines, start, endIndex, sectionStack.map(entry => entry.label), label))
      index = Math.max(endIndex, index + 1)
      continue
    }

    if (TABLE_PATTERN.test(line)) {
      const end = scanTable(lines, index)
      units.push(makeUnit(sourceId, 'table', lines, lineNumber, end, sectionStack.map(entry => entry.label)))
      index = Math.max(end, index + 1)
      continue
    }

    if (FENCE_PATTERN.test(line)) {
      let end = index + 1
      while (end < lines.length && !FENCE_PATTERN.test(lines[end] ?? '')) end++
      if (end < lines.length) end++
      units.push(makeUnit(sourceId, 'generic-block', lines, lineNumber, Math.max(end, index + 1), sectionStack.map(entry => entry.label)))
      index = Math.max(end, index + 1)
      continue
    }

    const list = LIST_PATTERN.exec(line)
    if (list !== null) {
      units.push(makeUnit(sourceId, 'list-item', lines, lineNumber, lineNumber, sectionStack.map(entry => entry.label), list[1]))
      index++
      continue
    }

    if (IMAGE_PATTERN.test(line)) {
      units.push(makeUnit(sourceId, 'image-reference', lines, lineNumber, lineNumber, sectionStack.map(entry => entry.label)))
      index++
      continue
    }

    const end = scanParagraph(lines, index)
    units.push(makeUnit(sourceId, 'paragraph', lines, lineNumber, Math.max(end, index + 1), sectionStack.map(entry => entry.label)))
    index = Math.max(end, index + 1)
  }

  const quality = new Set<ParseQualityFlag>()
  if (lines.every(isBlank)) quality.add('empty-content')
  if (!units.some(unit => unit.kind === 'heading' || unit.kind === 'chapter' || unit.kind === 'section' || unit.kind === 'attachment')) quality.add('no-heading')
  if (!units.some(unit => unit.kind === 'article')) quality.add('no-article')
  if (units.length > 0 && units.every(unit => unit.kind === 'attachment' || unit.sectionPath.some(path => ATTACHMENT_PATTERN.test(path)))) quality.add('attachment-only')
  if (units.length > 0 && units.every(unit => unit.kind === 'paragraph' || unit.kind === 'generic-block')) quality.add('unstructured-document')
  return {
    parserVersion: 1,
    sourceId,
    documentSpan: { lineStart: 1, lineEnd: lines.length },
    units,
    quality: [...quality].sort(),
  }
}
