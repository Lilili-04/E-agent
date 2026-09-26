import type { ParsedDocument, SourceSpan } from './parse.ts'
import { parsePolicyMarkdown } from './parse.ts'

/** Metadata fields that can be supported by a source quote. */
export interface MetadataEvidence extends SourceSpan {
  readonly field: string
  readonly quote: string
}

/** A date found in the source with a conservative role classification. */
export interface DateCandidate {
  readonly value: string
  readonly role: 'effective-from' | 'effective-to' | 'publish' | 'revision' | 'unknown'
  readonly evidence: MetadataEvidence
}

/** Catalog fields supplied by 环保政策法规清单.xlsx. */
export interface PolicyCatalogRecord {
  readonly title?: string
  readonly originalTitle?: string
  readonly issuingAuthority?: string
  readonly documentNumber?: string
  readonly publishDate?: string
  readonly legalStatus?: string
  readonly subjectArea?: string
  readonly sourcePath?: string
  readonly officialUrl?: string
  readonly versionRelation?: string
  readonly note?: string
}

/** A deterministic first-pass document metadata result. */
export interface DocumentMetadata {
  readonly sourceId: string
  readonly rawTitle?: string
  readonly canonicalTitleCandidate?: string
  readonly titleCandidates: readonly string[]
  readonly regulationKeyCandidate?: string
  readonly documentType: string
  readonly issuingAuthorityCandidate?: string
  readonly jurisdictionCandidate?: string
  readonly documentNumberCandidate?: string
  readonly aliases: readonly string[]
  readonly publishDateCandidate?: string
  readonly legalStatus?: string
  readonly subjectArea?: string
  readonly sourcePath?: string
  readonly versionRelation?: string
  readonly effectiveFromCandidate?: string
  readonly effectiveToCandidate?: string
  readonly revisionDateCandidate?: string
  readonly dateCandidates: readonly DateCandidate[]
  readonly statusCandidate: string
  readonly officialSourceUrls: readonly string[]
  readonly evidence: readonly MetadataEvidence[]
  readonly issues: readonly string[]
  readonly metadataStatus: 'auto-extracted' | 'pending-review'
}

/**
 * Merge catalog metadata without allowing it to overwrite Markdown evidence.
 * @param metadata - candidates extracted from the source Markdown.
 * @param catalog - fields imported from the workbook row.
 * @returns merged metadata with recalculated review status.
 */
export function mergePolicyCatalogMetadata(metadata: DocumentMetadata, catalog: PolicyCatalogRecord): DocumentMetadata {
  const issues = new Set(metadata.issues)
  if (catalog.title !== undefined) {
    issues.delete('missing-title-candidate')
    issues.delete('multiple-title-candidates')
  }
  if (catalog.title === undefined && metadata.canonicalTitleCandidate === undefined) issues.add('missing-title-candidate')
  if (catalog.publishDate === undefined && metadata.publishDateCandidate === undefined) issues.add('missing-publish-date')
  const legalStatus = catalog.legalStatus ?? metadata.statusCandidate
  const blockingIssues = [
    'missing-title-candidate',
    'missing-publish-date',
    'unknown-document-type',
    'multiple-title-candidates',
    'effective-range-reversed',
  ]
  const metadataStatus = blockingIssues.some(issue => issues.has(issue)) ? 'pending-review' : 'auto-extracted'
  return {
    ...metadata,
    ...(catalog.title === undefined ? {} : {
      canonicalTitleCandidate: catalog.title,
      regulationKeyCandidate: normalizeTitle(catalog.title),
    }),
    ...(catalog.title === undefined ? {} : { titleCandidates: [...new Set([catalog.title, ...metadata.titleCandidates])] }),
    ...(catalog.originalTitle === undefined ? {} : { rawTitle: catalog.originalTitle }),
    ...(catalog.issuingAuthority === undefined ? {} : { issuingAuthorityCandidate: catalog.issuingAuthority }),
    ...(catalog.documentNumber === undefined ? {} : { documentNumberCandidate: catalog.documentNumber }),
    ...(catalog.publishDate === undefined ? {} : { publishDateCandidate: catalog.publishDate }),
    ...(catalog.legalStatus === undefined ? {} : { legalStatus: catalog.legalStatus }),
    ...(catalog.subjectArea === undefined ? {} : { subjectArea: catalog.subjectArea }),
    ...(catalog.sourcePath === undefined ? {} : { sourcePath: catalog.sourcePath }),
    ...(catalog.versionRelation === undefined ? {} : { versionRelation: catalog.versionRelation }),
    officialSourceUrls: catalog.officialUrl === undefined
      ? metadata.officialSourceUrls
      : [...new Set([catalog.officialUrl, ...metadata.officialSourceUrls])],
    statusCandidate: legalStatus,
    metadataStatus,
    issues: [...issues].sort(),
  }
}

const DATE_PATTERN = /(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?/g
const DOCUMENT_NUMBER_PATTERN = /(?:[A-Za-z\u4e00-\u9fff]{1,24}〔\d{4}〕\d+号|(?:国务院|生态环境部|财政部|主席)令第[一二三四五六七八九十百千万\d]+号)/
const URL_PATTERN = /https?:\/\/[^\s)）]+/g
const GENERIC_TITLE_PATTERN = /^(?:目录|附件|说明|序言|中华人民共和国.+令|第[一二三四五六七八九十百千万\d]+号)$/
const ISSUER_PATTERNS = [
  '中华人民共和国国务院',
  '国务院',
  '生态环境部',
  '国家环境保护总局',
  '环境保护部',
  '国家发展和改革委员会',
  '住房和城乡建设部',
  '工业和信息化部',
  '自然资源部',
  '交通运输部',
  '国家林业和草原局',
]

function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index; cursor++) if (text[cursor] === '\n') line++
  return line
}

function evidence(field: string, text: string, index: number, quote: string): MetadataEvidence {
  const line = lineNumberAt(text, index)
  return { field, quote, lineStart: line, lineEnd: line }
}

function normalizeDate(year: string, month: string, day: string): string {
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

function contextAround(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - 36), Math.min(text.length, index + length + 36))
}

function normalizeTitle(title: string): string {
  return title.replace(/[《》“”"'‘’（）()\s]/g, '').replace(/（[^）]*(?:原始|修订|修正|试行|暂行)版）$/u, '')
}

function inferJurisdiction(text: string): string | undefined {
  if (/全国|中华人民共和国|国家级/.test(text.slice(0, 12_000))) return 'national'
  return undefined
}

function titleCandidates(parsed: ParsedDocument, text: string): string[] {
  const headings = parsed.units
    .filter(unit => unit.label !== undefined && ['heading', 'chapter', 'section', 'attachment'].includes(unit.kind))
    .map(unit => unit.label as string)
    .filter(label => !GENERIC_TITLE_PATTERN.test(label))
  const quoted = [...text.matchAll(/《([^》]{2,120})》/g)].map(match => match[1] as string)
  return [...new Set([...headings, ...quoted])].slice(0, 12)
}

function classifyDocumentType(text: string, title: string | undefined): string {
  const sample = `${title ?? ''}\n${text.slice(0, 12_000)}`
  if (/征求意见稿|意见稿|草案/.test(sample)) return 'draft'
  if (/办法|规定/.test(sample)) return 'rule'
  // A law can quote technical standards in its body. Prefer the title when it
  // explicitly names a law or regulation before scanning the full text.
  if (/(?:法|条例)$/.test((title ?? '').trim())) return title?.trim().endsWith('条例') ? 'administrative-regulation' : 'law'
  if (/技术标准|国家标准|行业标准|技术规范|技术指南|技术导则|\bHJ\s*\d+/i.test(sample)) return 'standard'
  if (/废止.*公告|公告.*废止/.test(sample)) return 'repeal-announcement'
  if (/修改决定|修正案|修订决定/.test(sample)) return 'amendment-decision'
  if (/规划|行动计划|实施方案|工作方案/.test(sample)) return 'plan'
  if (/通知/.test(sample)) return 'notice'
  if (/公告/.test(sample)) return 'announcement'
  if (/条例/.test(sample)) return 'administrative-regulation'
  if (/(?:^|[\s《》])(?:.+法|.+法律)(?:$|[\s《》])/u.test(sample) && !/办法|规定/.test(title ?? '')) return 'law'
  return 'unknown'
}

function classifyDateRole(text: string, index: number, length: number): DateCandidate['role'] {
  const context = contextAround(text, index, length)
  const localAfter = text.slice(index + length, index + length + 24).split(/[，。；,.;]/u)[0] ?? ''
  const localBefore = text.slice(Math.max(0, index - 4), index)
  if (/施行|生效|实施/.test(localAfter) || /施行|生效|实施/.test(localBefore)) return 'effective-from'
  if (/废止|失效|终止/.test(localAfter) || /废止|失效|终止/.test(localBefore)) return 'effective-to'
  if (/修订|修正|修改/.test(localAfter) || /修订|修正|修改/.test(localBefore)) return 'revision'
  if (/发布|公布|印发|签署/.test(localAfter) || /发布|公布|印发|签署/.test(localBefore)) return 'publish'
  void context
  return 'unknown'
}

function firstDate(candidates: readonly DateCandidate[], role: DateCandidate['role']): DateCandidate | undefined {
  return candidates.find(candidate => candidate.role === role)
}

/**
 * Extract explainable document metadata without making legal-validity claims.
 * @param sourceId - stable content source identifier.
 * @param markdown - authoritative Markdown text.
 * @param parsed - optional existing structural parse of the same text.
 * @returns metadata candidates, evidence, and review issues.
 */
export function extractPolicyMetadata(
  sourceId: string,
  markdown: string,
  parsed = parsePolicyMarkdown(sourceId, markdown),
): DocumentMetadata {
  const candidates = titleCandidates(parsed, markdown)
  const rawTitle = parsed.units.find(unit => unit.label !== undefined)?.label
  const canonicalTitleCandidate = candidates[0]
  const documentType = classifyDocumentType(markdown, canonicalTitleCandidate)
  const documentNumberMatch = DOCUMENT_NUMBER_PATTERN.exec(markdown)
  const documentNumberCandidate = documentNumberMatch?.[0]
  const issuer = ISSUER_PATTERNS.find(candidate => markdown.slice(0, 8_000).includes(candidate))
  const jurisdiction = inferJurisdiction(`${canonicalTitleCandidate ?? ''}\n${markdown}`)
  const urls = [...markdown.matchAll(URL_PATTERN)].map(match => match[0]).slice(0, 8)
  const dateCandidates: DateCandidate[] = []
  for (const match of markdown.matchAll(DATE_PATTERN)) {
    const value = normalizeDate(match[1] as string, match[2] as string, match[3] as string)
    const index = match.index
    const quote = match[0]
    const role = classifyDateRole(markdown, index, quote.length)
    dateCandidates.push({ value, role, evidence: evidence(role, markdown, index, quote) })
  }
  const effectiveFrom = firstDate(dateCandidates, 'effective-from')
  const effectiveTo = firstDate(dateCandidates, 'effective-to')
  const publish = firstDate(dateCandidates, 'publish')
  const revision = firstDate(dateCandidates, 'revision')
  const issues = new Set<string>()
  if (candidates.length === 0) issues.add('missing-title-candidate')
  if (candidates.length > 1) issues.add('multiple-title-candidates')
  if (documentType === 'unknown') issues.add('unknown-document-type')
  if (publish === undefined) issues.add('missing-publish-date')
  if (dateCandidates.filter(candidate => candidate.role === 'effective-from').length > 1) issues.add('multiple-effective-from-candidates')
  if (dateCandidates.filter(candidate => candidate.role === 'effective-to').length > 1) issues.add('multiple-effective-to-candidates')
  if (effectiveFrom !== undefined && effectiveTo !== undefined && effectiveFrom.value > effectiveTo.value) issues.add('effective-range-reversed')
  const evidenceItems = [
    ...(canonicalTitleCandidate === undefined ? [] : [evidence(
      'canonical-title-candidate',
      markdown,
      Math.max(0, markdown.indexOf(canonicalTitleCandidate)),
      canonicalTitleCandidate,
    )]),
    ...(documentNumberMatch === null ? [] : [evidence(
      'document-number',
      markdown,
      documentNumberMatch.index,
      documentNumberMatch[0],
    )]),
    ...dateCandidates.map(candidate => candidate.evidence),
  ]
  const regulationKeyCandidate = canonicalTitleCandidate === undefined ? undefined : normalizeTitle(canonicalTitleCandidate)
  return {
    sourceId,
    ...(rawTitle === undefined ? {} : { rawTitle }),
    ...(canonicalTitleCandidate === undefined ? {} : { canonicalTitleCandidate }),
    titleCandidates: candidates,
    ...(regulationKeyCandidate === undefined ? {} : { regulationKeyCandidate }),
    documentType,
    ...(issuer === undefined ? {} : { issuingAuthorityCandidate: issuer }),
    ...(jurisdiction === undefined ? {} : { jurisdictionCandidate: jurisdiction }),
    ...(documentNumberCandidate === undefined ? {} : { documentNumberCandidate }),
    aliases: [],
    ...(publish === undefined ? {} : { publishDateCandidate: publish.value }),
    ...(effectiveFrom === undefined ? {} : { effectiveFromCandidate: effectiveFrom.value }),
    ...(effectiveTo === undefined ? {} : { effectiveToCandidate: effectiveTo.value }),
    ...(revision === undefined ? {} : { revisionDateCandidate: revision.value }),
    dateCandidates,
    statusCandidate: documentType === 'draft' ? 'draft' : /试行|暂行/.test(markdown) ? 'trial' : /废止/.test(markdown) ? 'repeal-candidate' : 'unknown',
    officialSourceUrls: urls,
    evidence: evidenceItems,
    issues: [...issues].sort(),
    metadataStatus: issues.size === 0 ? 'auto-extracted' : 'pending-review',
  }
}
