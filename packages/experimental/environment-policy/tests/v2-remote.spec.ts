import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { PolicyV2Database } from '../src/v2-database.ts'
import PolicyV2Service from '../src/v2-service.ts'
import PolicyV2Http from '../src/v2-http.ts'
import RemotePolicyV2Service from '../src/v2-remote-service.ts'
import * as Tools from '../src/v2-tools.ts'
import { readRequest, readResult, searchRequest, searchResult } from '../src/v2-wire.ts'

it('serves authenticated v2 search and lossless pages through a remote Loader composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'policy-v2-remote-'))
  const server = new Context()
  const client = new Context()
  const original = '# 测试环境法\r\n第一章 总则\r\n第一条' + '不得排放污染物😀。\r\n'.repeat(90)
  const token = 'keyless-policy-v2-fixture-token-123456789'
  const tokenFile = join(root, 'token')
  const path = join(root, 'policy.sqlite')
  try {
    await writeFile(tokenFile, token)
    PolicyV2Database.create(path, [{
      id: 'law', title: '测试环境法', full_text: original, source_hash: createHash('sha256').update(original).digest('hex'),
      description: '污染防治', text_status: 'complete', document_number: null, standard_number: null, document_type: '法律',
      issuing_authority: null, region: '全国', publish_date: null, effective_date: null, legal_status: null,
      pdf_path: null, markdown_path: 'private/source/full.md',
    }, ...['江苏省', '浙江省'].map(region => ({
      id: region, title: region + '污染处理办法', full_text: '第一条 污染物必须处理。\n',
      source_hash: createHash('sha256').update('第一条 污染物必须处理。\n').digest('hex'), description: '污染防治', text_status: 'complete' as const,
      document_number: null, standard_number: null, document_type: '办法', issuing_authority: null, region,
      publish_date: null, effective_date: null, legal_status: null, pdf_path: null, markdown_path: 'private/province/full.md',
    }))])
    const serverConfig = join(root, 'server.yml')
    await writeFile(serverConfig, [
      '- name: cordis:policy', `  config: { path: ${JSON.stringify(path)}, pageCharacters: 201 }`,
      '- name: cordis:http', `  config: { host: 127.0.0.1, port: 0, tokenFile: ${JSON.stringify(tokenFile)}, maxRequestBytes: 1024 }`, '',
    ].join('\n'))
    await server.plugin(Loader)
    Object.assign(server.loader.builtins, { include: Include, policy: PolicyV2Service, http: PolicyV2Http })
    await server.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(serverConfig).href } })
    await server.loader.await()
    const endpoint = server.environmentPolicyV2Http.endpoint
    const post = (route: string, body: unknown, auth = token) => fetch(endpoint + route, {
      method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body),
    })
    expect((await fetch(endpoint + '/v2/policy/status')).status).toBe(401)
    expect((await post('/v2/policy/read', { document_id: 'law' }, 'wrong')).status).toBe(401)
    expect((await post('/v2/policy/search', { question: '' })).status).toBe(400)
    expect((await post('/v2/policy/read', { document_id: 'law', scope: 'article' })).status).toBe(400)
    expect((await post('/v2/policy/read', { document_id: 'law', cursor: 'bad-cursor' })).status).toBe(400)
    expect((await post('/v2/policy/search', { question: '废水'.repeat(1024) })).status).toBe(413)

    const clientConfig = join(root, 'client.yml')
    await writeFile(clientConfig, [
      '- name: cordis:prompt', '- name: cordis:tools', '- name: cordis:remote',
      `  config: { endpoint: ${endpoint}, tokenFile: ${JSON.stringify(tokenFile)} }`, '- name: cordis:policy-tools', '',
    ].join('\n'))
    await client.plugin(Loader)
    Object.assign(client.loader.builtins, { include: Include, prompt: SystemPrompt, tools: ToolRuntime, remote: RemotePolicyV2Service, 'policy-tools': Tools })
    await client.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(clientConfig).href } })
    await client.loader.await()
    expect(client.tools.schemas().map(s => s.name)).toEqual(['policy_search', 'policy_read'])
    const search = await client.environmentPolicyV2.search({ question: '测试环境法讲了什么' })
    expect(search).toMatchObject({ requires_full_read: true, route: 'exact_document', documents: [{ id: 'law' }] })
    const local = await client.environmentPolicyV2.search({ question: '污染防治', target: 'documents', region: '江苏', region_mode: 'only' })
    expect(local.documents.map(doc => doc.region)).toEqual(['江苏省'])
    const combined = await client.environmentPolicyV2.search({ question: '江苏污染防治', target: 'documents' })
    expect(combined.documents.map(doc => doc.region).sort()).toEqual(['全国', '江苏省'])
    const scopedTool = await client.tools.execute({ name: 'policy_search',
      arguments: { question: '污染防治', target: 'documents', region: '江苏省', region_mode: 'only' },
      callId: ToolCallId('remote-province'), signal: new AbortController().signal })
    expect(scopedTool.isError).toBe(false)
    const scopedEvidence = JSON.parse(typeof scopedTool.value === 'string' ? scopedTool.value : '{}') as { documents: Array<{ region: string }> }
    expect(scopedEvidence.documents.map(doc => doc.region)).toEqual(['江苏省'])
    let page = await client.environmentPolicyV2.read({ document_id: 'law' })
    let text = page.text
    let pages = 1
    while (page.has_more) {
      page = await client.environmentPolicyV2.read({ document_id: 'law', cursor: page.next_cursor! })
      text += page.text
      if (++pages > 100) throw new Error('Pagination did not advance')
    }
    expect(pages).toBeGreaterThan(1)
    expect(text).toBe(original)
    const agent = {} as NonNullable<ToolExecutionInput['agent']>
    await client.tools.execute({ name: 'policy_search', arguments: { question: '测试环境法' },
      callId: ToolCallId('remote-read-discovery'), signal: new AbortController().signal, agent })
    const result = await client.tools.execute({ name: 'policy_read', arguments: { document_id: 'law', scope: 'article', selector: '第999条' },
      callId: ToolCallId('remote-v2-missing'), signal: new AbortController().signal, agent })
    expect(result.isError).toBe(false)
    const block = result.content.find(block => block.type === 'text')
    if (block?.type !== 'text') throw new Error('Missing tool evidence')
    const evidence = JSON.parse(block.text) as Record<string, unknown>
    expect({ found: evidence.found, citation_id: evidence.citation_id, text: evidence.text }).toMatchInlineSnapshot(`
      {
        "citation_id": "1",
        "found": false,
        "text": "",
      }
    `)
    expect(block.text).not.toContain('private/source')
    const cancelled = AbortSignal.abort()
    await expect(client.environmentPolicyV2.search({ question: '废水' }, cancelled)).rejects.toThrow()
    const remote = client.environmentPolicyV2
    await client.fiber.dispose()
    expect(client.get('environmentPolicyV2')).toBeUndefined()
    await expect(remote.search({ question: '废水' })).rejects.toThrow()
    await server.fiber.dispose()
    await expect(fetch(endpoint + '/v2/policy/status')).rejects.toThrow()
  } finally {
    await client.fiber.dispose()
    await server.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects incompatible wire payloads before they reach model tools', () => {
  expect(() => searchResult({ documents: [], passages: [] })).toThrow('Invalid remote')
  expect(() => readResult({ text: 'missing source metadata' })).toThrow('Invalid remote')
  expect(() => searchRequest({ question: '废水', target: 'sql' })).toThrow('Invalid search')
  expect(() => readRequest({ document_id: 'law', scope: 'sql' })).toThrow('Invalid read')
  expect(() => readRequest({ document_id: 'law', scope: ['full'] })).toThrow('Invalid read')
  expect(() => searchRequest({ question: '废水', target: ['documents'] })).toThrow('Invalid search')
  expect(() => searchRequest({ question: '废水', region_mode: 'all' })).toThrow('Invalid search')
})


it('preserves model-selected operations and original scope across the HTTP parser', () => {
  expect(searchRequest({ question: '改写后的检索词', scope_question: '只查江苏省', mode: 'facts' }))
    .toEqual({ question: '改写后的检索词', scope_question: '只查江苏省', mode: 'facts' })
  expect(() => searchRequest({ question: '问题', mode: 'invented' })).toThrow('Invalid search request')
})
