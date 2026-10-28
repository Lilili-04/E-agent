/** Validate the mounted combined release and render its deployment-local endpoints. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.POLICY_RELEASE_DIR
const home = process.env.DSH_HOME
if (!root || !home) throw new Error('Set POLICY_RELEASE_DIR and DSH_HOME')
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const manifest = json(join(root, 'vectors/manifest.json'))
const graph = json(join(root, 'graph/source-config.json'))
if (!manifest.complete || manifest.database_sha256 !== hash(join(root, 'policy.sqlite')) ||
    graph.databaseSha256 !== manifest.database_sha256 || graph.snapshotSha256 !== hash(join(root, 'graph/graph.json'))) {
  throw new Error('Combined release checksum mismatch')
}
function endpoint(name, fallback, loopback = true) {
  const url = new URL(process.env[name] ?? fallback)
  if (!(loopback ? url.protocol === 'http:' : ['http:', 'https:'].includes(url.protocol)) ||
      (loopback && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must use an allowed HTTP endpoint without credentials, query, or fragment`)
  }
  return url.href.replace(/\/$/u, '')
}
const output = join(home, 'deployment')
mkdirSync(output, { recursive: true, mode: 0o700 })
const write = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
write('policy-semantic.json', {
  embeddingUrl: endpoint('POLICY_EMBEDDING_URL', 'http://127.0.0.1:8000'),
  chromaUrl: endpoint('POLICY_CHROMA_URL', 'http://127.0.0.1:18104'), model: manifest.model,
  documentCollection: manifest.collections.document, passageCollection: manifest.collections.passage,
  timeoutMs: 60000, embeddingRetries: 1, documentCandidates: 10, passageCandidates: 30,
  documentMaxDistance: 4, maxDistance: 2,
})
write('policy-graph.json', { ...graph, snapshot: join(root, 'graph/graph.json'),
  endpoint: endpoint('POLICY_GRAPH_URL', 'http://127.0.0.1:17475/db/neo4j/tx/commit') })
const template = readFileSync(new URL('./policy.patch.yml', import.meta.url), 'utf8')
if (/planningProvider|planningModel/u.test(template)) throw new Error('Model planning must stay disabled in this deployment')
writeFileSync(join(output, 'policy.patch.yml'), template.replace('http://127.0.0.1:8001/v1',
  endpoint('DGX_QWEN_API_BASE_URL', 'http://127.0.0.1:8001/v1', false)), { mode: 0o600 })
console.log('Combined release verified; backend automatic retrieval enabled.')
