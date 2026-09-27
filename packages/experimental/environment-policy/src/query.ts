/** A review state that may be used to constrain policy retrieval. */
export type PolicyReviewStatus = 'generated' | 'pending-review' | 'rejected' | 'reviewed' | 'stale'

/** A reviewed or unresolved temporal classification stored for one document version. */
export type PolicyTemporalStatus = 'draft' | 'effective' | 'repealed' | 'superseded' | 'unknown'

/** An inclusive date constraint extracted from a question. */
export interface PolicyDateFilter {
  readonly role: 'as-of' | 'publish'
  readonly from: string
  readonly to: string
  readonly current: boolean
}

/** Structured constraints applied before lexical ranking. */
export interface PolicyQueryFilters {
  readonly title?: string
  readonly documentNumber?: string
  readonly articleLabel?: string
  readonly date?: PolicyDateFilter
  readonly documentTypes: readonly string[]
  readonly jurisdictions: readonly string[]
  readonly reviewStatuses: readonly PolicyReviewStatus[]
}

/** A deterministic retrieval plan derived from one user question. */
export interface PolicyQueryPlan {
  readonly question: string
  readonly intent: 'comparison' | 'document-discovery' | 'lookup' | 'temporal'
  readonly freeText: string
  readonly filters: PolicyQueryFilters
  readonly useExactRecall: boolean
  readonly useFullTextRecall: boolean
  readonly useDescriptionRecall: boolean
}

/** Optional explicit values and clock input for query planning. */
export interface PolicyQueryPlanningOptions {
  readonly currentDate?: string
  readonly filters?: Partial<PolicyQueryFilters>
}

/** Reviewed time facts associated with a searchable document version. */
export interface PolicyTemporalFacts {
  readonly status: PolicyTemporalStatus
  readonly reviewStatus: 'pending-review' | 'reviewed'
  readonly effectiveFrom?: string
  readonly effectiveTo?: string
}

/** One authoritative content-unit hit returned by a retrieval provider. */
export interface PolicyQueryHit {
  readonly recordKey: string
  readonly sourceId: string
  readonly relativePath: string
  readonly title?: string
  readonly aliases?: readonly string[]
  readonly documentNumber?: string
  readonly documentType: string
  readonly jurisdiction?: string
  readonly publishDate?: string
  readonly reportedLegalStatus?: string
  readonly reviewStatus: PolicyReviewStatus
  readonly temporal: PolicyTemporalFacts
  readonly unitId: string
  readonly kind: string
  readonly label?: string
  readonly sectionPath: readonly string[]
  readonly lineStart: number
  readonly lineEnd: number
  readonly text: string
  readonly score: number
}

/** A document discovered from its non-authoritative description. */
export interface PolicyDescriptionHit {
  readonly recordKey: string
  readonly score: number
}

/** Exact lookup request supplied to a read-only retrieval provider. */
export interface PolicyExactSearchRequest {
  readonly plan: PolicyQueryPlan
  readonly limit: number
}

/** Lexical content lookup request supplied to a read-only retrieval provider. */
export interface PolicyTextSearchRequest {
  readonly query: string
  readonly plan: PolicyQueryPlan
  readonly limit: number
  readonly recordKeys?: readonly string[]
}

/** Description lookup request supplied to a read-only retrieval provider. */
export interface PolicyDescriptionSearchRequest {
  readonly query: string
  readonly plan: PolicyQueryPlan
  readonly limit: number
}

/** Minimal database-independent read interface required by the query service. */
export interface PolicyQueryStore {
  findExact(request: PolicyExactSearchRequest): Promise<readonly PolicyQueryHit[]>
  searchContent(request: PolicyTextSearchRequest): Promise<readonly PolicyQueryHit[]>
  searchDescriptions(request: PolicyDescriptionSearchRequest): Promise<readonly PolicyDescriptionHit[]>
}

/** Why an authoritative content unit was retained in the evidence package. */
export type PolicyMatchReason =
  | 'article-exact'
  | 'description'
  | 'document-number-exact'
  | 'full-text'
  | 'title-exact'

/** Conservative temporal assessment produced without interpreting raw status labels. */
export type PolicyTemporalAssessment = 'confirmed-effective' | 'not-requested' | 'unconfirmed'

/** One bounded, source-addressable item returned to the answer layer. */
export interface PolicyEvidenceResult {
  readonly resultId: string
  readonly recordKey: string
  readonly sourceId: string
  readonly relativePath: string
  readonly title?: string
  readonly documentNumber?: string
  readonly documentType: string
  readonly jurisdiction?: string
  readonly publishDate?: string
  readonly reportedLegalStatus?: string
  readonly reviewStatus: PolicyReviewStatus
  readonly temporal: PolicyTemporalFacts
  readonly temporalAssessment: PolicyTemporalAssessment
  readonly unitId: string
  readonly kind: string
  readonly label?: string
  readonly sectionPath: readonly string[]
  readonly lineStart: number
  readonly lineEnd: number
  readonly text: string
  readonly textTruncated: boolean
  readonly score: number
  readonly matchReasons: readonly PolicyMatchReason[]
}

/** Bounded retrieval output suitable for use as answer evidence. */
export interface PolicyEvidenceBundle {
  readonly plan: PolicyQueryPlan
  readonly results: readonly PolicyEvidenceResult[]
  readonly warnings: readonly string[]
  readonly limits: {
    readonly maxResults: number
    readonly maxEvidenceCharacters: number
    readonly returnedEvidenceCharacters: number
  }
}

/** Runtime limits and planner inputs for one query. */
export interface PolicyQueryOptions extends PolicyQueryPlanningOptions {
  readonly maxResults?: number
  readonly maxEvidenceCharacters?: number
}

const DEFAULT_MAX_RESULTS = 8
const DEFAULT_MAX_EVIDENCE_CHARACTERS = 12_000
const MAX_RESULTS = 50
const MAX_EVIDENCE_CHARACTERS = 100_000

const DOCUMENT_TYPES: readonly (readonly [RegExp, string])[] = [
  [/征求意见稿|意见稿|草案/u, 'draft'],
  [/行政法规/u, 'administrative-regulation'],
  [/法律/u, 'law'],
  [/部门规章|规范性文件|规章/u, 'rule'],
  [/技术标准|国家标准|行业标准|技术规范|技术指南|技术导则/u, 'standard'],
  [/规划|行动计划|实施方案|工作方案/u, 'plan'],
  [/通知/u, 'notice'],
  [/公告/u, 'announcement'],
]

const REVIEW_STATUSES: readonly (readonly [RegExp, PolicyReviewStatus])[] = [
  [/待审核|未审核/u, 'pending-review'],
  [/审核通过|已经审核|已审核/u, 'reviewed'],
  [/已拒绝|审核拒绝/u, 'rejected'],
  [/已过期|摘要过期/u, 'stale'],
]

const TITLE_PATTERN = /《([^》]{2,160})》/u
const DOCUMENT_NUMBER_PATTERN = /(?:[A-Za-z\u4e00-\u9fff]{1,24}〔\d{4}〕\d+号|(?:国务院|生态环境部|财政部|主席)令第[一二三四五六七八九十百千万\d]+号)/u
const ARTICLE_PATTERN = /第[一二三四五六七八九十百千万零〇\d]+条/u
const DATE_PATTERN = /(\d{4})(?:年|[./-])(\d{1,2})(?:月|[./-])(\d{1,2})日?/u
const YEAR_PATTERN = /(?<!\d)(\d{4})年(?!\d)/u

function normalizeDate(year: string, month: string, day: string): string {
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

function validIsoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`environment-policy query: ${field} must be an ISO date`)
  }
  return value
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function matchValue(pattern: RegExp, question: string): string | undefined {
  return pattern.exec(question)?.[0]
}

function parseDateFilter(question: string, currentDate: string | undefined): PolicyDateFilter | undefined {
  const date = DATE_PATTERN.exec(question)
  if (date !== null) {
    const value = normalizeDate(date[1] as string, date[2] as string, date[3] as string)
    const contextStart = Math.max(0, date.index - 10)
    const context = question.slice(contextStart, date.index + date[0].length + 10)
    return { role: /发布|公布|印发/u.test(context) ? 'publish' : 'as-of', from: value, to: value, current: false }
  }
  const year = YEAR_PATTERN.exec(question)
  if (year !== null) {
    const contextStart = Math.max(0, year.index - 10)
    const context = question.slice(contextStart, year.index + year[0].length + 10)
    return {
      role: /发布|公布|印发/u.test(context) ? 'publish' : 'as-of',
      from: `${year[1]}-01-01`,
      to: `${year[1]}-12-31`,
      current: false,
    }
  }
  if (!/当前|目前|现在|现行/u.test(question)) return undefined
  if (currentDate === undefined) throw new Error('environment-policy query: currentDate is required for a current-status question')
  const value = validIsoDate(currentDate, 'currentDate')
  return { role: 'as-of', from: value, to: value, current: true }
}

function inferredDocumentTypes(question: string): string[] {
  return unique(DOCUMENT_TYPES.filter(([pattern]) => pattern.test(question)).map(([, value]) => value))
}

function inferredReviewStatuses(question: string): PolicyReviewStatus[] {
  return unique(REVIEW_STATUSES.filter(([pattern]) => pattern.test(question)).map(([, value]) => value))
}

function freeText(question: string, extracted: readonly (string | undefined)[]): string {
  let text = question
  for (const value of extracted) if (value !== undefined) text = text.replace(value, ' ')
  return text
    .replace(/请问|请查询|查询|查找|检索|帮我|哪些|什么|如何|是否|关于|有关|内容|要求|规定|当前|目前|现在|现行|有效/gu, ' ')
    .replace(/[？?，,。；;：:\s]+/gu, ' ')
    .trim()
}

function mergeFilters(inferred: PolicyQueryFilters, explicit: Partial<PolicyQueryFilters> | undefined): PolicyQueryFilters {
  if (explicit === undefined) return inferred
  return {
    ...(explicit.title ?? inferred.title) === undefined ? {} : { title: explicit.title ?? inferred.title },
    ...(explicit.documentNumber ?? inferred.documentNumber) === undefined
      ? {}
      : { documentNumber: explicit.documentNumber ?? inferred.documentNumber },
    ...(explicit.articleLabel ?? inferred.articleLabel) === undefined
      ? {}
      : { articleLabel: explicit.articleLabel ?? inferred.articleLabel },
    ...(explicit.date ?? inferred.date) === undefined ? {} : { date: explicit.date ?? inferred.date },
    documentTypes: explicit.documentTypes ?? inferred.documentTypes,
    jurisdictions: explicit.jurisdictions ?? inferred.jurisdictions,
    reviewStatuses: explicit.reviewStatuses ?? inferred.reviewStatuses,
  }
}

/**
 * Parse explicit legal-document constraints before selecting retrieval channels.
 * @param question - natural-language policy question.
 * @param options - explicit filters and clock input.
 * @returns deterministic retrieval plan.
 */
export function planPolicyQuery(question: string, options: PolicyQueryPlanningOptions = {}): PolicyQueryPlan {
  const normalizedQuestion = question.trim()
  if (normalizedQuestion.length === 0) throw new Error('environment-policy query: question is required')
  const titleMatch = TITLE_PATTERN.exec(normalizedQuestion)
  const title = titleMatch?.[1]?.trim()
  const documentNumber = matchValue(DOCUMENT_NUMBER_PATTERN, normalizedQuestion)
  const articleLabel = matchValue(ARTICLE_PATTERN, normalizedQuestion)
  const date = parseDateFilter(normalizedQuestion, options.currentDate)
  const inferred: PolicyQueryFilters = {
    ...(title === undefined ? {} : { title }),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    ...(articleLabel === undefined ? {} : { articleLabel }),
    ...(date === undefined ? {} : { date }),
    documentTypes: inferredDocumentTypes(normalizedQuestion),
    jurisdictions: /全国|国家级/u.test(normalizedQuestion) ? ['national'] : [],
    reviewStatuses: inferredReviewStatuses(normalizedQuestion),
  }
  const filters = mergeFilters(inferred, options.filters)
  const dateText = date === undefined
    ? undefined
    : matchValue(DATE_PATTERN, normalizedQuestion) ?? matchValue(YEAR_PATTERN, normalizedQuestion)
  const text = freeText(normalizedQuestion, [titleMatch?.[0], documentNumber, articleLabel, dateText])
  const exact = filters.title !== undefined || filters.documentNumber !== undefined || filters.articleLabel !== undefined
  const intent = /对比|比较|区别|差异|修订前后|新旧/u.test(normalizedQuestion)
    ? 'comparison'
    : !filters.title && !filters.documentNumber && !filters.articleLabel
        && /有哪些|有什么|列出|相关(?:的)?(?:法规|法律|政策|文件)/u.test(normalizedQuestion)
      ? 'document-discovery'
      : filters.date?.role === 'as-of' ? 'temporal' : 'lookup'
  return {
    question: normalizedQuestion,
    intent,
    freeText: text,
    filters,
    useExactRecall: exact,
    useFullTextRecall: text.length > 0,
    useDescriptionRecall: text.length > 0 && !exact,
  }
}

function normalizeExact(value: string): string {
  return value.replace(/[《》“”"'‘’（）()\s]/gu, '')
}

function inDateRange(value: string, filter: PolicyDateFilter): boolean {
  return value >= filter.from && value <= filter.to
}

function satisfiesFilters(hit: PolicyQueryHit, filters: PolicyQueryFilters): boolean {
  if (filters.title !== undefined) {
    const expected = normalizeExact(filters.title)
    const names = [hit.title, ...(hit.aliases ?? [])].filter((value): value is string => value !== undefined).map(normalizeExact)
    if (!names.includes(expected)) return false
  }
  if (filters.documentNumber !== undefined && normalizeExact(hit.documentNumber ?? '') !== normalizeExact(filters.documentNumber)) return false
  if (filters.articleLabel !== undefined && normalizeExact(hit.label ?? '') !== normalizeExact(filters.articleLabel)) return false
  if (filters.documentTypes.length > 0 && !filters.documentTypes.includes(hit.documentType)) return false
  if (filters.jurisdictions.length > 0
    && (hit.jurisdiction === undefined || !filters.jurisdictions.includes(hit.jurisdiction))) return false
  if (filters.reviewStatuses.length > 0 && !filters.reviewStatuses.includes(hit.reviewStatus)) return false
  if (filters.date?.role === 'publish' && (hit.publishDate === undefined || !inDateRange(hit.publishDate, filters.date))) return false
  return true
}

function temporalAssessment(hit: PolicyQueryHit, filter: PolicyDateFilter | undefined): PolicyTemporalAssessment | 'exclude' {
  if (filter?.role !== 'as-of') return 'not-requested'
  const facts = hit.temporal
  if (facts.reviewStatus !== 'reviewed' || facts.status === 'unknown') return 'unconfirmed'
  if (facts.status === 'draft') return 'exclude'
  if (facts.effectiveFrom !== undefined && facts.effectiveFrom > filter.to) return 'exclude'
  if (facts.effectiveTo !== undefined && facts.effectiveTo < filter.from) return 'exclude'
  if (filter.current) return facts.status === 'effective' ? 'confirmed-effective' : 'exclude'
  if (facts.effectiveFrom === undefined) return 'unconfirmed'
  if (facts.effectiveTo !== undefined) return 'confirmed-effective'
  return facts.status === 'effective' ? 'confirmed-effective' : 'unconfirmed'
}

function matchReasons(hit: PolicyQueryHit, plan: PolicyQueryPlan, channel: 'description' | 'exact' | 'full-text'): PolicyMatchReason[] {
  const reasons: PolicyMatchReason[] = []
  if (channel === 'description') reasons.push('description')
  if (channel === 'full-text') reasons.push('full-text')
  const title = plan.filters.title
  if (title !== undefined
    && [hit.title, ...(hit.aliases ?? [])].some(value => value !== undefined && normalizeExact(value) === normalizeExact(title))) {
    reasons.push('title-exact')
  }
  if (plan.filters.documentNumber !== undefined && normalizeExact(hit.documentNumber ?? '') === normalizeExact(plan.filters.documentNumber)) reasons.push('document-number-exact')
  if (plan.filters.articleLabel !== undefined && normalizeExact(hit.label ?? '') === normalizeExact(plan.filters.articleLabel)) reasons.push('article-exact')
  return unique(reasons)
}

interface RankedHit {
  readonly hit: PolicyQueryHit
  readonly score: number
  readonly reasons: readonly PolicyMatchReason[]
  readonly temporalAssessment: PolicyTemporalAssessment
}

function ranked(hit: PolicyQueryHit, plan: PolicyQueryPlan, channel: 'description' | 'exact' | 'full-text', descriptionScore = 0): RankedHit | undefined {
  if (!satisfiesFilters(hit, plan.filters)) return undefined
  const assessment = temporalAssessment(hit, plan.filters.date)
  if (assessment === 'exclude') return undefined
  const base = channel === 'exact' ? 100 : channel === 'full-text' ? 50 : 20
  const providerScore = Number.isFinite(hit.score) ? hit.score : 0
  return {
    hit,
    score: base + providerScore + (channel === 'description' ? descriptionScore : 0),
    reasons: matchReasons(hit, plan, channel),
    temporalAssessment: assessment,
  }
}

function mergeRanked(values: readonly RankedHit[]): RankedHit[] {
  const merged = new Map<string, RankedHit>()
  for (const value of values) {
    const key = `${value.hit.recordKey}\0${value.hit.unitId}`
    const previous = merged.get(key)
    if (previous === undefined) {
      merged.set(key, value)
      continue
    }
    merged.set(key, {
      hit: value.score > previous.score ? value.hit : previous.hit,
      score: Math.max(previous.score, value.score) + 2,
      reasons: unique([...previous.reasons, ...value.reasons]).sort(),
      temporalAssessment: previous.temporalAssessment === 'confirmed-effective' || value.temporalAssessment === 'confirmed-effective'
        ? 'confirmed-effective'
        : previous.temporalAssessment,
    })
  }
  return [...merged.values()].sort((left, right) => right.score - left.score
    || `${left.hit.recordKey}:${left.hit.unitId}`.localeCompare(`${right.hit.recordKey}:${right.hit.unitId}`))
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`environment-policy query: ${field} must be an integer from 1 to ${maximum}`)
  return resolved
}

function evidenceResult(value: RankedHit, remainingCharacters: number): PolicyEvidenceResult {
  const characters = Array.from(value.hit.text)
  const truncated = characters.length > remainingCharacters
  const text = truncated ? characters.slice(0, remainingCharacters).join('') : value.hit.text
  const hit = value.hit
  return {
    resultId: `${hit.recordKey}:${hit.unitId}`,
    recordKey: hit.recordKey,
    sourceId: hit.sourceId,
    relativePath: hit.relativePath,
    ...(hit.title === undefined ? {} : { title: hit.title }),
    ...(hit.documentNumber === undefined ? {} : { documentNumber: hit.documentNumber }),
    documentType: hit.documentType,
    ...(hit.jurisdiction === undefined ? {} : { jurisdiction: hit.jurisdiction }),
    ...(hit.publishDate === undefined ? {} : { publishDate: hit.publishDate }),
    ...(hit.reportedLegalStatus === undefined ? {} : { reportedLegalStatus: hit.reportedLegalStatus }),
    reviewStatus: hit.reviewStatus,
    temporal: hit.temporal,
    temporalAssessment: value.temporalAssessment,
    unitId: hit.unitId,
    kind: hit.kind,
    ...(hit.label === undefined ? {} : { label: hit.label }),
    sectionPath: hit.sectionPath,
    lineStart: hit.lineStart,
    lineEnd: hit.lineEnd,
    text,
    textTruncated: truncated,
    score: value.score,
    matchReasons: value.reasons,
  }
}

/**
 * Execute exact, content, and description-assisted recall.
 * @param store - database-independent retrieval provider.
 * @param question - natural-language policy question.
 * @param options - planner inputs and evidence limits.
 * @returns bounded source evidence and uncertainty warnings.
 */
export async function queryPolicies(
  store: PolicyQueryStore,
  question: string,
  options: PolicyQueryOptions = {},
): Promise<PolicyEvidenceBundle> {
  const maxResults = positiveInteger(options.maxResults, DEFAULT_MAX_RESULTS, MAX_RESULTS, 'maxResults')
  const maxEvidenceCharacters = positiveInteger(options.maxEvidenceCharacters, DEFAULT_MAX_EVIDENCE_CHARACTERS, MAX_EVIDENCE_CHARACTERS, 'maxEvidenceCharacters')
  const plan = planPolicyQuery(question, options)
  const candidateLimit = Math.min(MAX_RESULTS, Math.max(maxResults * 4, 12))
  const [exactHits, contentHits, descriptionHits] = await Promise.all([
    plan.useExactRecall ? store.findExact({ plan, limit: candidateLimit }) : Promise.resolve([]),
    plan.useFullTextRecall ? store.searchContent({ query: plan.freeText, plan, limit: candidateLimit }) : Promise.resolve([]),
    plan.useDescriptionRecall ? store.searchDescriptions({ query: plan.freeText, plan, limit: candidateLimit }) : Promise.resolve([]),
  ])
  const descriptionScores = new Map(descriptionHits.map(hit => [hit.recordKey, hit.score]))
  const descriptionEvidence = descriptionHits.length === 0
    ? []
    : await store.searchContent({
      query: plan.freeText,
      plan,
      limit: candidateLimit,
      recordKeys: unique(descriptionHits.map(hit => hit.recordKey)),
    })
  const rankedHits = mergeRanked([
    ...exactHits.map(hit => ranked(hit, plan, 'exact')).filter((value): value is RankedHit => value !== undefined),
    ...contentHits.map(hit => ranked(hit, plan, 'full-text')).filter((value): value is RankedHit => value !== undefined),
    ...descriptionEvidence.map(hit => ranked(hit, plan, 'description', descriptionScores.get(hit.recordKey) ?? 0)).filter((value): value is RankedHit => value !== undefined),
  ])
  const selectedHits = plan.intent === 'document-discovery'
    ? [...new Map(rankedHits.map(value => [value.hit.recordKey, value])).values()]
    : rankedHits
  const results: PolicyEvidenceResult[] = []
  let returnedEvidenceCharacters = 0
  for (const value of selectedHits) {
    if (results.length >= maxResults || returnedEvidenceCharacters >= maxEvidenceCharacters) break
    const remaining = maxEvidenceCharacters - returnedEvidenceCharacters
    const result = evidenceResult(value, remaining)
    results.push(result)
    returnedEvidenceCharacters += Array.from(result.text).length
  }
  const warnings: string[] = []
  if (results.length === 0) warnings.push('no-authoritative-evidence')
  if (results.some(result => result.temporalAssessment === 'unconfirmed')) warnings.push('temporal-status-unconfirmed')
  if (results.some(result => result.textTruncated)) warnings.push('evidence-truncated')
  return {
    plan,
    results,
    warnings,
    limits: { maxResults, maxEvidenceCharacters, returnedEvidenceCharacters },
  }
}
