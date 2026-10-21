/** Authenticated, read-only HTTP transport for an injected v2 retrieval provider. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readRequest, searchRequest } from './v2-wire.ts'
import type {} from './v2-service.ts'

/** Private listener and bounded request payloads. */
export interface Config { host?: string; port?: number; tokenFile: string; maxRequestBytes?: number; requestTimeoutMs?: number }
/** Loader configuration; remote access requires an explicit bind address. */
export const Config: z<Config> = z.object({
  host: z.string().default('127.0.0.1'), port: z.number().step(1).min(0).max(65535).default(18081), tokenFile: z.string().required(),
  maxRequestBytes: z.number().step(1).min(1024).max(1048576).default(32768),
  requestTimeoutMs: z.number().step(1).min(100).max(120000).default(15000),
})

/** HTTP listener owned by the dsh plugin lifecycle, without a separate application launcher. */
export default class PolicyV2Http extends Service {
  static Config = Config
  static inject = ['environmentPolicyV2']
  /** Listening endpoint, including the assigned ephemeral port in tests. */
  endpoint = ''
  private readonly shutdown = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private readonly server
  private readonly authorization: Buffer

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'environmentPolicyV2Http')
    const token = readFileSync(config.tokenFile, 'utf8').trim()
    if (token.length < 32) throw new Error('Policy API token must contain at least 32 characters')
    this.authorization = createHash('sha256').update(`Bearer ${token}`).digest()
    this.server = createServer((request, response) => {
      const task = this.handle(request, response).catch(() => { response.destroy() })
      this.pending.add(task)
      void task.finally(() => this.pending.delete(task))
    })
    this.server.requestTimeout = config.requestTimeoutMs ?? 15000
    this.server.headersTimeout = config.requestTimeoutMs ?? 15000
    ctx.effect(() => async () => {
      this.shutdown.abort()
      const closed = new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
      this.server.closeAllConnections()
      await Promise.allSettled([...this.pending])
      await closed
    }, 'policyV2Http.close')
  }

  protected async [Service.init](): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.port ?? 18081, this.config.host ?? '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Policy HTTP listener has no TCP address')
    this.endpoint = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      if (!response.destroyed) {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(body))
      }
    }
    if (!timingSafeEqual(this.authorization, createHash('sha256').update(request.headers.authorization ?? '').digest())) {
      reply(401, { error: 'unauthorized' }); return
    }
    if (request.method === 'GET' && request.url === '/v2/policy/status') {
      reply(200, { schemaVersion: 2, tools: ['policy_search', 'policy_read'] }); return
    }
    if (request.method !== 'POST' || !['/v2/policy/search', '/v2/policy/read'].includes(request.url ?? '')) {
      reply(404, { error: 'not_found' }); return
    }
    const disconnect = new AbortController()
    const signal = AbortSignal.any([disconnect.signal, this.shutdown.signal, AbortSignal.timeout(this.config.requestTimeoutMs ?? 15000)])
    const abort = () => { disconnect.abort() }
    response.once('close', abort)
    const expire = () => { request.destroy() }
    signal.addEventListener('abort', expire, { once: true })
    try {
      const chunks: Uint8Array[] = []
      let bytes = 0
      for await (const part of request) {
        const chunk: unknown = part
        if (!(chunk instanceof Uint8Array)) throw new Error('Invalid HTTP body chunk')
        bytes += chunk.byteLength
        if (bytes > (this.config.maxRequestBytes ?? 32768)) { reply(413, { error: 'request_too_large' }); return }
        chunks.push(chunk)
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (request.url === '/v2/policy/search') reply(200, await this.ctx.environmentPolicyV2.search(searchRequest(body), signal))
      else reply(200, await this.ctx.environmentPolicyV2.read(readRequest(body), signal))
    } catch (_error) {
      // Invalid selectors/cursors and malformed requests must not expose server paths or credentials.
      reply(signal.aborted ? 504 : 400, { error: signal.aborted ? 'request_aborted' : 'invalid_policy_request' })
    } finally {
      response.removeListener('close', abort)
      signal.removeEventListener('abort', expire)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { environmentPolicyV2Http: PolicyV2Http }
}
