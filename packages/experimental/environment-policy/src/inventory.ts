import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Configuration for one source-corpus inventory run. */
export interface SourceInventoryConfig {
  /** Absolute or process-relative directory containing national `full.md` files. */
  readonly sourceRoot: string
}

/** A stable quality flag attached to one source document. */
export type SourceQualityFlag = 'duplicate-content' | 'missing-pdf' | 'no-heading' | 'short-content'

/** One discovered Markdown source document. */
export interface SourceRecord {
  readonly sourceId: string
  readonly relativePath: string
  readonly byteLength: number
  readonly sha256: string
  readonly headingCandidates: readonly string[]
  readonly pdfRelativePath?: string
  readonly quality: readonly SourceQualityFlag[]
}

/** The deterministic result of one source-corpus inventory run. */
export interface SourceInventory {
  readonly schemaVersion: 1
  readonly sourceRoot: string
  readonly sourceCount: number
  readonly duplicateGroups: readonly (readonly string[])[]
  readonly records: readonly SourceRecord[]
}

const FULL_MARKDOWN = 'full.md'
const SHORT_CONTENT_BYTES = 1024

async function findMarkdownFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await findMarkdownFiles(root, path))
    else if (entry.isFile() && entry.name === FULL_MARKDOWN) files.push(path)
  }
  return files.sort()
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/')
}

function headingCandidates(text: string): string[] {
  return text.split(/\r?\n/)
    .map(line => /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1])
    .filter((heading): heading is string => heading !== undefined)
    .slice(0, 8)
}

async function siblingPdf(path: string): Promise<string | undefined> {
  const directory = join(path, '..')
  const entries = await readdir(directory, { withFileTypes: true })
  const pdf = entries.find(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
  return pdf === undefined ? undefined : join(directory, pdf.name)
}

/**
 * Build a deterministic inventory for a configured source corpus.
 * @param config - source root to scan recursively.
 * @returns source records and duplicate groups for the unchanged corpus.
 */
export async function buildSourceInventory(config: SourceInventoryConfig): Promise<SourceInventory> {
  const rootStats = await stat(config.sourceRoot)
  if (!rootStats.isDirectory()) throw new Error(`environment-policy: sourceRoot is not a directory: ${config.sourceRoot}`)
  const paths = await findMarkdownFiles(config.sourceRoot)
  const initial: SourceRecord[] = []
  for (const path of paths) {
    const [bytes, sourceStats, pdf] = await Promise.all([readFile(path), stat(path), siblingPdf(path)])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const text = bytes.toString('utf8')
    const quality: SourceQualityFlag[] = []
    if (sourceStats.size < SHORT_CONTENT_BYTES) quality.push('short-content')
    if (headingCandidates(text).length === 0) quality.push('no-heading')
    if (pdf === undefined) quality.push('missing-pdf')
    initial.push({
      sourceId: `source-${sha256.slice(0, 24)}`,
      relativePath: normalizeRelativePath(relative(config.sourceRoot, path)),
      byteLength: sourceStats.size,
      sha256,
      headingCandidates: headingCandidates(text),
      ...(pdf === undefined ? {} : { pdfRelativePath: normalizeRelativePath(relative(config.sourceRoot, pdf)) }),
      quality,
    })
  }
  const byHash = new Map<string, SourceRecord[]>()
  for (const record of initial) {
    const records = byHash.get(record.sha256) ?? []
    records.push(record)
    byHash.set(record.sha256, records)
  }
  const duplicateGroups = [...byHash.values()]
    .filter(records => records.length > 1)
    .sort((left, right) => (left.at(0)?.relativePath ?? '').localeCompare(right.at(0)?.relativePath ?? ''))
    .map(records => records.map(record => record.relativePath).sort())
  const duplicatePaths = new Set(duplicateGroups.flat())
  const records = initial
    .map(record => duplicatePaths.has(record.relativePath)
      ? { ...record, quality: [...record.quality, 'duplicate-content' as const].sort() }
      : record)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { schemaVersion: 1, sourceRoot: config.sourceRoot, sourceCount: records.length, duplicateGroups, records }
}
