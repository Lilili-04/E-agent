import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { PolicyV2Database, type PolicyDocument } from '../src/v2-database.ts'
import { PolicyV2CombinedSemantic } from '../src/v2-combined-semantic.ts'
import PolicyV2Service from '../src/v2-service.ts'

interface Query { where: { $and: Array<{ region?: string; document_id?: { $in: string[] } }> } }
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'combined-policy-')); roots.push(dir)
  const path = join(dir, 'source.sqlite'), config = join(dir, 'semantic.json'), manifest = join(dir, 'manifest.json')
  const docs: PolicyDocument[] = ['全国', '江苏省', '上海市'].map((region, i) => {
    const full_text = `第一条 危险废物转移应当核对联单。${region}😀\r\n\r\n第二条 保存危险废物转移记录。`
    return { id: `d${i}`, title: `${region}固废条例`, description: '危险废物转移管理', full_text,
      source_hash: hash(full_text), region, document_number: null, standard_number: null, document_type: null,
      issuing_authority: null, publish_date: null, effective_date: null, legal_status: null, pdf_path: null,
      markdown_path: 'fixture.md', text_status: 'complete' }
  })
  PolicyV2Database.create(path, docs)
  await writeFile(config, JSON.stringify({ embeddingUrl: 'http://embedding', chromaUrl: 'http://vectors', model: 'qwen',
    documentCollection: 'files', passageCollection: 'passages', documentCandidates: 10, passageCandidates: 30,
    documentMaxDistance: 4, maxDistance: 2 }))
  const m = { complete: true, build_id: 'build', database_sha256: hash(await readFile(path)), model: 'qwen',
    dimension: 2560, normalization: 'l2-unit', offset_unit: 'unicode_code_point',
    metrics: { document: 'l2', passage: 'cosine' }, collections: { document: 'files', passage: 'passages' } }
  await writeFile(manifest, JSON.stringify(m))
  const db = new PolicyV2Database(path)
  const requests: Query[] = []
  let embeddingCalls = 0
  let tamper = '', failRegion = ''
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith('http://embedding')) {
      embeddingCalls++; return Response.json({ data: [{ embedding: [1, ...Array<number>(2559).fill(0)] }] })
    }
    const kind = url.includes('files') ? 'document' : 'passage'
    if (!url.endsWith('/query')) return Response.json({ id: kind === 'document' ? 'files' : 'passages', dimension: 2560,
      metadata: { build_id: 'build', database_sha256: m.database_sha256, model: 'qwen' },
      configuration_json: { hnsw: { space: m.metrics[kind] } } })
    if (typeof init.body !== 'string') throw new Error('Expected a JSON string')
    const body = JSON.parse(init.body) as Query; requests.push(body)
    const region = body.where.$and.find(f => f.region)?.region
    if (region === failRegion) throw new Error('region channel unavailable')
    const ids = body.where.$and.find(f => f.document_id)?.document_id?.$in
    const doc = docs.find(d => d.region === region && (!ids || ids.includes(d.id)))
    if (!doc) return Response.json({ metadatas: [[]], documents: [[]], distances: [[]] })
    const units = db.atSequence(doc.id, 0, 100)
    const first = units[0], last = units.at(-1)
    if (!first || !last) throw new Error('Expected fixture source units')
    const text = kind === 'document' ? `标题：${doc.title}\n内容概述：${doc.description}`
      : `标题：${doc.title}\n章节：\n正文：${units.map(u => u.text.replace(/\r\n/gu, '\n')).join('')}`
    const meta: Record<string, string | number> = { document_id: doc.id, build_id: 'build', source_hash: doc.source_hash,
      region: doc.region ?? '', embedding_text_hash: hash(text), unit_ids: JSON.stringify(units.map(u => u.id), null, 1),
      sequence_start: first.sequence, sequence_end: last.sequence, text_start: 0,
      text_end: Array.from(units.map(u => u.text.replace(/\r\n/gu, '\n')).join('')).length }
    if (tamper === 'source') meta.source_hash = 'wrong'
    if (tamper === 'offset') meta.text_end = Number(meta.text_end) + 1
    if (tamper === 'units') meta.unit_ids = '["another-file-unit"]'
    return Response.json({ metadatas: [[meta]], documents: [[text]], distances: [[0.1]] })
  }))
  return { db, path, config, manifest, requests, manifestData: m, embeddingCalls: () => embeddingCalls,
    setTamper: (s: string) => { tamper = s }, fail: (s: string) => { failRegion = s } }
}

it('embeds once and applies region/build/document scope before all vector queries', async () => {
  const f = await fixture()
  try {
    const semantic = new PolicyV2CombinedSemantic(f.db, f.config, f.manifest, f.path)
    const r = await semantic.search('危险废物转移', 'passages', undefined, { regions: ['全国', '江苏省'], documentIds: ['d1'] })
    expect(f.embeddingCalls()).toBe(1)
    const queries = f.requests
    expect(queries).toHaveLength(4)
    expect(queries.every(r => r.where.$and.some(x => x.document_id?.$in[0] === 'd1'))).toBe(true)
    expect(r.warnings).toEqual([])
    expect(r.passages.length).toBeGreaterThan(0)
    expect(r.passages.every(p => p.document_id === 'd1')).toBe(true)
    expect(r.passages.map(p => p.text).join('')).toContain('😀')
  } finally { f.db.close() }
})

it.each(['source', 'offset', 'units'])('rejects %s mismatches rather than exposing unverified passages', async (tamper) => {
  const f = await fixture(); f.setTamper(tamper)
  try {
    const r = await new PolicyV2CombinedSemantic(f.db, f.config, f.manifest, f.path)
      .search('转移', 'passages', undefined, { regions: ['江苏省'] })
    expect(r.passages).toEqual([]); expect(r.rejected).toBeGreaterThan(0)
  } finally { f.db.close() }
})

it('retains successful regional channels and reports unavailable ones', async () => {
  const f = await fixture(); f.fail('全国')
  try {
    const r = await new PolicyV2CombinedSemantic(f.db, f.config, f.manifest, f.path)
      .search('转移', 'passages', undefined, { regions: ['全国', '江苏省'] })
    expect(r.warnings).toHaveLength(2); expect(r.passages.length).toBeGreaterThan(0)
    expect(r.passages.every(p => p.document.region === '江苏省')).toBe(true)
  } finally { f.db.close() }
})

it('refuses a manifest from another SQLite snapshot', async () => {
  const f = await fixture()
  try {
    const m = { ...f.manifestData, database_sha256: 'wrong' }
    await writeFile(f.manifest, JSON.stringify(m))
    expect(() => new PolicyV2CombinedSemantic(f.db, f.config, f.manifest, f.path)).toThrow('manifest')
  } finally { f.db.close() }
})

it('fuses national and provincial evidence and falls back to lexical evidence when embeddings fail', async () => {
  const f = await fixture(); const ctx = new Context()
  try {
    await ctx.plugin(PolicyV2Service, { path: f.path, semanticConfigPath: f.config, vectorManifestPath: f.manifest })
    const r = await ctx.environmentPolicyV2.search({ question: '危险废物转移', region: '江苏省' })
    expect(new Set(r.passages.map(p => p.document.region))).toEqual(new Set(['全国', '江苏省']))
    const only = await ctx.environmentPolicyV2.search({ question: '仅根据江苏省文件说明危险废物转移要求' })
    expect(only.passages.every(p => p.document.region === '江苏省')).toBe(true)
    expect(only.passages.length).toBeGreaterThan(0)
    expect(only.passages.some(p => (p.unit_ids?.length ?? 0) > 1)).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('embedding offline') }))
    const fallback = await ctx.environmentPolicyV2.search({ question: '危险废物转移', region: '江苏省', region_mode: 'only' })
    expect(fallback.passages.length).toBeGreaterThan(0)
    expect(fallback.passages.every(p => p.document.region === '江苏省')).toBe(true)
    expect(fallback.diagnostics.warnings.join()).toContain('embedding offline')
  } finally { await ctx.fiber.dispose(); f.db.close() }
})


it('applies the offline latest allowlist to every vector channel before ranking', async () => {
  const f = await fixture(); const ctx = new Context()
  const latestManifestPath = join(roots.at(-1)!, 'latest.json')
  await writeFile(latestManifestPath, JSON.stringify({ format: 1, database_sha256: hash(await readFile(f.path)), entries: [
    { title: '江苏省固废条例', aliases: [], region: '江苏省', document_ids: ['d1'], all_document_ids: ['d1'], source_text_status: 'complete', status: 'ready' },
  ] }))
  try {
    await ctx.plugin(PolicyV2Service, { path: f.path, semanticConfigPath: f.config, vectorManifestPath: f.manifest, latestManifestPath })
    const result = await ctx.environmentPolicyV2.search({ question: '江苏省危险废物转移' })
    expect(result.passages.length).toBeGreaterThan(0)
    expect(result.passages.every(p => p.document_id === 'd1')).toBe(true)
    expect(f.requests.length).toBeGreaterThan(0)
    expect(f.requests.every(q => q.where.$and.some(f => JSON.stringify(f.document_id?.$in) === '["d1"]'))).toBe(true)
    const calls = f.embeddingCalls()
    const empty = await ctx.environmentPolicyV2.search({ question: '危险废物转移' })
    expect(empty.passages).toEqual([])
    expect(f.embeddingCalls()).toBe(calls)
  } finally { f.db.close(); await ctx.fiber.dispose() }
})
