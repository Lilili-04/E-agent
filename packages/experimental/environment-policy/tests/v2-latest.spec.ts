import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { PolicyV2Database, type PolicyDocument } from '../src/v2-database.ts'
import Service from '../src/v2-service.ts'
import { needsPolicyGraph } from '../src/v2-latest.ts'

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'policy-latest-')); roots.push(root)
  const path = join(root, 'body.sqlite'), latestManifestPath = join(root, 'latest.json')
  const docs: PolicyDocument[] = ['old', 'new', 'local', 'gap'].map((id) => {
    const full_text = `第一条 污水治理${id}。\n`
    return { id, title: id === 'gap' ? '排水管理条例' : '污染管理办法', full_text, description: '污水治理',
      source_hash: hash(full_text), document_number: null, standard_number: null, document_type: '法规',
      issuing_authority: null, region: id === 'local' ? '江苏省' : '全国', publish_date: null, effective_date: null,
      legal_status: null, pdf_path: null, markdown_path: 'fixture.md', text_status: 'complete' }
  })
  PolicyV2Database.create(path, docs)
  await writeFile(latestManifestPath, JSON.stringify({ format: 1, database_sha256: hash(await readFile(path)), entries: [
    { title: '污染管理办法', aliases: [], region: '全国', document_ids: ['new'], all_document_ids: ['old', 'new'], source_text_status: 'complete', status: 'ready' },
    { title: '污染管理办法', aliases: [], region: '江苏省', document_ids: ['local'], all_document_ids: ['local'], source_text_status: 'partial', status: 'ready' },
    { title: '排水管理条例', aliases: [], region: '全国', document_ids: [], all_document_ids: ['gap'], source_text_status: 'history_only', status: 'missing_body' },
  ] }))
  return { path, latestManifestPath, root, docs }
}

it('retrieves only national latest bodies and reads them with no graph configuration or network access', async () => {
  const f = await fixture(); const ctx = new Context()
  const fetcher = vi.fn(() => { throw new Error('All network is unavailable') }); vi.stubGlobal('fetch', fetcher)
  try {
    await ctx.plugin(Service, { path: f.path, latestManifestPath: f.latestManifestPath, graphConfigPath: join(f.root, 'unavailable-graph.json') })
    const exact = await ctx.environmentPolicyV2.search({ question: '《污染管理办法》第一条' })
    expect(exact.passages.map(p => p.document_id)).toEqual(['new'])
    const topic = await ctx.environmentPolicyV2.search({ question: '污水治理' })
    expect(topic.passages.map(p => p.document_id)).toEqual(['new'])
    expect(topic.graph).toBeUndefined()
    const files = await ctx.environmentPolicyV2.search({ question: '污水治理', target: 'documents' })
    expect(files.documents.map(d => d.id)).toEqual(['new'])
    const local = await ctx.environmentPolicyV2.search({ question: '江苏省污水治理', region_mode: 'only' })
    expect(local.passages.map(p => p.document_id)).toEqual(['local'])
    expect((await ctx.environmentPolicyV2.read({ document_id: 'new' })).text).toContain('治理new')
    expect((await ctx.environmentPolicyV2.read({ document_id: 'local' })).source_complete).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
    await expect(ctx.environmentPolicyV2.search({ question: '污染管理办法是否有效' })).rejects.toThrow()
  } finally { await ctx.fiber.dispose() }
})

it('reports missing latest text, rejects implicit old document scopes, and never infers province from a document', async () => {
  const f = await fixture(); const ctx = new Context()
  try {
    await ctx.plugin(Service, { path: f.path, latestManifestPath: f.latestManifestPath })
    const missing = await ctx.environmentPolicyV2.search({ question: '《排水管理条例》全文' })
    expect(missing.route).toBe('latest_version_unavailable')
    expect(missing.documents).toEqual([]); expect(missing.requires_full_read).toBe(false)
    await expect(ctx.environmentPolicyV2.search({ question: '污水治理', document_id: 'old' })).rejects.toThrow('not a verified latest')
    await expect(ctx.environmentPolicyV2.search({ question: '第一条', document_id: 'local' })).rejects.toThrow('outside the selected region')
  } finally { await ctx.fiber.dispose() }
})

it('routes explicit versions and validity questions to history without mistaking quoted title words for intent', () => {
  for (const question of ['2002年版管理办法', '管理办法旧版', '管理办法废止了吗', '管理办法目前是否适用', '截至2010年管理办法']) {
    expect(needsPolicyGraph(question, [])).toBe(true)
  }
  for (const question of ['污水如何治理', '《关于修改管理办法的决定》第一条', '污染管理办法最新全文', '污染管理办法最新版本全文', '如何有效治理污水', '排污之前需要准备什么材料']) {
    expect(needsPolicyGraph(question, [])).toBe(false)
  }
})
