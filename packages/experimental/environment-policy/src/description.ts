import { createHash } from 'node:crypto'
import type { DocumentMetadata } from './metadata.ts'

/** Revision of the model instructions and result format. */
export const DESCRIPTION_PROMPT_REVISION = 'environment-policy-description-v1'

/** A bounded, numbered excerpt from the authoritative Markdown. */
export interface DescriptionEvidenceChunk {
  readonly lineStart: number
  readonly lineEnd: number
  readonly text: string
}

/** Offline input for one document-version description request. */
export interface DescriptionRequest {
  readonly sourceId: string
  readonly sourceHash: string
  readonly title?: string
  readonly documentType: string
  readonly promptRevision: typeof DESCRIPTION_PROMPT_REVISION
  readonly instructions: string
  readonly chunks: readonly DescriptionEvidenceChunk[]
  readonly truncated: boolean
}

/** A model-supplied citation, checked against the original Markdown. */
export interface DescriptionCitation {
  readonly lineStart: number
  readonly lineEnd: number
  readonly quote: string
}

/** Persisted output for a single source version. */
export interface PolicyDescription {
  readonly sourceId: string
  readonly sourceHash: string
  readonly description: string
  readonly citations: readonly DescriptionCitation[]
  readonly promptRevision: typeof DESCRIPTION_PROMPT_REVISION
  readonly modelId: string
  readonly generatedAt: string
  readonly status: 'generated' | 'reviewed' | 'stale' | 'rejected'
}

/** Explicit model adapter; the package never chooses credentials or a provider. */
export interface DescriptionModel {
  readonly modelId: string
  generate(request: DescriptionRequest): Promise<unknown>
}

const INSTRUCTIONS = '请仅根据提供的带行号原文，写一段80至200个汉字的文档检索简介。概括文件主题、适用对象或范围及主要规定，保留原文的规范语气。不要推断现行效力、全国适用性、生效日期或未提供的事实。只返回JSON对象：{"description":"...","citations":[{"lineStart":1,"lineEnd":2,"quote":"原文片段"}]}。每条引文必须能在对应行中找到；至少提供一条引文。不要返回法规正文或其他字段。'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Prepare bounded evidence without changing the authoritative source text.
 * @param sourceId - stable content source identifier.
 * @param markdown - authoritative Markdown text.
 * @param metadata - title and type hints supplied to the adapter.
 * @param maxChars - maximum source characters included in the request.
 * @returns immutable, line-addressable model input.
 */
export function prepareDescriptionRequest(
  sourceId: string,
  markdown: string,
  metadata: Pick<DocumentMetadata, 'canonicalTitleCandidate' | 'documentType'>,
  maxChars = 24_000,
): DescriptionRequest {
  if (!Number.isInteger(maxChars) || maxChars < 100) throw new Error('description: maxChars must be an integer of at least 100')
  const lines = markdown.split(/\r?\n/)
  const chunks: DescriptionEvidenceChunk[] = []
  let chars = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (chars + line.length + 1 > maxChars) break
    chunks.push({ lineStart: index + 1, lineEnd: index + 1, text: line })
    chars += line.length + 1
  }
  if (chunks.length === 0) throw new Error('description: first source line exceeds maxChars')
  return {
    sourceId,
    sourceHash: sha256(markdown),
    ...(metadata.canonicalTitleCandidate === undefined ? {} : { title: metadata.canonicalTitleCandidate }),
    documentType: metadata.documentType,
    promptRevision: DESCRIPTION_PROMPT_REVISION,
    instructions: INSTRUCTIONS,
    chunks,
    truncated: chunks.length < lines.length,
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('description: model response must be a JSON object')
  return value as Record<string, unknown>
}

/**
 * Validate model JSON and its exact quotes against the original Markdown.
 * @param response - untrusted adapter output.
 * @param markdown - authoritative Markdown used to verify quotations.
 * @returns a bounded description and verified citations.
 */
export function validateDescriptionResponse(response: unknown, markdown: string): Pick<PolicyDescription, 'description' | 'citations'> {
  const value = object(response)
  if (Object.keys(value).some(key => key !== 'description' && key !== 'citations')) throw new Error('description: response contains unsupported fields')
  const description = value.description
  const descriptionLength = typeof description === 'string' ? Array.from(description.trim()).length : 0
  if (typeof description !== 'string' || descriptionLength < 80 || descriptionLength > 200) {
    throw new Error('description: text must contain 80–200 characters')
  }
  if (!Array.isArray(value.citations) || value.citations.length === 0 || value.citations.length > 8) {
    throw new Error('description: provide 1–8 citations')
  }
  const lines = markdown.split(/\r?\n/)
  const citations: DescriptionCitation[] = []
  for (const item of value.citations) {
    const citation = object(item)
    if (Object.keys(citation).some(key => !['lineStart', 'lineEnd', 'quote'].includes(key))) throw new Error('description: citation contains unsupported fields')
    const { lineStart, lineEnd, quote } = citation
    if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || typeof lineStart !== 'number' || typeof lineEnd !== 'number' || lineStart < 1 || lineEnd < lineStart || lineEnd > lines.length || lineEnd - lineStart > 10) throw new Error('description: citation span is invalid')
    if (typeof quote !== 'string' || quote.trim().length < 4 || !lines.slice(lineStart - 1, lineEnd).join('\n').includes(quote)) throw new Error('description: citation quote is absent from its source span')
    citations.push({ lineStart, lineEnd, quote })
  }
  return { description: description.trim(), citations }
}

/**
 * Invoke an injected model and retain provenance for human review.
 * @param model - caller-selected adapter with provenance identifier.
 * @param request - bounded evidence request prepared from the same source.
 * @param markdown - authoritative Markdown used for final validation.
 * @param generatedAt - ISO generation timestamp stored in provenance.
 * @returns validated generated description awaiting review.
 */
export async function generatePolicyDescription(
  model: DescriptionModel,
  request: DescriptionRequest,
  markdown: string,
  generatedAt: string,
): Promise<PolicyDescription> {
  if (request.sourceHash !== sha256(markdown)) throw new Error('description: source changed before generation')
  if (!model.modelId.trim()) throw new Error('description: modelId is required')
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error('description: generatedAt must be an ISO date-time')
  const response = validateDescriptionResponse(await model.generate(request), markdown)
  const allowedLines = new Set(request.chunks.map(chunk => chunk.lineStart))
  if (response.citations.some(citation => !allowedLines.has(citation.lineStart)
    || !allowedLines.has(citation.lineEnd))) {
    throw new Error('description: citation refers to text omitted from the model request')
  }
  return {
    sourceId: request.sourceId,
    sourceHash: request.sourceHash,
    ...response,
    promptRevision: request.promptRevision,
    modelId: model.modelId,
    generatedAt,
    status: 'generated',
  }
}

/**
 * Mark a saved description stale when its source bytes change.
 * @param description - saved description and original source hash.
 * @param markdown - current authoritative Markdown.
 * @returns the original record or a copy with `stale` status.
 */
export function refreshDescriptionStatus(description: PolicyDescription, markdown: string): PolicyDescription {
  return description.sourceHash === sha256(markdown) ? description : { ...description, status: 'stale' }
}

/**
 * Record a human decision without changing the generated text or citations.
 * @param description - generated description to review.
 * @param decision - accepted or rejected review outcome.
 * @param markdown - current authoritative Markdown.
 * @returns a copy carrying the human review status.
 */
export function reviewPolicyDescription(description: PolicyDescription, decision: 'reviewed' | 'rejected', markdown: string): PolicyDescription {
  if (description.sourceHash !== sha256(markdown)) throw new Error('description: stale source cannot be reviewed')
  return { ...description, status: decision }
}
