import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./prepare-config.mjs', import.meta.url))

test('writes a private endpoint configuration without putting credentials into YAML', async () => {
  const home = await mkdtemp(join(tmpdir(), 'e-agent-config-'))
  try {
    const result = spawnSync(process.execPath, [script], {
      env: { DSH_HOME: home, DGX_QWEN_API_BASE_URL: 'http://127.0.0.1:18001/v1', DGX_QWEN38_API_KEY: 'keyless-do-not-persist',
        POLICY_DOCUMENT_COLLECTION: 'national-documents', POLICY_PASSAGE_COLLECTION: 'national-passages' },
      encoding: 'utf8', timeout: 10000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    const config = await readFile(join(home, 'deployment/dgx.patch.yml'), 'utf8')
    assert.match(config, /baseURL: "http:\/\/127\.0\.0\.1:18001\/v1"/u)
    assert.match(config, /apiKeyEnv: DGX_QWEN38_API_KEY/u)
    assert.doesNotMatch(config + result.stdout + result.stderr, /keyless-do-not-persist/u)
    const semantic = JSON.parse(await readFile(join(home, 'deployment/policy-semantic.json'), 'utf8'))
    assert.equal(semantic.documentCollection, 'national-documents')
    assert.equal(semantic.passageCollection, 'national-passages')
    assert.equal(semantic.chromaUrl, 'http://chroma:8000')
    assert.match(config, /environment-policy\/v2-service/u)
    assert.match(config, /environment-policy\/v2-tools/u)
    assert.doesNotMatch(config, /remote-service|DGX_POLICY_API/u)
    assert.deepEqual(await readdir(join(home, 'deployment')), ['dgx.patch.yml', 'policy-semantic.json'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('rejects credentials embedded in an endpoint before writing configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'e-agent-config-'))
  try {
    const result = spawnSync(process.execPath, [script], {
      env: { DSH_HOME: home, DGX_QWEN_API_BASE_URL: 'https://user:private-value@example.test/v1' },
      encoding: 'utf8', timeout: 10000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /without credentials/u)
    assert.doesNotMatch(result.stdout + result.stderr, /private-value/u)
    assert.deepEqual(await readdir(home), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
