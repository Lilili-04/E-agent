import { describe, expect, it } from 'vitest'
import { assessPolicyValidity, checkedPolicyAnswer } from '../src/v2-validity.ts'
import { resolvePolicyShortTitle } from '../src/v2-title-matches.ts'
import type { GraphContext } from '../src/v2-graph.ts'
import type { PolicyEvidence } from '../src/v2-evidence.ts'
const document: PolicyEvidence['sources'][number]['document'] = { id: 'source', title: '废止决定', document_number: null,
  standard_number: null, document_type: '法律', issuing_authority: null, region: '全国', publish_date: null,
  effective_date: null, legal_status: null, description: '', source_hash: 'hash', text_status: 'complete' }
const sources: PolicyEvidence['sources'] = [{ document, text: '测试法自2026年8月15日起废止。', labels: [], source_complete: true,
  selection_complete: true, text_role: 'history_evidence' }]
const event: GraphContext['events'][number] = { id: 'repeal', type: 'REPEALS', issuing_version_id: 'new', target_version_id: null,
  target_id: 'reg', target_title: '测试法', date: '2026-08-15', scope: 'full', scope_text: '', evidence: sources[0]!.text,
  review_status: 'verified', review_reason: '', sources: [{ document_id: 'source', unit_id: 'unit', line_start: 1, line_end: 1 }] }
const version: GraphContext['versions'][number] = { id: 'old', title: '测试法（2023-10-24版）', version_label: '', document_number: null,
  publish_date: '2023-10-24', revision_date: null, effective_date: '2024-01-01', source_text_status: 'complete',
  review_status: 'verified', review_reason: '', body_document_ids: ['old-body'], read_sources: [] }
const graph: GraphContext = { identity_matched: true, selected_version_ids: ['old'], versions: [version], events: [event], truncated: false, warnings: [] }
describe('date-bound validity', () => {
  it('distinguishes the day before, the effective day and a later query date', () => {
    expect(assessPolicyValidity('测试法有效吗？', graph, sources, '2026-08-14')?.status).toBe('future_repeal')
    expect(assessPolicyValidity('测试法有效吗？', graph, sources, '2026-08-15')?.status).toBe('repealed')
    expect(assessPolicyValidity('截至2026年8月14日，测试法有效吗？', graph, sources, '2026-10-28')?.status).toBe('future_repeal')
    expect(assessPolicyValidity('测试法有效吗？', graph, sources, '2026-10-28')?.status).toBe('repealed')
  })
  it('requires the corresponding original, not graph summaries or other source text', () => {
    expect(assessPolicyValidity('测试法有效吗？', graph, [], '2026-10-28')?.status).toBe('unknown')
    expect(assessPolicyValidity('测试法有效吗？', graph, [{ ...sources[0]!, text: '第一条 管理要求。' }], '2026-10-28')?.status).toBe('unknown')
  })
  it('presumes current validity when a complete matched lookup finds no relevant whole-law repeal', () => {
    const body = { ...sources[0]!, document: { ...document, id: 'old-body', title: version.title },
      text: '第一条 管理要求。', text_role: 'body' as const }
    for (const events of [[], [{ ...event, scope: 'partial' }], [{ ...event, target_title: '另一部法' }]]) {
      const validity = assessPolicyValidity('测试法有效吗？', { ...graph, events }, [...sources, body], '2026-10-28')
      expect(validity).toMatchObject({ status: 'presumed_valid', source_titles: [version.title] })
      expect(checkedPolicyAnswer('已被官方确认有效。', validity!)).toMatch(/未查到.*整部废止依据，按现行有效处理/u)
    }
  })
  it('preserves uncertainty for temporal constraints, incomplete lookups and unresolved repeal leads', () => {
    const noEvents = { ...graph, events: [] }
    for (const question of ['截至2025年1月1日测试法有效吗？', '2025年1月1日时测试法有效吗？', '测试法2023年版有效吗？', '测试法2023-10-24版有效吗？']) {
      expect(assessPolicyValidity(question, noEvents, sources, '2026-10-28')?.status).toBe('unknown')
    }
    for (const context of [{ ...noEvents, identity_matched: false }, { ...noEvents, truncated: true },
      { ...noEvents, versions: [{ ...version, effective_date: '2027-01-01' }] }, { ...graph, events: [{ ...event, date: null }] }]) {
      expect(assessPolicyValidity('测试法有效吗？', context, sources, '2026-10-28')?.status).toBe('unknown')
    }
  })
  it('rejects invalid dates and leaves ordinary facts outside the validity guard', () => {
    expect(assessPolicyValidity('截至2026年2月30日，测试法有效吗？', graph, sources)?.status).toBe('unknown')
    expect(assessPolicyValidity('测试法要求保存几年台账？', graph, sources)).toBeUndefined()
  })
  it('corrects an asserted current validity and retains a consistent sourced answer', () => {
    const validity = assessPolicyValidity('测试法有效吗？', graph, sources, '2026-10-28')!
    expect(checkedPolicyAnswer('测试法现行有效，未来将被废止。', validity)).toContain('已于2026-08-15废止')
    expect(checkedPolicyAnswer('测试法现行有效。', validity)).toContain('《废止决定》')
    const answer = validity.opening + '\n\n来源：《废止决定》。'
    expect(checkedPolicyAnswer(answer, validity)).toBe(answer)
    const natural = '截至2026年10月28日，《测试法》已被废止。\n\n《废止决定》规定自2026年8月15日起废止。'
    expect(checkedPolicyAnswer(natural, validity)).toBe(natural)
    expect(checkedPolicyAnswer(validity.opening + '\n该法仍然有效。', validity)).not.toContain('仍然有效')
  })
})
it('resolves only a unique shortened identity and preserves ambiguous names', () => {
  const titles = ['中华人民共和国海洋环境保护法', '中华人民共和国水污染防治法', '中华人民共和国大气污染防治法']
  expect(resolvePolicyShortTitle('海洋保护法现行有效吗？', titles)).toBe(titles[0])
  expect(resolvePolicyShortTitle('污染防治法现行有效吗？', titles)).toBeUndefined()
  expect(resolvePolicyShortTitle('保护法有效吗？', titles)).toBeUndefined()
  expect(resolvePolicyShortTitle('中华人民共和国河道管理条例现行有效吗？', ['中华人民共和国河道管理条例','长江河道采砂管理条例'])).toBeUndefined()
})

it('keeps explicit source-line ranges in cursor identity and cannot widen verified historical ranges', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const paths = await import('node:path')
  const { PolicyV2Database } = await import('../src/v2-database.ts')
  const { readRequest } = await import('../src/v2-wire.ts')
  const root = mkdtempSync(paths.join(tmpdir(), 'policy-line-read-'))
  const path = paths.join(root, 'body.sqlite')
  const { createHash } = await import('node:crypto')
  const full_text = '第一条 第一条的正文内容。\n第二条 第二条的正文内容。\n'
  PolicyV2Database.create(path, [{ ...document, full_text, source_hash: createHash('sha256').update(full_text).digest('hex'), markdown_path: 'fixture.md', pdf_path: null }])
  const database = new PolicyV2Database(path)
  try {
    const selection = readRequest({ document_id: 'source', line_start: 2, line_end: 2 })
    expect(database.read(selection, 1000).text).toBe('第二条 第二条的正文内容。\n')
    const page = database.read(selection, 5)
    expect(page.has_more).toBe(true)
    expect(() => database.read({ document_id: 'source', line_start: 1, line_end: 1, cursor: page.next_cursor! }, 5)).toThrow('Cursor')
    expect(database.read(selection, 1000, { identity: 'old', ranges: [{ start: 1, end: 1 }] }).found).toBe(false)
    expect(() => readRequest({ document_id: 'source', line_start: 2 })).toThrow('Invalid')
    expect(() => readRequest({ document_id: 'source', line_start: 2, line_end: 1 })).toThrow('Invalid')
  } finally { database.close(); rmSync(root, { recursive: true, force: true }) }
})

it('does not turn a future repeal into unconditional current validity', () => {
  const validity = assessPolicyValidity('测试法有效吗？', graph, sources, '2026-08-14')
  if (!validity) throw new Error('Expected validity')
  const answer = '截至2026年8月14日，《测试法》尚未废止，处于有效状态。\n\n《废止决定》规定2026年8月15日废止。'
  expect(checkedPolicyAnswer(answer, validity)).not.toContain('处于有效状态')
  expect(checkedPolicyAnswer(answer, validity)).toContain('仅核对该废止条款的生效时间')
  expect(checkedPolicyAnswer('该法仍处于施行状态。', validity)).not.toContain('仍处于施行状态')
})
