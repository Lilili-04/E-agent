import { readFileSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  ENVIRONMENT_POLICY_SCHEMA_VERSION,
  type PolicyBuildManifest,
} from './database.ts'
import type { PolicyQueryOptions } from './query.ts'
import {
  EnvironmentPolicyError,
  EnvironmentPolicyKnowledge,
  type EnvironmentPolicyExecContext,
  type EnvironmentPolicySearchResult,
} from './service.ts'

/** Configuration for a remote read-only environment-policy API. */
export interface RemoteConfig {
  /** Base URL of the DGX policy API, for example http://172.27.153.44:18080. */
  endpoint: string
  /** Optional bearer token required by the API. */
  token?: string
  /** Local token file; useful when launching from an interactive terminal. */
  tokenFile?: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
}

/** Schemastery configuration for Loader. */
export const RemoteConfig: z<RemoteConfig> = z.object({
  endpoint: z.string().required(),
  token: z.string().default(''),
  tokenFile: z.string().default(''),
  timeoutMs: z.number().default(8_000),
})

type RemoteResponse = EnvironmentPolicySearchResult

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isManifest(value: unknown): value is PolicyBuildManifest {
  return isRecord(value) && value.schemaVersion === ENVIRONMENT_POLICY_SCHEMA_VERSION
    && ['buildId', 'sourceRoot', 'builtAt', 'corpusHash'].every(key => typeof value[key] === 'string')
    && ['sourceCount', 'unitCount', 'descriptionCount'].every(key => Number.isInteger(value[key]) && Number(value[key]) >= 0)
}

function isSearchResponse(value: unknown): value is RemoteResponse {
  if (!isRecord(value) || !isRecord(value.index) || !isRecord(value.evidence)) return false
  const index = value.index
  const evidence = value.evidence
  return index.schemaVersion === ENVIRONMENT_POLICY_SCHEMA_VERSION
    && ['buildId', 'builtAt', 'corpusHash'].every(key => typeof index[key] === 'string')
    && Number.isInteger(index.sourceCount)
    && isRecord(evidence.plan) && typeof evidence.plan.question === 'string'
    && Array.isArray(evidence.warnings) && evidence.warnings.every(item => typeof item === 'string')
    && isRecord(evidence.limits)
    && Array.isArray(evidence.results) && evidence.results.length <= 50
    && evidence.results.every(item => isRecord(item)
      && ['resultId', 'recordKey', 'sourceId', 'relativePath', 'documentType', 'unitId', 'kind', 'text'].every(key => typeof item[key] === 'string')
      && isRecord(item.temporal) && typeof item.temporal.status === 'string'
      && Array.isArray(item.sectionPath) && Array.isArray(item.matchReasons)
      && typeof item.textTruncated === 'boolean' && typeof item.score === 'number')
}

/** Read-only environment-policy service backed by the DGX HTTP API. */
export class RemoteEnvironmentPolicyKnowledge extends EnvironmentPolicyKnowledge {
  static Config = RemoteConfig

  private readonly endpoint: string
  private readonly token: string
  private readonly timeoutMs: number
  private manifest: PolicyBuildManifest | undefined
  private closed = false
  private readonly controllers = new Set<AbortController>()

  constructor(ctx: Context, config: RemoteConfig) {
    super(ctx)
    this.endpoint = config.endpoint.replace(/\/+$/u, '')
    this.token = config.tokenFile === undefined || config.tokenFile.length === 0
      ? config.token ?? ''
      : readFileSync(config.tokenFile, 'utf8').trim()
    this.timeoutMs = config.timeoutMs ?? 8_000
    if (!/^https?:\/\//u.test(this.endpoint)) {
      throw new EnvironmentPolicyError('remote policy API endpoint is required', 'ENVIRONMENT_POLICY_REMOTE_UNAVAILABLE')
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new EnvironmentPolicyError('remote policy API timeout is invalid', 'ENVIRONMENT_POLICY_REMOTE_UNAVAILABLE')
    }
    ctx.effect(() => () => {
      this.close()
    }, 'environmentPolicyRemote.close')
  }

  protected async [Service.init](): Promise<void> {
    const value = await this.request('/v1/policy/manifest', {})
    if (!isManifest(value)) {
      throw new EnvironmentPolicyError('remote policy API manifest is invalid or incompatible', 'ENVIRONMENT_POLICY_REMOTE_UNAVAILABLE')
    }
    this.manifest = value
  }

  getManifest(): PolicyBuildManifest {
    if (this.closed) throw new EnvironmentPolicyError('environment-policy service is closed', 'ENVIRONMENT_POLICY_SERVICE_CLOSED')
    if (this.manifest === undefined) {
      throw new EnvironmentPolicyError('remote policy API manifest has not been loaded', 'ENVIRONMENT_POLICY_INDEX_EMPTY')
    }
    return this.manifest
  }

  close(): void {
    this.closed = true
    for (const controller of this.controllers) controller.abort()
  }

  async search(
    question: string,
    options: PolicyQueryOptions = {},
    exec: EnvironmentPolicyExecContext = {},
  ): Promise<EnvironmentPolicySearchResult> {
    if (this.closed) throw new EnvironmentPolicyError('environment-policy service is closed', 'ENVIRONMENT_POLICY_SERVICE_CLOSED')
    const value = await this.request('/v1/policy/search', {
      method: 'POST',
      body: JSON.stringify({ question, options }),
    }, exec.signal)
    if (!isSearchResponse(value)) {
      throw new EnvironmentPolicyError('remote policy API returned an invalid or incompatible search response', 'ENVIRONMENT_POLICY_REMOTE_UNAVAILABLE')
    }
    const manifest = this.getManifest()
    if (value.index.buildId !== manifest.buildId || value.index.corpusHash !== manifest.corpusHash) {
      await this[Service.init]()
    }
    return value
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new EnvironmentPolicyError('environment-policy search aborted', 'ENVIRONMENT_POLICY_ABORTED')
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => { controller.abort() }, this.timeoutMs)
    const abort = () => { controller.abort() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (this.token.length > 0) headers.authorization = `Bearer ${this.token}`
      const response = await fetch(`${this.endpoint}${path}`, {
        ...init, headers, signal: controller.signal, redirect: 'error',
      })
      if (!response.ok) throw new Error(`remote policy API returned HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      if (signal?.aborted) {
        throw new EnvironmentPolicyError('environment-policy search aborted', 'ENVIRONMENT_POLICY_ABORTED')
      }
      throw new EnvironmentPolicyError(
        `remote policy API unavailable: ${error instanceof Error ? error.message : String(error)}`,
        'ENVIRONMENT_POLICY_REMOTE_UNAVAILABLE',
      )
    } finally {
      clearTimeout(timer)
      this.controllers.delete(controller)
      signal?.removeEventListener('abort', abort)
    }
  }
}

export default RemoteEnvironmentPolicyKnowledge
