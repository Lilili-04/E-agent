/** Verify the portable deployment preset through the built public Web profile, without upstream services. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { withDefaultWeb, webGet } from './default-web-process.ts'

const preset = fileURLToPath(new URL('../../../../config/examples/environment-policy-dgx.patch.yml', import.meta.url))

it('boots the policy preset, Qwen route and clock before preset-local data is opened', async (test) => {
  test.onTestFinished(() => { vi.unstubAllEnvs() })
  try {
    await withDefaultWeb(test, async ({ url, request }) => {
      const auth = await webGet(url, test.signal)
      expect(auth.status).toBe(303)
      const cookie = auth.headers['set-cookie']?.[0]?.split(';', 1)[0]
      if (cookie === undefined) throw new Error('Missing authenticated Web session cookie')
      const page = await webGet(new URL('/', url), test.signal, { cookie })
      expect(page.status).toBe(200)
      expect(page.text).toContain('__DSH_BOOT__')
      const roster = await request('roster')
      for (const id of ['preset-environment-policy', 'llm-pi-ai', 'agent-default-model', 'time-context']) {
        expect(roster.entries.find(entry => entry.id === `include:${id}`), id).toMatchObject({ state: FiberState.ACTIVE })
      }
      expect(roster.entries.some(entry => entry.name === '@deepseek-ai/dsh-experimental-environment-policy')).toBe(false)
    }, {
      patches: [preset],
      prepare: async (root) => {
        const token = join(root, 'policy-token')
        await writeFile(token, 'keyless-deployment-fixture-token', { mode: 0o600 })
        vi.stubEnv('POLICY_V2_DB_PATH', join(root, 'policy-v2.sqlite'))
        vi.stubEnv('POLICY_V2_COMPATIBILITY_PATH', token)
        vi.stubEnv('POLICY_V2_SEMANTIC_CONFIG_PATH', token)
        vi.stubEnv('DGX_QWEN36_API_KEY', 'keyless-deployment-no-model-call')
      },
    })
  } finally {
    vi.unstubAllEnvs()
  }
})
