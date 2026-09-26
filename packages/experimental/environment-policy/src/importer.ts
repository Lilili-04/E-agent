import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { PolicyDescription } from './description.ts'
import type { PolicyImportDocument } from './database.ts'
import type { DocumentMetadata } from './metadata.ts'
import { parsePolicyMarkdown } from './parse.ts'
import type { SourceInventory } from './inventory.ts'

/** Path-qualified metadata from the corpus extraction report. */
export interface PolicyMetadataImportRecord {
  readonly sourceId: string
  readonly relativePath: string
  readonly metadata: DocumentMetadata
}

/** A description optionally qualified by path when content hashes are duplicated. */
export interface PolicyDescriptionImportRecord extends PolicyDescription {
  readonly relativePath?: string
}

/** Inputs needed to read and verify one source inventory from local disk. */
export interface LoadPolicyImportOptions {
  readonly inventory: SourceInventory
  readonly metadata: readonly PolicyMetadataImportRecord[]
  readonly descriptions?: readonly PolicyDescriptionImportRecord[]
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sourcePath(root: string, relativePath: string): string {
  const rootPath = resolve(root)
  const path = resolve(rootPath, relativePath)
  const back = relative(rootPath, path)
  if (back.startsWith('..') || isAbsolute(back)) throw new Error(`environment-policy importer: source path escapes root: ${relativePath}`)
  return path
}

function uniqueByPath(metadata: readonly PolicyMetadataImportRecord[]): Map<string, PolicyMetadataImportRecord> {
  const result = new Map<string, PolicyMetadataImportRecord>()
  for (const record of metadata) {
    if (result.has(record.relativePath)) throw new Error(`environment-policy importer: duplicate metadata path: ${record.relativePath}`)
    result.set(record.relativePath, record)
  }
  return result
}

function findDescription(
  records: readonly PolicyDescriptionImportRecord[],
  sourceId: string,
  relativePath: string,
): PolicyDescriptionImportRecord | undefined {
  const exact = records.filter(record => record.sourceId === sourceId && record.relativePath === relativePath)
  if (exact.length > 1) throw new Error(`environment-policy importer: duplicate description path: ${relativePath}`)
  if (exact.length === 1) return exact[0]
  const unqualified = records.filter(record => record.sourceId === sourceId && record.relativePath === undefined)
  if (unqualified.length > 1) throw new Error(`environment-policy importer: ambiguous descriptions for source id: ${sourceId}`)
  return unqualified[0]
}

/**
 * Read, hash-check, parse, and join all local inputs for one database rebuild.
 * @param options - inventory plus path-qualified metadata and descriptions.
 * @returns verified documents ready for an atomic database rebuild.
 */
export async function loadPolicyImportDocuments(options: LoadPolicyImportOptions): Promise<readonly PolicyImportDocument[]> {
  const metadataByPath = uniqueByPath(options.metadata)
  const descriptions = options.descriptions ?? []
  const documents: PolicyImportDocument[] = []
  for (const source of options.inventory.records) {
    const metadataRecord = metadataByPath.get(source.relativePath)
    if (metadataRecord === undefined) throw new Error(`environment-policy importer: missing metadata for ${source.relativePath}`)
    if (metadataRecord.sourceId !== source.sourceId || metadataRecord.metadata.sourceId !== source.sourceId) {
      throw new Error(`environment-policy importer: metadata source id mismatch for ${source.relativePath}`)
    }
    const bytes = await readFile(sourcePath(options.inventory.sourceRoot, source.relativePath))
    if (bytes.byteLength !== source.byteLength || sha256(bytes) !== source.sha256) {
      throw new Error(`environment-policy importer: source changed since inventory: ${source.relativePath}`)
    }
    const markdown = bytes.toString('utf8')
    const description = findDescription(descriptions, source.sourceId, source.relativePath)
    if (description !== undefined && description.sourceHash !== source.sha256) {
      throw new Error(`environment-policy importer: stale description for ${source.relativePath}`)
    }
    documents.push({
      source,
      markdown,
      metadata: metadataRecord.metadata,
      parsed: parsePolicyMarkdown(source.sourceId, markdown),
      ...(description === undefined ? {} : { description }),
    })
  }
  return documents
}
