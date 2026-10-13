import { PolicyDatabase, type PolicyContentSearchHit, type PolicySourceRow } from './database.ts'
import type { PolicyDescriptionSearchRequest, PolicyExactSearchRequest, PolicyQueryHit, PolicyQueryStore, PolicyReviewStatus, PolicyTemporalStatus, PolicyTextSearchRequest } from './query.ts'

function reviewStatus(row: PolicySourceRow): PolicyReviewStatus {
  return row.descriptionStatus ?? 'pending-review'
}

function temporalStatus(value: string | undefined): PolicyTemporalStatus {
  if (value === undefined) return 'unknown'
  if (/草案|征求意见/u.test(value)) return 'draft'
  if (/废止|失效/u.test(value)) return 'repealed'
  if (/替代|取代/u.test(value)) return 'superseded'
  if (/现行|有效/u.test(value)) return 'effective'
  return 'unknown'
}

/**
 * Project a SQLite source unit into retrieval evidence without generated descriptions.
 * @param row - indexed source unit and metadata.
 * @returns source-addressable query hit.
 */
export function queryHit(row: PolicyContentSearchHit): PolicyQueryHit {
  return {
    recordKey: row.recordKey,
    sourceId: row.sourceId,
    relativePath: row.relativePath,
    ...(row.title === undefined ? {} : { title: row.title }),
    ...(row.documentNumber === undefined ? {} : { documentNumber: row.documentNumber }),
    documentType: row.documentType,
    ...(row.jurisdiction === undefined ? {} : { jurisdiction: row.jurisdiction }),
    ...(row.publishDate === undefined ? {} : { publishDate: row.publishDate }),
    ...(row.legalStatus === undefined ? {} : { reportedLegalStatus: row.legalStatus }),
    reviewStatus: reviewStatus(row),
    temporal: {
      status: temporalStatus(row.legalStatus),
      reviewStatus: 'pending-review',
      ...(row.effectiveFrom === undefined ? {} : { effectiveFrom: row.effectiveFrom }),
      ...(row.effectiveTo === undefined ? {} : { effectiveTo: row.effectiveTo }),
    },
    unitId: row.unitId,
    kind: row.kind,
    ...(row.label === undefined ? {} : { label: row.label }),
    sectionPath: row.sectionPath,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    text: row.text,
    score: row.score,
  }
}

/** Read-only query adapter over the committed SQLite policy build. */
export class SqliteQueryStore implements PolicyQueryStore {
  protected readonly database: PolicyDatabase

  constructor(database: PolicyDatabase) {
    this.database = database
  }

  getTitles(): readonly string[] {
    return this.database.getTitles()
  }

  findExact(request: PolicyExactSearchRequest): Promise<readonly PolicyQueryHit[]> {
    const filters = request.plan.filters
    const sources = this.database.findSourcesByExact({
      ...(filters.title === undefined ? {} : { title: filters.title }),
      ...(filters.documentNumber === undefined ? {} : { documentNumber: filters.documentNumber }),
      ...(filters.documentTypes.length === 1 ? { documentType: filters.documentTypes[0] } : {}),
      ...(filters.date?.role === 'publish' && filters.date.from === filters.date.to
        ? { publishDate: filters.date.from }
        : {}),
    }, request.limit)
    if (request.plan.intent === 'overview' && filters.articleLabel === undefined) {
      return Promise.resolve(this.database.readOverviewUnits(sources.map(source => source.recordKey), request.limit).map(queryHit))
    }
    const hits = this.database.readContentUnits({
      recordKeys: sources.map(source => source.recordKey),
      ...(filters.articleLabel === undefined ? {} : { label: filters.articleLabel }),
      limit: request.limit,
    }).map(queryHit)
    return Promise.resolve(hits)
  }

  searchTitles(topic: string, limit: number, label?: string): Promise<readonly PolicyQueryHit[]> {
    return Promise.resolve(this.database.searchTitles(topic, limit, label).map(queryHit))
  }

  searchContent(request: PolicyTextSearchRequest): Promise<readonly PolicyQueryHit[]> {
    const constrained = request.plan.filters.title === undefined && request.plan.filters.documentNumber === undefined
      ? request.recordKeys
      : this.database.findSourcesByExact({ ...(request.plan.filters.title === undefined ? {} : { title: request.plan.filters.title }),
        ...(request.plan.filters.documentNumber === undefined ? {} : { documentNumber: request.plan.filters.documentNumber }),
      }, 100).map(row => row.recordKey)
    if (constrained !== undefined && constrained.length === 0) return Promise.resolve([])
    const hits = this.database.searchContent(request.query, {
      limit: request.limit,
      ...(constrained === undefined ? {} : { recordKeys: constrained }),
    }).map(queryHit)
    return Promise.resolve(hits)
  }

  searchDescriptions(request: PolicyDescriptionSearchRequest) {
    return Promise.resolve(this.database.searchDescriptions(request.query, request.limit))
  }
}
