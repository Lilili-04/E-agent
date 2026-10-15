/** Evaluate retrieval against a read-only corpus; no model answer or legal-accuracy score is inferred. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { ENVIRONMENT_POLICY_EVALUATION_CASES } from './cases.ts'

const { values } = parseArgs({ options: {
  database: { type: 'string' }, output: { type: 'string' }, 'implementation-root': { type: 'string' },
  'hybrid-config': { type: 'string' },
} })
if (!values.database || !values.output) throw new Error('Pass --database <snapshot.sqlite> --output <report.json>')
if (existsSync(values.output)) throw new Error('Report output already exists; choose a new file to preserve existing data.')
const implementation = resolve(values['implementation-root'] ?? fileURLToPath(new URL('../src/', import.meta.url)))
const { PolicyDatabase }: typeof import('../src/database.ts') = await import(pathToFileURL(resolve(implementation, 'database.ts')).href)
const { SqliteQueryStore }: typeof import('../src/query-store.ts') = await import(pathToFileURL(resolve(implementation, 'query-store.ts')).href)
const { queryPolicies }: typeof import('../src/query.ts') = await import(pathToFileURL(resolve(implementation, 'query.ts')).href)
const database = new PolicyDatabase(values.database, { readOnly: true })
try {
  let store = new SqliteQueryStore(database)
  if (values['hybrid-config']) {
    const { HybridQueryStore }: typeof import('../src/hybrid-store.ts') = await import(pathToFileURL(resolve(implementation, 'hybrid-store.ts')).href)
    store = new HybridQueryStore(database, JSON.parse(readFileSync(values['hybrid-config'], 'utf8')))
  }
  const cases = [...ENVIRONMENT_POLICY_EVALUATION_CASES, ...[
    '中华人民共和国核安全法', '中华人民共和国核安全法第一条规定了什么？',
    '中华人民共和国水土保持法讲了什么', '养猪场粪污处理有哪些要求？',
    '企业排放污水超过标准应当承担什么法律责任？', '养殖产生的粪水能直接排入河里吗？',
  ].map((question, index) => ({ id: `regression-${index + 1}`, question, category: 'regression',
    expectedDocumentTitles: index < 2 ? ['中华人民共和国核安全法'] : index === 2 ? ['中华人民共和国水土保持法']
      : index === 4 ? ['中华人民共和国水污染防治法'] : ['畜禽规模养殖污染防治条例'], expectResults: true }))]
  const rows = []
  for (const item of cases) {
    const started = performance.now()
    const bundle = await queryPolicies(store, item.question, { currentDate: '2026-10-15' })
    const elapsedMs = performance.now() - started
    const titles = [...new Set(bundle.results.flatMap(hit => hit.title ? [hit.title] : []))]
    const passed = item.expectResults ? item.expectedDocumentTitles.some(title => titles.includes(title)) : titles.length === 0
    const integrity = bundle.results.every((hit) => {
      const original = database.readUnitsById([hit])[0]
      return original !== undefined && original.text.includes(hit.text) && original.title === hit.title
        && original.publishDate === hit.publishDate && original.documentNumber === hit.documentNumber
        && hit.lineStart >= original.lineStart && hit.lineEnd <= original.lineEnd
    })
    rows.push({ id: item.id, question: item.question, category: item.category, passed, integrity, elapsedMs,
      titles, diagnostics: bundle.diagnostics, warnings: bundle.warnings, resultCount: bundle.results.length })
  }
  const times = rows.map(row => row.elapsedMs).sort((a, b) => a - b)
  const summary = { count: rows.length, titleOrAbsencePassed: rows.filter(row => row.passed).length,
    sourceIntegrityPassed: rows.filter(row => row.integrity).length,
    p50Ms: times[Math.floor(times.length * 0.5)], p95Ms: times[Math.floor(times.length * 0.95)],
    baseline90Passed: rows.slice(0, 90).filter(row => row.passed).length,
    regression6Passed: rows.slice(90).filter(row => row.passed).length,
    limitation: 'Expected-title/presence checks measure retrieval only, not answer accuracy or legal correctness.' }
  const report = { mode: values['hybrid-config'] ? 'hybrid' : 'lexical', index: database.getManifest(), summary, rows }
  writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(summary))
  if (rows.some(row => !row.integrity)) process.exitCode = 1
} finally {
  database.close()
}
