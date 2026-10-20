/** Two business tables, two rebuildable FTS5 indexes, and deterministic original-text reading. */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { articleKey, sourceUnits, type SourceUnit } from './v2-parser.ts'
import { policyMatch, policyTerms } from './v2-tokenizer.ts'

/** One source-backed document version; summaries are discovery aids only. */
export interface PolicyDocument {
  id: string
  title: string
  document_number: string | null
  standard_number: string | null
  document_type: string | null
  issuing_authority: string | null
  region: string | null
  publish_date: string | null
  effective_date: string | null
  legal_status: string | null
  description: string
  full_text: string
  pdf_path: string | null
  markdown_path: string
  source_hash: string
  text_status: 'complete' | 'partial' | 'missing'
}

/** Model-visible metadata excludes machine-specific storage paths. */
export type DocumentCard = Omit<PolicyDocument, 'full_text' | 'pdf_path' | 'markdown_path'>

/** A source unit with its owning document, suitable for citation. */
export interface Passage extends SourceUnit {
  document: DocumentCard
  excerpted?: boolean
}

/** Original-text selection; paging never changes the selected version or scope. */
export interface PolicyV2ReadRequest {
  document_id: string
  scope?: 'full' | 'section' | 'article'
  selector?: string
  cursor?: string
}

/** Full-source completeness and page completeness are independent. */
export interface PolicyV2ReadResult {
  document: DocumentCard
  scope: 'full' | 'section' | 'article'
  units: SourceUnit[]
  text: string
  found: boolean
  has_more: boolean
  next_cursor: string | null
  source_complete: boolean
  unit_fragments: boolean
}

/** Exact normalization retains years, version labels and geographical qualifiers.
 * @param text - Title, identifier or question.
 * @returns Text for conservative title matching.
 */
export function canonical(text: string): string {
  return text.normalize('NFKC').replace(/[\s《》“”"'·]/gu, '').toLowerCase()
}

function sourceRow(row: Record<string, SQLOutputValue>): SourceUnit {
  if (row.kind !== 'article' && row.kind !== 'heading' && row.kind !== 'paragraph') throw new Error('Invalid source unit kind')
  return { id: String(row.id), document_id: String(row.document_id), sequence: Number(row.sequence), kind: row.kind,
    label: String(row.label), section_path: String(row.section_path), text: String(row.text),
    line_start: Number(row.line_start), line_end: Number(row.line_end) }
}

/** Read-only query store. Builders use create(), never the runtime constructor. */
export class PolicyV2Database {
  /** Read-only SQLite handle for offline diagnostics; the store owns its lifetime. */
  readonly sql: DatabaseSync
  /** Version-specific metadata loaded from this snapshot, excluding machine paths. */
  readonly documents: DocumentCard[]

  constructor(path: string) {
    this.sql = new DatabaseSync(path, { readOnly: true })
    try {
      if (this.sql.prepare('PRAGMA user_version').get()?.user_version !== 2) throw new Error('Expected policy schema version 2')
      this.documents = this.sql.prepare(`SELECT id,title,document_number,standard_number,document_type,
        issuing_authority,region,publish_date,effective_date,legal_status,description,source_hash,text_status FROM documents`).all() as DocumentCard[]
    } catch (error) { this.sql.close(); throw error }
  }

  /** Build a new database; caller must choose a fresh staging path.
   * @param path - Nonexistent database path.
   * @param documents - Validated source records.
   */
  static create(path: string, documents: PolicyDocument[]): void {
    const db = new DatabaseSync(path)
    try {
      db.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE documents (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, document_number TEXT, standard_number TEXT,
          document_type TEXT, issuing_authority TEXT, region TEXT, publish_date TEXT, effective_date TEXT,
          legal_status TEXT, description TEXT NOT NULL, full_text TEXT NOT NULL, pdf_path TEXT,
          markdown_path TEXT NOT NULL, source_hash TEXT NOT NULL,
          text_status TEXT NOT NULL CHECK(text_status IN ('complete','partial','missing')));
        CREATE TABLE content_units (
          id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), sequence INTEGER NOT NULL,
          kind TEXT NOT NULL, label TEXT NOT NULL, section_path TEXT NOT NULL, text TEXT NOT NULL,
          line_start INTEGER NOT NULL, line_end INTEGER NOT NULL, UNIQUE(document_id,sequence));
        CREATE INDEX units_document ON content_units(document_id,sequence);
        CREATE INDEX documents_hash ON documents(source_hash);
        CREATE VIRTUAL TABLE documents_fts USING fts5(title,description, tokenize='unicode61');
        CREATE VIRTUAL TABLE content_units_fts USING fts5(text, tokenize='unicode61');
        PRAGMA user_version=2; BEGIN IMMEDIATE;`)
      const insertDoc = db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      const insertUnit = db.prepare('INSERT INTO content_units VALUES (?,?,?,?,?,?,?,?,?)')
      const docFts = db.prepare('INSERT INTO documents_fts(rowid,title,description) VALUES (?,?,?)')
      const unitFts = db.prepare('INSERT INTO content_units_fts(rowid,text) VALUES (?,?)')
      for (const doc of documents) {
        if (createHash('sha256').update(doc.full_text).digest('hex') !== doc.source_hash) throw new Error(`Source hash mismatch: ${doc.id}`)
        const inserted = insertDoc.run(doc.id, doc.title, doc.document_number, doc.standard_number, doc.document_type,
          doc.issuing_authority, doc.region, doc.publish_date, doc.effective_date, doc.legal_status, doc.description,
          doc.full_text, doc.pdf_path, doc.markdown_path, doc.source_hash, doc.text_status)
        docFts.run(inserted.lastInsertRowid, policyTerms(doc.title).join(' '), policyTerms(doc.description).join(' '))
        for (const unit of sourceUnits(doc.id, doc.full_text)) {
          const insertedUnit = insertUnit.run(unit.id, unit.document_id, unit.sequence, unit.kind, unit.label,
            unit.section_path, unit.text, unit.line_start, unit.line_end)
          unitFts.run(insertedUnit.lastInsertRowid, policyTerms(unit.text).join(' '))
        }
      }
      db.exec("COMMIT; INSERT INTO documents_fts(documents_fts) VALUES('optimize'); INSERT INTO content_units_fts(content_units_fts) VALUES('optimize');")
      if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('SQLite integrity check failed')
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Policy foreign key mismatch')
    } finally { db.close() }
  }

  /** Release the read handle. */
  close(): void { this.sql.close() }

  /** Resolve one immutable version ID.
   * @param id - Search-returned document ID.
   * @returns Metadata, or undefined when absent.
   */
  document(id: string): DocumentCard | undefined { return this.documents.find(doc => doc.id === id) }

  /** Find exact title/identifier candidates without choosing a version by date alone.
   * @param query - Original question.
   * @returns All matching versions of the longest explicit title.
   */
  exact(query: string): DocumentCard[] {
    const normalized = canonical(query)
    const scored = this.documents.map((doc) => {
      const title = canonical(doc.title)
      const alias = title.replace(/^中华人民共和国/u, '')
      const matched = normalized.includes(title) ? title.length : alias.length >= 4 && normalized.includes(alias) ? alias.length : 0
      const identifiers = [doc.document_number, doc.standard_number].filter((v): v is string => !!v)
      return { doc, score: identifiers.some(value => normalized.includes(canonical(value))) ? 10000 : matched }
    }).filter(item => item.score > 0)
    const best = Math.max(...scored.map(item => item.score))
    let result = scored.filter(item => item.score === best).map(item => item.doc)
    const year = query.match(/(?:19|20)\d{2}(?=年|版|修订|修正)/u)?.[0]
    if (year) result = result.filter(doc => doc.publish_date?.startsWith(year) || doc.title.includes(year))
    return result
  }

  /** Rank title and description jointly with native FTS5 BM25.
   * @param query - User query.
   * @param limit - Candidate count after BM25 ranking.
   * @param region - Explicit geographical filter.
   * @returns Ranked document cards.
   */
  searchDocuments(query: string, limit: number, region?: string): DocumentCard[] {
    const match = policyMatch(query)
    if (!match) return []
    const rows = this.sql.prepare(`SELECT d.id FROM documents_fts JOIN documents d ON d.rowid=documents_fts.rowid
      WHERE documents_fts MATCH ? ${region ? 'AND d.region=?' : ''}
      ORDER BY bm25(documents_fts,5.0,1.0),d.id LIMIT ?`).all(...[match, ...(region ? [region] : []), limit])
    return rows.flatMap((row) => { const doc = this.document(String(row.id)); return doc ? [doc] : [] })
  }

  /** Retrieve complete source units using native BM25, optionally within selected documents.
   * @param query - Topic query with explicit title removed when scoped.
   * @param limit - Candidate bound.
   * @param ids - Optional document scope; an empty list yields no matches.
   * @param region - Explicit geographical filter.
   * @returns Ranked original units, never presegmented index text.
   */
  searchPassages(query: string, limit: number, ids?: string[], region?: string): Passage[] {
    const match = policyMatch(query)
    if (!match || ids?.length === 0) return []
    const params: SQLInputValue[] = [match]
    const conditions: string[] = []
    if (ids) { conditions.push(`u.document_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids) }
    if (region) { conditions.push('d.region=?'); params.push(region) }
    params.push(limit)
    const rows = this.sql.prepare(`SELECT u.* FROM content_units_fts
      JOIN content_units u ON u.rowid=content_units_fts.rowid JOIN documents d ON d.id=u.document_id
      WHERE content_units_fts MATCH ? ${conditions.map(c => `AND ${c}`).join(' ')}
      ORDER BY bm25(content_units_fts),u.id LIMIT ?`).all(...params).map(sourceRow)
    return rows.map((unit) => {
      const document = this.document(unit.document_id)
      if (!document) throw new Error('Source unit references an unavailable document')
      return { ...unit, document }
    })
  }

  /** Locate original units covering a verified legacy span.
   * @param documentId - Mapped version.
   * @param start - Inclusive source line.
   * @param end - Inclusive source line.
   * @returns All overlapping units, in original order.
   */
  atLines(documentId: string, start: number, end: number): Passage[] {
    const doc = this.document(documentId)
    if (!doc) return []
    const rows = this.sql.prepare('SELECT * FROM content_units WHERE document_id=? AND line_end>=? AND line_start<=? ORDER BY sequence')
      .all(documentId, start, end).map(sourceRow)
    return rows.map(unit => ({ ...unit, document: doc }))
  }

  /** Read an exact original selection in consecutive structural pages.
   * @param request - Fixed version and scope.
   * @param maxCharacters - Page character bound; oversized units continue explicitly on the next page.
   * @returns Original text and continuation state. A missing article has found=false.
   */
  read(request: PolicyV2ReadRequest, maxCharacters: number): PolicyV2ReadResult {
    const doc = this.document(request.document_id)
    if (!doc) throw new Error('Unknown document_id; call policy_search first')
    const scope = request.scope ?? 'full'
    if (scope !== 'full' && !request.selector) throw new Error('section/article requires selector')
    const requestedSelector = request.selector ?? ''
    let units = this.sql.prepare('SELECT * FROM content_units WHERE document_id=? ORDER BY sequence').all(doc.id).map(sourceRow)
    if (scope === 'article') units = units.filter(unit => unit.kind === 'article' && articleKey(unit.label) === articleKey(requestedSelector))
    if (scope === 'section') {
      const selector = canonical(requestedSelector)
      const marker = (label: string) => label.match(/^第[零〇一二三四五六七八九十百千万两\d]+([编章节])/u)
      const depth = (unit: SourceUnit) => {
        const type = marker(unit.label)?.[1]
        return type ? { 编: 1, 章: 2, 节: 3 }[type] ?? 4 : unit.text.match(/^#+/u)?.[0].length ?? 4
      }
      const ranges = units.flatMap((unit, index) => {
        if (unit.kind !== 'heading' || !(canonical(unit.label) === selector || articleKey(marker(unit.label)?.[0] ?? '') === articleKey(selector))) return []
        let end = index + 1
        while (end < units.length) {
          const nextUnit = units[end]
          if (!nextUnit || (nextUnit.kind === 'heading' && depth(nextUnit) <= depth(unit))) break
          end++
        }
        const selected = units.slice(index, end)
        return selected.some(item => item.kind !== 'heading' && item.text.trim()) ? [selected] : []
      })
      if (ranges.length > 1) throw new Error('Section selector is ambiguous; read full text or specify the complete heading')
      units = ranges[0] ?? []
    }
    const identity = createHash('sha256').update(JSON.stringify([doc.id, doc.source_hash, scope, request.selector ?? ''])).digest('hex')
    let offset = 0
    let within = 0
    if (request.cursor) {
      let cursor: unknown
      try { cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) } catch { throw new Error('Invalid read cursor') }
      if (!cursor || typeof cursor !== 'object' || !('identity' in cursor) || cursor.identity !== identity ||
        !('offset' in cursor) || typeof cursor.offset !== 'number' || !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= units.length) throw new Error('Cursor does not match version/scope')
      offset = cursor.offset
      if ('within' in cursor) {
        const cursorUnit = units[offset]
        if (!cursorUnit || typeof cursor.within !== 'number' || !Number.isInteger(cursor.within) || cursor.within < 0 ||
          cursor.within >= cursorUnit.text.length) throw new Error('Invalid intra-unit cursor')
        within = cursor.within
      }
    }
    const selected: SourceUnit[] = []
    let length = 0
    let fragments = within > 0
    let next = offset
    for (const unit of units.slice(offset)) {
      const remaining = unit.text.slice(within)
      if (selected.length && length + remaining.length > maxCharacters) break
      if (remaining.length > maxCharacters) {
        let end = maxCharacters
        const prefix = remaining.slice(0, end)
        const boundary = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('。'), prefix.lastIndexOf('；'))
        if (boundary > maxCharacters / 2) end = boundary + 1
        // Avoid cutting a UTF-16 surrogate pair or CRLF.
        if (/[\uD800-\uDBFF\r]/u.test(remaining.charAt(end - 1))) end--
        const text = remaining.slice(0, end)
        const lineStart = unit.line_start + (unit.text.slice(0, within).match(/\n/gu)?.length ?? 0)
        selected.push({ ...unit, text, line_start: lineStart, line_end: lineStart + (text.match(/\n/gu)?.length ?? 0) })
        within += end; fragments = true
        break
      }
      selected.push({ ...unit, text: remaining }); length += remaining.length
      next++; within = 0
    }
    const hasMore = next < units.length
    return { document: doc, scope, units: selected, text: selected.map(unit => unit.text).join(''),
      found: units.length > 0, has_more: hasMore, next_cursor: hasMore ? Buffer.from(JSON.stringify({ identity, offset: next, within })).toString('base64url') : null,
      source_complete: doc.text_status === 'complete', unit_fragments: fragments }
  }
}
