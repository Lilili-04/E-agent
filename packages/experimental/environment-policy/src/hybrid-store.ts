import { performance } from 'node:perf_hooks'
import type { PolicyDatabase } from './database.ts'
import { queryHit, SqliteQueryStore } from './query-store.ts'
import type { PolicySemanticRecall, PolicyTextSearchRequest } from './query.ts'

/** Deployment settings for DGX semantic recall; collections belong to one SQLite build. */
export interface HybridConfig {
  embeddingUrl: string
  chromaUrl: string
  model: string
  documentCollection: string
  passageCollection?: string
  timeoutMs: number
  documentCandidates: number
  passageCandidates: number
  maxDistance: number
  documentMaxDistance: number
  cacheEntries: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Combine lexical source retrieval with cached document and passage vector recall. */
export class HybridQueryStore extends SqliteQueryStore {
  private readonly config: HybridConfig
  private readonly embeddingCache = new Map<string, Promise<readonly number[]>>()
  private readonly collections = new Map<string, { id: string; space: 'cosine' | 'l2' }>()
  private readonly sourceHashes: Map<string, string>

  constructor(database: PolicyDatabase, config: HybridConfig) {
    super(database)
    this.config = config
    this.sourceHashes = new Map(database.findSourcesByExact({}, 1000).map(row => [row.recordKey, row.sourceHash]))
  }

  private async json(url: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await fetch(url, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: { 'content-type': 'application/json' }, signal, redirect: 'error',
    })
    if (!response.ok) throw new Error(`semantic endpoint HTTP ${response.status}`)
    return await response.json()
  }

  private async embedding(question: string, signal: AbortSignal): Promise<readonly number[]> {
    const cached = this.embeddingCache.get(question)
    if (cached !== undefined) return await cached
    const pending = (async () => {
      const body = await this.json(`${this.config.embeddingUrl}/v1/embeddings`, signal, {
        model: this.config.model, encoding_format: 'float',
        input: `Instruct: Retrieve Chinese environmental policy documents and passages relevant to the question.\nQuery: ${question}`,
      })
      if (!record(body) || !Array.isArray(body.data) || !record(body.data[0]) || !Array.isArray(body.data[0].embedding)) throw new Error('invalid embedding response')
      const vector: unknown[] = body.data[0].embedding
      if (vector.length !== 2560 || !vector.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) throw new Error('incompatible embedding dimension')
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
      if (norm === 0) throw new Error('zero embedding')
      return vector.map(value => value / norm)
    })()
    this.embeddingCache.set(question, pending)
    if (this.embeddingCache.size > this.config.cacheEntries) {
      const first = this.embeddingCache.keys().next().value
      if (first !== undefined) this.embeddingCache.delete(first)
    }
    try { return await pending } catch (error) { this.embeddingCache.delete(question); throw error }
  }

  private async nearest(name: string, vector: readonly number[], count: number, signal: AbortSignal) {
    const prefix = `${this.config.chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`
    let collection = this.collections.get(name)
    if (collection === undefined) {
      const value = await this.json(`${prefix}/${encodeURIComponent(name)}`, signal)
      if (!record(value) || typeof value.id !== 'string' || value.dimension !== 2560 || !record(value.metadata)
        || value.metadata.build_id !== this.database.getManifest()?.buildId) throw new Error('vector collection build mismatch')
      const configuration = value.configuration_json
      const space = record(configuration) && record(configuration.hnsw) ? configuration.hnsw.space : undefined
      if (space !== 'cosine' && space !== 'l2') throw new Error('unsupported vector distance metric')
      if (name === this.config.passageCollection && space !== 'cosine') throw new Error('passage collection must use cosine distance')
      collection = { id: value.id, space }
      this.collections.set(name, collection)
    }
    const value = await this.json(`${prefix}/${collection.id}/query`, signal, {
      query_embeddings: [vector], n_results: count, include: ['metadatas', 'distances'],
      where: { build_id: this.database.getManifest()?.buildId },
    })
    if (!record(value) || !Array.isArray(value.metadatas) || !Array.isArray(value.metadatas[0])
      || !Array.isArray(value.distances) || !Array.isArray(value.distances[0])) throw new Error('invalid Chroma response')
    const distances: unknown[] = value.distances[0]
    const metadata: unknown[] = value.metadatas[0]
    return metadata.flatMap((item, index) => {
      const distance = distances[index]
      const maximum = name === this.config.documentCollection ? this.config.documentMaxDistance : this.config.maxDistance
      if (!record(item) || typeof item.record_key !== 'string' || typeof item.source_hash !== 'string'
        || typeof distance !== 'number' || !Number.isFinite(distance) || distance > maximum
        || item.build_id !== this.database.getManifest()?.buildId) return []
      return [{ recordKey: item.record_key, unitId: typeof item.unit_id === 'string' ? item.unit_id : undefined,
        sourceHash: item.source_hash,
        start: typeof item.start === 'number' ? item.start : 0, end: typeof item.end === 'number' ? item.end : undefined,
        distance, rank: index + 1 }]
    })
  }

  async searchSemanticContent(request: PolicyTextSearchRequest): Promise<PolicySemanticRecall> {
    const started = performance.now()
    const signal = AbortSignal.timeout(this.config.timeoutMs)
    try {
      const vector = await this.embedding(request.query, signal)
      const [documents, passages] = await Promise.all([
        this.nearest(this.config.documentCollection, vector, this.config.documentCandidates, signal),
        this.config.passageCollection === undefined ? Promise.resolve([])
          : this.nearest(this.config.passageCollection, vector, this.config.passageCandidates, signal),
      ])
      const validDocuments = documents.filter(item => this.sourceHashes.get(item.recordKey) === item.sourceHash)
      const recordKeys = [...new Set(validDocuments.map(item => item.recordKey))]
      const docUnits = recordKeys.length === 0 ? []
        : this.database.searchContent(request.plan.freeText, { recordKeys, limit: request.limit })
      const docRanks = new Map(validDocuments.map(item => [item.recordKey, item.rank]))
      const hits = docUnits.map(row => ({ ...queryHit(row), score: 100 / (60 + (docRanks.get(row.recordKey) ?? 60)) }))
      for (const item of passages) {
        if (item.unitId === undefined) continue
        const row = this.database.readUnitsById([{ recordKey: item.recordKey, unitId: item.unitId }])[0]
        if (row === undefined || row.sourceHash !== item.sourceHash) continue
        // Builder offsets count Unicode code points, including supplementary characters.
        const characters = Array.from(row.text)
        if (!Number.isInteger(item.start) || item.start < 0 || item.start >= characters.length
          || item.end !== undefined && (!Number.isInteger(item.end) || item.end <= item.start || item.end > characters.length)) continue
        const text = characters.slice(item.start, item.end).join('')
        const prefix = characters.slice(0, item.start).join('')
        hits.push({ ...queryHit(row), text, score: 100 / (60 + item.rank),
          lineStart: row.lineStart + prefix.split('\n').length - 1,
          lineEnd: row.lineStart + (prefix + text).split('\n').length - 1 })
      }
      const uniqueHits = [...hits.reduce((map, hit) => {
        const key = `${hit.recordKey}:${hit.unitId}`
        const previous = map.get(key)
        if (previous === undefined || hit.score > previous.score
          || hit.text.length < previous.text.length && previous.text.includes(hit.text)) map.set(key, hit)
        return map
      }, new Map<string, typeof hits[number]>()).values()].sort((a, b) => b.score - a.score)
      return { hits: uniqueHits, warnings: [], elapsedMs: Math.round(performance.now() - started) }
    } catch (error) {
      return { hits: [], warnings: [`semantic-unavailable: ${error instanceof Error ? error.message : String(error)}`], elapsedMs: Math.round(performance.now() - started) }
    }
  }
}
