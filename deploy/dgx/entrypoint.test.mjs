import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const entrypoint = fileURLToPath(new URL('./entrypoint.sh', import.meta.url))
const posix = { skip: process.platform === 'win32' && 'The container entrypoint requires a POSIX shell.' }

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'e-agent-entrypoint-'))
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    const stub = join(bin, 'node')
    await writeFile(stub, '#!/bin/sh\n[ "$DGX_QWEN36_API_KEY" = "$EXPECTED_KEY" ] || exit 9\nprintf "%s\\n" "$@" > "$ARGS_OUTPUT"\n', { mode: 0o700 })
    const policy = join(root, 'policy-token')
    const model = join(root, 'model-key')
    await writeFile(policy, 'keyless-policy-token', { mode: 0o600 })
    await writeFile(model, 'keyless-model-secret\n', { mode: 0o600 })
    const output = join(root, 'args')
    const env = {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HARNESS_TRUSTED_HOSTS: '127.0.0.1:3080',
      POLICY_V2_DB_PATH: policy,
      POLICY_V2_COMPATIBILITY_PATH: policy,
      DGX_QWEN_API_KEY_FILE: model,
      EXPECTED_KEY: 'keyless-model-secret',
      ARGS_OUTPUT: output,
    }
    await run({ env, model, policy, output })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('loads the model secret and delegates unchanged arguments to dsh', posix, async () => {
  await fixture(async ({ env, output }) => {
    const result = spawnSync('/bin/sh', [entrypoint, 'web', '--patch', '/example.yml', '--no-open'], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(await readFile(output, 'utf8'), '/app/apps/cli/lib/bin.js\nweb\n--patch\n/example.yml\n--no-open\n')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  })
})

test('rejects missing policy data without exposing the model key', posix, async () => {
  await fixture(async ({ env, policy }) => {
    await rm(policy)
    const result = spawnSync('/bin/sh', [entrypoint, 'web'], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /policy data file/u)
    assert.doesNotMatch(result.stdout + result.stderr, /keyless-model-secret/u)
  })
})

test('rejects a model key consisting only of a newline', posix, async () => {
  await fixture(async ({ env, model }) => {
    await writeFile(model, '\n')
    const result = spawnSync('/bin/sh', [entrypoint, 'web'], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /model API key is empty/u)
  })
})

test('requires an explicit browser authority', posix, async () => {
  await fixture(async ({ env }) => {
    delete env.HARNESS_TRUSTED_HOSTS
    const result = spawnSync('/bin/sh', [entrypoint, 'web'], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /HARNESS_TRUSTED_HOSTS/u)
  })
})
