/** Shared embedding/HTTP helpers and source-verified compatibility with legacy DGX vectors. */
import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { PolicyV2Database, type DocumentCard, type Passage } from './v2-database.ts'

/** Validated embedding and collection query configuration. */
export const SemanticSettings = z.object({
  embeddingUrl: z.string().required(),
  chromaUrl: z.string().required(),
  model: z.string().required(),
  documentCollection: z.string().required(),
  passageCollection: z.string().required(),
  timeoutMs: z.number().min(100).default(5000),
  embeddingRetries: z.number().step(1).min(0).max(3).default(1),
  documentCandidates: z.number().min(1).default(12),
  passageCandidates: z.number().min(1).default(32),
  documentMaxDistance: z.number().default(0.9),
  maxDistance: z.number().default(0.45),
})
const Compatibility = z.object({
  legacy_build_id: z.string().required(),
  documents: z.dict(z.object({ document_id: z.string().required(), source_hash: z.string().required() })).required(),
  units: z.dict(z.object({
    unit_id: z.string().required(), record_key: z.string().required(), line_start: z.number().required(),
    line_end: z.number().required(), text: z.string().required(),
  })).required(),
})

/** Narrow decoded JSON to an object whose fields can be validated.
 * @param value - Decoded JSON value.
 * @returns Whether the value is a non-array object.
 */
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validated semantic candidates plus explicit partial-failure diagnostics. */
export interface SemanticResult {
  documents: DocumentCard[]
  passages: Passage[]
  warnings: string[]
  rejected: number
}

/** Read a JSON response; redirects and non-success status codes reject.
 * @param url - Configured read or embedding endpoint.
 * @param signal - Shared cancellation and deadline.
 * @param body - Optional read-only POST input.
 * @returns Decoded untrusted JSON.
 */
export async function semanticJson(url: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(url, { signal, redirect: 'error', headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  if (!response.ok) throw new Error(`Semantic HTTP ${response.status}`)
  return await response.json()
}


/** Embed one unchanged question with the corpus query instruction and unit normalization.
 * @param config - Embedding endpoint and model.
 * @param question - Original complete question.
 * @param deadline - Shared cancellation and timeout.
 * @returns A finite unit vector with the corpus dimension.
 */
export async function questionVector(
  config: { embeddingUrl: string; model: string; embeddingRetries: number },
  question: string, deadline: AbortSignal,
): Promise<number[]> {
  let embedding: unknown
  for (let attempt = 0; ; attempt++) {
    try {
      embedding = await semanticJson(`${config.embeddingUrl}/v1/embeddings`, deadline, {
        model: config.model,
        input: `Instruct: Retrieve Chinese environmental policy documents and passages relevant to the question.\nQuery: ${question}`,
        encoding_format: 'float',
      })
      break
    } catch (error) {
      if (deadline.aborted || !(error instanceof TypeError) || attempt >= config.embeddingRetries) throw error
    }
  }
  if (!object(embedding) || !Array.isArray(embedding.data) || !object(embedding.data[0]) || !Array.isArray(embedding.data[0].embedding)) throw new Error('Invalid embedding response')
  const values: unknown[] = embedding.data[0].embedding
  if (values.length !== 2560 || !values.every((v): v is number => typeof v === 'number' && Number.isFinite(v))) throw new Error('Embedding dimension mismatch')
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0))
  if (!norm) throw new Error('Zero embedding')
  return values.map(v => v / norm)
}

/** Existing collections remain unchanged; only mapped, source-identical hits are accepted. */
export class PolicyV2Semantic {
  private readonly config
  private readonly compatibility
  private readonly collections = new Map<string, string>()

  constructor(private readonly database: PolicyV2Database, configPath: string, compatibilityPath: string) {
    this.config = SemanticSettings(JSON.parse(readFileSync(configPath, 'utf8')) as Parameters<typeof SemanticSettings>[0])
    this.compatibility = Compatibility(JSON.parse(readFileSync(compatibilityPath, 'utf8')) as Parameters<typeof Compatibility>[0])
  }


  private async nearest(name: string, vector: number[], count: number, signal: AbortSignal) {
    const base = `${this.config.chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`
    let id = this.collections.get(name)
    if (!id) {
      const collection = await semanticJson(`${base}/${encodeURIComponent(name)}`, signal)
      if (!object(collection) || typeof collection.id !== 'string' || collection.dimension !== vector.length ||
        !object(collection.metadata) || collection.metadata.build_id !== this.compatibility.legacy_build_id ||
        (collection.metadata.model !== undefined && collection.metadata.model !== this.config.model)) throw new Error('Legacy vector collection identity mismatch')
      id = collection.id; this.collections.set(name, id)
    }
    const reply = await semanticJson(`${base}/${id}/query`, signal, { query_embeddings: [vector], n_results: count,
      include: ['metadatas', 'distances'], where: { build_id: this.compatibility.legacy_build_id } })
    if (!object(reply) || !Array.isArray(reply.metadatas) || !Array.isArray(reply.metadatas[0]) ||
      !Array.isArray(reply.distances) || !Array.isArray(reply.distances[0])) throw new Error('Invalid Chroma response')
    const distances: unknown[] = reply.distances[0]
    const metadata: unknown[] = reply.metadatas[0]
    return metadata.flatMap((meta, index) => {
      const distance = distances[index]
      if (!object(meta) || typeof distance !== 'number' || !Number.isFinite(distance)) return []
      return [{ meta, distance }]
    })
  }

  /** Execute one embedding and parallel collection searches; no collection is created or updated.
   * @param question - Original user query.
   * @param target - Document discovery or evidence retrieval.
   * @param signal - Caller cancellation.
   * @returns Only candidates that can be traced to unchanged local source text.
   */
  async search(question: string, target: 'documents' | 'passages', signal?: AbortSignal): Promise<SemanticResult> {
    const result: SemanticResult = { documents: [], passages: [], warnings: [], rejected: 0 }
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const vector = await questionVector(this.config, question, deadline)
      const channels = await Promise.allSettled([
        this.nearest(this.config.documentCollection, vector, this.config.documentCandidates, deadline),
        target === 'passages' ? this.nearest(this.config.passageCollection, vector, this.config.passageCandidates, deadline) : Promise.resolve([]),
      ])
      for (const [index, channel] of channels.entries()) {
        if (channel.status === 'rejected') { result.warnings.push(`semantic_channel_${index}: ${String(channel.reason)}`); continue }
        for (const { meta, distance } of channel.value) {
          if (distance > (index === 0 ? this.config.documentMaxDistance : this.config.maxDistance)) continue
          const key = typeof meta.record_key === 'string' ? meta.record_key : ''
          const mapped = this.compatibility.documents[key]
          const doc = mapped ? this.database.document(mapped.document_id) : undefined
          if (!doc || !mapped || doc.source_hash !== meta.source_hash || doc.source_hash !== mapped.source_hash ||
            meta.build_id !== this.compatibility.legacy_build_id) { result.rejected++; continue }
          if (index === 0) { result.documents.push(doc); continue }
          const old = typeof meta.unit_id === 'string' ? this.compatibility.units[meta.unit_id] : undefined
          if (!old || old.record_key !== key || typeof meta.start !== 'number' || typeof meta.end !== 'number' ||
            !Number.isInteger(meta.start) || !Number.isInteger(meta.end) || meta.start < 0 || meta.end <= meta.start
            || meta.end > Array.from(old.text).length) {
            result.rejected++; continue
          }
          const units = this.database.atLines(doc.id, old.line_start, old.line_end)
          const original = units.map(unit => unit.text).join('').replace(/\r\n/gu, '\n')
          const snippet = Array.from(old.text).slice(meta.start, meta.end).join('').replace(/\r\n/gu, '\n')
          if (!original.includes(snippet)) { result.rejected++; continue }
          result.passages.push(...units)
        }
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      result.warnings.push(`semantic_unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    return result
  }
}
