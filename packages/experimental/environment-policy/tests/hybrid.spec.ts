import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PolicyDatabase, type PolicyImportDocument } from '../src/database.ts'
import { HybridQueryStore, type HybridConfig } from '../src/hybrid-store.ts'
import { parsePolicyMarkdown } from '../src/parse.ts'
import { planPolicyQuery, queryPolicies, type PolicyCandidate } from '../src/query.ts'

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
    expect(first.candidates.every(candidate => !('text' in candidate))).toBe(true)
    const evidence = await store.readEvidence(first.candidates)
    expect(evidence.resolved.find(({ hit }) => hit.text === text)?.hit.text).toBe(text)
    expect(first.warnings).toEqual([])
  })

  it('rejects stale source hashes instead of attaching unrelated original text', async () => {
    const { db, config, metadata } = fixture()
    metadata.source_hash = 'stale'
    const query = '养猪污水处理'
    const store = new HybridQueryStore(db, config)
    const result = await store.searchSemanticContent({ query, plan: planPolicyQuery(query), limit: 8 })
    const evidence = await store.readEvidence(result.candidates)
    expect(evidence.resolved).toEqual([])
    expect(evidence.rejected.sourceMismatch).toBeGreaterThan(0)
  })

  it('counts stale document-vector associations when no passage collection is configured', async () => {
    const { db, config, metadata } = fixture()
    metadata.source_hash = 'old-document-source'
    const { passageCollection: _passages, ...documentOnly } = config
    const result = await queryPolicies(new HybridQueryStore(db, documentOnly), '粪水如何处理')
    expect(result.diagnostics?.rejected.sourceMismatch).toBeGreaterThan(0)
    expect(result.warnings).toContain('candidate-source-association-rejected')
    expect(result.results.length).toBeGreaterThan(0)
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

  it('reads repeated span addresses in one batch and rejects stale, missing and invalid associations', async () => {
    const { db, config, unit, metadata } = fixture()
    const store = new HybridQueryStore(db, config)
    const batch = vi.spyOn(db, 'readUnitsById')
    const perUnit = vi.spyOn(db, 'readContentUnits')
    const candidate: PolicyCandidate = { recordKey: unit.recordKey, unitId: unit.unitId, sourceHash: unit.sourceHash, score: 1 }
    const result = await store.readEvidence([
      candidate, { ...candidate, start: metadata.start, end: metadata.end },
      { ...candidate, sourceHash: 'old-source' }, { ...candidate, unitId: 'missing' }, { ...candidate, start: -1 },
    ])
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0]?.[0]).toHaveLength(2)
    expect(perUnit).not.toHaveBeenCalled()
    expect(result.resolved).toHaveLength(2)
    expect(result.resolved[1]?.hit.text).toBe(Array.from(unit.text).slice(metadata.start).join(''))
    expect(result.rejected).toEqual({ missingUnit: 1, sourceMismatch: 1, invalidSpan: 1 })
  })

  it('keeps valid candidates beyond the first 100 addresses', async () => {
    const { db, config, unit } = fixture()
    const store = new HybridQueryStore(db, config)
    const candidate = { recordKey: unit.recordKey, unitId: unit.unitId, sourceHash: unit.sourceHash, score: 1 }
    const batch = vi.spyOn(db, 'readUnitsById')
    const result = await store.readEvidence([...Array.from({ length: 100 }, (_, index) => ({ ...candidate, unitId: `missing-${index}` })), candidate])
    expect(batch).toHaveBeenCalledTimes(2)
    expect(result.resolved[0]?.hit.text).toBe(unit.text)
    expect(result.rejected.missingUnit).toBe(100)
  })

  it('retains a working passage index when document recall fails', async () => {
    const { db, config, mock, unit } = fixture()
    const original = mock.getMockImplementation()!
    mock.mockImplementation(async url => url.includes('documents-id/query') ? new Response('', { status: 503 }) : original(url))
    const store = new HybridQueryStore(db, config)
    const question = '养猪产生的污水怎样处理'
    const recalled = await store.searchSemanticContent({ query: question, plan: planPolicyQuery(question), limit: 8 })
    expect(recalled.candidates).toHaveLength(1)
    const result = await store.readEvidence(recalled.candidates)
    expect(result.resolved[0]?.hit.unitId).toBe(unit.unitId)
    expect(recalled.warnings[0]).toContain('503')
    expect(store.semanticStatus().state).toBe('degraded')
  })

  it('checks configured model revisions without querying the GPU', async () => {
    const { db, config, mock } = fixture()
    const store = new HybridQueryStore(db, { ...config, modelRevision: 'pinned-weights-revision' })
    expect(store.semanticStatus().state).toBe('unverified')
    expect((await store.inspectIndexes()).state).toBe('degraded')
    expect(mock.mock.calls.every(([url]) => !url.endsWith('/v1/embeddings'))).toBe(true)
    expect(store.semanticStatus().warnings.every(warning => warning.includes('model revision mismatch'))).toBe(true)
  })

  it('checks release fingerprints and collection counts before using a versioned index', async () => {
    const { db, config, mock } = fixture()
    const manifest = db.getManifest()!
    const release = { formatVersion: 1 as const, databaseFile: 'snapshot.sqlite', buildId: manifest.buildId,
      corpusHash: manifest.corpusHash, model: config.model, modelRevision: 'weights-a', dimension: 2560 as const,
      queryInstructionVersion: 'environment-policy-query-v1' as const, chunkVersion: 'chars1200-overlap120-v1',
      documents: { collection: 'documents', count: 1, metric: 'l2' as const, inputVersion: 'document-v1' },
      passages: { collection: 'passages', count: 1, metric: 'cosine' as const, inputVersion: 'passage-v1' } }
    const original = mock.getMockImplementation()!
    let count = 1
    mock.mockImplementation(async (url) => {
      if (url.endsWith('/count')) return Response.json(count)
      if (url.endsWith('/query') || url.endsWith('/v1/embeddings')) return await original(url)
      const passage = url.endsWith('/passages')
      return Response.json({ id: passage ? 'passages-id' : 'documents-id', dimension: 2560,
        configuration_json: { hnsw: { space: passage ? 'cosine' : 'l2' } },
        metadata: { build_id: manifest.buildId, corpus_hash: release.corpusHash, model: config.model,
          input_version: passage ? 'passage-v1' : 'document-v1', model_revision: 'weights-a',
          query_instruction_version: release.queryInstructionVersion, chunk_version: release.chunkVersion } })
    })
    const store = new HybridQueryStore(db, { ...config, release, modelRevision: release.modelRevision, chunkVersion: release.chunkVersion })
    expect((await store.inspectIndexes()).state).toBe('ready')
    count = 0
    expect((await store.inspectIndexes()).warnings.every(warning => warning.includes('incomplete'))).toBe(true)
    expect(mock.mock.calls.every(([url]) => !url.endsWith('/v1/embeddings'))).toBe(true)
  })

  it('reports rejected vector associations while keeping authentic lexical evidence', async () => {
    const { db, config, metadata } = fixture()
    metadata.unit_id = 'removed-unit'
    const result = await queryPolicies(new HybridQueryStore(db, config), '粪水如何处理')
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.diagnostics?.rejected.missingUnit).toBe(1)
    expect(result.warnings).toContain('candidate-source-association-rejected')
    expect(result.results.every(hit => hit.text.includes('粪水'))).toBe(true)
  })

  it('counts a unit only once per semantic channel and uses source text instead of Chroma document copies', async () => {
    const { db, config, mock, metadata } = fixture()
    const original = mock.getMockImplementation()!
    mock.mockImplementation(async (url) => {
      if (!url.endsWith('/query')) return await original(url)
      return Response.json({ metadatas: [[metadata]], distances: [[url.includes('documents-id') ? 0.5 : 0.2]],
        documents: [['伪造正文，不得引用']] })
    })
    const result = await queryPolicies(new HybridQueryStore(db, config), '粪水如何处理')
    expect(result.results.every(hit => !hit.text.includes('伪造正文'))).toBe(true)
    expect(result.results[0]?.score).toBeLessThanOrEqual(2 / 61)
    expect(result.diagnostics?.uniqueUnitCount).toBeGreaterThan(0)
  })
})
