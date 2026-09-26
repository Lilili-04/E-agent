import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PolicyDatabase } from '../packages/experimental/environment-policy/src/database.ts'
import {
  loadPolicyImportDocuments,
  type PolicyDescriptionImportRecord,
  type PolicyMetadataImportRecord,
} from '../packages/experimental/environment-policy/src/importer.ts'
import type { SourceInventory } from '../packages/experimental/environment-policy/src/inventory.ts'

interface MetadataReport {
  readonly records: readonly PolicyMetadataImportRecord[]
}

interface DescriptionCorpus {
  readonly records: readonly PolicyDescriptionImportRecord[]
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

const inventoryPath = resolve(argument('--inventory') ?? '../policy_inventory-national.json')
const metadataPath = resolve(argument('--metadata') ?? '../policy_metadata-report-national-v2.json')
const descriptionsPath = resolve(argument('--descriptions') ?? '../policy-descriptions-national-v1.json')
const outputPath = resolve(argument('--output') ?? '../policy-national-v1.sqlite')
const manifestPath = resolve(argument('--manifest') ?? '../policy-national-v1-manifest.json')

const [inventory, metadata, descriptions] = await Promise.all([
  json<SourceInventory>(inventoryPath),
  json<MetadataReport>(metadataPath),
  json<DescriptionCorpus>(descriptionsPath),
])
const documents = await loadPolicyImportDocuments({
  inventory,
  metadata: metadata.records,
  descriptions: descriptions.records,
})
const database = new PolicyDatabase(outputPath)
try {
  const manifest = database.rebuild({
    sourceRoot: inventory.sourceRoot,
    builtAt: new Date().toISOString(),
    documents,
  })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ output: outputPath, manifest: manifestPath, ...manifest }, null, 2)}\n`)
} finally {
  database.close()
}
