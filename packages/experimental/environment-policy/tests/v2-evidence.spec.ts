import { expect, it, vi } from 'vitest'
import { preparePolicyEvidence } from '../src/v2-evidence.ts'
import type { PolicyV2Knowledge, PolicyV2SearchResult } from '../src/v2-service.ts'
import type { DocumentCard, PolicyV2ReadResult } from '../src/v2-database.ts'

const document: DocumentCard = { id: 'law', title: '测试条例', document_number: null, standard_number: null,
  document_type: '条例', issuing_authority: null, region: '全国', publish_date: null, effective_date: null,
  legal_status: null, description: '发现摘要不能替代原文', source_hash: 'hash', text_status: 'complete' }
const result: PolicyV2SearchResult = { target: 'documents', route: 'exact_document', documents: [document],
  passages: [], requires_full_read: true, diagnostics: { lexical: 0, semantic_documents: 0, semantic_passages: 0,
    rejected_vectors: 0, elapsed_ms: 0, warnings: [] } }
const page: PolicyV2ReadResult = { document, scope: 'full', units: [], text: '第一条 原文。', found: true,
  has_more: false, next_cursor: null, source_complete: false, unit_fragments: false }
const settings = { characters: 2000, pages: 3, documents: 2, timeoutMs: 1000 }
const signal = () => new AbortController().signal

it('reads sequential cursors and keeps source incompleteness separate from selection completion', async () => {
  const read = vi.fn<PolicyV2Knowledge['read']>()
    .mockResolvedValueOnce({ ...page, has_more: true, next_cursor: 'next' }).mockResolvedValueOnce(page)
  const packet = await preparePolicyEvidence({ search: async () => result, read }, '概括测试条例', settings, signal())
  expect(read.mock.calls.map(call => call[0].cursor)).toEqual([undefined, 'next'])
  expect(packet.evidence.sources.map(source => [source.source_complete, source.selection_complete]))
    .toEqual([[false, true], [false, true]])
  expect(packet.evidence.status).toBe('ready')
})

it('marks bounded full reading incomplete and bounds the entire serialized packet including metadata', async () => {
  const read = vi.fn<PolicyV2Knowledge['read']>().mockResolvedValue({ ...page, text: '😀'.repeat(1500),
    has_more: true, next_cursor: 'next' })
  const packet = await preparePolicyEvidence({ search: async () => result, read }, '概括测试条例', settings, signal())
  expect(packet.text.length).toBeLessThanOrEqual(settings.characters)
  expect(packet.evidence.status).toBe('empty')
  expect(packet.evidence.warnings.join()).toContain('上限')
  expect(read).toHaveBeenCalledTimes(1)
})

it('keeps read-limit warnings instead of claiming a complete full-law overview', async () => {
  const read = vi.fn<PolicyV2Knowledge['read']>().mockResolvedValue({ ...page, has_more: true, next_cursor: 'next' })
  const packet = await preparePolicyEvidence({ search: async () => result, read }, '概括测试条例',
    { ...settings, pages: 1 }, signal())
  expect(packet.evidence.sources[0]?.selection_complete).toBe(false)
  expect(packet.evidence.warnings).toContain('原文读取达到页数上限。')
})

it('reports unavailable retrieval without accepting discovery summaries as evidence and propagates cancellation', async () => {
  const knowledge: PolicyV2Knowledge = { search: async () => { throw new Error('offline') }, read: async () => page }
  const packet = await preparePolicyEvidence(knowledge, '问题', settings, signal())
  expect(packet.evidence.status).toBe('unavailable')
  expect(packet.evidence.sources).toEqual([])
  const controller = new AbortController()
  controller.abort()
  await expect(preparePolicyEvidence(knowledge, '问题', settings, controller.signal)).rejects.toThrow()
})
