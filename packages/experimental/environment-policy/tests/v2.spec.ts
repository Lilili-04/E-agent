import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PolicyV2Database, type PolicyDocument } from '../src/v2-database.ts'
import { sourceUnits } from '../src/v2-parser.ts'
import { policyTerms, policyMatch } from '../src/v2-tokenizer.ts'
import PolicyV2Service from '../src/v2-service.ts'
import * as Tools from '../src/v2-tools.ts'
import { PolicyV2Semantic } from '../src/v2-semantic.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function doc(id: string, title: string, text: string, description = ''): PolicyDocument {
  return { id, title, full_text: text, description, source_hash: createHash('sha256').update(text).digest('hex'),
    document_number: null, standard_number: null, document_type: '法律', issuing_authority: null, region: '全国',
    publish_date: null, effective_date: null, legal_status: null, pdf_path: null, markdown_path: 'fixture/full.md', text_status: 'complete' }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'policy-v2-')); roots.push(dir)
  const path = join(dir, 'policy.sqlite')
  const original = '# 中华人民共和国水土保持法\r\n\r\n第一章 总则\r\n\r\n## 第一条为了防治水土流失。\r\n\r\n第二条 水土保持设施应当维护。\r\n\r\n第二十六条生产建设项目须编制水土保持方案。\r\n\r\n第二十六条之一不得随意排放污水。\r\n'
  PolicyV2Database.create(path, [
    doc('water', '中华人民共和国水土保持法', original, '水土流失预防、治理和监督。'),
    doc('waste', '畜禽养殖管理条例', '第一条畜禽养殖废水禁止直接排入河道，应当处理。\n', '养殖设施管理。'),
    doc('old', '中华人民共和国水土保持法', '第一条历史文本。\n', '历史版本。'),
  ])
  return { dir, path, original }
}

describe('policy v2 source retrieval', () => {
  it('keeps articles, inserted articles and all original characters across Markdown variants', () => {
    const text = '# 法律\r\n\r\n第一章 总则\r\n第二条正文\r\n下一款。\r\n\r\n## 第二条之一插入条款\r\n第三条 末条\n'
    const units = sourceUnits('law', text)
    expect(units.map(u => u.text).join('')).toBe(text)
    expect(units.filter(u => u.kind === 'article').map(u => u.label)).toEqual(['第二条', '第二条之一', '第三条'])
    expect(units.find(u => u.label === '第二条')?.text).toContain('下一款。')
  })

  it('uses Chinese words and retains negation, repetition and safe literal query syntax', () => {
    expect(policyTerms('水土保持 不得排放 废水 废水')).toEqual(expect.arrayContaining(['水土保持', '不得', '废水', '废水']))
    expect(policyTerms('生态环境')).not.toContain('态环')
    expect(policyMatch('" OR *')).not.toContain('*')
  })

  it('reads consecutive full pages losslessly and rejects cursors for another document or scope', async () => {
    const { path, original } = await fixture(); const db = new PolicyV2Database(path)
    try {
      let page = db.read({ document_id: 'water' }, 40)
      expect(page.has_more).toBe(true)
      const texts = [page.text]
      const cursor = page.next_cursor!
      expect(() => db.read({ document_id: 'old', cursor }, 40)).toThrow('version/scope')
      expect(() => db.read({ document_id: 'water', scope: 'article', selector: '第二条', cursor }, 40)).toThrow('version/scope')
      while (page.has_more) { page = db.read({ document_id: 'water', cursor: page.next_cursor! }, 40); texts.push(page.text) }
      expect(texts.join('')).toBe(original)
      expect(db.read({ document_id: 'water', scope: 'article', selector: '第26条' }, 20).text).toContain('须编制')
      expect(db.read({ document_id: 'water', scope: 'article', selector: '第999条' }, 20).found).toBe(false)
      expect(db.read({ document_id: 'water', scope: 'section', selector: '第一章' }, 1000).text).toContain('第二十六条')
      expect(db.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { db.close() }
  })

  it('recalls body evidence even when its description lacks the search topic', async () => {
    const { path } = await fixture(); const ctx = new Context()
    try {
      await ctx.plugin(PolicyV2Service, { path })
      const result = await ctx.environmentPolicyV2.search({ question: '废水排入河道', target: 'passages' })
      expect(result.passages[0]?.document_id).toBe('waste')
      const scoped = await ctx.environmentPolicyV2.search({ question: '水土保持法第26条是什么' })
      expect(scoped.route).toBe('exact_article')
      expect(scoped.passages.map(p => p.label)).toEqual(['第二十六条'])
      expect(scoped.documents).toHaveLength(2)
      const missing = await ctx.environmentPolicyV2.search({ question: '《不存在的法律》第一条' })
      expect(missing.passages).toEqual([])
      expect(missing.route).toBe('explicit_document_missing')
      const overview = await ctx.environmentPolicyV2.search({ question: '水土保持法讲了什么' })
      expect(overview.requires_full_read).toBe(true)
      expect(overview.target).toBe('documents')
      const topic = await ctx.environmentPolicyV2.search({ question: '水土保持法中生产建设项目有哪些要求？' })
      expect(topic.route).toBe('scoped_passage_bm25_semantic')
      expect(topic.passages[0]?.label).toBe('第二十六条')
    } finally { await ctx.fiber.dispose() }
  })

  it('paginates oversized units without dropping characters or breaking Unicode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'policy-v2-long-')); roots.push(dir)
    const path = join(dir, 'long.sqlite')
    const original = '第一条' + '不得排放污染物😀。\r\n'.repeat(100)
    PolicyV2Database.create(path, [doc('long', '长条款法规', original)])
    const db = new PolicyV2Database(path)
    try {
      let result = db.read({ document_id: 'long' }, 201)
      let actual = result.text
      let pages = 1
      expect(result.unit_fragments).toBe(true)
      while (result.has_more) {
        result = db.read({ document_id: 'long', cursor: result.next_cursor! }, 201)
        expect(result.text.length).toBeLessThanOrEqual(201)
        expect(result.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
        actual += result.text; pages++
        if (pages > 100) throw new Error('Read did not advance')
      }
      expect(actual).toBe(original)
    } finally { db.close() }
  })

  it('rejects vector hits from changed sources and reports collection version mismatches', async () => {
    const { dir, path } = await fixture()
    const config = join(dir, 'semantic.json')
    const compatibility = join(dir, 'compat.json')
    const db = new PolicyV2Database(path)
    await writeFile(config, JSON.stringify({ embeddingUrl: 'http://embedding', chromaUrl: 'http://chroma',
      model: 'qwen3-embedding-4b', documentCollection: 'documents', passageCollection: 'passages' }))
    await writeFile(compatibility, JSON.stringify({ legacy_build_id: 'old-build',
      documents: { legacy: { document_id: 'water', source_hash: db.document('water')!.source_hash } }, units: {} }))
    let version = 'old-build'
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/embeddings')) return Response.json({ data: [{ embedding: Array.from({ length: 2560 }, () => 1) }] })
      if (url.endsWith('/query')) return Response.json({
        metadatas: [[{ record_key: 'legacy', build_id: 'old-build', source_hash: 'changed-source' }]], distances: [[0.01]],
      })
      return Response.json({ id: 'collection', dimension: 2560, metadata: { build_id: version } })
    })
    try {
      const first = await new PolicyV2Semantic(db, config, compatibility).search('水土保持', 'documents')
      expect(first.documents).toEqual([])
      expect(first.rejected).toBe(1)
      version = 'wrong-build'
      const second = await new PolicyV2Semantic(db, config, compatibility).search('水土保持', 'documents')
      expect(second.documents).toEqual([])
      expect(second.warnings.join(' ')).toContain('identity mismatch')
    } finally { vi.unstubAllGlobals(); db.close() }
  })

  it('mounts through Loader and exposes a discover/read model transcript', async () => {
    const { path, dir } = await fixture(); const ctx = new Context()
    try {
      const configPath = join(dir, 'cordis.yml')
      await writeFile(configPath, [
        '- name: cordis:prompt', '- name: cordis:tools', '- name: cordis:policy',
        `  config: { path: ${JSON.stringify(path)} }`, '- name: cordis:policy-tools', '',
      ].join('\n'))
      await ctx.plugin(Loader)
      Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: ToolRuntime, policy: PolicyV2Service, 'policy-tools': Tools })
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      expect(ctx.tools.schemas().map(s => s.name)).toEqual(['policy_search', 'policy_read'])
      const result = await ctx.tools.execute({ name: 'policy_read', arguments: { document_id: 'water', scope: 'article', selector: '第26条' },
        callId: ToolCallId('policy-v2-read'), signal: new AbortController().signal })
      expect(result.isError).toBe(false)
      const text = result.content.find(block => block.type === 'text')
      if (text?.type !== 'text') throw new Error('Missing source evidence')
      const data = JSON.parse(text.text)
      expect({ citation_id: data.citation_id, text: data.text, scope: data.scope,
        found: data.found, has_more: data.has_more, source_complete: data.source_complete })
        .toMatchInlineSnapshot(`
          {
            "citation_id": "1",
            "found": true,
            "has_more": false,
            "scope": "article",
            "source_complete": true,
            "text": "第二十六条生产建设项目须编制水土保持方案。

          ",
          }
        `)
    } finally { await ctx.fiber.dispose() }
  })
})
