import { performance } from 'node:perf_hooks'
import type { PolicyDatabase } from './database.ts'
import { queryCandidate, SqliteQueryStore } from './query-store.ts'
import type { PolicyCandidate, PolicySemanticRecall, PolicyTextSearchRequest } from './query.ts'
import type { PolicyDataRelease } from './release.ts'

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
  /** Required embedding weights revision when using a versioned data release. */
  modelRevision?: string
  /** Expected passage splitter version when using a versioned data release. */
  chunkVersion?: string
  /** Optional validated manifest selecting both indexes with the SQLite snapshot. */
  release?: PolicyDataRelease
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Last observed semantic compatibility or query outcome; metadata checks do not test model inference. */
export interface PolicySemanticStatus {
  readonly state: 'unverified' | 'ready' | 'degraded'
  readonly warnings: readonly string[]
  readonly verifiedBy: 'none' | 'metadata' | 'query'
}

/** Combine lexical source retrieval with cached document and passage vector recall. */
export class HybridQueryStore extends SqliteQueryStore {
  private readonly config: HybridConfig
  private readonly embeddingCache = new Map<string, Promise<readonly number[]>>()
  private readonly collections = new Map<string, { id: string; space: 'cosine' | 'l2' }>()
  private status: PolicySemanticStatus = { state: 'unverified', warnings: [], verifiedBy: 'none' }

  constructor(database: PolicyDatabase, config: HybridConfig) {
    super(database)
    this.config = config
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
        model: this.config.release?.model ?? this.config.model, encoding_format: 'float',
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

  /** @returns the last observed semantic state; reading health never calls a model. */
  semanticStatus(): PolicySemanticStatus {
    return this.status
  }

  private async collection(name: string, signal: AbortSignal) {
    const prefix = `${this.config.chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`
    let collection = this.collections.get(name)
    if (collection === undefined) {
      const value = await this.json(`${prefix}/${encodeURIComponent(name)}`, signal)
      if (!record(value) || typeof value.id !== 'string' || value.dimension !== 2560 || !record(value.metadata)
        || value.metadata.build_id !== this.database.getManifest()?.buildId) throw new Error('vector collection build mismatch')
      const modelRevision = this.config.release?.modelRevision ?? this.config.modelRevision
      const chunkVersion = this.config.release?.chunkVersion ?? this.config.chunkVersion
      if (value.metadata.model !== undefined && value.metadata.model !== (this.config.release?.model ?? this.config.model)) {
        throw new Error('vector collection model mismatch')
      }
      if (modelRevision !== undefined && value.metadata.model_revision !== modelRevision) throw new Error('vector collection model revision mismatch')
      if (name === this.config.passageCollection && chunkVersion !== undefined
        && value.metadata.chunk_version !== chunkVersion) throw new Error('vector collection chunk version mismatch')
      const configuration = value.configuration_json
      const space = record(configuration) && record(configuration.hnsw) ? configuration.hnsw.space : undefined
      if (space !== 'cosine' && space !== 'l2') throw new Error('unsupported vector distance metric')
      if (name === this.config.passageCollection && space !== 'cosine') throw new Error('passage collection must use cosine distance')
      if (this.config.release !== undefined) {
        const release = this.config.release
        const expected = name === this.config.documentCollection ? release.documents : release.passages
        if (expected.collection !== name || expected.metric !== space || value.metadata.model !== release.model
          || value.metadata.corpus_hash !== release.corpusHash
          || value.metadata.input_version !== expected.inputVersion) throw new Error('vector collection release mismatch')
        if (value.metadata.query_instruction_version !== release.queryInstructionVersion) throw new Error('vector query instruction mismatch')
        const count = await this.json(`${prefix}/${value.id}/count`, signal)
        if (count !== expected.count) throw new Error('vector collection is incomplete')
      }
      collection = { id: value.id, space }
      this.collections.set(name, collection)
    }
    return collection
  }

  /**
   * Validate configured collections without running an embedding query.
   * @returns current collection compatibility, with bounded failures reported as degradation.
   */
  async inspectIndexes(): Promise<PolicySemanticStatus> {
    const signal = AbortSignal.timeout(this.config.timeoutMs)
    this.collections.clear()
    const checked = await Promise.allSettled([this.config.documentCollection, this.config.passageCollection]
      .filter((name): name is string => name !== undefined).map(name => this.collection(name, signal)))
    const warnings = checked.flatMap(result => result.status === 'fulfilled' ? [] : [String(result.reason)])
    this.status = { state: warnings.length ? 'degraded' : 'ready', warnings, verifiedBy: 'metadata' }
    return this.status
  }

  private async nearest(name: string, vector: readonly number[], count: number, signal: AbortSignal) {
    const prefix = `${this.config.chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`
    const collection = await this.collection(name, signal)
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
      if (name === this.config.passageCollection && (typeof item.unit_id !== 'string'
        || typeof item.start !== 'number' || typeof item.end !== 'number')) throw new Error('invalid passage source address')
      return [{ recordKey: item.record_key, unitId: typeof item.unit_id === 'string' ? item.unit_id : undefined,
        sourceHash: item.source_hash,
        start: typeof item.start === 'number' ? item.start : 0, end: typeof item.end === 'number' ? item.end : undefined,
        distance, rank: index + 1 }]
    })
  }

  /**
   * Recall source addresses from document and passage indexes within one semantic deadline.
   * @param request - original question, deterministic plan and candidate bound.
   * @returns candidates without citation text; one failed collection does not discard the other.
   */
  async searchSemanticContent(request: PolicyTextSearchRequest): Promise<PolicySemanticRecall> {
    const started = performance.now()
    const signal = AbortSignal.timeout(this.config.timeoutMs)
    try {
      const vector = await this.embedding(request.query, signal)
      const recalled = await Promise.allSettled([
        this.nearest(this.config.documentCollection, vector, this.config.documentCandidates, signal),
        this.config.passageCollection === undefined ? Promise.resolve([])
          : this.nearest(this.config.passageCollection, vector, this.config.passageCandidates, signal),
      ])
      const warnings = recalled.flatMap(result => result.status === 'fulfilled' ? [] : [`semantic-unavailable: ${String(result.reason)}`])
      const [documentResult, passageResult] = recalled
      const documents = documentResult.status === 'fulfilled' ? documentResult.value : []
      const passages = passageResult.status === 'fulfilled' ? passageResult.value : []
      const recordKeys = [...new Set(documents.map(item => item.recordKey))]
      const docUnits = recordKeys.length === 0 ? []
        : this.database.searchContent(request.plan.freeText, { recordKeys, limit: request.limit })
      const docRanks = new Map(documents.map(item => [item.recordKey, item]))
      const candidates: PolicyCandidate[] = docUnits.flatMap((row) => {
        const document = docRanks.get(row.recordKey)
        return document === undefined ? [] : [{ ...queryCandidate(row),
          sourceHash: document.sourceHash, score: 100 / (60 + document.rank) }]
      })
      for (const item of passages) {
        if (item.unitId === undefined) continue
        candidates.push({ recordKey: item.recordKey, unitId: item.unitId, sourceHash: item.sourceHash,
          start: item.start, ...(item.end === undefined ? {} : { end: item.end }), score: 100 / (60 + item.rank) })
      }
      this.status = { state: warnings.length ? 'degraded' : 'ready', warnings, verifiedBy: 'query' }
      return { candidates: candidates.sort((a, b) => b.score - a.score), warnings, elapsedMs: Math.round(performance.now() - started) }
    } catch (error) {
      const warnings = [`semantic-unavailable: ${error instanceof Error ? error.message : String(error)}`]
      this.status = { state: 'degraded', warnings, verifiedBy: 'query' }
      return { candidates: [], warnings, elapsedMs: Math.round(performance.now() - started) }
    }
  }
}
