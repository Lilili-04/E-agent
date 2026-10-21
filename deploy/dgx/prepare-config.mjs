/** Render the deployment endpoint before dsh captures its launch environment; no credential value enters YAML. */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME
if (!home) throw new Error('Harness: set DSH_HOME to the persistent Harness home.')
const baseURL = new URL(process.env.DGX_QWEN_API_BASE_URL ?? 'http://vllm-qwen36:8000/v1')
if (!['http:', 'https:'].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.search || baseURL.hash) {
  throw new Error('Harness: model base URL must be HTTP(S), without credentials, query, or fragment.')
}
const source = readFileSync(new URL('../../apps/cli/config/examples/environment-policy-dgx.patch.yml', import.meta.url), 'utf8')
const marker = '        baseURL: http://vllm-qwen36:8000/v1'
if (source.split(marker).length !== 2) throw new Error('Harness: expected exactly one model endpoint in the deployment template.')
const rendered = source.replace(marker, '        baseURL: ' + JSON.stringify(baseURL.href))
const output = join(home, 'deployment')
function endpoint(name, fallback) {
  const value = new URL(process.env[name] ?? fallback)
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.search || value.hash) {
    throw new Error(`Harness: ${name} must be HTTP(S), without credentials, query, or fragment.`)
  }
  return value.href.replace(/\/$/u, '')
}
const timeoutMs = Number(process.env.POLICY_SEMANTIC_TIMEOUT_MS ?? 5000)
if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('Harness: invalid semantic timeout.')
const documentCollection = process.env.POLICY_DOCUMENT_COLLECTION
const passageCollection = process.env.POLICY_PASSAGE_COLLECTION
if (!documentCollection || !passageCollection) throw new Error('Harness: configure both national vector collections.')
const semantic = {
  embeddingUrl: endpoint('POLICY_EMBEDDING_URL', 'http://vllm-qwen3-embedding-4b:8000'),
  chromaUrl: endpoint('POLICY_CHROMA_URL', 'http://chroma:8000'),
  model: process.env.POLICY_EMBEDDING_MODEL ?? 'qwen3-embedding-4b',
  documentCollection, passageCollection, timeoutMs,
}
mkdirSync(output, { recursive: true, mode: 0o700 })
const pending = mkdtempSync(join(output, '.pending-'))
try {
  const path = join(pending, 'dgx.patch.yml')
  writeFileSync(path, rendered, { mode: 0o600, flag: 'wx' })
  const semanticPath = join(pending, 'policy-semantic.json')
  writeFileSync(semanticPath, JSON.stringify(semantic, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(semanticPath, join(output, 'policy-semantic.json'))
  renameSync(path, join(output, 'dgx.patch.yml'))
} finally {
  rmSync(pending, { recursive: true, force: true })
}
console.log('Harness deployment patch prepared.')
