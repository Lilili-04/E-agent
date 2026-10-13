import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PolicyDatabase } from '../src/database.ts'
import { extractPolicyMetadata } from '../src/metadata.ts'
import { parsePolicyMarkdown } from '../src/parse.ts'
import RemoteEnvironmentPolicyKnowledge from '../src/remote-service.ts'
import * as PolicyTools from '../src/tools.ts'

const token = 'test-token-with-at-least-thirty-two-characters'
let root: string
let endpoint: string
let child: ChildProcess | undefined

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'environment-policy-http-'))
  const markdown = '# 中华人民共和国核安全法\n\n第一条 为了保障核安全，保护生态环境，制定本法。'
  const hash = createHash('sha256').update(markdown).digest('hex')
  const sourceId = `source-${hash.slice(0, 24)}`
  const parsed = parsePolicyMarkdown(sourceId, markdown)
  const path = join(root, 'policy.sqlite')
  const db = new PolicyDatabase(path)
  db.rebuild({ sourceRoot: 'fixture', builtAt: '2026-10-13T00:00:00.000Z', documents: [{
    source: { sourceId, relativePath: 'nuclear/full.md', sha256: hash, byteLength: Buffer.byteLength(markdown), headingCandidates: ['中华人民共和国核安全法'], quality: [] },
    markdown, parsed, metadata: extractPolicyMetadata(sourceId, markdown, parsed),
  }] })
  db.close()
  const server = fileURLToPath(new URL('../deploy/server.ts', import.meta.url))
  child = spawn(process.execPath, ['--experimental-strip-types', server], {
    env: { ...process.env, POLICY_DB_PATH: path, POLICY_API_TOKEN: token, POLICY_API_HOST: '127.0.0.1', POLICY_API_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  endpoint = await new Promise<string>((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(() => { reject(new Error(`API startup timeout: ${stderr}`)) }, 10000)
    child?.stderr?.on('data', (data) => { stderr += String(data) })
    child?.on('exit', (code) => { clearTimeout(timer); reject(new Error(`API exited ${String(code)}: ${stderr}`)) })
    child?.stdout?.on('data', (data) => {
      const match = /listening on 127\.0\.0\.1:(\d+)/u.exec(String(data))
      if (match !== null) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`) }
    })
  })
})

afterAll(async () => {
  if (child !== undefined && child.exitCode === null) {
    const done = once(child, 'exit')
    child.kill()
    await done
  }
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('remote environment-policy HTTP service', () => {
  it('exposes health and rejects missing credentials', async () => {
    expect((await fetch(`${endpoint}/health`)).status).toBe(200)
    expect((await fetch(`${endpoint}/v1/policy/manifest`)).status).toBe(401)
    expect((await fetch(`${endpoint}/v1/policy/search`, { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it('returns article evidence through the remote provider and policy tool', async () => {
    const ctx = new Context()
    try {
      const configPath = join(root, 'cordis.yml')
      await writeFile(configPath, [
        '- name: cordis:policy-system-prompt', '- name: cordis:policy-tool-runtime', '- name: cordis:policy-remote',
        '  config:', `    endpoint: ${endpoint}`, `    token: ${token}`, '- name: cordis:policy-tools', '',
      ].join('\n'))
      await ctx.plugin(Loader)
      Object.assign(ctx.loader.builtins, {
        include: Include,
        'policy-system-prompt': SystemPrompt,
        'policy-tool-runtime': ToolRuntime,
        'policy-remote': RemoteEnvironmentPolicyKnowledge,
        'policy-tools': PolicyTools,
      })
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      expect(ctx.environmentPolicyKnowledge.getManifest().sourceCount).toBe(1)
      const result = await ctx.tools.execute({ name: 'policy_search', arguments: { question: '中华人民共和国核安全法第一条是什么' }, callId: ToolCallId('remote-test'), signal: new AbortController().signal })
      expect(result.isError).toBe(false)
      const text = result.content.find(block => block.type === 'text')
      if (text?.type !== 'text') throw new Error('missing tool text')
      expect(text.text).toContain('保护生态环境')
      expect(text.text).not.toContain('relativePath')
      await ctx.fiber.dispose()
      expect(ctx.get('environmentPolicyKnowledge')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects invalid JSON options and evidence limits', async () => {
    for (const options of [{ maxResults: 0 }, { maxEvidenceCharacters: 100001 }, { maxResults: '8' }, { filters: {} }]) {
      const response = await fetch(`${endpoint}/v1/policy/search`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ question: '中华人民共和国核安全法', options }) })
      expect(response.status).toBe(400)
    }
  })

  it('honors an already cancelled query without sending it', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(RemoteEnvironmentPolicyKnowledge, { endpoint, token })
      const controller = new AbortController()
      controller.abort()
      await expect(ctx.environmentPolicyKnowledge.search('中华人民共和国核安全法', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'ENVIRONMENT_POLICY_ABORTED' })
    } finally { await ctx.fiber.dispose() }
  })
})
