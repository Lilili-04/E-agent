/** Read-only, snapshot-bound version and event enrichment inside the existing provider. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { policyTitleMatches } from './v2-title-matches.ts'
import { canonical, type PolicyV2Database, type PolicyV2ReadRequest, type PolicyV2ReadResult } from './v2-database.ts'

interface Ref {
  document_id: string
  unit_id: string
  line_start: number
  line_end: number
}
interface Regulation {
  id: string
  title: string
  aliases: string[]
  region: string
}
interface Version {
  id: string
  title: string
  document_ids: string[]
  document_number: string | null
  publish_date: string | null
  revision_date: string | null
  adoption_date?: string | null
  effective_date: string | null
  version_label: string
  source_text_status: string
  review_status: string
  review_reason: string
  evidence_refs: Ref[] | string[] | string
}
interface Relation {
  id: string
  type: string
  from: string
  to: string
  date: string | null
  scope: string
  scope_text: string
  evidence: string
  source_refs: Ref[]
  review_status: string
  review_reason: string
}
interface Snapshot {
  regulations: Regulation[]
  versions: Version[]
  relations: Relation[]
}
interface Settings {
  endpoint: string
  group: string
  snapshot: string
  snapshotSha256: string
  databaseSha256: string
  timeoutMs: number
  versionLimit: number
  eventLimit: number
  contextCharacters: number
}

/** A source locator always names an actual body document, never a graph ID. */
export interface GraphSource extends Ref {
  version_id: string
  purpose: 'body' | 'attachment' | 'history_evidence'
}
/** Version dates retain their distinct meaning
  completeness concerns available source text. */
export interface GraphVersion {
  id: string
  title: string
  version_label: string
  document_number: string | null
  publish_date: string | null
  revision_date: string | null
  effective_date: string | null
  source_text_status: string
  review_status: string
  review_reason: string
  body_document_ids: string[]
  read_sources: GraphSource[]
}
/** An event's issuer is independent of the document preserving its evidence. */
export interface GraphEvent {
  id: string
  type: string
  issuing_version_id: string
  target_version_id: string | null
  target_id: string
  target_title: string
  date: string | null
  scope: string
  scope_text: string
  evidence: string
  review_status: string
  review_reason: string
  sources: Ref[]
}
/** Bounded one-hop history
  an absent event never establishes present validity. */
export interface GraphContext {
  identity_matched: boolean
  selected_version_ids: string[]
  versions: GraphVersion[]
  events: GraphEvent[]
  truncated: boolean
  warnings: string[]
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function refs(value: unknown): Ref[] {
  const input: unknown = typeof value === 'string' ? JSON.parse(value) : value
  const decoded: unknown = Array.isArray(input) ? input.map((v: unknown): unknown => typeof v === 'string' ? JSON.parse(v) : v) : input
  if (!Array.isArray(decoded) || !decoded.every(v => object(v) && typeof v.document_id === 'string' &&
    typeof v.unit_id === 'string' && Number.isSafeInteger(v.line_start) && Number.isSafeInteger(v.line_end) &&
    Number(v.line_start) > 0 && Number(v.line_end) >= Number(v.line_start))) throw new Error('Invalid graph source references')
  return (decoded as Ref[]).map(v => ({ document_id: v.document_id, unit_id: v.unit_id, line_start: v.line_start, line_end: v.line_end }))
}
function digest(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function snapshot(value: unknown): asserts value is Snapshot {
  if (!object(value) || !Array.isArray(value.regulations) || !Array.isArray(value.versions) || !Array.isArray(value.relations)) throw new Error('Invalid graph snapshot')
  for (const r of value.regulations) if (!object(r) || !['id', 'title', 'region'].every(k => typeof r[k] === 'string') || !Array.isArray(r.aliases) || !r.aliases.every(a => typeof a === 'string')) throw new Error('Invalid regulation')
  for (const v of value.versions) {
    if (!object(v) || !['id', 'title', 'version_label', 'source_text_status', 'review_status', 'review_reason'].every(k => typeof v[k] === 'string') ||
      !['document_number', 'publish_date', 'revision_date', 'effective_date'].every(k => v[k] === null || typeof v[k] === 'string') ||
      !Array.isArray(v.document_ids) || !v.document_ids.every(d => typeof d === 'string')) throw new Error('Invalid graph version')
    refs(v.evidence_refs)
  }
  for (const r of value.relations) {
    if (!object(r) || !['id', 'type', 'from', 'to', 'scope', 'scope_text', 'evidence', 'review_status', 'review_reason'].every(k => typeof r[k] === 'string') ||
      !(r.date === null || typeof r.date === 'string') || !['HAS_VERSION', 'AMENDS', 'REVISES', 'REPEALS'].includes(String(r.type))) throw new Error('Invalid graph event')
    refs(r.source_refs)
  }
}

/** Loads a fixed export and verifies its critical fields against the existing local Neo4j partition. */
export class PolicyV2Graph {
  private readonly data: Snapshot
  private readonly settings: Settings
  private verified = false
  private readonly owners = new Map<string, Regulation>()

  constructor(private readonly database: PolicyV2Database, configPath: string, databasePath: string) {
    const settings: unknown = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, ''))
    if (!object(settings) || !['endpoint', 'group', 'snapshot', 'snapshotSha256', 'databaseSha256'].every(k => typeof settings[k] === 'string') ||
      !['timeoutMs', 'versionLimit', 'eventLimit', 'contextCharacters'].every(k => typeof settings[k] === 'number' && Number.isSafeInteger(settings[k]) && settings[k] > 0) || Number(settings.contextCharacters) < 2000) throw new Error('Invalid graph config')
    this.settings = { endpoint: String(settings.endpoint), group: String(settings.group), snapshot: String(settings.snapshot),
      snapshotSha256: String(settings.snapshotSha256), databaseSha256: String(settings.databaseSha256),
      timeoutMs: Number(settings.timeoutMs),
      versionLimit: Number(settings.versionLimit), eventLimit: Number(settings.eventLimit),
      contextCharacters: Number(settings.contextCharacters) }
    const url = new URL(this.settings.endpoint)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('Graph endpoint must be local HTTP')
    }
    if (digest(databasePath) !== this.settings.databaseSha256 || digest(this.settings.snapshot) !== this.settings.snapshotSha256) {
      throw new Error('Graph/SQLite snapshot hash mismatch')
    }
    const data: unknown = JSON.parse(readFileSync(this.settings.snapshot, 'utf8')); snapshot(data); this.data = data
    const regulations = new Map(data.regulations.map(r => [r.id, r]))
    for (const r of data.relations.filter(r => r.type === 'HAS_VERSION')) {
      const owner = regulations.get(r.from)
      if (!owner || this.owners.has(r.to)) throw new Error('Graph version ownership mismatch')
      this.owners.set(r.to, owner)
    }
    for (const v of data.versions) {
      if (!this.owners.has(v.id) || v.document_ids.some(id => !database.document(id))) {
        throw new Error('Graph references unavailable body/owner')
      }
    }
  }

  private async verify(signal?: AbortSignal): Promise<void> {
    // Fixed projections exclude all vectors and technical Graphiti properties.
    const statements = [
      'MATCH (n:Entity {group_id:$group}) RETURN n.id,n.title,n.document_ids,n.version_label,n.source_text_status,n.evidence_refs,n.publish_date,n.revision_date,n.effective_date,n.document_number,n.review_status,n.review_reason,n.region,n.aliases',
      'MATCH (a:Entity {group_id:$group})-[r:RELATES_TO {group_id:$group}]->(b:Entity {group_id:$group}) RETURN r.id,r.name,a.id,b.id,r.date,r.scope,r.scope_text,r.evidence,r.source_refs,r.review_status,r.review_reason',
    ].map(statement => ({ statement, parameters: { group: this.settings.group } }))
    const response = await fetch(this.settings.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ statements }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.settings.timeoutMs)])
        : AbortSignal.timeout(this.settings.timeoutMs) })
    if (!response.ok) throw new Error(`Graph HTTP ${response.status}`)
    const payload: unknown = await response.json()
    if (!object(payload) || !Array.isArray(payload.errors) || payload.errors.length ||
      !Array.isArray(payload.results) || payload.results.length !== 2) throw new Error('Graph query failed')
    const rows = payload.results.map((result) => {
      if (!object(result) || !Array.isArray(result.data)) throw new Error('Invalid graph query response')
      return result.data.map((item): unknown[] => {
        if (!object(item) || !Array.isArray(item.row)) throw new Error('Invalid graph row')
        return item.row
      })
    })
    const nodes = new Map((rows[0] ?? []).map(row => [row[0], row]))
    if (nodes.size !== this.data.regulations.length + this.data.versions.length || (rows[0] ?? []).length !== nodes.size) {
      throw new Error('Graph node count mismatch')
    }
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
    for (const v of this.data.versions) {
      const row = nodes.get(v.id)
      const expected = [v.id, v.title, v.document_ids, v.version_label, v.source_text_status, refs(v.evidence_refs),
        v.publish_date, v.revision_date, v.effective_date, v.document_number, v.review_status, v.review_reason]
      if (!row || expected.some((value, i) => !same(i === 5 ? refs(row[i]) : row[i], value))) throw new Error(`Graph version mismatch: ${v.id}`)
    }
    for (const r of this.data.regulations) {
      const row = nodes.get(r.id)
      if (!row || !same(row[1], r.title) || !same(row[12], r.region) || !same(row[13], r.aliases)) throw new Error('Graph regulation mismatch')
    }
    const edges = new Map((rows[1] ?? []).map(row => [row[0], row]))
    if (edges.size !== this.data.relations.length || (rows[1] ?? []).length !== edges.size) throw new Error('Graph event count mismatch')
    for (const r of this.data.relations) {
      const row = edges.get(r.id)
      const expected = [r.id, r.type, r.from, r.to, r.date, r.scope, r.scope_text, r.evidence,
        refs(r.source_refs), r.review_status, r.review_reason]
      if (!row || expected.some((value, i) => !same(i === 8 ? refs(row[i]) : row[i], value))) throw new Error(`Graph event mismatch: ${r.id}`)
    }
  }

  /** Confirm the pinned partition; errors remain visible to the caller.
   * @param signal - Caller cancellation.
   * @returns Completion after graph identity verification.
   */
  async ensureReady(signal?: AbortSignal): Promise<void> {
    if (!this.verified) await this.verify(signal)
    signal?.throwIfAborted()
    this.verified = true
  }

  private validRefs(values: Ref[], documentId?: string): Ref[] {
    return values.filter(ref => (!documentId || ref.document_id === documentId) &&
      this.database.atLines(ref.document_id, ref.line_start, ref.line_end)
        .some(unit => unit.id === ref.unit_id && unit.line_start <= ref.line_start && unit.line_end >= ref.line_end))
  }

  private card(v: Version, documentId?: string): GraphVersion {
    const direct = v.document_ids.filter(id => !documentId || id === documentId)
    const evidence = this.validRefs(refs(v.evidence_refs), documentId)
    return { id: v.id, title: v.title, version_label: v.version_label, document_number: v.document_number,
      publish_date: v.publish_date, revision_date: v.revision_date, effective_date: v.effective_date,
      source_text_status: v.source_text_status, review_status: v.review_status, review_reason: v.review_reason,
      body_document_ids: direct, read_sources: [
        ...direct.map(id => ({ document_id: id, version_id: v.id, unit_id: '', line_start: 0, line_end: 0, purpose: 'body' as const })),
        ...evidence.map(ref => ({ ...ref, version_id: v.id,
          purpose: v.source_text_status === 'bundled_attachment' ? 'attachment' as const : 'history_evidence' as const })),
      ] }
  }

  /** Resolve named versions and enrich retrieved body candidates within region and document constraints.
   * @param question - Original question.
   * @param regions - Allowed catalog regions.
   * @param documentIds - Retrieved body candidates.
   * @param documentId - Explicit hard document constraint.
   * @returns Bounded version/event evidence with original-source locators.
   */
  context(question: string, regions: string[], documentIds: string[] = [], documentId?: string): GraphContext {
    const normalized = canonical(question)
    const candidates = this.data.versions.filter(v => regions.includes((this.owners.get(v.id)?.region ?? '')) &&
      (!documentId || v.document_ids.includes(documentId)))
    const identified = candidates.filter(v => v.document_number && normalized.includes(canonical(v.document_number)))
    const named = identified.length ? identified : policyTitleMatches(normalized, candidates, v =>
      [(this.owners.get(v.id)?.title ?? ''), ...(this.owners.get(v.id)?.aliases ?? []), v.title]
        .map(title => canonical(title).replace(/^中华人民共和国/u, '').replace(/\(试行\)$/u, '')))
    const identityMatched = named.length > 0 || !!documentId && candidates.length > 0
    let selected = named.length ? named : candidates.filter(v => v.document_ids.some(id => documentIds.includes(id)))
    const year = question.match(/((?:19|20)\d{2})(?:年?(?:版|修订|修正|发布|公布)|年)/u)?.[1]
    if (year) selected = selected.filter(v => [v.publish_date, v.revision_date, v.adoption_date, v.version_label, v.title]
      .some(text => text?.includes(year)))
    const truncated = selected.length > this.settings.versionLimit
    selected = selected.slice(0, this.settings.versionLimit)
    const ids = new Set(selected.map(v => v.id))
    const regulationIds = new Set(selected.map(v => this.owners.get(v.id)?.id))
    const history = /废止|修订|修正|沿革|版本|替代|效力|现行|有效|施行|生效/u.test(question)
    const events = this.data.relations.filter(r => r.type !== 'HAS_VERSION' && (ids.has(r.from) || ids.has(r.to) || regulationIds.has(r.to)) &&
      candidates.some(v => v.id === r.from) &&
      (candidates.some(v => v.id === r.to) || this.data.regulations.some(v => v.id === r.to && regions.includes(v.region))))
    const limited = history ? events.slice(0, this.settings.eventLimit) : []
    const endpoints = new Set(limited.flatMap(r => [r.from, r.to]))
    const versions = candidates.filter(v => ids.has(v.id) || endpoints.has(v.id)).map(v => this.card(v, documentId))
    const warnings = ['沿革仅反映已收录事件；没有废止关系不等于现行有效。未知日期不得推算，部分修改不等于整部废止。']
    if (history && !limited.length) warnings.push('未找到可验证的相关沿革事件；不能据此作效力结论。')
    if (limited.some(r => this.validRefs(r.source_refs, documentId).length < r.source_refs.length)) warnings.push('部分沿革依据不在当前正文快照或指定范围内，未提供读取入口。')
    if (identityMatched && year && !selected.length) warnings.push('已识别法规，但指定年份版本未收录；不能使用其他年份正文替代。')
    const result: GraphContext = { identity_matched: identityMatched, selected_version_ids: [...ids], versions,
      events: limited.map(r => ({ id: r.id, type: r.type,
        issuing_version_id: r.from, target_version_id: r.to.startsWith('ver-') ? r.to : null,
        target_id: r.to, target_title: this.data.versions.find(v => v.id === r.to)?.title ??
        this.data.regulations.find(v => v.id === r.to)?.title ?? r.to,
        date: r.date, scope: r.scope, scope_text: r.scope_text,
        evidence: r.evidence, review_status: r.review_status, review_reason: r.review_reason,
        sources: this.validRefs(r.source_refs, documentId) })),
      truncated: truncated || history && events.length > limited.length, warnings }
    while (JSON.stringify(result).length > this.settings.contextCharacters) {
      result.truncated = true
      if (result.events.length) result.events.pop()
      else if (result.selected_version_ids.length) result.selected_version_ids.pop()
      else throw new Error('Graph context budget is too small')
      const retained = new Set([...result.selected_version_ids, ...result.events.flatMap(e => [e.issuing_version_id, e.target_id])])
      result.versions = result.versions.filter(v => retained.has(v.id))
    }
    return result
  }

  /** Read a fixed version body or the explicitly identified surviving evidence, without substituting versions.
   * @param request - Body document and optional graph version.
   * @param maxCharacters - Page bound.
   * @returns Page annotated with its actual text role.
   */
  read(request: PolicyV2ReadRequest, maxCharacters: number): PolicyV2ReadResult {
    const v = this.data.versions.find(v => v.id === request.version_id)
    if (!v) throw new Error('Unknown graph version_id')
    const card = this.card(v, request.document_id)
    if (card.body_document_ids.includes(request.document_id)) {
      const page = this.database.read(request, maxCharacters, { identity: v.id })
      return { ...page, version: card, text_role: 'body', source_complete: page.source_complete && v.source_text_status === 'complete' }
    }
    const evidence = card.read_sources
    if (!evidence.length) throw new Error('Selected historical version has no readable body or evidence in this document')
    const attachment = v.source_text_status === 'bundled_attachment'
    if (!attachment && (request.scope ?? 'full') !== 'full') throw new Error('Historical body is unavailable; read surviving history evidence with scope=full')
    const page = this.database.read(request, maxCharacters, { identity: v.id,
      ranges: attachment ? [{ start: Math.min(...evidence.map(r => r.line_start)), end: Math.max(...evidence.map(r => r.line_end)) }]
        : evidence.map(r => ({ start: r.line_start, end: r.line_end })) })
    return { ...page, version: card, text_role: attachment ? 'attachment' : 'history_evidence', source_complete: false }
  }
}
