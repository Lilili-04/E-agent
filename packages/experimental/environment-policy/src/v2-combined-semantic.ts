/** Manifest-bound combined vectors; SQLite owns every returned source unit. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { PolicyV2Database } from './v2-database.ts'
import { object, questionVector, semanticJson, SemanticSettings, type SemanticResult } from './v2-semantic.ts'

const Manifest = z.object({
  complete: z.boolean().required(), build_id: z.string().required(), database_sha256: z.string().required(),
  model: z.string().required(), dimension: z.number().required(), normalization: z.string().required(),
  offset_unit: z.string().required(),
  metrics: z.object({ document: z.string().required(), passage: z.string().required() }).required(),
  collections: z.object({ document: z.string().required(), passage: z.string().required() }).required(),
})

/** Scope is applied independently to each region before nearest-neighbor selection. */
export interface SemanticScope { regions: readonly string[]; documentIds?: readonly string[] }

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const norm = (text: string) => text.replace(/\r\n/gu, '\n')

/** Query the combined corpus without legacy record mappings or storage writes. */
export class PolicyV2CombinedSemantic {
  private readonly config
  private readonly manifest

  constructor(private readonly database: PolicyV2Database, configPath: string, manifestPath: string, databasePath: string) {
    this.config = SemanticSettings(JSON.parse(readFileSync(configPath, 'utf8')) as Parameters<typeof SemanticSettings>[0])
    this.manifest = Manifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as Parameters<typeof Manifest>[0])
    const m = this.manifest
    if (!m.complete || m.database_sha256 !== hash(readFileSync(databasePath)) || m.dimension !== 2560 ||
      m.model !== this.config.model || m.collections.document !== this.config.documentCollection ||
      m.collections.passage !== this.config.passageCollection || m.metrics.document !== 'l2' ||
      m.metrics.passage !== 'cosine' || m.normalization !== 'l2-unit' || m.offset_unit !== 'unicode_code_point') {
      throw new Error('Combined vector manifest does not match SQLite, model, or collection configuration')
    }
  }

  private async nearest(kind: 'document' | 'passage', vector: number[], region: string, scope: SemanticScope, signal: AbortSignal) {
    const m = this.manifest
    if (scope.documentIds?.length === 0) return { documents: [], passages: [], rejected: 0 }
    const base = `${this.config.chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`
    const collection = await semanticJson(`${base}/${encodeURIComponent(m.collections[kind])}`, signal)
    if (!object(collection) || typeof collection.id !== 'string' || collection.dimension !== m.dimension ||
      !object(collection.metadata) || collection.metadata.build_id !== m.build_id ||
      collection.metadata.database_sha256 !== m.database_sha256 || collection.metadata.model !== m.model ||
      !object(collection.configuration_json) || !object(collection.configuration_json.hnsw) ||
      collection.configuration_json.hnsw.space !== m.metrics[kind]) throw new Error('Combined collection identity mismatch')
    const filters: object[] = [{ build_id: m.build_id }, { region }]
    if (scope.documentIds) filters.push({ document_id: { $in: scope.documentIds } })
    const reply = await semanticJson(`${base}/${collection.id}/query`, signal, {
      query_embeddings: [vector], n_results: kind === 'document' ? this.config.documentCandidates : this.config.passageCandidates,
      where: { $and: filters }, include: ['documents', 'metadatas', 'distances'],
    })
    if (!object(reply) || !Array.isArray(reply.metadatas) || !Array.isArray(reply.metadatas[0]) ||
      !Array.isArray(reply.documents) || !Array.isArray(reply.documents[0]) ||
      !Array.isArray(reply.distances) || !Array.isArray(reply.distances[0]) ||
      reply.documents[0].length !== reply.metadatas[0].length || reply.distances[0].length !== reply.metadatas[0].length) {
      throw new Error('Invalid combined Chroma response')
    }
    const texts: unknown[] = reply.documents[0]
    const distances: unknown[] = reply.distances[0]
    const metas: unknown[] = reply.metadatas[0]
    const result: SemanticResult = { documents: [], passages: [], warnings: [], rejected: 0 }
    for (const [index, meta] of metas.entries()) {
      const text = texts[index], distance = distances[index]
      if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < -1e-6 ||
        distance > (kind === 'document' ? this.config.documentMaxDistance : this.config.maxDistance)) continue
      const doc = object(meta) && typeof meta.document_id === 'string' ? this.database.document(meta.document_id) : undefined
      if (!object(meta) || !doc || typeof text !== 'string' || meta.build_id !== m.build_id ||
        meta.source_hash !== doc.source_hash || meta.region !== doc.region || doc.region !== region ||
        (scope.documentIds && !scope.documentIds.includes(doc.id)) || meta.embedding_text_hash !== hash(text)) {
        result.rejected++; continue
      }
      if (kind === 'document') {
        if (text !== `标题：${doc.title}\n内容概述：${doc.description}`) { result.rejected++; continue }
        result.documents.push(doc); continue
      }
      const { sequence_start: start, sequence_end: end, text_start: from, text_end: to } = meta
      if (typeof start !== 'number' || typeof end !== 'number' || typeof from !== 'number' || typeof to !== 'number' ||
        ![start, end, from, to].every(Number.isSafeInteger) || start < 0 || end < start || from < 0 || to <= from ||
        typeof meta.unit_ids !== 'string') { result.rejected++; continue }
      const units = this.database.atSequence(doc.id, start, end)
      let unitIds: unknown
      try { unitIds = JSON.parse(meta.unit_ids) }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; result.rejected++; continue }
      const joined = Array.from(units.map(unit => norm(unit.text)).join(''))
      const marker = text.indexOf('\n正文：')
      if (!units.length || to > joined.length || marker < 0 ||
        JSON.stringify(units.map(unit => unit.id)) !== JSON.stringify(unitIds) ||
        norm(text.slice(marker + '\n正文：'.length)) !== joined.slice(from, to).join('')) {
        result.rejected++; continue
      }
      // Return original structural units so policy_read can recover context unchanged.
      result.passages.push(...units)
    }
    return result
  }

  /** Embed once, query each region and collection independently, and preserve partial failures.
   * @param question - Original user question.
   * @param target - File discovery or original evidence.
   * @param signal - Caller cancellation.
   * @param scope - Allowed regions and optional exact versions.
   * @returns Source-validated candidates; failed channels are reported as warnings.
   */
  async search(
    question: string, target: 'documents' | 'passages', signal: AbortSignal | undefined, scope: SemanticScope,
  ): Promise<SemanticResult> {
    const result: SemanticResult = { documents: [], passages: [], warnings: [], rejected: 0 }
    signal?.throwIfAborted()
    if (scope.documentIds?.length === 0) return result
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const vector = await questionVector(this.config, question, deadline)
      const kinds = target === 'documents' ? ['document'] as const : ['document', 'passage'] as const
      const jobs = kinds.flatMap(kind => scope.regions.map(region => ({ kind, region })))
      const channels = await Promise.allSettled(jobs.map(job => this.nearest(job.kind, vector, job.region, scope, deadline)))
      for (const [index, channel] of channels.entries()) {
        if (channel.status === 'rejected') {
          const job = jobs[index]
          result.warnings.push(`semantic_${job?.kind}_${job?.region}: ${String(channel.reason)}`); continue
        }
        result.documents.push(...channel.value.documents)
        result.passages.push(...channel.value.passages)
        result.rejected += channel.value.rejected
      }
      signal?.throwIfAborted()
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      result.warnings.push(`semantic_unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    return result
  }
}
