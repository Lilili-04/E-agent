/** HTTP provider for v2 search/read; no SQLite file is opened on the client. */
import { readFileSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PolicyV2ReadRequest, PolicyV2ReadResult } from './v2-database.ts'
import type { PolicyV2Knowledge, PolicyV2SearchRequest, PolicyV2SearchResult } from './v2-service.ts'
import { readResult, searchResult } from './v2-wire.ts'

/** Authenticated remote endpoint and request deadline. */
export interface Config { endpoint: string; tokenFile: string; timeoutMs?: number; maxResponseBytes?: number }
/** Loader configuration; credentials are loaded from a private file. */
export const Config: z<Config> = z.object({
  endpoint: z.string().required(), tokenFile: z.string().required(),
  timeoutMs: z.number().step(1).min(100).max(120000).default(15000),
  maxResponseBytes: z.number().step(1).min(1024).max(16777216).default(4194304),
})

/** Remote implementation shared by the existing v2 model tools. */
export default class RemotePolicyV2Service extends Service implements PolicyV2Knowledge {
  static Config = Config
  private readonly endpoint: string
  private readonly token: string
  private readonly shutdown = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'environmentPolicyV2')
    const url = new URL(config.endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Policy endpoint must be HTTP(S), without credentials, query or fragment')
    }
    this.endpoint = url.href.replace(/\/$/u, '')
    this.token = readFileSync(config.tokenFile, 'utf8').trim()
    if (this.token.length < 32) throw new Error('Policy API token must contain at least 32 characters')
    ctx.effect(() => async () => {
      this.shutdown.abort()
      await Promise.allSettled([...this.pending])
    }, 'policyV2Remote.close')
  }

  protected async [Service.init](): Promise<void> {
    const status = await this.request('/v2/policy/status')
    if (!status || typeof status !== 'object' || !('schemaVersion' in status) || status.schemaVersion !== 2) {
      throw new Error('Remote policy API does not support schema version 2')
    }
  }

  /** Retrieve remote candidates, preserving cancellation and remote warnings.
   * @param request - Original question and optional scope.
   * @param signal - Caller cancellation.
   * @returns Validated source-backed candidates.
   */
  async search(request: PolicyV2SearchRequest, signal?: AbortSignal): Promise<PolicyV2SearchResult> {
    return searchResult(await this.request('/v2/policy/search', request, signal))
  }

  /** Read a remote source page without local database access.
   * @param request - Fixed document version, range and continuation.
   * @param signal - Caller cancellation.
   * @returns Original page and continuation state.
   */
  async read(request: PolicyV2ReadRequest, signal?: AbortSignal): Promise<PolicyV2ReadResult> {
    return readResult(await this.request('/v2/policy/read', request, signal))
  }

  private request(path: string, body?: PolicyV2ReadRequest | PolicyV2SearchRequest, signal?: AbortSignal): Promise<unknown> {
    const task = this.fetchResponse(path, body, signal)
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }

  private async fetchResponse(path: string, body?: PolicyV2ReadRequest | PolicyV2SearchRequest, signal?: AbortSignal): Promise<unknown> {
    const deadline = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.config.timeoutMs ?? 15000),
      ...(signal ? [signal] : [])])
    deadline.throwIfAborted()
    const response = await fetch(this.endpoint + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: deadline,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Remote policy API HTTP ${response.status}`) }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Remote policy API returned an empty response')
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > (this.config.maxResponseBytes ?? 4194304)) throw new Error('Remote policy response exceeds byte limit')
        chunks.push(value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
}
