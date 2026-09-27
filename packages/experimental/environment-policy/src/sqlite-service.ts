import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  PolicyDatabase,
  type PolicyBuildManifest,
  type PolicyContentSearchHit,
  type PolicySourceRow,
} from './database.ts'
import {
  queryPolicies,
  type PolicyDescriptionSearchRequest,
  type PolicyExactSearchRequest,
  type PolicyQueryHit,
  type PolicyQueryOptions,
  type PolicyQueryStore,
  type PolicyReviewStatus,
  type PolicyTemporalStatus,
  type PolicyTextSearchRequest,
} from './query.ts'
import {
  EnvironmentPolicyError,
  EnvironmentPolicyKnowledge,
  type EnvironmentPolicyExecContext,
  type EnvironmentPolicySearchResult,
} from './service.ts'

/** SQLite provider configuration. */
export interface Config {
  /** Existing Step6 SQLite index. The provider opens it read-only in intent and never rebuilds it. */
  path: string
}

/** Schemastery configuration for Loader. */
export const Config: z<Config> = z.object({
  path: z.string().min(1).required(),
})

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

function queryHit(row: PolicyContentSearchHit): PolicyQueryHit {
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

class SqliteQueryStore implements PolicyQueryStore {
  private readonly database: PolicyDatabase

  constructor(database: PolicyDatabase) {
    this.database = database
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
    const hits = this.database.readContentUnits({
      recordKeys: sources.map(source => source.recordKey),
      ...(filters.articleLabel === undefined ? {} : { label: filters.articleLabel }),
      limit: request.limit,
    }).map(queryHit)
    return Promise.resolve(hits)
  }

  searchTitles(topic: string, limit: number): Promise<readonly PolicyQueryHit[]> {
    return Promise.resolve(this.database.searchTitles(topic, limit).map(queryHit))
  }

  searchContent(request: PolicyTextSearchRequest): Promise<readonly PolicyQueryHit[]> {
    const hits = this.database.searchContent(request.query, {
      limit: request.limit,
      ...(request.recordKeys === undefined ? {} : { recordKeys: request.recordKeys }),
    }).map(queryHit)
    return Promise.resolve(hits)
  }

  searchDescriptions(request: PolicyDescriptionSearchRequest) {
    return Promise.resolve(this.database.searchDescriptions(request.query, request.limit))
  }
}

/** Concrete read-only query provider over a Step6 SQLite index. */
export class SqliteEnvironmentPolicyKnowledge extends EnvironmentPolicyKnowledge {
  static Config = Config

  private readonly _database: PolicyDatabase
  private readonly _store: SqliteQueryStore
  private _closed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    try {
      this._database = new PolicyDatabase(config.path, { readOnly: true })
    } catch (error) {
      throw new EnvironmentPolicyError(
        `environment-policy index is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        'ENVIRONMENT_POLICY_INDEX_UNAVAILABLE',
      )
    }
    this._store = new SqliteQueryStore(this._database)
    ctx.effect(() => () => {
      this.close()
    }, 'environmentPolicyKnowledge.close')
  }

  protected [Service.init](): void {
    this.getManifest()
  }

  /** Close the local index; subsequent operations fail with a stable code. */
  close(): void {
    if (this._closed) return
    this._closed = true
    this._database.close()
  }

  getManifest(): PolicyBuildManifest {
    if (this._closed) throw new EnvironmentPolicyError('environment-policy service is closed', 'ENVIRONMENT_POLICY_SERVICE_CLOSED')
    const manifest = this._database.getManifest()
    if (manifest === undefined) {
      throw new EnvironmentPolicyError(
        'environment-policy index has no committed build',
        'ENVIRONMENT_POLICY_INDEX_EMPTY',
      )
    }
    return manifest
  }

  async search(
    question: string,
    options: PolicyQueryOptions = {},
    exec: EnvironmentPolicyExecContext = {},
  ): Promise<EnvironmentPolicySearchResult> {
    if (this._closed) throw new EnvironmentPolicyError('environment-policy service is closed', 'ENVIRONMENT_POLICY_SERVICE_CLOSED')
    if (exec.signal?.aborted) throw new EnvironmentPolicyError('environment-policy search aborted', 'ENVIRONMENT_POLICY_ABORTED')
    const manifest = this.getManifest()
    const evidence = await queryPolicies(this._store, question, options)
    if (exec.signal?.aborted) throw new EnvironmentPolicyError('environment-policy search aborted', 'ENVIRONMENT_POLICY_ABORTED')
    return {
      index: {
        schemaVersion: manifest.schemaVersion,
        buildId: manifest.buildId,
        corpusHash: manifest.corpusHash,
        builtAt: manifest.builtAt,
        sourceCount: manifest.sourceCount,
      },
      evidence,
    }
  }
}

export default SqliteEnvironmentPolicyKnowledge
