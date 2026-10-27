/** Backend retrieval and bounded original-source preparation before generation. */
import type { DocumentCard, PolicyV2ReadRequest } from './v2-database.ts'
import type { PolicyV2Knowledge, PolicyV2SearchResult, PolicyV2SearchRequest } from './v2-service.ts'

/** Deployment limits apply to retrieval, sequential reading and the complete serialized packet. */
export interface EvidenceSettings { characters: number; pages: number; documents: number; timeoutMs: number }
/** Prepared evidence remains separate from discovery metadata and graph claims. */
export interface PolicyEvidence {
  status: 'ready' | 'empty' | 'unavailable'
  question: string
  route: string
  diagnostics?: PolicyV2SearchResult['diagnostics']
  graph?: PolicyV2SearchResult['graph']
  sources: Array<{
    document: DocumentCard
    text: string
    labels: string[]
    source_complete: boolean
    selection_complete: boolean
    text_role: string
    version_id?: string
  }>
  warnings: string[]
}

/** Search, read original ranges and serialize an auditable evidence packet.
 * @param knowledge - Existing read-only local or remote provider.
 * @param question - Accepted user text, retaining all scope and version constraints.
 * @param settings - Complete packet and operation bounds.
 * @param signal - Owning turn cancellation.
 * @param request - Optional explicit retrieval route and original scope supplied by the planner.
 * @returns Packet and source permissions for optional supplementary tools.
 */
export async function preparePolicyEvidence(knowledge: PolicyV2Knowledge, question: string,
  settings: EvidenceSettings, signal: AbortSignal, request?: PolicyV2SearchRequest): Promise<{
  text: string
  evidence: PolicyEvidence
  search?: PolicyV2SearchResult
  read_pages: number
}> {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)])
  const evidence: PolicyEvidence = { status: 'empty', question, route: '', sources: [], warnings: [] }
  let search: PolicyV2SearchResult | undefined
  let pages = 0
  const size = () => JSON.stringify(evidence).length
  function append(source: PolicyEvidence['sources'][number]): boolean {
    if (!source.text.trim()) return true
    evidence.sources.push(source)
    if (size() <= settings.characters) return true
    evidence.sources.pop()
    evidence.warnings.push('证据包达到长度上限；未覆盖范围不能视为已读取。')
    return false
  }
  async function read(request: PolicyV2ReadRequest, full: boolean, role?: string): Promise<void> {
    let cursor: string | undefined
    const start = evidence.sources.length
    do {
      boundedSignal.throwIfAborted()
      if (pages >= settings.pages) { evidence.warnings.push('原文读取达到页数上限。'); return }
      pages++
      const page = await knowledge.read({ ...request, ...(cursor ? { cursor } : {}) }, boundedSignal)
      if (!page.found) { evidence.warnings.push(`未找到所选原文：${page.document.title}`); return }
      if (!append({ document: page.document, text: page.text, labels: [...new Set(page.units.map(u => u.label).filter(Boolean))],
        source_complete: page.source_complete, selection_complete: !page.has_more,
        text_role: role ?? page.text_role ?? 'body', ...(request.version_id ? { version_id: request.version_id } : {}) })) return
      cursor = page.next_cursor ?? undefined
      if (!page.has_more) {
        for (const source of evidence.sources.slice(start)) source.selection_complete = true
      }
      if (page.has_more && !cursor) { evidence.warnings.push('原文分页缺少后续游标。'); return }
      if (!full && page.has_more) { evidence.warnings.push(`仅读取部分原文：${page.document.title}`); return }
    } while (cursor)
  }
  try {
    search = await knowledge.search(request ?? { question }, boundedSignal)
    evidence.route = search.route
    evidence.diagnostics = search.diagnostics
    evidence.warnings.push(...search.diagnostics.warnings)
    evidence.graph = search.graph
    if (search.graph && !search.graph.identity_matched) {
      evidence.graph = { ...search.graph, selected_version_ids: [], versions: [], events: [] }
      evidence.warnings.push('未匹配到指定法规的图谱身份，不能据此确认版本沿革或效力。')
    }
    const documents = [...new Map([...search.documents, ...search.passages.map(p => p.document)]
      .map(doc => [doc.id, doc])).values()].slice(0, settings.documents)
    if (search.requires_full_read) {
      const selected = search.graph?.versions.filter(v => search?.graph?.selected_version_ids.includes(v.id)) ?? []
      const attachments = selected.flatMap(v => v.read_sources.filter(s => s.purpose === 'attachment'))
      for (const doc of documents.filter(d => !attachments.some(a => a.document_id === d.id))) {
        await read({ document_id: doc.id, scope: 'full' }, true)
      }
      for (const source of attachments.slice(0, settings.documents)) await read({ ...source, scope: 'full' }, true)
    } else if (search.passages.length) {
      const seen = new Set<string>()
      const complete = new Set<string>()
      const completeness = new Map<string, boolean>()
      for (const doc of documents) {
        boundedSignal.throwIfAborted()
        if (pages >= settings.pages) { evidence.warnings.push('原文读取达到页数上限。'); break }
        pages++
        const page = await knowledge.read({ document_id: doc.id }, boundedSignal)
        completeness.set(doc.id, page.source_complete)
        if (search.route === 'scoped_passage_bm25_semantic' && page.found && !page.has_more &&
          append({ document: doc, text: page.text, labels: [...new Set(page.units.map(u => u.label).filter(Boolean))],
            source_complete: page.source_complete, selection_complete: true, text_role: 'body' })) complete.add(doc.id)
      }
      for (const passage of search.passages) {
        if (!documents.some(d => d.id === passage.document_id)) continue
        if (complete.has(passage.document_id)) continue
        const labels = [...new Set(passage.text.match(/第[零〇一二三四五六七八九十百千万两\d]+条(?:之[零〇一二三四五六七八九十百千万两\d]+)?/gu) ?? [])]
        const key = JSON.stringify([passage.document_id, passage.unit_ids ?? passage.id])
        if (seen.has(key)) continue
        seen.add(key)
        const selector = labels[0]
        if (passage.excerpted && labels.length === 1 && selector) {
          await read({ document_id: passage.document_id, scope: 'article', selector }, true)
        } else {
          // Source completeness is provider-owned, independent of passage truncation.
          if (!append({ document: passage.document, text: passage.text, labels,
            source_complete: completeness.get(passage.document_id) ?? false,
            selection_complete: !passage.excerpted, text_role: 'body' })) break
        }
      }
    } else if (!search.graph) {
      for (const doc of documents) await read({ document_id: doc.id, scope: 'full' }, false)
    }
    if (search.graph?.identity_matched) {
      const seen = new Set<string>()
      for (const version of search.graph.versions.filter(v => search?.graph?.selected_version_ids.includes(v.id))) {
        for (const source of version.read_sources) {
          const key = JSON.stringify([source.document_id, source.version_id])
          if (seen.has(key)) continue
          seen.add(key)
          if (seen.size <= settings.documents) await read({ ...source, scope: 'full' }, true)
        }
      }
      for (const event of search.graph.events) {
        const selector = event.evidence.match(/第[零〇一二三四五六七八九十百千万两\d]+条(?:之[零〇一二三四五六七八九十百千万两\d]+)?/u)?.[0]
        for (const source of event.sources) {
          const key = JSON.stringify([source.document_id, source.unit_id, selector])
          if (seen.has(key)) continue
          seen.add(key)
          if (seen.size <= settings.documents) await read({ document_id: source.document_id,
            ...(selector ? { scope: 'article', selector } : { scope: 'full' }) }, true, 'history_evidence')
        }
      }
    }
  } catch (error) {
    signal.throwIfAborted()
    evidence.warnings.push(error instanceof Error && error.name === 'TimeoutError'
      ? '检索或原文读取超时。' : '检索或原文读取服务不可用，本次证据可能不完整。')
    evidence.status = 'unavailable'
  }
  if (evidence.sources.length) evidence.status = 'ready'
  // Metadata and graph context also consume the complete packet budget.
  if (size() > settings.characters) {
    delete evidence.graph
    delete evidence.diagnostics
    evidence.warnings.push('图谱或诊断超过证据包预算，已省略。')
  }
  while (size() > settings.characters && evidence.sources.length) evidence.sources.pop()
  if (!evidence.sources.length && evidence.status === 'ready') evidence.status = 'empty'
  if (size() > settings.characters) {
    evidence.question = ''
    evidence.warnings = ['用户问题超过证据包长度上限；请依据原始问题，当前无可用原文。']
  }
  return { text: JSON.stringify(evidence), evidence, read_pages: pages, ...(search ? { search } : {}) }
}
