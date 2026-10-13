import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { PolicyDatabase, type PolicyBuildManifest } from '../src/database.ts'
import { queryPolicies, type PolicyQueryOptions } from '../src/query.ts'
import { HybridQueryStore } from '../src/hybrid-store.ts'
import { performance } from 'node:perf_hooks'
import { SqliteQueryStore } from '../src/query-store.ts'

const HOST = process.env.POLICY_API_HOST ?? '0.0.0.0'
const PORT = Number.parseInt(process.env.POLICY_API_PORT ?? '8080', 10)
const DB_PATH = process.env.POLICY_DB_PATH ?? '/app/data/policy-national-v1.sqlite'
const TOKEN = process.env.POLICY_API_TOKEN_FILE === undefined
  ? process.env.POLICY_API_TOKEN ?? ''
  : readFileSync(process.env.POLICY_API_TOKEN_FILE, 'utf8').trim()
if (TOKEN.length < 32) throw new Error('POLICY_API_TOKEN must contain at least 32 characters')
const MAX_BODY_BYTES = 512_000

function manifestIdentity(manifest: PolicyBuildManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    buildId: manifest.buildId,
    corpusHash: manifest.corpusHash,
    builtAt: manifest.builtAt,
    sourceCount: manifest.sourceCount,
  }
}

function requireManifest(): PolicyBuildManifest {
  const manifest = database.getManifest()
  if (manifest === undefined) throw new Error('environment-policy index has no committed build')
  return manifest
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', Buffer.byteLength(body))
  response.end(body)
}

function authorized(request: IncomingMessage): boolean {
  if (TOKEN.length === 0) return false
  const provided = Buffer.from(request.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${TOKEN}`)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function requestOptions(value: unknown): PolicyQueryOptions {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('options must be an object')
  // Harness sends these fields; arbitrary provider filters are not accepted over HTTP.
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some(key => !['maxResults', 'maxEvidenceCharacters', 'currentDate', 'titleTopic'].includes(key))) {
    throw new Error('unsupported search option')
  }
  if (fields.maxResults !== undefined && typeof fields.maxResults !== 'number') throw new Error('maxResults must be a number')
  if (fields.maxEvidenceCharacters !== undefined && typeof fields.maxEvidenceCharacters !== 'number') throw new Error('maxEvidenceCharacters must be a number')
  if (fields.currentDate !== undefined && typeof fields.currentDate !== 'string') throw new Error('currentDate must be a string')
  if (fields.titleTopic !== undefined && typeof fields.titleTopic !== 'string') throw new Error('titleTopic must be a string')
  return {
    ...(fields.maxResults === undefined ? {} : { maxResults: fields.maxResults }),
    ...(fields.maxEvidenceCharacters === undefined ? {} : { maxEvidenceCharacters: fields.maxEvidenceCharacters }),
    ...(fields.currentDate === undefined ? {} : { currentDate: fields.currentDate }),
    ...(fields.titleTopic === undefined ? {} : { titleTopic: fields.titleTopic }),
  }
}

const database = new PolicyDatabase(DB_PATH, { readOnly: true })
requireManifest()
function numberSetting(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`invalid ${name}`)
  return value
}
const documentCollection = process.env.POLICY_DOCUMENT_COLLECTION?.trim()
const passageCollection = process.env.POLICY_PASSAGE_COLLECTION?.trim()
const store = !documentCollection ? new SqliteQueryStore(database)
  : new HybridQueryStore(database, {
    embeddingUrl: process.env.POLICY_EMBEDDING_URL ?? 'http://vllm-qwen3-embedding-4b:8000',
    chromaUrl: process.env.POLICY_CHROMA_URL ?? 'http://chroma:8000',
    model: process.env.POLICY_EMBEDDING_MODEL ?? 'qwen3-embedding-4b',
    documentCollection,
    ...(!passageCollection ? {} : { passageCollection }),
    timeoutMs: numberSetting('POLICY_SEMANTIC_TIMEOUT_MS', 2000, 8000),
    documentCandidates: numberSetting('POLICY_DOCUMENT_CANDIDATES', 12, 100),
    passageCandidates: numberSetting('POLICY_PASSAGE_CANDIDATES', 32, 100),
    documentMaxDistance: numberSetting('POLICY_DOCUMENT_MAX_DISTANCE', 0.9, 4),
    maxDistance: numberSetting('POLICY_PASSAGE_MAX_DISTANCE', 0.45, 2),
    cacheEntries: numberSetting('POLICY_EMBEDDING_CACHE_ENTRIES', 256, 10000),
  })
const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8_192 }, async (request, response) => {
  try {
    const method = request.method ?? 'GET'
    const path = new URL(request.url ?? '/', 'http://policy-api').pathname
    if (method === 'GET' && path === '/health') {
      const manifest = requireManifest()
      json(response, 200, { status: 'ok', database: 'ready', index: manifestIdentity(manifest) })
      return
    }
    if (method === 'GET' && path === '/v1/policy/manifest') {
      if (!authorized(request)) {
        json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } })
        return
      }
      json(response, 200, requireManifest())
      return
    }
    if (method === 'POST' && path === '/v1/policy/search') {
      if (!authorized(request)) {
        json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } })
        return
      }
      const body = await readJson(request)
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('request body must be an object')
      const question = (body as { question?: unknown }).question
      if (typeof question !== 'string' || question.trim().length === 0 || question.length > 4000) throw new Error('question is required')
      const options = requestOptions((body as { options?: unknown }).options)
      const started = performance.now()
      const evidence = await queryPolicies(store, question, options)
      json(response, 200, {
        index: manifestIdentity(requireManifest()), evidence,
        diagnostics: {
          ...evidence.diagnostics, totalMs: Math.round(performance.now() - started),
          semanticEnabled: store instanceof HybridQueryStore, route: evidence.plan.intent,
        },
      })
      return
    }
    json(response, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } })
  } catch (error) {
    json(response, 400, { error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) } })
  }
})

server.listen(PORT, HOST, () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('API has no TCP address')
  console.log(`environment-policy API listening on ${HOST}:${String(address.port)}`)
})

function shutdown(): void {
  server.close(() => database.close())
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
