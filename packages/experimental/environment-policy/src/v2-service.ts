/** SQLite-backed find/read provider with optional legacy or combined semantic retrieval. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { canonical, PolicyV2Database, type DocumentCard, type Passage, type PolicyV2ReadRequest, type PolicyV2ReadResult } from './v2-database.ts'
import { PolicyV2Semantic } from './v2-semantic.ts'
import { PolicyV2CombinedSemantic } from './v2-combined-semantic.ts'
import { PolicyLatest, needsPolicyGraph } from './v2-latest.ts'
import { policyRegions } from './v2-region.ts'
import { PolicyV2Graph, type GraphContext } from './v2-graph.ts'

/** Local database and optional read-only legacy or manifest-bound vector connection. */
export interface Config {
  path: string
  semanticConfigPath?: string
  compatibilityPath?: string
  vectorManifestPath?: string
  graphConfigPath?: string
  latestManifestPath?: string
  guidedCandidates?: number
  maxEvidencePerDocument?: number
  candidateLimit?: number
  resultLimit?: number
  pageCharacters?: number
  evidenceCharacters?: number
}
/** Validated Loader settings. */
export const Config: z<Config> = z.object({
  path: z.string().required(), semanticConfigPath: z.string(), compatibilityPath: z.string(),
  vectorManifestPath: z.string(), graphConfigPath: z.string(), latestManifestPath: z.string(),
  guidedCandidates: z.number().step(1).min(1).max(100).default(20),
  maxEvidencePerDocument: z.number().step(1).min(1).max(30).default(3),
  candidateLimit: z.number().step(1).min(1).max(500).default(60),
  resultLimit: z.number().step(1).min(1).max(30).default(8),
  pageCharacters: z.number().step(1).min(200).max(50000).default(12000),
  evidenceCharacters: z.number().step(1).min(1000).max(50000).default(12000),
})

/** Search chooses candidates; reading chooses original-source ranges. */
export interface PolicyV2SearchRequest {
  question: string
  target?: 'auto' | 'documents' | 'passages'
  mode?: 'facts' | 'documents' | 'overview' | 'history' | 'validity'
  scope_question?: string
  document_id?: string
  region?: string
  region_mode?: 'applicable' | 'only'
}

/** Explicit route and per-channel counts support local evaluation. */
export interface PolicyV2SearchResult {
  target: 'documents' | 'passages'
  route: string
  documents: DocumentCard[]
  passages: Passage[]
  requires_full_read: boolean
  graph?: GraphContext
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
  private readonly semantic?: PolicyV2Semantic | PolicyV2CombinedSemantic
  private graph?: PolicyV2Graph
  private readonly graphConfig?: { path: string; databasePath: string }
  private readonly latest?: PolicyLatest
  private readonly settings: Required<Pick<Config, 'candidateLimit' | 'resultLimit' | 'pageCharacters' | 'evidenceCharacters' | 'guidedCandidates' | 'maxEvidencePerDocument'>>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'environmentPolicyV2')
    if (config.compatibilityPath && config.vectorManifestPath) throw new Error('Choose legacy compatibilityPath or vectorManifestPath')
    if (!!config.semanticConfigPath !== !!(config.compatibilityPath || config.vectorManifestPath)) {
      throw new Error('Provide semanticConfigPath with compatibilityPath or vectorManifestPath')
    }
    this.database = new PolicyV2Database(config.path)
    ctx.effect(() => () => { this.database.close() }, 'policyV2.close')
    if (config.graphConfigPath) this.graphConfig = { path: config.graphConfigPath, databasePath: config.path }
    if (config.latestManifestPath) this.latest = new PolicyLatest(config.latestManifestPath, config.path, this.database.documents)
    this.settings = { candidateLimit: config.candidateLimit ?? 60, resultLimit: config.resultLimit ?? 8,
      pageCharacters: config.pageCharacters ?? 12000, evidenceCharacters: config.evidenceCharacters ?? 12000,
      guidedCandidates: config.guidedCandidates ?? 20,
      maxEvidencePerDocument: config.maxEvidencePerDocument ?? 3 }
    if (config.semanticConfigPath && config.vectorManifestPath) {
      this.semantic = new PolicyV2CombinedSemantic(this.database, config.semanticConfigPath, config.vectorManifestPath, config.path)
    } else if (config.semanticConfigPath && config.compatibilityPath) {
      this.semantic = new PolicyV2Semantic(this.database, config.semanticConfigPath, config.compatibilityPath)
    }
  }

  /** Read source text without invoking BM25, Chroma or an embedding.
   * @param request - Exact source version and range.
   * @param signal - Caller cancellation, including the first local graph verification.
   * @returns Original page with an immutable continuation cursor.
   */
  async read(request: PolicyV2ReadRequest, signal?: AbortSignal): Promise<PolicyV2ReadResult> {
    signal?.throwIfAborted()
    if (request.version_id) {
      const graph = this.historyGraph()
      if (!graph) throw new Error('Graph version reading is not configured')
      await graph.ensureReady(signal)
      return graph.read(request, this.settings.pageCharacters)
    }
    const page = this.database.read(request, this.settings.pageCharacters)
    return { ...page, source_complete: page.source_complete && (!this.latest || this.latest.complete(request.document_id)) }
  }

  private historyGraph(): PolicyV2Graph | undefined {
    if (!this.graph && this.graphConfig) this.graph = new PolicyV2Graph(this.database, this.graphConfig.path, this.graphConfig.databasePath)
    return this.graph
  }

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
    const regions = policyRegions(request.scope_question ?? request.question, this.database.documents, exact,
      request.region, request.region_mode)
    exact = exact.filter(doc => doc.region !== null && regions.includes(doc.region))
    if (request.document_id && !exact.length) throw new Error('Requested document is outside the selected region')
    const historical = request.mode ? request.mode === 'history' || request.mode === 'validity'
      : needsPolicyGraph(request.question, this.database.documents)
    const graphReader = historical ? this.historyGraph() : undefined
    const latestMatches = !historical && this.latest ? this.latest.match(request.question, regions) : []
    if (!historical && this.latest) {
      if (latestMatches.length && !request.document_id) exact = latestMatches.flatMap(e => e.document_ids)
        .flatMap((id) => { const doc = this.database.document(id); return doc ? [doc] : [] })
      exact = exact.filter(doc => this.latest?.documentIds.includes(doc.id))
      if (request.document_id && !exact.length) throw new Error('Requested document is not a verified latest body; specify the historical version in question')
    }
    let graph: GraphContext | undefined
    if (graphReader) {
      await graphReader.ensureReady(signal)
      graph = graphReader.context(request.question, regions, exact.map(doc => doc.id), request.document_id)
      const selected = graph.versions.filter(v => graph?.selected_version_ids.includes(v.id))
      if (request.document_id && graph.identity_matched && !selected.length) {
        throw new Error('Requested document does not match the specified graph version/year')
      }
      if (graph.identity_matched) exact = selected.flatMap(v => v.body_document_ids).flatMap((id) => {
        const doc = this.database.document(id); return doc ? [doc] : []
      })
    }
    const article = request.question.match(/第[零〇一二三四五六七八九十百千万两\d]+条(?:之[零〇一二三四五六七八九十百千万两\d]+)?/u)?.[0]
    const full = request.mode ? request.mode === 'overview'
      : /全文|完整正文|讲了什么|主要内容|概括|总结|介绍一下|整体/u.test(request.question)
    const list = /(?:哪些|什么)(?:相关)?(?:法规|文件|政策|法律|标准)|(?:法规|文件|政策|法律|标准)(?:有哪|清单|目录)|找.*(?:法规|文件|政策)/u.test(request.question)
    const titleOnly = exact.some(doc => [doc.title, doc.title.replace(/^中华人民共和国/u, '')].some(title => canonical(title) === canonical(request.question)))
    const target = request.mode === 'documents' || full ? 'documents' : request.mode ? 'passages' : request.target && request.target !== 'auto' ? request.target : list || titleOnly ? 'documents' : 'passages'
    const diagnostics: PolicyV2SearchResult['diagnostics'] = { lexical: 0, semantic_documents: 0, semantic_passages: 0, rejected_vectors: 0, elapsed_ms: 0, warnings: [] }
    const result: PolicyV2SearchResult = { target, route: '', documents: [], passages: [], requires_full_read: full, diagnostics, ...(graph ? { graph } : {}) }
    const finish = () => {
      if (graphReader) result.graph = graphReader.context(request.question, regions,
        [...result.documents.map(d => d.id), ...result.passages.map(p => p.document_id)], request.document_id)
      diagnostics.elapsed_ms = Math.round(performance.now() - start)
      return result
    }
    if (latestMatches.some(e => e.status !== 'ready')) {
      result.route = 'latest_version_unavailable'; result.requires_full_read = false
      result.documents = []; result.passages = []
      diagnostics.warnings.push(...latestMatches.filter(e => e.status !== 'ready').map(e => `${e.status}: ${e.title}`))
      return finish()
    }
    const explicitTitle = request.question.match(/《([^》]+)》/u)?.[1]
    if ((explicitTitle || graph?.identity_matched) && !exact.length) {
      result.route = graph?.selected_version_ids.length ? 'graph_version_without_body' : 'explicit_document_missing'
      result.requires_full_read = full && !!graph?.versions.some(v => graph.selected_version_ids.includes(v.id) && v.source_text_status === 'bundled_attachment' && v.read_sources.length)
      return finish()
    }
    if (graph?.selected_version_ids.length && (request.mode === 'history' || request.mode === 'validity' ||
      /废止|修订|修正|沿革|版本|替代|效力|现行|有效|施行|生效/u.test(request.question)) && !article && !full) {
      result.route = 'graph_history'; result.documents = exact; return finish()
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
      return finish()
    }
    let query = request.question
    for (const doc of exact) query = query.replace(doc.title, '').replace(doc.title.replace(/^中华人民共和国/u, ''), '')
    if (/定义|何谓|什么是|是指什么/u.test(query)) query += ' 所称 是指'
    const ids = exact.length ? exact.map(doc => doc.id) : !historical && this.latest
      ? this.latest.documentIds.filter((id) => {
        const doc = this.database.document(id); return doc?.region && regions.includes(doc.region)
      }) : undefined
    result.route = target === 'documents' ? 'document_bm25_semantic' : exact.length ? 'scoped_passage_bm25_semantic' : 'global_passage_bm25_semantic'
    // Independent province lists prevent national matches from exhausting the
    // candidate budget before local evidence can participate in fusion.
    const byRegion = <T>(read: (region: string) => T[]): T[] => {
      const channels = regions.map(read)
      return Array.from({ length: Math.max(0, ...channels.map(channel => channel.length)) }, (_, rank) =>
        channels.flatMap(channel => channel[rank] === undefined ? [] : [channel[rank]]))
        .flat().slice(0, this.settings.candidateLimit * regions.length)
    }
    const semanticPending = this.semantic
      ? this.semantic.search(exact.length && target === 'passages' ? query : request.question,
        target, signal, { regions, ...(ids ? { documentIds: ids } : {}) })
      : Promise.resolve({ documents: [], passages: [], warnings: ['semantic_not_configured'], rejected: 0 })
    const lexicalDocs = target === 'documents' ? byRegion(region => this.database.searchDocuments(query, this.settings.candidateLimit, [region], ids)) : []
    const lexicalPassages = target === 'passages' ? byRegion(region => this.database.searchPassages(query, this.settings.candidateLimit, ids, [region])) : []
    diagnostics.lexical = target === 'documents' ? lexicalDocs.length : lexicalPassages.length
    const semantic = await semanticPending
    const inScope = (doc: DocumentCard) => (!ids || ids.includes(doc.id)) && doc.region !== null && regions.includes(doc.region)
    const semanticDocs = byRegion(region => semantic.documents.filter(doc => inScope(doc) && doc.region === region))
    const semanticPassages = byRegion(region => semantic.passages.filter(unit => inScope(unit.document) && unit.document.region === region))
    diagnostics.semantic_documents = semanticDocs.length; diagnostics.semantic_passages = semanticPassages.length
    diagnostics.rejected_vectors = semantic.rejected; diagnostics.warnings.push(...semantic.warnings)
    signal?.throwIfAborted()
    // Document similarity is only a prior. Body evidence still comes from a matching source unit.
    const docGuided = target === 'passages' && semanticDocs.length
      ? byRegion(region => this.database.searchPassages(query, this.settings.guidedCandidates,
        semanticDocs.filter(doc => doc.region === region).map(doc => doc.id), [region])) : []
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
    const balance = <T>(items: T[], regionOf: (item: T) => string | null): T[] => {
      const channels = regions.map(region => items.filter(item => regionOf(item) === region))
      return Array.from({ length: Math.max(0, ...channels.map(channel => channel.length)) }, (_, rank) =>
        channels.flatMap(channel => channel[rank] === undefined ? [] : [channel[rank]] )).flat()
    }
    result.documents = target === 'documents' ? balance(fuse([lexicalDocs, semanticDocs]), doc => doc.region).slice(0, this.settings.resultLimit) : exact
    if (target === 'passages') {
      const seen = new Set<string>()
      const perDocument = new Map<string, number>()
      result.passages = balance(fuse([lexicalPassages, semanticPassages, docGuided]), unit => unit.document.region).filter((unit) => {
        // Identical evidence in duplicate source exports is not another independent vote.
        const key = JSON.stringify([unit.document.region, unit.document.title, unit.document.publish_date,
          unit.label, canonical(unit.text)])
        const limit = exact.length ? this.settings.resultLimit : this.settings.maxEvidencePerDocument
        if (seen.has(key) || (perDocument.get(unit.document_id) ?? 0) >= limit) return false
        seen.add(key); perDocument.set(unit.document_id, (perDocument.get(unit.document_id) ?? 0) + 1); return true
      }).slice(0, this.settings.resultLimit)
      // Merge only consecutive units from the same version and section, preserving
      // each original ID and the highest-ranked member's position in the result.
      const selected = result.passages
      const grouped = new Map<string, Passage>()
      const ordered = [...selected].sort((a, b) => a.document_id.localeCompare(b.document_id) || a.sequence - b.sequence)
      let previous: Passage | undefined
      let previousEnd = -1
      for (const unit of ordered) {
        if (previous && previous.document_id === unit.document_id && previous.section_path === unit.section_path &&
          previousEnd + 1 === unit.sequence) {
          previous.text += unit.text
          previous.line_end = unit.line_end
          previous.unit_ids?.push(unit.id)
        } else {
          previous = { ...unit, unit_ids: [unit.id] }
        }
        previousEnd = unit.sequence
        grouped.set(unit.id, previous)
      }
      const emitted = new Set<Passage>()
      result.passages = this.bounded(selected.flatMap((unit) => {
        const group = grouped.get(unit.id)
        if (!group) throw new Error('Missing merged evidence group')
        if (emitted.has(group)) return []
        emitted.add(group); return [group]
      }))
    }
    diagnostics.elapsed_ms = Math.round(performance.now() - start)
    return finish()
  }
}
