import { expect, it, vi } from 'vitest'
import { parsePolicyPlan, preparePlannedEvidence, type PolicyModelCall, type PlannedEvidence } from '../src/v2-plan.ts'
import type { PolicyV2Knowledge, PolicyV2SearchResult } from '../src/v2-service.ts'
import type { DocumentCard, PolicyV2ReadResult } from '../src/v2-database.ts'

const document: DocumentCard = { id: 'law', title: '测试条例', document_number: null, standard_number: null,
  document_type: '条例', issuing_authority: null, region: '全国', publish_date: null, effective_date: null,
  legal_status: '现行有效', description: '', source_hash: 'hash', text_status: 'complete' }
const page: PolicyV2ReadResult = { document, scope: 'full', units: [], text: '第一条 保存五年。', found: true,
  has_more: false, next_cursor: null, source_complete: true, unit_fragments: false }
const result: PolicyV2SearchResult = { target: 'documents', route: 'exact_document', documents: [document],
  passages: [], requires_full_read: false, diagnostics: { lexical: 1, semantic_documents: 0, semantic_passages: 0,
    rejected_vectors: 0, elapsed_ms: 0, warnings: [] } }
const settings = { characters: 5000, pages: 4, documents: 2, timeoutMs: 1000, tasks: 4, searches: 4, reviews: 2 }
const plan = { tasks: [{ id: 'q1', question: '保存多久', query: '保存期限', mode: 'facts', document_title: '测试条例' }] }
const review = { coverage: [{ task_id: 'q1', status: 'covered', source_ids: ['E1'], reason: '原文直接规定期限' }] }

it('rejects duplicate tasks, invented historical years and malformed article addresses', () => {
  expect(() => parsePolicyPlan(JSON.stringify({ tasks: [...plan.tasks, ...plan.tasks] }), '问题', 4)).toThrow('Duplicate')
  expect(() => parsePolicyPlan(JSON.stringify({ tasks: [{ ...plan.tasks[0], mode: 'history', year: '2005' }] }), '问题', 4)).toThrow('year')
  expect(() => parsePolicyPlan(JSON.stringify({ tasks: [{ ...plan.tasks[0], article: '虚构条款' }] }), '问题', 4)).toThrow('article')
})

it('executes the model-selected route and retains original scope independently of rewritten queries', async () => {
  const search = vi.fn<PolicyV2Knowledge['search']>().mockResolvedValue(result)
  const call = vi.fn<PolicyModelCall>().mockResolvedValueOnce(JSON.stringify(plan)).mockResolvedValueOnce(JSON.stringify(review))
  const output = await preparePlannedEvidence({ search, read: () => page }, '江苏省保存多久？', '', settings,
    call, new AbortController().signal)
  expect(search.mock.calls[0]?.[0]).toEqual({ question: '《测试条例》 保存期限', scope_question: '江苏省保存多久？',
    mode: 'facts', target: 'passages' })
  expect(output.evidence.coverage).toEqual(review.coverage)
  expect(output.evidence.sources[0]?.source_id).toBe('E1')
  expect(output.text.length).toBeLessThanOrEqual(settings.characters)
})

it('performs targeted supplementary retrieval for an uncovered subquestion without changing other tasks', async () => {
  const search = vi.fn<PolicyV2Knowledge['search']>().mockResolvedValue(result)
  const call = vi.fn<PolicyModelCall>().mockResolvedValueOnce(JSON.stringify(plan))
    .mockResolvedValueOnce(JSON.stringify({ coverage: [{ ...review.coverage[0], status: 'partial',
      followup: { query: '记录保存期限', mode: 'facts', document_title: '测试条例', article: '第一条' } }] }))
    .mockResolvedValueOnce(JSON.stringify(review))
  const output = await preparePlannedEvidence({ search, read: () => page }, '记录保存多久？', '', settings,
    call, new AbortController().signal)
  expect(search).toHaveBeenCalledTimes(2)
  expect(search.mock.calls[1]?.[0].question).toContain('第一条')
  expect(output.evidence.coverage[0]?.status).toBe('covered')
})

it('does not accept made-up evidence IDs or ineffective current-law sources as verified coverage', async () => {
  const call = vi.fn<PolicyModelCall>().mockResolvedValueOnce(JSON.stringify(plan))
    .mockResolvedValueOnce(JSON.stringify({ coverage: [{ ...review.coverage[0], source_ids: ['invented'] }] }))
  const output = await preparePlannedEvidence({ search: async () => result, read: () => page }, '问题', '', settings,
    call, new AbortController().signal)
  expect(output.evidence.coverage[0]?.status).toBe('missing')
  const stale: PolicyV2Knowledge = { search: async () => result,
    read: () => ({ ...page, document: { ...document, legal_status: '废止或失效' } }) }
  const staleCall = vi.fn<PolicyModelCall>().mockResolvedValueOnce(JSON.stringify(plan))
    .mockResolvedValue(JSON.stringify({ coverage: [{ ...review.coverage[0], status: 'missing', source_ids: [] }] }))
  const empty = await preparePlannedEvidence(stale, '问题', '', settings, staleCall, new AbortController().signal)
  expect(empty.evidence.sources).toEqual([])
})

it('keeps explicit gaps when the execution budget is exhausted and propagates caller cancellation', async () => {
  const call = vi.fn<PolicyModelCall>().mockResolvedValueOnce(JSON.stringify(plan))
    .mockResolvedValue(JSON.stringify({ coverage: [{ ...review.coverage[0], status: 'missing', source_ids: [],
      followup: { query: '再检索', mode: 'facts' } }] }))
  const output = await preparePlannedEvidence({ search: async () => result, read: () => page }, '问题', '',
    { ...settings, searches: 1 }, call, new AbortController().signal)
  expect(output.evidence.searches).toBe(1)
  expect(output.evidence.coverage[0]?.status).toBe('missing')
  const controller = new AbortController(); controller.abort()
  await expect(preparePlannedEvidence({ search: async () => result, read: () => page }, '问题', '', settings,
    async () => { throw new Error('aborted') }, controller.signal)).rejects.toThrow()
})

it('uses independent task coverage rather than assuming one matching passage answers a compound question', async () => {
  const compound = { tasks: [...plan.tasks, { ...plan.tasks[0], id: 'q2', question: '记录什么', query: '记录内容' }] }
  const call: PolicyModelCall = async (stage, _system, input) => {
    if (stage === 'plan') return JSON.stringify(compound)
    const packet = JSON.parse(input) as PlannedEvidence
    return JSON.stringify({ coverage: packet.plan.tasks.map(t => ({ task_id: t.id,
      status: t.id === 'q1' ? 'covered' : 'missing', source_ids: t.id === 'q1' ? ['E1'] : [], reason: '按子问题核查' })) })
  }
  const output = await preparePlannedEvidence({ search: async () => result, read: () => page }, '记录什么，保存多久？', '',
    settings, call, new AbortController().signal)
  expect(output.evidence.coverage.map(c => c.status)).toEqual(['covered', 'missing'])
})

it('discovers actual sources when a model candidate is absent, without relaxing an explicit user title', async () => {
  const guessed = { tasks: [{ ...plan.tasks[0], document_title: '未收录候选条例' }] }
  const missing = { ...result, route: 'explicit_document_missing', documents: [] }
  const search = vi.fn<PolicyV2Knowledge['search']>().mockResolvedValueOnce(missing).mockResolvedValue(result)
  const call = vi.fn<PolicyModelCall>().mockResolvedValueOnce(JSON.stringify(guessed)).mockResolvedValueOnce(JSON.stringify(review))
  const output = await preparePlannedEvidence({ search, read: () => page }, '保存多久？', '', settings,
    call, new AbortController().signal)
  expect(search).toHaveBeenCalledTimes(2)
  expect(search.mock.calls[1]?.[0].question).toBe('保存多久')
  expect(output.evidence.coverage[0]?.status).toBe('covered')
  const explicitSearch = vi.fn<PolicyV2Knowledge['search']>().mockResolvedValue(missing)
  const explicitCall = vi.fn<PolicyModelCall>().mockResolvedValueOnce(JSON.stringify(guessed))
    .mockResolvedValue(JSON.stringify({ coverage: [{ task_id: 'q1', status: 'missing', source_ids: [], reason: '指定文件未收录' }] }))
  const explicit = await preparePlannedEvidence({ search: explicitSearch, read: () => page }, '《未收录候选条例》保存多久？', '',
    { ...settings, reviews: 1 }, explicitCall, new AbortController().signal)
  expect(explicitSearch).toHaveBeenCalledTimes(1)
  expect(explicit.evidence.sources).toEqual([])
})

it('normalizes empty optional JSON fields and numeric user years without allowing invented years', () => {
  const parsed = parsePolicyPlan(JSON.stringify({ tasks: [{ ...plan.tasks[0], year: 2005, article: '', document_title: null }] }),
    '2005年旧版', 4)
  expect(parsed.tasks[0]?.year).toBe('2005')
  expect(parsed.tasks[0]).not.toHaveProperty('article')
  const current = parsePolicyPlan(JSON.stringify({ tasks: [{ ...plan.tasks[0], year: '2014' }] }), '保存多久', 4)
  expect(current.tasks[0]).not.toHaveProperty('year')
})
