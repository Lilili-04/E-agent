/** Compare real local sources through the v2 provider, recording routes, timings and evidence. */
import { readFileSync, writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import PolicyV2Service from '../packages/experimental/environment-policy/src/v2-service.ts'
import { policyTerms } from '../packages/experimental/environment-policy/src/v2-tokenizer.ts'

const [database, output, semanticConfigPath, compatibilityPath] = process.argv.slice(2)
if (!database || !output) throw new Error('Usage: evaluate-policy-v2.ts database output.json [semantic-config compatibility-map]')
const ctx = new Context()
try {
  await ctx.plugin(PolicyV2Service, { path: database, ...(semanticConfigPath ? { semanticConfigPath, compatibilityPath } : {}) })
  const provider = ctx.environmentPolicyV2
  if (!(provider instanceof PolicyV2Service)) throw new Error('Evaluation requires the local SQLite provider')
  const questions = [
    '中华人民共和国水土保持法第二十六条是什么？',
    '水土保持法讲了什么',
    '中华人民共和国核安全法讲了什么',
    '中华人民共和国生态环境法典第一千二百四十二条是什么',
    '水土保持法第999条是什么',
    '养殖场的废水能直接排到河里吗？',
    '危险废物转移需要什么手续？',
    '排污许可证管理有哪些法规？',
    '《不存在的环境法规》第一条是什么？',
    '水土保持法中生产建设项目有哪些要求？',
  ]
  const results = []
  for (const question of questions) {
    const result = await provider.search({ question })
    const reads = []
    const doc = result.documents[0]
    if (result.requires_full_read && result.documents.length === 1 && doc) {
      let page = await provider.read({ document_id: doc.id })
      let text = page.text; let pages = 1
      while (page.has_more) {
        if (!page.next_cursor) throw new Error('Incomplete read has no continuation cursor')
        page = await provider.read({ document_id: doc.id, cursor: page.next_cursor })
        text += page.text; pages++
      }
      const path = provider.database.sql.prepare('SELECT markdown_path FROM documents WHERE id=?').get(doc.id)?.markdown_path
      reads.push({ document: doc.title, pages, characters: text.length,
        exact_source_match: typeof path === 'string' && readFileSync(path, 'utf8').replace(/^\uFEFF/u, '') === text })
    }
    const item = {
      question, terms: policyTerms(question), ...result, reads,
    }
    results.push(item)
    console.log(JSON.stringify({ question, route: result.route, ...result.diagnostics,
      documents: result.documents.map(doc => doc.title), passages: result.passages.map(unit => `${unit.document.title} ${unit.label}`), reads }))
  }
  writeFileSync(output, JSON.stringify({ evaluated_at: new Date().toISOString(), database, semantic: !!semanticConfigPath, results }, null, 2) + '\n')
} finally { await ctx.fiber.dispose() }
