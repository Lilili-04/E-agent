/** Validation for policy v2 HTTP requests and source evidence responses. */
import type { DocumentCard, Passage, PolicyV2ReadRequest, PolicyV2ReadResult } from './v2-database.ts'
import type { SourceUnit } from './v2-parser.ts'
import type { PolicyV2SearchRequest, PolicyV2SearchResult } from './v2-service.ts'

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(v => typeof v === 'string') }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function source(value: unknown): boolean {
  return record(value) && typeof value.document_id === 'string' && typeof value.unit_id === 'string' && integer(value.line_start) && integer(value.line_end) && value.line_end >= value.line_start
}
function graphVersion(value: unknown): boolean {
  return record(value) && ['id', 'title', 'version_label', 'source_text_status', 'review_status', 'review_reason'].every(k => typeof value[k] === 'string') &&
    ['document_number', 'publish_date', 'revision_date', 'effective_date'].every(k => value[k] === null || typeof value[k] === 'string') &&
    strings(value.body_document_ids) && Array.isArray(value.read_sources) && value.read_sources.every(s => source(s) && record(s) &&
      s.version_id === value.id && ['body', 'attachment', 'history_evidence'].includes(String(s.purpose)))
}
function graph(value: unknown): boolean {
  return record(value) && typeof value.identity_matched === 'boolean' && strings(value.selected_version_ids) &&
    Array.isArray(value.versions) && value.versions.every(graphVersion) && Array.isArray(value.events) && value.events.every(e =>
    record(e) && ['id', 'type', 'issuing_version_id', 'target_id', 'target_title', 'scope', 'scope_text', 'evidence', 'review_status', 'review_reason'].every(k => typeof e[k] === 'string') &&
      ['AMENDS', 'REVISES', 'REPEALS'].includes(String(e.type)) && (e.target_version_id === null || typeof e.target_version_id === 'string') &&
      (e.date === null || typeof e.date === 'string') && Array.isArray(e.sources) && e.sources.every(source)) &&
    typeof value.truncated === 'boolean' && strings(value.warnings)
}
function document(value: unknown): value is DocumentCard {
  return record(value) && ['id', 'title', 'description', 'source_hash'].every(k => typeof value[k] === 'string') &&
    ['document_number', 'standard_number', 'document_type', 'issuing_authority', 'region', 'publish_date', 'effective_date', 'legal_status']
      .every(k => value[k] === null || typeof value[k] === 'string') && typeof value.text_status === 'string' && ['complete', 'partial', 'missing'].includes(value.text_status)
}
function unit(value: unknown): value is SourceUnit {
  return record(value) && ['id', 'document_id', 'label', 'section_path', 'text'].every(k => typeof value[k] === 'string') &&
    typeof value.kind === 'string' && ['article', 'heading', 'paragraph'].includes(value.kind) && integer(value.sequence) && integer(value.line_start) && integer(value.line_end)
}
function passage(value: unknown): value is Passage {
  return unit(value) && record(value) && document(value.document) && value.document_id === value.document.id &&
    (value.excerpted === undefined || typeof value.excerpted === 'boolean') &&
    (value.unit_ids === undefined || (Array.isArray(value.unit_ids) && value.unit_ids.every(id => typeof id === 'string')))
}
function optionalStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(k => value[k] === undefined || typeof value[k] === 'string' && value[k].length > 0)
}

/** Parse a bounded HTTP search request.
 * @param value - Decoded JSON.
 * @returns Validated query.
 */
export function searchRequest(value: unknown): PolicyV2SearchRequest {
  if (!record(value) || typeof value.question !== 'string' || !value.question.trim() ||
    !optionalStrings(value, ['document_id', 'region', 'scope_question']) ||
    value.mode !== undefined && (typeof value.mode !== 'string' ||
      !['facts', 'documents', 'overview', 'history', 'validity'].includes(value.mode)) ||
    value.target !== undefined && value.target !== 'auto' && value.target !== 'documents' && value.target !== 'passages' ||
    value.region_mode !== undefined && value.region_mode !== 'applicable' && value.region_mode !== 'only') throw new Error('Invalid search request')
  return { question: value.question,
    ...(value.mode === undefined ? {} : { mode: value.mode as NonNullable<PolicyV2SearchRequest['mode']> }),
    ...(typeof value.scope_question === 'string' ? { scope_question: value.scope_question } : {}), ...(value.target === undefined ? {} : { target: value.target }),
    ...(typeof value.document_id === 'string' ? { document_id: value.document_id } : {}), ...(typeof value.region === 'string' ? { region: value.region } : {}),
    ...(value.region_mode === 'applicable' || value.region_mode === 'only' ? { region_mode: value.region_mode } : {}) }
}

/** Parse a source page request, rejecting unsupported scopes.
 * @param value - Decoded JSON.
 * @returns Validated selection.
 */
export function readRequest(value: unknown): PolicyV2ReadRequest {
  if (!record(value) || typeof value.document_id !== 'string' || !value.document_id || !optionalStrings(value, ['selector', 'cursor', 'version_id']) ||
    value.scope !== undefined && value.scope !== 'full' && value.scope !== 'section' && value.scope !== 'article' ||
    (value.scope === 'section' || value.scope === 'article') && typeof value.selector !== 'string') throw new Error('Invalid read request')
  return { document_id: value.document_id, ...(typeof value.version_id === 'string' ? { version_id: value.version_id } : {}), ...(value.scope === undefined ? {} : { scope: value.scope }),
    ...(typeof value.selector === 'string' ? { selector: value.selector } : {}), ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}) }
}

function assertSearchResult(value: unknown): asserts value is PolicyV2SearchResult {
  if (!record(value) || (value.target !== 'documents' && value.target !== 'passages') || typeof value.route !== 'string' ||
    value.graph !== undefined && !graph(value.graph) ||
    typeof value.requires_full_read !== 'boolean' || !Array.isArray(value.documents) || !value.documents.every(document) ||
     !Array.isArray(value.passages) || !value.passages.every(passage) || !record(value.diagnostics) ||
     !strings(value.diagnostics.warnings) ||
    !['lexical', 'semantic_documents', 'semantic_passages', 'rejected_vectors', 'elapsed_ms'].every(k =>
      integer(record(value.diagnostics) ? value.diagnostics[k] : undefined))) {
    throw new Error('Invalid remote policy search response')
  }
}

/** Validate source evidence received from a remote search.
 * @param value - Decoded HTTP response.
 * @returns Search results or an explicit compatibility error.
 */
export function searchResult(value: unknown): PolicyV2SearchResult {
  assertSearchResult(value)
  return value
}

function assertReadResult(value: unknown): asserts value is PolicyV2ReadResult {
  if (!record(value) || !document(value.document) || (value.scope !== 'full' && value.scope !== 'section' && value.scope !== 'article') ||
    value.version !== undefined && !graphVersion(value.version) ||
    value.text_role !== undefined && (typeof value.text_role !== 'string' || !['body', 'attachment', 'history_evidence'].includes(value.text_role)) ||
    !Array.isArray(value.units) || !value.units.every(unit) || typeof value.text !== 'string' ||
    !['found', 'has_more', 'source_complete', 'unit_fragments'].every(k => typeof value[k] === 'boolean') ||
    (value.has_more ? typeof value.next_cursor !== 'string' || !value.next_cursor : value.next_cursor !== null)) {
    throw new Error('Invalid remote policy read response')
  }
}

/** Validate original page data and its continuation state.
 * @param value - Decoded HTTP response.
 * @returns Source page or an explicit compatibility error.
 */
export function readResult(value: unknown): PolicyV2ReadResult {
  assertReadResult(value)
  return value
}
