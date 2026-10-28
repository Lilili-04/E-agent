import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./prepare.mjs', import.meta.url))
const digest = value => createHash('sha256').update(value).digest('hex')
test('renders the combined release with model planning disabled and rejects damaged snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'combined-release-'))
  try {
    mkdirSync(join(root, 'vectors'))
    mkdirSync(join(root, 'graph'))
    writeFileSync(join(root, 'policy.sqlite'), 'snapshot')
    writeFileSync(join(root, 'graph/graph.json'), '{}')
    writeFileSync(join(root, 'vectors/manifest.json'), JSON.stringify({ complete: true,
      database_sha256: digest('snapshot'), model: 'qwen3-embedding-4b',
      collections: { document: 'documents', passage: 'passages' } }))
    writeFileSync(join(root, 'graph/source-config.json'), JSON.stringify({
      databaseSha256: digest('snapshot'), snapshotSha256: digest('{}'), group: 'policy-combined-v4',
    }))
    const env = { ...process.env, POLICY_RELEASE_DIR: root, DSH_HOME: join(root, 'state'),
      DGX_QWEN_API_BASE_URL: 'http://172.27.153.44:8001/v1' }
    const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    const config = readFileSync(join(root, 'state/deployment/policy.patch.yml'), 'utf8')
    assert.doesNotMatch(config, /planningProvider|planningModel|compatibilityPath/u)
    assert.match(config, /vectorManifestPath/u)
    assert.match(config, /evidencePages: 12/u)
    assert.match(config, /host: 0\.0\.0\.0/u)
    assert.match(config, /baseURL: http:\/\/172\.27\.153\.44:8001\/v1/u)
    const graph = JSON.parse(readFileSync(join(root, 'state/deployment/policy-graph.json'), 'utf8'))
    assert.equal(graph.snapshot, join(root, 'graph/graph.json'))
    writeFileSync(join(root, 'graph/graph.json'), 'damaged')
    const damaged = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 10000 })
    assert.notEqual(damaged.status, 0)
    assert.match(damaged.stderr, /checksum mismatch/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
