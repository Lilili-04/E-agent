/** Offline builder: validate JSONL sources, create a new v2 index and write an external manifest. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { PolicyV2Database, type PolicyDocument } from '../packages/experimental/environment-policy/src/v2-database.ts'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('Usage: node --import tsx/esm scripts/build-policy-v2.ts input.jsonl output.sqlite')
if (existsSync(output)) throw new Error('Choose a fresh output path; existing databases are never overwritten')
const records: unknown[] = readFileSync(input, 'utf8').trim().split('\n').map(line => JSON.parse(line))
const documents: PolicyDocument[] = records.map((value) => {
  if (!value || typeof value !== 'object') throw new Error('Invalid source document')
  const doc = value as PolicyDocument
  for (const field of ['id', 'title', 'description', 'full_text', 'markdown_path', 'source_hash'] as const) {
    if (typeof doc[field] !== 'string') throw new Error(`Missing field ${field}`)
  }
  for (const field of ['document_number', 'standard_number', 'document_type', 'issuing_authority', 'region',
    'publish_date', 'effective_date', 'legal_status', 'pdf_path'] as const) {
    if (doc[field] !== null && typeof doc[field] !== 'string') throw new Error(`Invalid field ${field}`)
  }
  if (!['complete', 'partial', 'missing'].includes(doc.text_status)) throw new Error('Invalid text_status')
  return doc
})
const started = performance.now()
PolicyV2Database.create(output, documents)
const db = new PolicyV2Database(output)
try {
  const manifest = { schema_version: 2, tokenizer: 'jieba-wasm@2.4.0-policy-v1', splitter: 'source-units-v2',
    corpus_hash: createHash('sha256').update(documents.map(doc => `${doc.id}:${doc.source_hash}`).sort().join('\n')).digest('hex'),
    documents: documents.length, units: db.sql.prepare('SELECT count(*) AS n FROM content_units').get()?.n,
    built_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - started) }
  writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify(manifest))
} finally { db.close() }
