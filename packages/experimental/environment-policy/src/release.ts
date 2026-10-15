/** Read a versioned SQLite/vector release; loading a release never writes or rebuilds data. */
import { readFileSync } from 'node:fs'
import type { PolicyBuildManifest } from './database.ts'

/** One complete vector collection built from the release's source snapshot. */
export interface PolicyCollectionRelease {
  readonly collection: string
  readonly count: number
  readonly metric: 'cosine' | 'l2'
  readonly inputVersion: string
}

/** Independently persisted source data and indexes selected together for one deployment. */
export interface PolicyDataRelease {
  readonly formatVersion: 1
  readonly databaseFile: string
  readonly buildId: string
  readonly corpusHash: string
  readonly model: string
  readonly modelRevision: string
  readonly dimension: 2560
  readonly chunkVersion: string
  readonly queryInstructionVersion: 'environment-policy-query-v1'
  readonly documents: PolicyCollectionRelease
  readonly passages: PolicyCollectionRelease
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collection(value: unknown): value is PolicyCollectionRelease {
  return record(value) && typeof value.collection === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,511}$/u.test(value.collection)
    && typeof value.count === 'number' && Number.isInteger(value.count) && value.count > 0
    && (value.metric === 'cosine' || value.metric === 'l2') && typeof value.inputVersion === 'string' && value.inputVersion.length > 0
}

/**
 * Load and validate the release selected alongside an immutable SQLite snapshot.
 * @param path - private deployment manifest path.
 * @param database - manifest read from the opened SQLite database.
 * @param databaseFile - basename of the opened SQLite file.
 * @returns validated release; missing fields or mismatched source identities throw before serving requests.
 */
export function loadPolicyRelease(path: string, database: PolicyBuildManifest, databaseFile: string): PolicyDataRelease {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!record(value) || value.formatVersion !== 1 || value.dimension !== 2560
    || typeof value.databaseFile !== 'string' || !/^[a-zA-Z0-9_.-]+\.sqlite$/u.test(value.databaseFile)
    || value.databaseFile !== databaseFile || value.buildId !== database.buildId || value.corpusHash !== database.corpusHash
    || typeof value.model !== 'string' || !value.model.trim() || typeof value.modelRevision !== 'string' || !value.modelRevision.trim()
    || typeof value.chunkVersion !== 'string' || !value.chunkVersion.trim()
    || value.queryInstructionVersion !== 'environment-policy-query-v1'
    || !collection(value.documents) || !collection(value.passages) || value.passages.metric !== 'cosine') {
    throw new Error('policy release is incomplete or does not match the opened SQLite snapshot')
  }
  return { formatVersion: 1, dimension: 2560, databaseFile: value.databaseFile, buildId: database.buildId,
    corpusHash: database.corpusHash, model: value.model, modelRevision: value.modelRevision, chunkVersion: value.chunkVersion,
    queryInstructionVersion: value.queryInstructionVersion, documents: value.documents, passages: value.passages }
}
