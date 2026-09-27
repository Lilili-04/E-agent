import { createHash } from 'node:crypto'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { PolicyDescription } from './description.ts'
import type { DocumentMetadata } from './metadata.ts'
import type { ParsedDocument } from './parse.ts'
import type { SourceRecord } from './inventory.ts'

/** Current on-disk schema understood by the environment-policy index. */
export const ENVIRONMENT_POLICY_SCHEMA_VERSION = 1

/** Connection mode for a policy database handle. */
export interface PolicyDatabaseOptions {
  /** Refuse database creation and all writes. */
  readonly readOnly?: boolean
}

/** One fully prepared document written during an index rebuild. */
export interface PolicyImportDocument {
  readonly source: SourceRecord
  readonly markdown: string
  readonly metadata: DocumentMetadata
  readonly parsed: ParsedDocument
  readonly description?: PolicyDescription
}

/** Inputs that identify one deterministic corpus build. */
export interface PolicyDatabaseBuild {
  readonly sourceRoot: string
  readonly builtAt: string
  readonly documents: readonly PolicyImportDocument[]
}

/** Summary saved only after a complete rebuild commits. */
export interface PolicyBuildManifest {
  readonly schemaVersion: typeof ENVIRONMENT_POLICY_SCHEMA_VERSION
  readonly buildId: string
  readonly sourceRoot: string
  readonly builtAt: string
  readonly corpusHash: string
  readonly sourceCount: number
  readonly unitCount: number
  readonly descriptionCount: number
}

/** Exact metadata predicates supported directly by SQLite indexes. */
export interface PolicyExactFilter {
  readonly sourceId?: string
  readonly relativePath?: string
  readonly title?: string
  readonly documentNumber?: string
  readonly documentType?: string
  readonly legalStatus?: string
  readonly publishDate?: string
}

/** One source row returned from an exact lookup. */
export interface PolicySourceRow {
  readonly recordKey: string
  readonly sourceId: string
  readonly relativePath: string
  readonly sourceHash: string
  readonly title?: string
  readonly documentNumber?: string
  readonly documentType: string
  readonly jurisdiction?: string
  readonly legalStatus?: string
  readonly publishDate?: string
  readonly effectiveFrom?: string
  readonly effectiveTo?: string
  readonly officialUrl?: string
  readonly metadataStatus: DocumentMetadata['metadataStatus']
  readonly descriptionStatus?: PolicyDescription['status']
}

/** Options for indexed content lookup. */
export interface PolicyContentSearchOptions {
  readonly limit?: number
  readonly recordKeys?: readonly string[]
}

/** Options for reading authoritative units after a metadata-only match. */
export interface PolicyContentReadOptions {
  readonly limit?: number
  readonly recordKeys: readonly string[]
  readonly label?: string
}

/** One content-unit search hit with an evidence-ready source span. */
export interface PolicyContentSearchHit extends PolicySourceRow {
  readonly unitId: string
  readonly kind: string
  readonly label?: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly sectionPath: readonly string[]
  readonly text: string
  readonly score: number
}

/** Description recall result; generated text is never returned as evidence. */
export interface PolicyDescriptionSearchHit {
  readonly recordKey: string
  readonly score: number
}

interface ManifestSqlRow {
  schema_version: number
  build_id: string
  source_root: string
  built_at: string
  corpus_hash: string
  source_count: number
  unit_count: number
  description_count: number
}

interface SourceSqlRow {
  record_key: string
  source_id: string
  relative_path: string
  source_hash: string
  title: string | null
  document_number: string | null
  document_type: string
  jurisdiction: string | null
  legal_status: string | null
  publish_date: string | null
  effective_from: string | null
  effective_to: string | null
  metadata_status: DocumentMetadata['metadataStatus']
  metadata_json: string
  description_status: PolicyDescription['status'] | null
}

interface SearchSqlRow extends SourceSqlRow {
  unit_id: string
  kind: string
  label: string | null
  line_start: number
  line_end: number
  section_path_json: string
  text: string
  matched_terms: number
  document_length: number
  matched_term_dfs: string
}

function sqlString(row: Record<string, SQLOutputValue>, name: string): string {
  const value = row[name]
  if (typeof value !== 'string') throw new Error(`environment-policy database: ${name} is not text`)
  return value
}

function sqlNullableString(row: Record<string, SQLOutputValue>, name: string): string | null {
  const value = row[name]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`environment-policy database: ${name} is not nullable text`)
  return value
}

function sqlNumber(row: Record<string, SQLOutputValue>, name: string): number {
  const value = row[name]
  if (typeof value !== 'number') throw new Error(`environment-policy database: ${name} is not a number`)
  return value
}

function sqlSourceRow(row: Record<string, SQLOutputValue>): SourceSqlRow {
  const status = sqlNullableString(row, 'description_status')
  if (status !== null && !['generated', 'reviewed', 'stale', 'rejected'].includes(status)) {
    throw new Error('environment-policy database: invalid description status')
  }
  return {
    record_key: sqlString(row, 'record_key'),
    source_id: sqlString(row, 'source_id'),
    relative_path: sqlString(row, 'relative_path'),
    source_hash: sqlString(row, 'source_hash'),
    title: sqlNullableString(row, 'title'),
    document_number: sqlNullableString(row, 'document_number'),
    document_type: sqlString(row, 'document_type'),
    jurisdiction: sqlNullableString(row, 'jurisdiction'),
    legal_status: sqlNullableString(row, 'legal_status'),
    publish_date: sqlNullableString(row, 'publish_date'),
    effective_from: sqlNullableString(row, 'effective_from'),
    effective_to: sqlNullableString(row, 'effective_to'),
    metadata_status: sqlString(row, 'metadata_status') as DocumentMetadata['metadataStatus'],
    metadata_json: sqlString(row, 'metadata_json'),
    description_status: status as PolicyDescription['status'] | null,
  }
}

function sqlSearchRow(row: Record<string, SQLOutputValue>): SearchSqlRow {
  return {
    ...sqlSourceRow(row),
    unit_id: sqlString(row, 'unit_id'),
    kind: sqlString(row, 'kind'),
    label: sqlNullableString(row, 'label'),
    line_start: sqlNumber(row, 'line_start'),
    line_end: sqlNumber(row, 'line_end'),
    section_path_json: sqlString(row, 'section_path_json'),
    text: sqlString(row, 'text'),
    matched_terms: sqlNumber(row, 'matched_terms'),
    document_length: sqlNumber(row, 'document_length'),
    matched_term_dfs: sqlString(row, 'matched_term_dfs'),
  }
}

function bm25Score(row: SearchSqlRow, totalUnits: number, averageLength: number): number {
  const k1 = 1.2
  const b = 0.75
  const length = row.document_length
  const normalization = k1 * (1 - b + b * length / Math.max(averageLength, 1))
  return row.matched_term_dfs.split('|').reduce((score, item) => {
    const separator = item.indexOf('=')
    if (separator < 1) return score
    const documentFrequency = Number(item.slice(separator + 1))
    if (!Number.isFinite(documentFrequency) || documentFrequency < 1) return score
    const idf = Math.log(1 + (totalUnits - documentFrequency + 0.5) / (documentFrequency + 0.5))
    return score + idf * (k1 + 1) / (1 + normalization)
  }, 0)
}

const SCHEMA = `
  CREATE TABLE build_manifest (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    build_id TEXT NOT NULL,
    source_root TEXT NOT NULL,
    built_at TEXT NOT NULL,
    corpus_hash TEXT NOT NULL,
    source_count INTEGER NOT NULL,
    unit_count INTEGER NOT NULL,
    description_count INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sources (
    record_key TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    source_hash TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    markdown TEXT NOT NULL,
    heading_candidates_json TEXT NOT NULL,
    pdf_relative_path TEXT,
    quality_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX sources_source_id ON sources(source_id);
  CREATE INDEX sources_source_hash ON sources(source_hash);

  CREATE TABLE metadata (
    record_key TEXT PRIMARY KEY REFERENCES sources(record_key) ON DELETE CASCADE,
    title TEXT,
    regulation_key TEXT,
    document_type TEXT NOT NULL,
    issuing_authority TEXT,
    jurisdiction TEXT,
    document_number TEXT,
    publish_date TEXT,
    effective_from TEXT,
    effective_to TEXT,
    revision_date TEXT,
    legal_status TEXT,
    metadata_status TEXT NOT NULL,
    metadata_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX metadata_title ON metadata(title);
  CREATE INDEX metadata_regulation_key ON metadata(regulation_key);
  CREATE INDEX metadata_document_number ON metadata(document_number);
  CREATE INDEX metadata_document_type ON metadata(document_type);
  CREATE INDEX metadata_publish_date ON metadata(publish_date);
  CREATE INDEX metadata_legal_status ON metadata(legal_status);

  CREATE TABLE content_units (
    record_key TEXT NOT NULL REFERENCES sources(record_key) ON DELETE CASCADE,
    unit_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    parent_unit_id TEXT,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    section_path_json TEXT NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    PRIMARY KEY (record_key, unit_id)
  ) STRICT;
  CREATE INDEX content_units_label ON content_units(label);
  CREATE INDEX content_units_record_span ON content_units(record_key, line_start, line_end);

  CREATE TABLE descriptions (
    record_key TEXT PRIMARY KEY REFERENCES sources(record_key) ON DELETE CASCADE,
    source_hash TEXT NOT NULL,
    description TEXT NOT NULL,
    prompt_revision TEXT NOT NULL,
    model_id TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('generated', 'reviewed', 'stale', 'rejected')),
    description_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX descriptions_status ON descriptions(status);

  CREATE TABLE description_citations (
    record_key TEXT NOT NULL REFERENCES descriptions(record_key) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    quote TEXT NOT NULL,
    PRIMARY KEY (record_key, ordinal)
  ) STRICT;

  CREATE TABLE content_search_terms (
    term TEXT NOT NULL,
    record_key TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    PRIMARY KEY (term, record_key, unit_id),
    FOREIGN KEY (record_key, unit_id) REFERENCES content_units(record_key, unit_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX content_search_terms_unit ON content_search_terms(record_key, unit_id);

  CREATE TABLE description_search_terms (
    term TEXT NOT NULL,
    record_key TEXT NOT NULL REFERENCES descriptions(record_key) ON DELETE CASCADE,
    PRIMARY KEY (term, record_key)
  ) STRICT;
  CREATE INDEX description_search_terms_record ON description_search_terms(record_key);
`

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Return the path-sensitive identifier used as every relational foreign key.
 * @param sourceId - content-derived source identifier.
 * @param relativePath - source path that distinguishes duplicate content.
 * @returns stable relational record key.
 */
export function policyRecordKey(sourceId: string, relativePath: string): string {
  return `record-${sha256(`${sourceId}\0${relativePath}`).slice(0, 24)}`
}

function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('zh-CN')
}

function cjkTerms(value: string): string[] {
  const characters = Array.from(value)
  if (characters.length < 2) return characters
  return characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1] ?? ''}`)
}

/**
 * Tokenize Latin words and Chinese bigrams for a portable fallback index.
 * @param text - source or query text to normalize.
 * @returns unique normalized terms in source order.
 */
export function tokenizePolicyText(text: string): string[] {
  const normalized = normalizeSearchText(text)
  const terms: string[] = []
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu)) {
    const value = match[0]
    terms.push(...(/^[\p{Script=Han}]+$/u.test(value) ? cjkTerms(value) : [value]))
  }
  return [...new Set(terms)]
}

function assertBuild(build: PolicyDatabaseBuild): void {
  if (!build.sourceRoot.trim()) throw new Error('environment-policy database: sourceRoot is required')
  if (Number.isNaN(Date.parse(build.builtAt))) throw new Error('environment-policy database: builtAt must be an ISO date-time')
  for (const document of build.documents) {
    if (document.metadata.sourceId !== document.source.sourceId
      || document.parsed.sourceId !== document.source.sourceId) {
      throw new Error(`environment-policy database: source id mismatch for ${document.source.relativePath}`)
    }
    if (sha256(document.markdown) !== document.source.sha256) {
      throw new Error(`environment-policy database: source hash mismatch for ${document.source.relativePath}`)
    }
    if (document.description !== undefined
      && document.description.sourceId !== document.source.sourceId) {
      throw new Error(`environment-policy database: description source id mismatch for ${document.source.relativePath}`)
    }
    if (document.description !== undefined && document.description.sourceHash !== document.source.sha256) {
      throw new Error(`environment-policy database: description source hash mismatch for ${document.source.relativePath}`)
    }
  }
}

function corpusHash(documents: readonly PolicyImportDocument[]): string {
  return sha256([...documents]
    .sort((left, right) => left.source.relativePath.localeCompare(right.source.relativePath))
    .map(document => [
      document.source.relativePath,
      document.source.sha256,
      JSON.stringify(document.metadata),
      JSON.stringify(document.description ?? null),
    ].join('\0'))
    .join('\n'))
}

function jsonStrings(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error('environment-policy database: invalid string-array JSON')
  }
  return parsed.map(item => String(item))
}

function sourceRow(row: SourceSqlRow): PolicySourceRow {
  let officialUrl: string | undefined
  try {
    const metadata = JSON.parse(row.metadata_json) as { officialSourceUrls?: unknown[]; officialUrl?: unknown }
    const candidate = metadata.officialUrl ?? metadata.officialSourceUrls?.[0]
    if (typeof candidate === 'string' && candidate.length > 0) officialUrl = candidate
  } catch {
    officialUrl = undefined
  }
  return {
    recordKey: row.record_key,
    sourceId: row.source_id,
    relativePath: row.relative_path,
    sourceHash: row.source_hash,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.document_number === null ? {} : { documentNumber: row.document_number }),
    documentType: row.document_type,
    ...(row.jurisdiction === null ? {} : { jurisdiction: row.jurisdiction }),
    ...(row.legal_status === null ? {} : { legalStatus: row.legal_status }),
    ...(row.publish_date === null ? {} : { publishDate: row.publish_date }),
    ...(row.effective_from === null ? {} : { effectiveFrom: row.effective_from }),
    ...(row.effective_to === null ? {} : { effectiveTo: row.effective_to }),
    ...(officialUrl === undefined ? {} : { officialUrl }),
    metadataStatus: row.metadata_status,
    ...(row.description_status === null ? {} : { descriptionStatus: row.description_status }),
  }
}

/** Synchronous local SQLite index. Callers own and close the handle. */
export class PolicyDatabase {
  readonly #database: DatabaseSync

  /** Open or initialize one local environment-policy database. */
  constructor(path: string, options: PolicyDatabaseOptions = {}) {
    this.#database = new DatabaseSync(path, { readOnly: options.readOnly ?? false })
    this.#database.exec('PRAGMA foreign_keys = ON')
    const version = (this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version === 0) {
      if (options.readOnly) {
        this.#database.close()
        throw new Error('environment-policy database: read-only index is not initialized')
      }
      this.#database.exec('BEGIN IMMEDIATE')
      try {
        this.#database.exec(SCHEMA)
        this.#database.exec(`PRAGMA user_version = ${ENVIRONMENT_POLICY_SCHEMA_VERSION}`)
        this.#database.exec('COMMIT')
      } catch (error) {
        this.#database.exec('ROLLBACK')
        this.#database.close()
        throw error
      }
    } else if (version !== ENVIRONMENT_POLICY_SCHEMA_VERSION) {
      this.#database.close()
      throw new Error(`environment-policy database: unsupported schema version ${version}`)
    }
  }

  /** Close the underlying SQLite connection. */
  close(): void {
    this.#database.close()
  }

  /**
   * Read the last committed build manifest.
   * @returns manifest identity, or undefined for an empty index.
   */
  getManifest(): PolicyBuildManifest | undefined {
    const row = this.#database.prepare('SELECT * FROM build_manifest WHERE singleton = 1').get() as ManifestSqlRow | undefined
    if (row === undefined) return undefined
    if (row.schema_version !== ENVIRONMENT_POLICY_SCHEMA_VERSION) {
      throw new Error(`environment-policy database: manifest schema version ${row.schema_version} is unsupported`)
    }
    return {
      schemaVersion: ENVIRONMENT_POLICY_SCHEMA_VERSION,
      buildId: row.build_id,
      sourceRoot: row.source_root,
      builtAt: row.built_at,
      corpusHash: row.corpus_hash,
      sourceCount: row.source_count,
      unitCount: row.unit_count,
      descriptionCount: row.description_count,
    }
  }

  /**
   * Replace every indexed row atomically.
   * @param build - verified documents and build provenance.
   * @returns manifest saved by the committed rebuild.
   */
  rebuild(build: PolicyDatabaseBuild): PolicyBuildManifest {
    assertBuild(build)
    const sorted = [...build.documents].sort((left, right) => left.source.relativePath.localeCompare(right.source.relativePath))
    const digest = corpusHash(sorted)
    const unitCount = sorted.reduce((total, document) => total + document.parsed.units.length, 0)
    const descriptionCount = sorted.filter(document => document.description !== undefined).length
    const manifest: PolicyBuildManifest = {
      schemaVersion: ENVIRONMENT_POLICY_SCHEMA_VERSION,
      buildId: `build-${sha256(`${digest}\0${build.builtAt}`).slice(0, 24)}`,
      sourceRoot: build.sourceRoot,
      builtAt: build.builtAt,
      corpusHash: digest,
      sourceCount: sorted.length,
      unitCount,
      descriptionCount,
    }

    const insertSource = this.#database.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertMetadata = this.#database.prepare('INSERT INTO metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertUnit = this.#database.prepare('INSERT INTO content_units VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertDescription = this.#database.prepare('INSERT INTO descriptions VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const insertCitation = this.#database.prepare('INSERT INTO description_citations VALUES (?, ?, ?, ?, ?)')
    const insertSearchTerm = this.#database.prepare('INSERT INTO content_search_terms VALUES (?, ?, ?)')
    const insertDescriptionSearchTerm = this.#database.prepare('INSERT INTO description_search_terms VALUES (?, ?)')

    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#database.exec('DELETE FROM build_manifest; DELETE FROM content_search_terms; DELETE FROM description_search_terms; DELETE FROM description_citations; DELETE FROM descriptions; DELETE FROM content_units; DELETE FROM metadata; DELETE FROM sources')
      for (const document of sorted) {
        const key = policyRecordKey(document.source.sourceId, document.source.relativePath)
        insertSource.run(
          key,
          document.source.sourceId,
          document.source.relativePath,
          document.source.sha256,
          document.source.byteLength,
          document.markdown,
          JSON.stringify(document.source.headingCandidates),
          document.source.pdfRelativePath ?? null,
          JSON.stringify(document.source.quality),
        )
        const metadata = document.metadata
        insertMetadata.run(
          key,
          metadata.canonicalTitleCandidate ?? null,
          metadata.regulationKeyCandidate ?? null,
          metadata.documentType,
          metadata.issuingAuthorityCandidate ?? null,
          metadata.jurisdictionCandidate ?? null,
          metadata.documentNumberCandidate ?? null,
          metadata.publishDateCandidate ?? null,
          metadata.effectiveFromCandidate ?? null,
          metadata.effectiveToCandidate ?? null,
          metadata.revisionDateCandidate ?? null,
          metadata.legalStatus ?? null,
          metadata.metadataStatus,
          JSON.stringify(metadata),
        )
        for (const unit of document.parsed.units) {
          insertUnit.run(
            key,
            unit.unitId,
            unit.kind,
            unit.label ?? null,
            unit.parentUnitId ?? null,
            unit.lineStart,
            unit.lineEnd,
            JSON.stringify(unit.sectionPath),
            unit.text,
            unit.textHash,
          )
          for (const term of tokenizePolicyText(unit.text)) insertSearchTerm.run(term, key, unit.unitId)
        }
        if (document.description !== undefined) {
          const description = document.description
          insertDescription.run(
            key,
            description.sourceHash,
            description.description,
            description.promptRevision,
            description.modelId,
            description.generatedAt,
            description.status,
            JSON.stringify(description),
          )
          description.citations.forEach((citation, ordinal) => {
            insertCitation.run(key, ordinal, citation.lineStart, citation.lineEnd, citation.quote)
          })
          for (const term of tokenizePolicyText(description.description)) insertDescriptionSearchTerm.run(term, key)
        }
      }
      this.#database.prepare('INSERT INTO build_manifest VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        manifest.schemaVersion,
        manifest.buildId,
        manifest.sourceRoot,
        manifest.builtAt,
        manifest.corpusHash,
        manifest.sourceCount,
        manifest.unitCount,
        manifest.descriptionCount,
      )
      this.#database.exec('COMMIT')
      return manifest
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Remove all corpus rows atomically while retaining the initialized schema. */
  clear(): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#database.exec('DELETE FROM build_manifest; DELETE FROM content_search_terms; DELETE FROM description_search_terms; DELETE FROM description_citations; DELETE FROM descriptions; DELETE FROM content_units; DELETE FROM metadata; DELETE FROM sources')
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Find sources through indexed equality predicates.
   * @param filter - supported metadata equality conditions.
   * @param limit - maximum number of source rows.
   * @returns deterministic matching source rows.
   */
  findSourcesByExact(filter: PolicyExactFilter, limit = 100): readonly PolicySourceRow[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error('environment-policy database: exact lookup limit must be between 1 and 1000')
    const predicates: string[] = []
    const values: string[] = []
    const columns: ReadonlyArray<[keyof PolicyExactFilter, string]> = [
      ['sourceId', 's.source_id'], ['relativePath', 's.relative_path'], ['title', 'm.title'],
      ['documentNumber', 'm.document_number'], ['documentType', 'm.document_type'],
      ['legalStatus', 'm.legal_status'], ['publishDate', 'm.publish_date'],
    ]
    for (const [property, column] of columns) {
      const value = filter[property]
      if (value !== undefined) {
        predicates.push(`${column} = ?`)
        values.push(value)
      }
    }
    const where = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`
    const rows = this.#database.prepare(`
      SELECT s.record_key, s.source_id, s.relative_path, s.source_hash,
        m.title, m.document_number, m.document_type, m.jurisdiction, m.legal_status, m.publish_date,
        m.effective_from, m.effective_to, m.metadata_status, m.metadata_json,
        d.status AS description_status
      FROM sources s JOIN metadata m ON m.record_key = s.record_key
      LEFT JOIN descriptions d ON d.record_key = s.record_key
      ${where} ORDER BY s.relative_path LIMIT ?
    `).all(...values, limit).map(sqlSourceRow)
    return rows.map(sourceRow)
  }

  /**
   * Search content units with BM25 scoring over a portable Latin-word and Chinese-bigram index.
   * @param query - lexical query text.
   * @param options - result limit and optional source restriction.
   * @returns ranked source content units.
   */
  searchContent(query: string, options: PolicyContentSearchOptions = {}): readonly PolicyContentSearchHit[] {
    const terms = tokenizePolicyText(query)
    if (terms.length === 0) return []
    const limit = options.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('environment-policy database: search limit must be between 1 and 200')
    const recordKeys = [...new Set(options.recordKeys ?? [])]
    const termSlots = terms.map(() => '?').join(', ')
    const recordPredicate = recordKeys.length === 0 ? '' : `AND t.record_key IN (${recordKeys.map(() => '?').join(', ')})`
    const totalUnits = sqlNumber(this.#database.prepare('SELECT COUNT(*) AS count FROM content_units').get() as Record<string, SQLOutputValue>, 'count')
    const averageLength = sqlNumber(this.#database.prepare(`
      SELECT AVG(term_count) AS average_length FROM (
        SELECT COUNT(*) AS term_count FROM content_search_terms GROUP BY record_key, unit_id
      )
    `).get() as Record<string, SQLOutputValue>, 'average_length')
    const rows = this.#database.prepare(`
      WITH term_stats AS (
        SELECT term, COUNT(DISTINCT record_key || char(0) || unit_id) AS document_frequency
        FROM content_search_terms
        WHERE term IN (${termSlots})
        GROUP BY term
      )
      SELECT s.record_key, s.source_id, s.relative_path, s.source_hash,
        m.title, m.document_number, m.document_type, m.jurisdiction, m.legal_status, m.publish_date,
        m.effective_from, m.effective_to, m.metadata_status, m.metadata_json,
        d.status AS description_status, u.unit_id, u.kind, u.label, u.line_start, u.line_end,
        u.section_path_json, u.text, COUNT(DISTINCT t.term) AS matched_terms,
        (SELECT COUNT(*) FROM content_search_terms AS length_terms
         WHERE length_terms.record_key = t.record_key AND length_terms.unit_id = t.unit_id) AS document_length,
        group_concat(t.term || '=' || term_stats.document_frequency, '|') AS matched_term_dfs
      FROM content_search_terms t
      JOIN term_stats ON term_stats.term = t.term
      JOIN content_units u ON u.record_key = t.record_key AND u.unit_id = t.unit_id
      JOIN sources s ON s.record_key = t.record_key
      JOIN metadata m ON m.record_key = t.record_key
      LEFT JOIN descriptions d ON d.record_key = t.record_key
      WHERE t.term IN (${termSlots}) ${recordPredicate}
      GROUP BY t.record_key, t.unit_id
      ORDER BY matched_terms DESC, s.relative_path, u.line_start
      LIMIT ?
    `).all(...terms, ...terms, ...recordKeys, limit).map(sqlSearchRow)
    const normalizedQuery = normalizeSearchText(query).replace(/\s+/gu, '')
    return rows.map(row => ({
      ...sourceRow(row),
      unitId: row.unit_id,
      kind: row.kind,
      ...(row.label === null ? {} : { label: row.label }),
      lineStart: row.line_start,
      lineEnd: row.line_end,
      sectionPath: jsonStrings(row.section_path_json),
      text: row.text,
      score: bm25Score(row, totalUnits, averageLength) + (normalizeSearchText(row.text).replace(/\s+/gu, '').includes(normalizedQuery) ? 1 : 0),
    })).sort((left, right) => right.score - left.score
      || left.relativePath.localeCompare(right.relativePath)
      || left.lineStart - right.lineStart)
  }

  /**
   * Read source units for exact metadata hits without treating metadata as answer evidence.
   * @param options - matched record keys, optional label, and result limit.
   * @returns deterministic authoritative source units.
   */
  readContentUnits(options: PolicyContentReadOptions): readonly PolicyContentSearchHit[] {
    const limit = options.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('environment-policy database: content read limit must be between 1 and 200')
    const recordKeys = [...new Set(options.recordKeys)]
    if (recordKeys.length === 0) return []
    const labelPredicate = options.label === undefined ? '' : 'AND u.label = ?'
    const rows = this.#database.prepare(`
      SELECT s.record_key, s.source_id, s.relative_path, s.source_hash,
        m.title, m.document_number, m.document_type, m.jurisdiction, m.legal_status, m.publish_date,
        m.effective_from, m.effective_to, m.metadata_status, m.metadata_json,
        d.status AS description_status, u.unit_id, u.kind, u.label, u.line_start, u.line_end,
        u.section_path_json, u.text, 0 AS matched_terms, 0 AS document_length, '' AS matched_term_dfs
      FROM content_units u
      JOIN sources s ON s.record_key = u.record_key
      JOIN metadata m ON m.record_key = u.record_key
      LEFT JOIN descriptions d ON d.record_key = u.record_key
      WHERE u.record_key IN (${recordKeys.map(() => '?').join(', ')}) ${labelPredicate}
      ORDER BY s.relative_path, u.line_start
      LIMIT ?
    `).all(...recordKeys, ...(options.label === undefined ? [] : [options.label]), limit).map(sqlSearchRow)
    return rows.map(row => ({
      ...sourceRow(row),
      unitId: row.unit_id,
      kind: row.kind,
      ...(row.label === null ? {} : { label: row.label }),
      lineStart: row.line_start,
      lineEnd: row.line_end,
      sectionPath: jsonStrings(row.section_path_json),
      text: row.text,
      score: 0,
    }))
  }

  /**
   * Recall source records from descriptions without returning generated text as evidence.
   * @param query - lexical discovery query.
   * @param limit - maximum number of candidate records.
   * @returns record keys and discovery scores only.
   */
  searchDescriptions(query: string, limit = 20): readonly PolicyDescriptionSearchHit[] {
    const terms = tokenizePolicyText(query)
    if (terms.length === 0) return []
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('environment-policy database: description search limit must be between 1 and 200')
    const slots = terms.map(() => '?').join(', ')
    const rows = this.#database.prepare(`
      SELECT record_key, COUNT(DISTINCT term) AS matched_terms
      FROM description_search_terms
      WHERE term IN (${slots})
      GROUP BY record_key
      ORDER BY matched_terms DESC, record_key
      LIMIT ?
    `).all(...terms, limit)
    return rows.map(row => ({ recordKey: sqlString(row, 'record_key'), score: sqlNumber(row, 'matched_terms') }))
  }
}
