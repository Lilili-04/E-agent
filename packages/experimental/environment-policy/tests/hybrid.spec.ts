import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PolicyDatabase, type PolicyImportDocument } from '../src/database.ts'
import { HybridQueryStore, type HybridConfig } from '../src/hybrid-store.ts'
import { parsePolicyMarkdown } from '../src/parse.ts'
import { planPolicyQuery, queryPolicies } from '../src/query.ts'

const databases: PolicyDatabase[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close() })
function fixture() {
  const markdown = '# 养殖污染治理条例\n\n第一条 🌱养殖场应建设贮存设施，妥善处理粪水。\n不得将未经处理的粪水直接排入水体。\n\n第二条 违反排放要求的，应当依法承担责任。'
  const hash = createHash('sha256').update(markdown).digest('hex')
  const sourceId = `source-${hash.slice(0, 24)}`
  const document: PolicyImportDocument = {
    source: { sourceId, relativePath: 'farm/full.md', byteLength: Buffer.byteLength(markdown), sha256: hash, headingCandidates: ['养殖污染治理条例'], quality: [] },
    markdown, parsed: parsePolicyMarkdown(sourceId, markdown),
    metadata: { sourceId, canonicalTitleCandidate: '养殖污染治理条例', titleCandidates: ['养殖污染治理条例'], regulationKeyCandidate: '养殖污染治理条例', documentType: 'administrative-regulation', statusCandidate: 'unknown', aliases: [], dateCandidates: [], officialSourceUrls: [], evidence: [], issues: [], metadataStatus: 'auto-extracted' },
  }
  const db = new PolicyDatabase(':memory:'); databases.push(db)
  const manifest = db.rebuild({ sourceRoot: 'test', builtAt: '2026-10-13T00:00:00.000Z', documents: [document] })
  const source = db.findSourcesByExact({})[0]!
  const unit = db.readContentUnits({ recordKeys: [source.recordKey], label: '第一条' })[0]!
  const config: HybridConfig = {
    embeddingUrl: 'http://embedding', chromaUrl: 'http://chroma', model: 'qwen3-embedding-4b',
    documentCollection: 'documents', passageCollection: 'passages', timeoutMs: 50, documentCandidates: 12,
    passageCandidates: 32, maxDistance: 0.45, documentMaxDistance: 0.9, cacheEntries: 2,
  }
  const metadata = {
    record_key: source.recordKey, unit_id: unit.unitId, source_hash: hash, build_id: manifest.buildId,
    start: 6, end: Array.from(unit.text).length,
  }
  const mock = vi.fn(async (input: string) => {
    const url = input
    if (url.endsWith('/v1/embeddings')) return Response.json({ data: [{ embedding: [1, ...Array<number>(2559).fill(0)] }] })
    if (url.endsWith('/query')) return Response.json({ metadatas: [[metadata]], distances: [[url.includes('documents-id') ? 0.5 : 0.2]] })
    const passages = url.endsWith('/passages')
    return Response.json({ id: passages ? 'passages-id' : 'documents-id', dimension: 2560, metadata: { build_id: manifest.buildId }, configuration_json: { hnsw: { space: passages ? 'cosine' : 'l2' } } })
  })
  vi.stubGlobal('fetch', mock)
  return { db, config, mock, unit, metadata }
}

describe('DGX hybrid retrieval', () => {
  it('confirms document names from the catalog and bypasses GPU for precise requests', async () => {
    const { db, config, mock } = fixture()
    const result = await queryPolicies(new HybridQueryStore(db, config), '养殖污染治理条例第一条规定了什么？')
    expect(mock).not.toHaveBeenCalled()
    expect(result.diagnostics?.semanticUsed).toBe(false)
    expect(result.results[0]?.text).toContain('粪水')
  })

  it('reads catalog status directly without treating current wording as an effective-date filter', async () => {
    const { db, config, mock } = fixture()
    const result = await queryPolicies(new HybridQueryStore(db, config), '养殖污染治理条例目前标注的效力状态是什么？')
    expect(result.plan.filters.date).toBeUndefined()
    expect(result.results.length).toBeGreaterThan(0)
    expect(mock).not.toHaveBeenCalled()
  })

  it('keeps generic obligation questions out of exact title and document-list routes', () => {
    const options = { titleCatalog: ['中华人民共和国水污染防治法'] }
    const plan = planPolicyQuery('企业排放污水超过标准应当承担什么法律责任？', options)
    expect(plan.filters.title).toBeUndefined()
    expect(plan.filters.documentTypes).toEqual([])
    expect(plan.useExactRecall).toBe(false)
    expect(planPolicyQuery('养猪场粪污处理有哪些要求？', options).intent).toBe('lookup')
    const marine = planPolicyQuery('中华人民共和国海洋环境保护法第一条', {
      titleCatalog: ['中华人民共和国环境保护法', '中华人民共和国海洋环境保护法'],
    })
    expect(marine.filters.title).toBe('中华人民共和国海洋环境保护法')
  })

  it('reuses embeddings and hydrates code-point spans from authentic source text', async () => {
    const { db, config, mock, unit } = fixture()
    const store = new HybridQueryStore(db, config)
    const query = '养猪产生的污水怎样处理'
    const request = { query, plan: planPolicyQuery(query, { titleCatalog: [] }), limit: 8 }
    const first = await store.searchSemanticContent(request)
    await store.searchSemanticContent(request)
    expect(mock.mock.calls.filter(([url]) => url.endsWith('/v1/embeddings'))).toHaveLength(1)
    const text = Array.from(unit.text).slice(6).join('')
    expect(first.hits.find(hit => hit.text === text)?.text).toBe(text)
    expect(first.warnings).toEqual([])
  })

  it('rejects stale source hashes instead of attaching unrelated original text', async () => {
    const { db, config, metadata } = fixture()
    metadata.source_hash = 'stale'
    const query = '养猪污水处理'
    const result = await new HybridQueryStore(db, config).searchSemanticContent({ query, plan: planPolicyQuery(query), limit: 8 })
    expect(result.hits).toEqual([])
  })

  it('falls back to lexical evidence within the semantic timeout and retries failed embeddings', async () => {
    const { db, config } = fixture()
    const stalled = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>{  reject(new Error('semantic timeout')) }, { once: true })
    }))
    vi.stubGlobal('fetch', stalled)
    const store = new HybridQueryStore(db, config)
    const result = await queryPolicies(store, '粪水应当如何处理')
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.warnings.some(item => item.includes('semantic-unavailable'))).toBe(true)
    expect(result.diagnostics!.totalMs).toBeLessThan(500)
    await queryPolicies(store, '粪水应当如何处理')
    expect(stalled).toHaveBeenCalledTimes(2)
  })
})
