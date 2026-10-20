/** Create disposable national-policy data for the container startup smoke. */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PolicyV2Database } from '../../packages/experimental/environment-policy/lib/types/v2-database.js'

const directory = process.argv[2]
if (!directory) throw new Error('Pass the private smoke data directory')
const text = '# Fixture policy\n\n第一条 保护生态环境。\n'
PolicyV2Database.create(join(directory, 'policy-v2-national.sqlite'), [{
  id: 'fixture', title: 'Fixture policy', document_number: null, standard_number: null,
  document_type: null, issuing_authority: null, region: '全国', publish_date: null,
  effective_date: null, legal_status: null, description: 'Fixture description', full_text: text,
  pdf_path: null, markdown_path: 'fixture.md', source_hash: createHash('sha256').update(text).digest('hex'), text_status: 'complete',
}])
writeFileSync(join(directory, 'policy-v2-documents.compat.json'), JSON.stringify({ legacy_build_id: 'fixture', documents: {}, units: {} }))
