import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { PolicyV2Database, type PolicyDocument } from '../src/v2-database.ts'
import Service from '../src/v2-service.ts'
import type { PolicyEvidence } from '../src/v2-evidence.ts'
import * as Tools from '../src/v2-tools.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { planningPrompt, type PlannedEvidence } from '../src/v2-plan.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(planning = false) {
  const root = await mkdtemp(join(tmpdir(), 'policy-answer-guard-')); roots.push(root)
  const path = join(root, 'body.sqlite')
  const docs: PolicyDocument[] = ['short', 'long', 'old'].map((id) => {
    const full_text = `第一条 ${id}原文。\n第二条 ${'治理要求。'.repeat(80)}\n`
    return { id, title: id === 'long' ? '固体废物污染环境防治法' : id === 'old' ? '历史法规' : '水污染防治法', full_text,
      description: '法规摘要', source_hash: createHash('sha256').update(full_text).digest('hex'), document_number: null,
      standard_number: null, document_type: '法律', issuing_authority: null, region: '全国', publish_date: null,
      effective_date: null, legal_status: null, pdf_path: null, markdown_path: 'fixture.md', text_status: 'complete' }
  })
  PolicyV2Database.create(path, docs)
  const latest = join(root, 'latest.json')
  const { readFile } = await import('node:fs/promises')
  await writeFile(latest, JSON.stringify({ format: 1, database_sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    entries: docs.filter(d => d.id !== 'old').map(d => ({ title: d.title, aliases: [], region: d.region,
      document_ids: [d.id], all_document_ids: [d.id], source_text_status: 'complete', status: 'ready' })) }))
  const config = join(root, 'cordis.yml')
  await writeFile(config, [...planning ? ['- name: cordis:llm', '- name: cordis:sessions'] : [], '- name: cordis:prompt', '- name: cordis:tools', '- name: cordis:policy',
    `  config: ${JSON.stringify({ path, latestManifestPath: latest, pageCharacters: 200 })}`, '- name: cordis:policy-tools', ...planning ? ['  config: { planningProvider: test, planningModel: fixture }'] : [], ''].join('\n'))
  const ctx = new Context()
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: ToolRuntime, policy: Service, 'policy-tools': Tools,
    llm: LlmRuntime, sessions: SessionStore })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } }); await ctx.loader.await()
  const agent = (planning ? { session: ctx.sessions.create(SessionId('policy-planning-loader')) } : {}) as NonNullable<ToolExecutionInput['agent']>
  const signal = new AbortController().signal
  const request = (previous?: string) => ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal },
    async () => ({ provider: 'test', model: 'test', ...(previous ? { requiredTool: previous } : {}) }))
  const execute = (name: string, args: Record<string, unknown>) => ctx.tools.execute({ name, arguments: args,
    callId: ToolCallId('guard-call'), signal, agent })
  const stream = (chunks: StreamChunk[], requiredTool?: string) => ctx.waterfall('llm/stream', {
    provider: 'test', model: 'test', messages: [], signal, ...(requiredTool ? { requiredTool } : {}),
  }, () => (async function* () { yield* chunks })())
  const prepare = (question: string, turn = 1) => ctx.waterfall('agent/pre-step', {
    agent, turn, step: 1, signal, messages: [],
  }, async () => ({ kind: 'enter' as const, startsRequestSeries: true,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: question }] })] }))
  return { ctx, agent, signal, request, execute, stream, prepare }
}

it('prepares original evidence before answering without imposing a tool call', async () => {
  const f = await fixture()
  try {
    const prompt = renderPrompt(await f.ctx.systemPrompt.assemble())
    expect(prompt).toContain(Tools.policyV2Prompt)
    expect(prompt.split('\n').filter(line => line.startsWith('你是环境政策法规问答助手。') || line.startsWith('policy-evidence 是')))
      .toMatchInlineSnapshot(`
        [
          "你是环境政策法规问答助手。开头直接给出结论或要点，使用自然中文回答，不描述检索和资料整理过程。",
          "policy-evidence 是供你核对法规的内部资料。不要在回答中说“根据后端提供的证据”“根据提供的证据”“证据显示”或“证据包”。不要展示 legal_status、effective_date、source_complete 等字段名；效力、日期和资料缺口用自然中文说明。可以直接引用“《某条例》第某条规定”。已有原文足够时直接回答，无须先调用工具。",
        ]
      `)
    const decision = await f.prepare('《水污染防治法》第一条')
    if (decision.kind !== 'enter') throw new Error('Expected admitted step')
    expect(decision.startsRequestSeries).toBe(true)
    expect(decision.messages).toHaveLength(2)
    const evidence = decision.messages[1]
    expect(evidence?.source).toEqual({ kind: 'policy-evidence' })
    const block = evidence?.content[0]
    if (block?.type !== 'text') throw new Error('Expected evidence text')
    const packet = JSON.parse(block.text) as PolicyEvidence
    expect(packet.status).toBe('ready')
    expect(packet.route).toBe('exact_article')
    expect(packet.sources.map(source => source.text)).toEqual(['第一条 short原文。\n'])
    expect(await f.request()).not.toHaveProperty('requiredTool')
    expect((await f.execute('policy_read', { document_id: 'short', scope: 'article', selector: '第一条' })).isError).toBe(false)
    expect((await f.execute('policy_read', { document_id: 'old' })).isError).toBe(true)
    expect((await f.prepare('同轮继续')).kind).toBe('enter')
  } finally { await f.ctx.fiber.dispose() }
})

it('returns a source gap for empty retrieval without invoking the model stream', async () => {
  const f = await fixture()
  try {
    await f.prepare('《未收录法规》第一条')
    await f.request()
    const visible: StreamChunk[] = []
    for await (const chunk of f.stream([])) visible.push(chunk)
    expect(visible.filter(c => c.type === 'text-delta')).toMatchInlineSnapshot(`
      [
        {
          "index": 0,
          "text": "本次未获得足够的政策原文，暂时无法可靠回答。请补充法规名称、地区或版本，或稍后重试。",
          "type": "text-delta",
        },
      ]
    `)
  } finally { await f.ctx.fiber.dispose() }
})

it('automatically reads all pages of both named laws and resets permissions next turn', async () => {
  const f = await fixture()
  try {
    const read = vi.spyOn(f.ctx.environmentPolicyV2, 'read')
    const decision = await f.prepare('分别概括《水污染防治法》和《固体废物污染环境防治法》')
    if (decision.kind !== 'enter') throw new Error('Expected admitted step')
    const block = decision.messages.at(-1)?.content[0]
    if (block?.type !== 'text') throw new Error('Expected packet')
    const packet = JSON.parse(block.text) as PolicyEvidence
    expect([...new Set(packet.sources.map(s => s.document.id))].sort()).toEqual(['long', 'short'])
    expect(read.mock.calls.length).toBeGreaterThan(2)
    expect(await f.request()).not.toHaveProperty('requiredTool')
    await f.prepare('《未收录法规》第一条', 2)
    expect((await f.execute('policy_read', { document_id: 'short' })).isError).toBe(true)
  } finally { await f.ctx.fiber.dispose() }
})

it('reuses prepared evidence if admission retries and removes contributions on disposal', async () => {
  const f = await fixture()
  const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '《水污染防治法》第一条' }] })
  const search = vi.spyOn(f.ctx.environmentPolicyV2, 'search')
  const enter = () => f.ctx.waterfall('agent/pre-step', { agent: f.agent, turn: 1, step: 1,
    signal: f.signal, messages: [user] }, async () => ({ kind: 'enter' as const, messages: [user] }))
  const runtime = f.ctx.tools
  try {
    const first = await enter()
    const retry = await enter()
    expect(search).toHaveBeenCalledTimes(1)
    expect(retry).toEqual(first)
    await f.ctx.fiber.dispose()
    expect(await enter()).toEqual({ kind: 'enter', messages: [user] })
    expect(runtime.schemas()).toEqual([])
  } finally { await f.ctx.fiber.dispose() }
})

it('loads the model planner, logs exact auxiliary inputs before dispatch and enters verified evidence', async () => {
  const f = await fixture(true)
  class Adapter extends LlmAdapter {
    override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      await Promise.resolve()
      const events: readonly { type: string; data: unknown }[] = f.agent.session.snapshotEvents()
      const logged = events.findLast(e => e.type === 'policy/retrieval-model')
      expect(logged?.data).toMatchObject({ phase: 'request', system: options.system })
      const text = options.system === planningPrompt ? JSON.stringify({ tasks: [{ id: 'q1', question: '第一条内容',
        query: '第一条', mode: 'facts', document_title: '水污染防治法', article: '第一条' }] })
        : JSON.stringify({ coverage: [{ task_id: 'q1', status: 'covered', source_ids: ['E1'], reason: '原文明确' }] })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  f.ctx.effect(() => f.ctx.llm.registerAdapter(['test'], new Adapter()), 'fixture.planner')
  try {
    const decision = await f.prepare('水污染防治法第一条内容是什么？')
    if (decision.kind !== 'enter') throw new Error('Expected admitted step')
    const block = decision.messages.at(-1)?.content[0]
    if (block?.type !== 'text') throw new Error('Expected evidence packet')
    const packet = JSON.parse(block.text) as PlannedEvidence
    expect({ tasks: packet.plan.tasks.length, source: packet.sources[0]?.text, coverage: packet.coverage })
      .toMatchInlineSnapshot(`
        {
          "coverage": [
            {
              "reason": "原文明确",
              "source_ids": [
                "E1",
              ],
              "status": "covered",
              "task_id": "q1",
            },
          ],
          "source": "第一条 short原文。
        ",
          "tasks": 1,
        }
      `)
    const events: readonly { type: string; data: unknown }[] = f.agent.session.snapshotEvents()
    expect(events.filter(e => e.type === 'policy/retrieval-model').map(e =>
      e.data && typeof e.data === 'object' && 'phase' in e.data ? e.data.phase : undefined))
      .toEqual(['request', 'response', 'request', 'response'])
  } finally { await f.ctx.fiber.dispose() }
})
