import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildSourceInventory } from '../packages/experimental/environment-policy/src/inventory.ts'
import { extractPolicyMetadata, mergePolicyCatalogMetadata, type PolicyCatalogRecord } from '../packages/experimental/environment-policy/src/metadata.ts'

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (value === undefined || value.startsWith('--')) throw new Error(`missing argument: ${name}`)
  return value
}

const sourceRoot = argument('--source-root')
const output = argument('--output')
const catalogPath = argument('--catalog-json')
const inventory = await buildSourceInventory({ sourceRoot })
const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as PolicyCatalogRecord[]
const records = []
const metadataStatusCounts: Record<string, number> = {}
const documentTypeCounts: Record<string, number> = {}
const issueCounts: Record<string, number> = {}
let catalogMatchedCount = 0

function catalogRecordFor(relativePath: string, catalog: readonly PolicyCatalogRecord[]): PolicyCatalogRecord | undefined {
  const titleMatches = catalog
    .filter(item => item.title !== undefined && relativePath.includes(item.title))
    .sort((left, right) => (right.title?.length ?? 0) - (left.title?.length ?? 0))
  if (titleMatches.length > 0) return titleMatches[0]
  return catalog.find(item => item.documentNumber !== undefined && relativePath.includes(item.documentNumber))
}

for (const source of inventory.records) {
  const markdown = await readFile(join(sourceRoot, ...source.relativePath.split('/')), 'utf8')
  const metadata0 = extractPolicyMetadata(source.sourceId, markdown)
  const catalogRecord = catalogRecordFor(source.relativePath, catalog)
  const metadata = catalogRecord === undefined ? metadata0 : mergePolicyCatalogMetadata(metadata0, catalogRecord)
  if (catalogRecord !== undefined) catalogMatchedCount++
  metadataStatusCounts[metadata.metadataStatus] = (metadataStatusCounts[metadata.metadataStatus] ?? 0) + 1
  documentTypeCounts[metadata.documentType] = (documentTypeCounts[metadata.documentType] ?? 0) + 1
  for (const issue of metadata.issues) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1
  records.push({ sourceId: source.sourceId, relativePath: source.relativePath, metadata })
}

const report = {
  schemaVersion: 1,
  extractorVersion: 1,
  sourceRoot,
  documentCount: records.length,
  catalogCount: catalog.length,
  catalogMatchedCount,
  metadataStatusCounts,
  documentTypeCounts,
  issueCounts,
  records,
}
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  output,
  documentCount: records.length,
  catalogCount: catalog.length,
  catalogMatchedCount,
  metadataStatusCounts,
  documentTypeCounts,
  issueCounts,
}, null, 2))
