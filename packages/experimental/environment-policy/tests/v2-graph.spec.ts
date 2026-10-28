import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { PolicyV2Database, type PolicyDocument, type PolicyV2ReadResult } from '../src/v2-database.ts'
import Service from '../src/v2-service.ts'
import * as Tools from '../src/v2-tools.ts'
import { sourceUnits } from '../src/v2-parser.ts'
import type { GraphContext } from '../src/v2-graph.ts'
import { readRequest, readResult, searchResult } from '../src/v2-wire.ts'

function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing fixture value')
  return value
}
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function fixture(bodyStatus = 'complete') {
  const root = await mkdtemp(join(tmpdir(), 'policy-graph-')); roots.push(root)
  const path = join(root, 'sources.sqlite')
  const full_text = '# 印发通知\n通知说明不得当作附件正文。\n# 试验办法\n第一条 附件正文。\n第二条 旧办法同时废止，日期尚待核实。\n'
  const document: PolicyDocument = { id: 'notice', title: '云南省印发试验办法的通知', full_text, description: '',
    source_hash: hash(full_text), document_number: '云规〔2024〕2号', standard_number: null, document_type: '通知',
    issuing_authority: null, region: '云南省', publish_date: '2024-05-14', effective_date: null,
    legal_status: '待核实', pdf_path: null, markdown_path: 'fixture.md', text_status: 'complete' }
  PolicyV2Database.create(path, [document])
  const units = sourceUnits(document.id, full_text)
  const ref = (line: number) => ({ document_id: document.id,
    unit_id: present(units.find(u => u.line_start <= line && u.line_end >= line)).id, line_start: line, line_end: line })
  const regulations = [
    { id: 'reg-notice', title: document.title, region: '云南省', aliases: [] },
    { id: 'reg-attachment', title: '云南省试验办法（试行）', region: '云南省', aliases: ['试验办法'] },
    { id: 'reg-old', title: '云南省旧办法', region: '云南省', aliases: [] },
  ]
  const version = (id: string, title: string, document_ids: string[], status: string, evidence: ReturnType<typeof ref>[]) => ({
    id, title, document_ids, document_number: null, publish_date: null, revision_date: null, effective_date: null,
    version_label: '', source_text_status: status, review_status: 'verified', review_reason: '', evidence_refs: evidence.map(r => JSON.stringify(r)),
  })
  const versions = [version('ver-notice', document.title, ['notice'], bodyStatus, []),
    { ...version('ver-attachment', '云南省试验办法（试行）（2024年版附件）', [], 'bundled_attachment', [ref(3), ref(5)]), version_label: '2024年版附件' },
    { ...version('ver-old', '云南省旧办法（2011年版）', [], 'history_only', [ref(5)]), publish_date: '2011-01-31' },
  ]
  const relations = versions.map((v, i) => ({ id: `owner-${i}`, type: 'HAS_VERSION', from: present(regulations[i]).id, to: v.id,
    date: null, scope: 'unknown', scope_text: '', evidence: '', source_refs: [] as ReturnType<typeof ref>[],
    review_status: 'verified', review_reason: '' }))
  relations.push({ id: 'repeal', type: 'REPEALS', from: 'ver-attachment', to: 'ver-old', date: null,
    scope: 'full', scope_text: '', evidence: '旧办法同时废止，日期尚待核实。', source_refs: [ref(5)], review_status: 'needs_source', review_reason: '不能用通知日期代替' })
  const snapshot = join(root, 'graph.json'); const data = JSON.stringify({ regulations, versions, relations }); await writeFile(snapshot, data)
  const graphConfigPath = join(root, 'graph-config.json')
  await writeFile(graphConfigPath, JSON.stringify({ endpoint: 'http://127.0.0.1:17475/db/neo4j/tx/commit', group: 'policy-combined-v4',
    snapshot, snapshotSha256: hash(data), databaseSha256: hash(await readFile(path)),
    timeoutMs: 5000, versionLimit: 8, eventLimit: 30, contextCharacters: 8000 }))
  const latestManifestPath = join(root, 'latest.json')
  await writeFile(latestManifestPath, JSON.stringify({ format: 1, database_sha256: hash(await readFile(path)), entries: [
    { title: document.title, aliases: [], region: '云南省', document_ids: ['notice'], all_document_ids: ['notice'], source_text_status: bodyStatus, status: 'ready' },
  ] }))
  const payload = { errors: [], results: [{ data: [
    ...versions.map(v => ({ row: [v.id, v.title, v.document_ids, v.version_label, v.source_text_status, v.evidence_refs,
      v.publish_date, v.revision_date, v.effective_date, v.document_number, v.review_status, v.review_reason, null, null] })),
    ...regulations.map(r => ({ row: [r.id, r.title, null, null, null, null, null, null, null, null, null, null, r.region, r.aliases] })),
  ] }, { data: relations.map(r => ({ row: [r.id, r.type, r.from, r.to, r.date, r.scope, r.scope_text, r.evidence,
    JSON.stringify(r.source_refs), r.review_status, r.review_reason] })) }] }
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    if (typeof options.body !== 'string') throw new Error('Expected JSON body')
    const body = JSON.parse(options.body) as { statements: { statement: string; parameters: { group: string } }[] }
    expect(body.statements).toHaveLength(2)
    expect(body.statements.every((s: { statement: string }) => s.statement.startsWith('MATCH ') && !/CREATE|SET |DELETE/u.test(s.statement))).toBe(true)
    expect(body.statements[0]?.parameters.group).toBe('policy-combined-v4')
    return Response.json(payload)
  }); vi.stubGlobal('fetch', fetcher)
  return { path, graphConfigPath, latestManifestPath, root, payload, fetcher, full_text }
}

it('composes the same two tools through Loader and records historical uncertainty in their output', async () => {
  const f = await fixture(); const ctx = new Context()
  try {
    const config = join(f.root, 'cordis.yml')
    await writeFile(config, ['- name: cordis:prompt', '- name: cordis:tools', '- name: cordis:policy',
      `  config: ${JSON.stringify({ path: f.path, graphConfigPath: f.graphConfigPath, latestManifestPath: f.latestManifestPath })}`, '- name: cordis:policy-tools', ''].join('\n'))
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: ToolRuntime, policy: Service, 'policy-tools': Tools })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } }); await ctx.loader.await()
    expect(ctx.tools.schemas().map(t => t.name)).toEqual(['policy_search', 'policy_read'])
    const agent = {} as NonNullable<import('@deepseek-ai/dsh-tools').ToolExecutionInput['agent']>
    const execute = async <T>(name: string, args: object): Promise<T> => {
      const result = await ctx.tools.execute({ name, arguments: args, callId: ToolCallId('graph-test'), agent, signal: new AbortController().signal })
      if (result.isError) throw new Error(JSON.stringify(result.content))
      const block = result.content.find(b => b.type === 'text'); if (block?.type !== 'text') throw new Error('No text')
      const decoded: unknown = JSON.parse(block.text)
      return decoded as T
    }
    const ordinary = await execute<{ route: string; graph?: GraphContext; documents: { id: string }[] }>(
      'policy_search', { question: '《云南省印发试验办法的通知》全文' })
    const ordinaryPage = await execute<PolicyV2ReadResult>('policy_read', { document_id: 'notice' })
    expect({ route: ordinary.route, graph: ordinary.graph ?? null, documents: ordinary.documents.map(d => d.id),
      complete: ordinaryPage.source_complete, graphCalls: f.fetcher.mock.calls.length }).toMatchInlineSnapshot(`
        {
          "complete": true,
          "documents": [
            "notice",
          ],
          "graph": null,
          "graphCalls": 0,
          "route": "exact_document",
        }
      `)
    const result = await execute<{ route: string; graph: GraphContext }>('policy_search', { question: '《云南省试验办法》废止了什么？' })
    const page = await execute<PolicyV2ReadResult>('policy_read', { document_id: 'notice', version_id: 'ver-old' })
    expect({ route: result.route, selected: result.graph.selected_version_ids, date: present(result.graph.events[0]).date,
      issuer: present(result.graph.events[0]).issuing_version_id, target: present(result.graph.events[0]).target_version_id,
      role: page.text_role, text: page.text, complete: page.source_complete }).toMatchInlineSnapshot(`
        {
          "complete": false,
          "date": null,
          "issuer": "ver-attachment",
          "role": "history_evidence",
          "route": "graph_version_without_body",
          "selected": [
            "ver-attachment",
          ],
          "target": "ver-old",
          "text": "第二条 旧办法同时废止，日期尚待核实。
        ",
        }
      `)
    expect(f.fetcher).toHaveBeenCalledTimes(1)
  } finally { await ctx.fiber.dispose() }
})

it('reads only the bundled attachment and binds continuation to version as well as physical source', async () => {
  const f = await fixture(); const ctx = new Context()
  try {
    await ctx.plugin(Service, { path: f.path, graphConfigPath: f.graphConfigPath, latestManifestPath: f.latestManifestPath })
    const service = ctx.environmentPolicyV2 as Service
    const page = await service.read({ document_id: 'notice', version_id: 'ver-attachment' })
    expect(page.text).toBe(f.full_text.slice(f.full_text.indexOf('# 试验办法')))
    expect(page.text_role).toBe('attachment'); expect(page.source_complete).toBe(false)
    expect(readResult(page)).toEqual(page)
    const { PolicyV2Graph } = await import('../src/v2-graph.ts')
    const graph = new PolicyV2Graph(service.database, f.graphConfigPath, f.path)
    const first = graph.read({ document_id: 'notice', version_id: 'ver-attachment' }, 12)
    expect(first.has_more).toBe(true)
    expect(() => graph.read({ document_id: 'notice', version_id: 'ver-old', cursor: present(first.next_cursor) }, 12)).toThrow('version/scope')
    await expect(service.read({ document_id: 'notice', version_id: 'ver-old', scope: 'article', selector: '第一条' })).rejects.toThrow('Historical body is unavailable')
    expect(readRequest({ document_id: 'notice', version_id: 'ver-old' }).version_id).toBe('ver-old')
  } finally { await ctx.fiber.dispose() }
})

it('keeps explicit region, document and missing version constraints before lexical fallback', async () => {
  const f = await fixture(); const ctx = new Context()
  try {
    await ctx.plugin(Service, { path: f.path, graphConfigPath: f.graphConfigPath, latestManifestPath: f.latestManifestPath })
    const wrongRegion = await ctx.environmentPolicyV2.search({ question: '《云南省试验办法》废止了什么', region: '全国', region_mode: 'only' })
    expect(wrongRegion.graph?.versions).toEqual([]); expect(wrongRegion.documents).toEqual([])
    const scoped = await ctx.environmentPolicyV2.search({ question: '云南省试验办法', document_id: 'notice' })
    expect(scoped.graph).toBeUndefined()
    const scopedHistory = await ctx.environmentPolicyV2.search({ question: '云南省试验办法沿革', document_id: 'notice' })
    expect(scopedHistory.graph?.versions.every(v => v.body_document_ids.includes('notice'))).toBe(true)
    const missing = await ctx.environmentPolicyV2.search({ question: '《云南省旧办法》2001年版第一条' })
    expect(missing.passages).toEqual([]); expect(missing.documents).toEqual([])
    expect(missing.graph?.warnings.join('')).toContain('指定年份版本未收录')
    await expect(ctx.environmentPolicyV2.search({ question: '云南省2001年版第一条', document_id: 'notice' }))
      .rejects.toThrow('specified graph version/year')
    expect(searchResult(missing)).toEqual(missing)
    expect(() => searchResult({ ...missing, graph: { ...missing.graph, events: [{ type: 'invented' }] } })).toThrow('Invalid remote')
  } finally { await ctx.fiber.dispose() }
})

it('refuses a changed live partition instead of returning stale event evidence', async () => {
  const f = await fixture(); present(present(f.payload.results[1]).data.at(-1)).row[4] = '2024-06-13'
  const ctx = new Context()
  try {
    await ctx.plugin(Service, { path: f.path, graphConfigPath: f.graphConfigPath, latestManifestPath: f.latestManifestPath })
    await expect(ctx.environmentPolicyV2.search({ question: '云南省试验办法沿革' })).rejects.toThrow('Graph event mismatch')
  } finally { await ctx.fiber.dispose() }
})

it('retains a reviewed version source gap even when the body catalog says complete', async () => {
  const f = await fixture('partial'); const ctx = new Context()
  try {
    await ctx.plugin(Service, { path: f.path, graphConfigPath: f.graphConfigPath, latestManifestPath: f.latestManifestPath })
    const implicit = await ctx.environmentPolicyV2.read({ document_id: 'notice' })
    expect(f.fetcher).not.toHaveBeenCalled()
    const explicit = await ctx.environmentPolicyV2.read({ document_id: 'notice', version_id: 'ver-notice' })
    expect(implicit.document.text_status).toBe('complete')
    expect(implicit.source_complete).toBe(false)
    expect(explicit.source_complete).toBe(false)
  } finally { await ctx.fiber.dispose() }
})
