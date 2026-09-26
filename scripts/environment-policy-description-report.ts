import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildSourceInventory } from '../packages/experimental/environment-policy/src/inventory.ts'
import { extractPolicyMetadata, type DocumentMetadata } from '../packages/experimental/environment-policy/src/metadata.ts'
import {
  generatePolicyDescription,
  prepareDescriptionRequest,
  validateDescriptionResponse,
  type PolicyDescription,
} from '../packages/experimental/environment-policy/src/description.ts'

type InputDescription = {
  readonly sourceId: string
  readonly relativePath?: string
  readonly description: string
  readonly citations: readonly { readonly lineStart: number; readonly lineEnd: number; readonly quote: string }[]
  readonly modelId?: string
}

type MetadataReport = {
  readonly records?: readonly { readonly sourceId: string; readonly relativePath: string; readonly metadata: DocumentMetadata }[]
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value === undefined || value.startsWith('--') ? undefined : value
}

function requiredArgument(name: string): string {
  const value = argument(name)
  if (value === undefined) throw new Error(`missing argument: ${name}`)
  return value
}

function now(): string {
  return new Date().toISOString()
}

async function readExternalDescriptions(path: string | undefined): Promise<Map<string, readonly InputDescription[]>> {
  if (path === undefined) return new Map()
  const value: unknown = JSON.parse(await readFile(resolve(path), 'utf8'))
  const records = Array.isArray(value) ? value : (value as { records?: unknown }).records
  if (!Array.isArray(records)) throw new Error('description: input JSON must be an array or contain records')
  const result = new Map<string, InputDescription[]>()
  for (const item of records) {
    if (typeof item !== 'object' || item === null) throw new Error('description: input record must be an object')
    const record = item as Record<string, unknown>
    if (typeof record.sourceId !== 'string' || typeof record.description !== 'string' || !Array.isArray(record.citations)) throw new Error('description: input record requires sourceId, description, citations')
    const description: InputDescription = {
      sourceId: record.sourceId,
      ...(typeof record.relativePath === 'string' ? { relativePath: record.relativePath } : {}),
      description: record.description,
      citations: record.citations as InputDescription['citations'],
      ...(typeof record.modelId === 'string' ? { modelId: record.modelId } : {}),
    }
    const existing = result.get(description.sourceId) ?? []
    existing.push(description)
    result.set(description.sourceId, existing)
  }
  return result
}

function externalDescriptionFor(
  sourceId: string,
  relativePath: string,
  descriptions: ReadonlyMap<string, readonly InputDescription[]>,
): InputDescription | undefined {
  const candidates = descriptions.get(sourceId)
  if (candidates === undefined) return undefined
  const exact = candidates.find(candidate => candidate.relativePath === relativePath)
  if (exact !== undefined) return exact
  if (candidates.length === 1 && candidates[0]?.relativePath === undefined) return candidates[0]
  throw new Error(`description: ambiguous external records for ${sourceId}; include relativePath`)
}

const sourceRoot = resolve(requiredArgument('--source-root'))
const output = resolve(requiredArgument('--output'))
const metadataReportPath = argument('--metadata-report')
const externalPath = argument('--descriptions-json')
if (externalPath === undefined) throw new Error('description: --descriptions-json is required')
const metadataReport: MetadataReport = metadataReportPath === undefined
  ? {}
  : JSON.parse(await readFile(resolve(metadataReportPath), 'utf8')) as MetadataReport
const inventory = await buildSourceInventory({ sourceRoot })
const metadataByPath = new Map((metadataReport.records ?? []).map(record => [record.relativePath, record.metadata]))
const externalDescriptions = await readExternalDescriptions(externalPath)
if (metadataByPath.size === 0) {
  for (const source of inventory.records) {
    const markdown = await readFile(join(sourceRoot, ...source.relativePath.split('/')), 'utf8')
    metadataByPath.set(source.relativePath, extractPolicyMetadata(source.sourceId, markdown))
  }
}
const selected: typeof inventory.records[number][] = []
for (const source of inventory.records) {
  if (externalDescriptions.has(source.sourceId)) selected.push(source)
}

const records: Array<Record<string, unknown>> = []
const errors: Array<{ sourceId: string; error: string }> = []
for (const source of selected) {
  const markdown = await readFile(join(sourceRoot, ...source.relativePath.split('/')), 'utf8')
  const metadata = metadataByPath.get(source.relativePath) ?? extractPolicyMetadata(source.sourceId, markdown)
  const request = prepareDescriptionRequest(source.sourceId, markdown, metadata)
  const candidate = externalDescriptionFor(source.sourceId, source.relativePath, externalDescriptions)
  if (candidate === undefined) throw new Error(`description: missing external description for ${source.relativePath}`)
  try {
    const validated = validateDescriptionResponse({ description: candidate.description, citations: candidate.citations }, markdown)
    const saved: PolicyDescription = await generatePolicyDescription({
      modelId: candidate.modelId ?? (externalDescriptions.has(source.sourceId) ? 'child-agent-provided' : 'deterministic-extractor-v1'),
      generate: () => Promise.resolve(validated),
    }, request, markdown, now())
    records.push({
      sourceId: source.sourceId,
      relativePath: source.relativePath,
      documentType: metadata.documentType,
      sourceHash: source.sha256,
      provider: saved.modelId,
      description: saved,
    })
  } catch (error) {
    errors.push({ sourceId: source.sourceId, error: error instanceof Error ? error.message : String(error) })
  }
}

const report = {
  schemaVersion: 1,
  reportType: 'environment-policy-description-sample',
  sourceRoot,
  selection: { documentTypes: ['law', 'plan', 'standard', 'notice'], selectedCount: selected.length },
  externalDescriptionCount: records.length,
  records,
  errors,
}
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  output,
  selectedCount: selected.length,
  generatedCount: records.length,
  errors: errors.length,
}, null, 2))
