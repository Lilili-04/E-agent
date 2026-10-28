/** Offline version selection and query intent; ordinary retrieval never opens the graph. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { canonical, type DocumentCard } from './v2-database.ts'
import { policyTitleMatches } from './v2-title-matches.ts'

interface Entry {
  title: string
  aliases: string[]
  region: string
  document_ids: string[]
  all_document_ids: string[]
  source_text_status: string
  status: 'ready' | 'missing_body' | 'unresolved'
}

/** Detect explicit version, temporal and validity requests without interpreting a quoted title as an intent.
 * @param question - Original user question.
 * @param documents - Catalog identifiers that explicitly constrain a version.
 * @returns Whether this request requires the historical graph path.
 */
export function needsPolicyGraph(question: string, documents: readonly DocumentCard[]): boolean {
  let outsideTitles = question.replace(/《[^》]+》/gu, '').replace(/最新(?:修订版|修正版|版本|版)/gu, '')
  for (const doc of [...documents].sort((a, b) => b.title.length - a.title.length)) {
    if (doc.title.length >= 4) outsideTitles = outsideTitles.replace(doc.title, '')
  }
  const intent = /历史|旧版|旧法|原版|历次|沿革|版本|废止|废除|失效|是否.*有效|仍.*有效|还.*有效|效力|现行|替代|取代|修订|修正|修改|施行|生效/u
  const validity = /有效(?:吗|么|性|[？?])|有效(?:的)?(?:法规|法律|条例|政策|规定)|是否.*适用|目前.*适用|现在.*适用|仍.*适用|还.*适用/u
  const version = /(?:19|20)\d{2}年?(?:版|修订|修正|发布|公布)|当时|(?:19|20)\d{2}年/u
  const normalized = canonical(question)
  return intent.test(outsideTitles) || validity.test(outsideTitles) || version.test(question) || documents.some(doc =>
    [doc.document_number, doc.standard_number].some(number => number && normalized.includes(canonical(number))))
}

/** Hash-bound local metadata generated offline from reviewed graph identities. */
export class PolicyLatest {
  private readonly entries: Entry[]
  /** Physical latest body IDs eligible for ordinary retrieval. */
  readonly documentIds: string[]

  constructor(path: string, databasePath: string, documents: readonly DocumentCard[]) {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || !('format' in value) || value.format !== 1 ||
      !('database_sha256' in value) || value.database_sha256 !== createHash('sha256').update(readFileSync(databasePath)).digest('hex') ||
      !('entries' in value) || !Array.isArray(value.entries)) throw new Error('Invalid latest-version manifest or SQLite hash mismatch')
    this.entries = value.entries.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || !('title' in entry) || typeof entry.title !== 'string' ||
        !('region' in entry) || typeof entry.region !== 'string' ||
        !('status' in entry) || !['ready', 'missing_body', 'unresolved'].includes(String(entry.status)) ||
        !('source_text_status' in entry) || typeof entry.source_text_status !== 'string' ||
        !('aliases' in entry) || !Array.isArray(entry.aliases) || !entry.aliases.every((s: unknown) => typeof s === 'string') ||
        !('document_ids' in entry) || !Array.isArray(entry.document_ids) || !entry.document_ids.every((s: unknown) => typeof s === 'string' && documents.some(d => d.id === s)) ||
        !('all_document_ids' in entry) || !Array.isArray(entry.all_document_ids) || !entry.all_document_ids.every((s: unknown) => typeof s === 'string')) throw new Error('Invalid latest-version entry')
      return entry as Entry
    })
    this.documentIds = [...new Set(this.entries.filter(e => e.status === 'ready').flatMap(e => e.document_ids))]
  }

  /** Resolve independently named identities, including versions with no available body.
   * @param question - Original question.
   * @param regions - Allowed catalog regions.
   * @returns Matching identity entries, or an empty list for a topic query.
   */
  match(question: string, regions: string[]): Entry[] {
    const titles = [...question.matchAll(/《([^》]+)》/gu)].flatMap(match => match[1] ? [match[1]] : [])
    if (titles.length > 1) return [...new Set(titles.flatMap(title => this.match(title, regions)))]
    const normalized = canonical(question)
    return policyTitleMatches(normalized, this.entries.filter(e => regions.includes(e.region)),
      entry => [entry.title, ...entry.aliases].map(title => canonical(title).replace(/^中华人民共和国/u, '')))
  }

  /** Keep graph-reviewed partial sources partial without a runtime graph request.
   * @param documentId - Physical source ID.
   * @returns Whether the offline metadata identifies a complete latest body.
   */
  complete(documentId: string): boolean {
    return this.entries.some(e => e.document_ids.includes(documentId) && e.source_text_status === 'complete')
  }
}
