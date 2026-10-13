import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PolicyDatabase, type PolicyBuildManifest } from './database.ts'
import { queryPolicies, type PolicyQueryOptions } from './query.ts'
import { SqliteQueryStore } from './query-store.ts'
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
