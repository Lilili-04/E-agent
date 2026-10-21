/** Local v2 provider; DGX remains the embedding/vector/model host. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { canonical, PolicyV2Database, type DocumentCard, type Passage, type PolicyV2ReadRequest, type PolicyV2ReadResult } from './v2-database.ts'
import { PolicyV2Semantic } from './v2-semantic.ts'

/** Local database and optional read-only legacy vector connection. */
export interface Config {
  path: string
  semanticConfigPath?: string
  compatibilityPath?: string
  candidateLimit?: number
  resultLimit?: number
  pageCharacters?: number
  evidenceCharacters?: number
}
/** Validated Loader settings. */
export const Config: z<Config> = z.object({
  path: z.string().required(), semanticConfigPath: z.string(), compatibilityPath: z.string(),
  candidateLimit: z.number().step(1).min(1).max(500).default(60),
  resultLimit: z.number().step(1).min(1).max(30).default(8),
  pageCharacters: z.number().step(1).min(200).max(50000).default(12000),
  evidenceCharacters: z.number().step(1).min(1000).max(50000).default(12000),
})

/** Search chooses candidates; reading chooses original-source ranges. */
export interface PolicyV2SearchRequest {
  question: string
  target?: 'auto' | 'documents' | 'passages'
  document_id?: string
  region?: string
}

/** Explicit route and per-channel counts support local evaluation. */
export interface PolicyV2SearchResult {
  target: 'documents' | 'passages'
  route: string
  documents: DocumentCard[]
  passages: Passage[]
  requires_full_read: boolean
  diagnostics: {
    lexical: number
    semantic_documents: number
    semantic_passages: number
    rejected_vectors: number
    elapsed_ms: number
    warnings: string[]
  }
}

/** Source retrieval capability implemented by local SQLite and remote HTTP providers. */
export interface PolicyV2Knowledge {
  /** Retrieve candidates.
   * @param request - Original query and optional scope.
   * @param signal - Caller cancellation.
   * @returns Source-backed candidates.
   */
  search(request: PolicyV2SearchRequest, signal?: AbortSignal): Promise<PolicyV2SearchResult>
  /** Read one consecutive original page.
   * @param request - Fixed version, range and continuation.
   * @param signal - Caller cancellation.
   * @returns Original source page, synchronously or over HTTP.
   */
  read(request: PolicyV2ReadRequest, signal?: AbortSignal): PolicyV2ReadResult | Promise<PolicyV2ReadResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context { environmentPolicyV2: PolicyV2Knowledge }
}

/** A provider scoped to one preset; no database writes occur during questions. */
export default class PolicyV2Service extends Service {
  static Config = Config
  /** Provider-owned read-only snapshot, exposed for offline evaluation. */
  readonly database: PolicyV2Database
  private readonly semantic?: PolicyV2Semantic
  private readonly settings: Required<Pick<Config, 'candidateLimit' | 'resultLimit' | 'pageCharacters' | 'evidenceCharacters'>>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'environmentPolicyV2')
    if (!!config.semanticConfigPath !== !!config.compatibilityPath) throw new Error('Provide semanticConfigPath and compatibilityPath together')
    this.database = new PolicyV2Database(config.path)
    ctx.effect(() => () => { this.database.close() }, 'policyV2.close')
    this.settings = { candidateLimit: config.candidateLimit ?? 60, resultLimit: config.resultLimit ?? 8,
      pageCharacters: config.pageCharacters ?? 12000, evidenceCharacters: config.evidenceCharacters ?? 12000 }
    if (config.semanticConfigPath && config.compatibilityPath) {
      this.semantic = new PolicyV2Semantic(this.database, config.semanticConfigPath, config.compatibilityPath)
    }
  }

  /** Read source text without invoking BM25, Chroma or an embedding.
   * @param request - Exact source version and range.
   * @returns Original page with an immutable continuation cursor.
   */
  read(request: PolicyV2ReadRequest): PolicyV2ReadResult { return this.database.read(request, this.settings.pageCharacters) }

  private bounded(passages: Passage[]): Passage[] {
    let remaining = this.settings.evidenceCharacters
    return passages.flatMap((unit) => {
      if (remaining <= 0) return []
      const length = Math.min(unit.text.length, remaining)
      remaining -= length
      return [{ ...unit, text: unit.text.slice(0, length), ...(length < unit.text.length ? { excerpted: true } : {}) }]
    })
  }

  /** Discover documents or retrieve original passages; exact scopes never leak to other laws.
   * @param request - User query and optional explicit scope.
   * @param signal - Caller cancellation.
   * @returns Ranked candidates, route and observable degradation.
   */
  async search(request: PolicyV2SearchRequest, signal?: AbortSignal): Promise<PolicyV2SearchResult> {
    signal?.throwIfAborted()
    const start = performance.now()
    let exact = request.document_id
      ? [this.database.document(request.document_id)].filter((doc): doc is DocumentCard => !!doc)
      : this.database.exact(request.question)
    if (request.document_id && !exact.length) throw new Error('Unknown document_id')
    if (request.region) exact = exact.filter(doc => doc.region === request.region)
    const article = request.question.match(/第[零〇一二三四五六七八九十百千万两\d]+条(?:之[零〇一二三四五六七八九十百千万两\d]+)?/u)?.[0]
    const full = /全文|完整正文|讲了什么|主要内容|概括|总结|介绍一下|整体/u.test(request.question)
    const list = /(?:哪些|什么)(?:相关)?(?:法规|文件|政策|法律|标准)|(?:法规|文件|政策|法律|标准)(?:有哪|清单|目录)|找.*(?:法规|文件|政策)/u.test(request.question)
    const titleOnly = exact.some(doc => [doc.title, doc.title.replace(/^中华人民共和国/u, '')].some(title => canonical(title) === canonical(request.question)))
    const target = full ? 'documents' : request.target && request.target !== 'auto' ? request.target : list || titleOnly ? 'documents' : 'passages'
    const diagnostics: PolicyV2SearchResult['diagnostics'] = { lexical: 0, semantic_documents: 0, semantic_passages: 0, rejected_vectors: 0, elapsed_ms: 0, warnings: [] }
    const result: PolicyV2SearchResult = { target, route: '', documents: [], passages: [], requires_full_read: full, diagnostics }
    const explicitTitle = request.question.match(/《([^》]+)》/u)?.[1]
    if (explicitTitle && !exact.length) {
      result.route = 'explicit_document_missing'; diagnostics.elapsed_ms = Math.round(performance.now() - start); return result
    }
    if (exact.length && (target === 'documents' || article)) {
      result.route = article ? 'exact_article' : 'exact_document'
      result.documents = exact
      if (article) {
        result.target = 'passages'
        result.passages = exact.flatMap(doc => this.database.read({ document_id: doc.id, scope: 'article', selector: article }, Number.MAX_SAFE_INTEGER).units
          .map(unit => ({ ...unit, document: doc })))
        if (!result.passages.length) diagnostics.warnings.push('article_not_found')
        result.passages = this.bounded(result.passages)
      }
      diagnostics.elapsed_ms = Math.round(performance.now() - start)
      return result
    }
    let query = request.question
    for (const doc of exact) query = query.replace(doc.title, '').replace(doc.title.replace(/^中华人民共和国/u, ''), '')
    const ids = exact.length ? exact.map(doc => doc.id) : undefined
    result.route = target === 'documents' ? 'document_bm25_semantic' : ids ? 'scoped_passage_bm25_semantic' : 'global_passage_bm25_semantic'
    const lexicalDocs = target === 'documents' ? this.database.searchDocuments(query, this.settings.candidateLimit, request.region) : []
    const lexicalPassages = target === 'passages' ? this.database.searchPassages(query, this.settings.candidateLimit, ids, request.region) : []
    diagnostics.lexical = target === 'documents' ? lexicalDocs.length : lexicalPassages.length
    const semantic = this.semantic ? await this.semantic.search(request.question, target, signal) : { documents: [], passages: [], warnings: ['semantic_not_configured'], rejected: 0 }
    const inScope = (doc: DocumentCard) => (!ids || ids.includes(doc.id)) && (!request.region || doc.region === request.region)
    const semanticDocs = semantic.documents.filter(inScope)
    const semanticPassages = semantic.passages.filter(unit => inScope(unit.document))
    diagnostics.semantic_documents = semanticDocs.length; diagnostics.semantic_passages = semanticPassages.length
    diagnostics.rejected_vectors = semantic.rejected; diagnostics.warnings = semantic.warnings
    signal?.throwIfAborted()
    // Document similarity is only a prior. Body evidence still comes from a matching source unit.
    const docGuided = target === 'passages' && semanticDocs.length
      ? this.database.searchPassages(query, this.settings.candidateLimit, semanticDocs.map(doc => doc.id), request.region) : []
    function fuse<T extends { id: string }>(channels: T[][]): T[] {
      const items = new Map<string, { item: T; score: number }>()
      for (const [channelIndex, channel] of channels.entries()) {
        for (const [rank, item] of [...new Map(channel.map(item => [item.id, item])).values()].entries()) {
          const old = items.get(item.id)
          items.set(item.id, { item, score: (old?.score ?? 0) + (channelIndex === 2 ? 0.2 : 1) / (60 + rank + 1) })
        }
      }
      return [...items.values()].sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).map(value => value.item)
    }
    result.documents = target === 'documents' ? fuse([lexicalDocs, semanticDocs]).slice(0, this.settings.resultLimit) : exact
    if (target === 'passages') {
      const seen = new Set<string>()
      result.passages = fuse([lexicalPassages, semanticPassages, docGuided]).filter((unit) => {
        // Identical evidence in duplicate source exports is not another independent vote.
        const key = JSON.stringify([unit.document.title, unit.document.publish_date, unit.label, canonical(unit.text)])
        if (seen.has(key)) return false
        seen.add(key); return true
      }).slice(0, this.settings.resultLimit)
      result.passages = this.bounded(result.passages)
    }
    diagnostics.elapsed_ms = Math.round(performance.now() - start)
    return result
  }
}
