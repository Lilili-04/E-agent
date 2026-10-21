/** Validation for policy v2 HTTP requests and source evidence responses. */
import type { DocumentCard, Passage, PolicyV2ReadRequest, PolicyV2ReadResult } from './v2-database.ts'
import type { SourceUnit } from './v2-parser.ts'
import type { PolicyV2SearchRequest, PolicyV2SearchResult } from './v2-service.ts'

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(v => typeof v === 'string') }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
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
    (value.excerpted === undefined || typeof value.excerpted === 'boolean')
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
    !optionalStrings(value, ['document_id', 'region']) ||
    value.target !== undefined && value.target !== 'auto' && value.target !== 'documents' && value.target !== 'passages') throw new Error('Invalid search request')
  return { question: value.question, ...(value.target === undefined ? {} : { target: value.target }),
    ...(typeof value.document_id === 'string' ? { document_id: value.document_id } : {}), ...(typeof value.region === 'string' ? { region: value.region } : {}) }
}

/** Parse a source page request, rejecting unsupported scopes.
 * @param value - Decoded JSON.
 * @returns Validated selection.
 */
export function readRequest(value: unknown): PolicyV2ReadRequest {
  if (!record(value) || typeof value.document_id !== 'string' || !value.document_id || !optionalStrings(value, ['selector', 'cursor']) ||
    value.scope !== undefined && value.scope !== 'full' && value.scope !== 'section' && value.scope !== 'article' ||
    (value.scope === 'section' || value.scope === 'article') && typeof value.selector !== 'string') throw new Error('Invalid read request')
  return { document_id: value.document_id, ...(value.scope === undefined ? {} : { scope: value.scope }),
    ...(typeof value.selector === 'string' ? { selector: value.selector } : {}), ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}) }
}

function assertSearchResult(value: unknown): asserts value is PolicyV2SearchResult {
  if (!record(value) || (value.target !== 'documents' && value.target !== 'passages') || typeof value.route !== 'string' ||
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
