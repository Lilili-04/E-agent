import { describe, expect, it } from 'vitest'
import { planPolicyQuery, queryPolicies, type PolicyDescriptionSearchRequest, type PolicyExactSearchRequest, type PolicyQueryHit, type PolicyQueryStore, type PolicyTextSearchRequest } from '../src/query.ts'

function hit(overrides: Partial<PolicyQueryHit> = {}): PolicyQueryHit {
  return {
    recordKey: 'record-1',
    sourceId: 'source-1',
    relativePath: 'law/extracted/full.md',
    title: '中华人民共和国环境保护法',
    aliases: [],
    documentNumber: '主席令第九号',
    documentType: 'law',
    jurisdiction: 'national',
    publishDate: '2014-04-24',
    reportedLegalStatus: '现行有效',
    reviewStatus: 'reviewed',
    temporal: { status: 'effective', reviewStatus: 'reviewed', effectiveFrom: '2015-01-01' },
    unitId: 'unit-1',
    kind: 'article',
    label: '第二十五条',
    sectionPath: ['中华人民共和国环境保护法'],
    lineStart: 25,
    lineEnd: 26,
    text: '第二十五条 企业事业单位和其他生产经营者应当采取措施，防治在生产建设或者其他活动中产生的污染。',
    score: 0.9,
    ...overrides,
  }
}

class Store implements PolicyQueryStore {
  readonly exactRequests: PolicyExactSearchRequest[] = []
  readonly contentRequests: PolicyTextSearchRequest[] = []
  readonly descriptionRequests: PolicyDescriptionSearchRequest[] = []

  constructor(
    private readonly exactHits: readonly PolicyQueryHit[] = [],
    private readonly contentHits: readonly PolicyQueryHit[] = [],
    private readonly descriptionHits: readonly { readonly recordKey: string; readonly score: number }[] = [],
    private readonly hydratedHits: readonly PolicyQueryHit[] = [],
  ) {}

  async findExact(request: PolicyExactSearchRequest): Promise<readonly PolicyQueryHit[]> {
    this.exactRequests.push(request)
    return this.exactHits
  }

  async searchContent(request: PolicyTextSearchRequest): Promise<readonly PolicyQueryHit[]> {
    this.contentRequests.push(request)
    return request.recordKeys === undefined ? this.contentHits : this.hydratedHits
  }

  async searchDescriptions(
    request: PolicyDescriptionSearchRequest,
  ): Promise<readonly { readonly recordKey: string; readonly score: number }[]> {
    this.descriptionRequests.push(request)
    return this.descriptionHits
  }
}

describe('environment-policy query planning', () => {
  it('extracts exact fields, publication date, type, and review filters', () => {
    const plan = planPolicyQuery('查询已审核的国家级法律《中华人民共和国环境保护法》主席令第九号第二十五条，2014年4月24日发布')
    expect(plan.intent).toBe('lookup')
    expect(plan.filters).toMatchObject({
      title: '中华人民共和国环境保护法',
      documentNumber: '主席令第九号',
      articleLabel: '第二十五条',
      date: { role: 'publish', from: '2014-04-24', to: '2014-04-24', current: false },
      documentTypes: ['law'],
      jurisdictions: ['national'],
      reviewStatuses: ['reviewed'],
    })
    expect(plan.useExactRecall).toBe(true)
    expect(plan.useDescriptionRecall).toBe(false)
  })

  it('requires an injected date for current-status questions', () => {
    expect(() => planPolicyQuery('当前有效的排污规定')).toThrow('currentDate is required')
    expect(planPolicyQuery('当前有效的排污规定', { currentDate: '2026-09-26' }).filters.date).toEqual({
      role: 'as-of', from: '2026-09-26', to: '2026-09-26', current: true,
    })
  })
})

describe('environment-policy evidence query', () => {
  it('returns exact authoritative evidence with stable ids and bounded text', async () => {
    const store = new Store([hit()])
    const bundle = await queryPolicies(store, '《中华人民共和国环境保护法》主席令第九号第二十五条当前是否有效', {
      currentDate: '2026-09-26',
      maxEvidenceCharacters: 24,
    })
    expect(store.exactRequests).toHaveLength(1)
    expect(store.contentRequests).toHaveLength(0)
    expect(bundle.results).toHaveLength(1)
    expect(bundle.results[0]).toMatchObject({
      resultId: 'record-1:unit-1',
      temporalAssessment: 'confirmed-effective',
      textTruncated: true,
      matchReasons: ['title-exact', 'document-number-exact', 'article-exact'],
    })
    expect(Array.from(bundle.results[0]!.text)).toHaveLength(24)
    expect(bundle.warnings).toContain('evidence-truncated')
  })

  it('uses description only to discover records and returns source content as evidence', async () => {
    const sourceText = '企业应制定自行监测方案，保存原始监测记录，并依法公开监测结果。'
    const sourceHit = hit({ recordKey: 'record-monitoring', unitId: 'unit-monitoring', text: sourceText, score: 0.4 })
    const store = new Store([], [sourceHit], [{ recordKey: 'record-monitoring', score: 0.8 }], [sourceHit])
    const bundle = await queryPolicies(store, '企业怎样开展自行监测')
    expect(store.descriptionRequests).toHaveLength(1)
    expect(store.contentRequests).toHaveLength(2)
    expect(store.contentRequests[1]?.recordKeys).toEqual(['record-monitoring'])
    expect(bundle.results).toHaveLength(1)
    expect(bundle.results[0]?.text).toBe(sourceText)
    expect(bundle.results[0]?.matchReasons).toEqual(['description', 'full-text'])
  })

  it('never promotes unreviewed temporal metadata to confirmed current status', async () => {
    const unresolved = hit({
      recordKey: 'record-unresolved',
      unitId: 'unit-unresolved',
      temporal: { status: 'effective', reviewStatus: 'pending-review' },
    })
    const store = new Store([], [unresolved], [], [])
    const bundle = await queryPolicies(store, '当前排污单位应采取哪些措施', { currentDate: '2026-09-26' })
    expect(bundle.results[0]?.reportedLegalStatus).toBe('现行有效')
    expect(bundle.results[0]?.temporalAssessment).toBe('unconfirmed')
    expect(bundle.warnings).toContain('temporal-status-unconfirmed')
  })

  it('filters proved incompatible versions but retains unresolved historical candidates as unconfirmed', async () => {
    const expired = hit({
      recordKey: 'record-expired',
      unitId: 'unit-expired',
      temporal: { status: 'repealed', reviewStatus: 'reviewed', effectiveFrom: '2010-01-01', effectiveTo: '2018-12-31' },
    })
    const historical = hit({
      recordKey: 'record-historical',
      unitId: 'unit-historical',
      temporal: { status: 'repealed', reviewStatus: 'reviewed', effectiveFrom: '2019-01-01', effectiveTo: '2022-12-31' },
    })
    const unresolved = hit({
      recordKey: 'record-unknown',
      unitId: 'unit-unknown',
      temporal: { status: 'unknown', reviewStatus: 'pending-review' },
    })
    const store = new Store([], [expired, historical, unresolved], [], [])
    const bundle = await queryPolicies(store, '2020年6月1日排污单位应采取哪些措施')
    expect(bundle.results.map(result => result.recordKey)).toEqual(['record-historical', 'record-unknown'])
    expect(bundle.results.map(result => result.temporalAssessment)).toEqual(['confirmed-effective', 'unconfirmed'])
  })

  it('applies explicit document, review, and publication filters and reports no answer', async () => {
    const store = new Store([], [hit({ documentType: 'law', reviewStatus: 'reviewed', publishDate: '2014-04-24' })], [], [])
    const bundle = await queryPolicies(store, '污染防治', {
      filters: {
        documentTypes: ['draft'],
        reviewStatuses: ['reviewed'],
        date: { role: 'publish', from: '2020-01-01', to: '2020-12-31', current: false },
      },
    })
    expect(bundle.results).toEqual([])
    expect(bundle.warnings).toEqual(['no-authoritative-evidence'])
  })
})
