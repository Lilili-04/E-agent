import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  DESCRIPTION_PROMPT_REVISION,
  validateDescriptionResponse,
  type DescriptionCitation,
} from '../packages/experimental/environment-policy/src/description.ts'

interface ManifestRecord {
  readonly sourceId: string
  readonly relativePath: string
}

interface GeneratedRecord {
  readonly sourceId: string
  readonly relativePath?: string
  readonly description: string
  readonly citations: readonly DescriptionCitation[]
  readonly modelId?: string
  readonly status?: 'generated' | 'reviewed' | 'stale' | 'rejected'
}

interface BatchFiles {
  readonly manifest: string
  readonly result: string
  readonly report: string
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sourceRecordId(relativePath: string, sourceHash: string): string {
  return `source-record-${sha256(`${relativePath.replaceAll('\\', '/')}\0${sourceHash}`).slice(0, 24)}`
}

function recordList(value: unknown, subject: string): readonly unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'object' && value !== null) return [value]
  throw new Error(`${subject} must contain a JSON object or array`)
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${subject} must be a JSON object`)
  return value as Record<string, unknown>
}

function manifestRecord(value: unknown, subject: string): ManifestRecord {
  const record = object(value, subject)
  if (typeof record.sourceId !== 'string' || typeof record.relativePath !== 'string') throw new Error(`${subject} requires sourceId and relativePath`)
  return { sourceId: record.sourceId, relativePath: record.relativePath }
}

function generatedRecord(value: unknown, subject: string): GeneratedRecord {
  const record = object(value, subject)
  if (typeof record.sourceId !== 'string' || typeof record.description !== 'string' || !Array.isArray(record.citations)) throw new Error(`${subject} requires sourceId, description, and citations`)
  const citations = record.citations.map((value, index) => {
    const citation = object(value, `${subject}.citations[${index}]`)
    if (typeof citation.lineStart !== 'number'
      || typeof citation.lineEnd !== 'number'
      || typeof citation.quote !== 'string') {
      throw new Error(`${subject}.citations[${index}] requires lineStart, lineEnd, and quote`)
    }
    return { lineStart: citation.lineStart, lineEnd: citation.lineEnd, quote: citation.quote }
  })
  return {
    sourceId: record.sourceId,
    ...(typeof record.relativePath === 'string' ? { relativePath: record.relativePath } : {}),
    description: record.description,
    citations,
    ...(typeof record.modelId === 'string' ? { modelId: record.modelId } : {}),
    ...(record.status === 'generated'
      || record.status === 'reviewed'
      || record.status === 'stale'
      || record.status === 'rejected'
      ? { status: record.status }
      : {}),
  }
}

function reportGeneratedAt(value: unknown, source: ManifestRecord, subject: string): string | undefined {
  const record = object(value, subject)
  if (record.sourceId !== source.sourceId || record.relativePath !== source.relativePath) return undefined
  const description = object(record.description, `${subject}.description`)
  return typeof description.generatedAt === 'string' ? description.generatedAt : undefined
}

function batchFiles(names: readonly string[]): BatchFiles[] {
  const batches: BatchFiles[] = []
  for (const name of names) {
    const numbered = /^policy-description-small-results-(\d+)\.json$/u.exec(name)
    if (numbered !== null) {
      const number = numbered[1] as string
      batches.push({
        manifest: `policy-description-small-${number}.json`,
        result: name,
        report: `policy-description-small-report-${number}.json`,
      })
      continue
    }
    const missing = /^policy-description-(missing-.+)-results\.json$/u.exec(name)
    if (missing !== null) {
      const suffix = missing[1] as string
      batches.push({
        manifest: `policy-description-${suffix}.json`,
        result: name,
        report: `policy-description-${suffix}-report.json`,
      })
    }
  }
  return batches.sort((left, right) => left.result.localeCompare(right.result, 'en', { numeric: true }))
}

function pickManifestRecord(result: GeneratedRecord, candidates: readonly ManifestRecord[], usedPaths: Set<string>): ManifestRecord {
  if (result.relativePath !== undefined) {
    const exact = candidates.find(candidate => candidate.sourceId === result.sourceId && candidate.relativePath === result.relativePath)
    if (exact !== undefined) return exact
  }
  const matches = candidates.filter(item => item.sourceId === result.sourceId && !usedPaths.has(item.relativePath))
  if (matches.length === 1) return matches[0] as ManifestRecord
  if (matches.length === 0) throw new Error(`cannot resolve a manifest path for ${result.sourceId}`)
  throw new Error(`ambiguous manifest paths for ${result.sourceId}; include an exact relativePath`)
}

const sourceRoot = resolve(requiredArgument('--source-root'))
const inputRoot = resolve(requiredArgument('--input-root'))
const output = resolve(requiredArgument('--output'))
const reportOutput = resolve(requiredArgument('--report'))
const names = await readdir(inputRoot)
const batches = batchFiles(names)
if (batches.length === 0) throw new Error('description finalize: no batch result files found')

const finalized: Array<Record<string, unknown>> = []
const issues: string[] = []
const usedPaths = new Set<string>()
for (const batch of batches) {
  const manifestValues = recordList(JSON.parse(await readFile(join(inputRoot, batch.manifest), 'utf8')), batch.manifest)
  const resultValues = recordList(JSON.parse(await readFile(join(inputRoot, batch.result), 'utf8')), batch.result)
  const manifest = manifestValues.map((value, index) => manifestRecord(value, `${batch.manifest}[${index}]`))
  const reportValue = object(JSON.parse(await readFile(join(inputRoot, batch.report), 'utf8')), batch.report)
  const reportRecords = Array.isArray(reportValue.records) ? reportValue.records : []
  for (let index = 0; index < resultValues.length; index++) {
    const result = generatedRecord(resultValues[index], `${batch.result}[${index}]`)
    const source = pickManifestRecord(result, manifest, usedPaths)
    if (usedPaths.has(source.relativePath)) throw new Error(`duplicate finalized path: ${source.relativePath}`)
    usedPaths.add(source.relativePath)
    const sourcePath = join(sourceRoot, ...source.relativePath.split('/'))
    const markdown = await readFile(sourcePath, 'utf8')
    const validated = validateDescriptionResponse({ description: result.description, citations: result.citations }, markdown)
    const sourceHash = sha256(markdown)
    const generatedAt = reportRecords
      .map((record, reportIndex) => reportGeneratedAt(
        record,
        source,
        `${batch.report}.records[${reportIndex}]`,
      ))
      .find(value => value !== undefined)
    if (generatedAt === undefined || Number.isNaN(Date.parse(generatedAt))) {
      issues.push(`${source.relativePath}: missing valid generatedAt in batch report`)
    }
    finalized.push({
      sourceRecordId: sourceRecordId(source.relativePath, sourceHash),
      sourceId: source.sourceId,
      relativePath: source.relativePath,
      sourceHash,
      description: validated.description,
      citations: validated.citations,
      promptRevision: DESCRIPTION_PROMPT_REVISION,
      modelId: result.modelId ?? 'child-agent-provided',
      generatedAt: generatedAt ?? new Date(0).toISOString(),
      status: result.status ?? 'generated',
    })
  }
}

finalized.sort((left, right) => String(left.relativePath).localeCompare(String(right.relativePath), 'zh-CN'))
const uniqueSourceIds = new Set(finalized.map(record => record.sourceId))
const uniqueRecordIds = new Set(finalized.map(record => record.sourceRecordId))
if (uniqueRecordIds.size !== finalized.length) issues.push('sourceRecordId is not unique')
const artifact = {
  schemaVersion: 1,
  corpus: 'national',
  records: finalized,
}
const report = {
  schemaVersion: 1,
  reportType: 'environment-policy-description-finalization',
  sourceRoot,
  inputRoot,
  recordCount: finalized.length,
  uniqueSourceIdCount: uniqueSourceIds.size,
  uniqueSourceRecordIdCount: uniqueRecordIds.size,
  statusCounts: Object.fromEntries(
    [...new Set(finalized.map(record => String(record.status)))].sort()
      .map(status => [status, finalized.filter(record => record.status === status).length]),
  ),
  issues,
}
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
await writeFile(reportOutput, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ output, report: reportOutput, records: finalized.length, issues: issues.length }, null, 2))
