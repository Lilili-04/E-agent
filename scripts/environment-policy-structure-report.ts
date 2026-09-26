import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { buildSourceInventory } from '../packages/experimental/environment-policy/src/inventory.ts'
import { parsePolicyMarkdown, type ContentUnitKind, type ParseQualityFlag } from '../packages/experimental/environment-policy/src/parse.ts'

function usage(): never {
  throw new Error('usage: node --experimental-strip-types scripts/environment-policy-structure-report.ts --source-root <path> --output <path>')
}

function argument(name: string, args: readonly string[]): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

const args = process.argv.slice(2)
const sourceRoot = argument('--source-root', args)
const outputPath = argument('--output', args)
if (sourceRoot === undefined || outputPath === undefined) usage()
const root = resolve(sourceRoot)
const inventory = await buildSourceInventory({ sourceRoot: root })
const unitCounts: Partial<Record<ContentUnitKind, number>> = {}
const qualityCounts: Partial<Record<ParseQualityFlag, number>> = {}
const documents: Array<Record<string, unknown>> = []

for (const source of inventory.records) {
  const markdown = await readFile(join(root, ...source.relativePath.split('/')), 'utf8')
  const parsed = parsePolicyMarkdown(source.sourceId, markdown)
  for (const unit of parsed.units) unitCounts[unit.kind] = (unitCounts[unit.kind] ?? 0) + 1
  for (const flag of parsed.quality) qualityCounts[flag] = (qualityCounts[flag] ?? 0) + 1
  documents.push({
    sourceId: source.sourceId,
    relativePath: source.relativePath,
    unitCount: parsed.units.length,
    kinds: [...new Set(parsed.units.map(unit => unit.kind))].sort(),
    quality: parsed.quality,
  })
}

const report = {
  schemaVersion: 1,
  parserVersion: 1,
  sourceRoot: root,
  documentCount: documents.length,
  totalUnitCount: Object.values(unitCounts).reduce((sum, count) => sum + count, 0),
  unitCounts,
  qualityCounts,
  documents,
}
await mkdir(dirname(resolve(outputPath)), { recursive: true })
await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`environment-policy: parsed ${report.documentCount} documents`)
console.log(`environment-policy: content units ${report.totalUnitCount}`)
console.log(`environment-policy: wrote ${resolve(outputPath)}`)
