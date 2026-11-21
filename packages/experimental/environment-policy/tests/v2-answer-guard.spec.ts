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
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type UserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { PolicyV2Database, type PolicyDocument } from '../src/v2-database.ts'
import Service from '../src/v2-service.ts'
import type { PolicyEvidence } from '../src/v2-evidence.ts'
import * as Tools from '../src/v2-tools.ts'
import { assessPolicyValidity } from '../src/v2-validity.ts'
import { registerOriginal, sourceAnswerIssue, renderSourceAnswer, sourceFailureAnswer, type ModelSource } from '../src/v2-model-sources.ts'
import { modelAnswerIssue } from '../src/v2-model-tools.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { planningPrompt, type PlannedEvidence } from '../src/v2-plan.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(planning = false, model = false) {
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
    `  config: ${JSON.stringify({ path, latestManifestPath: latest, pageCharacters: 200 })}`, '- name: cordis:policy-tools', ...planning ? ['  config: { planningProvider: test, planningModel: fixture }'] : model ? ['  config: { retrievalMode: model }'] : [], ''].join('\n'))
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

it('checks an actual model stream after Loader admission and suppresses an unsupported validity claim', async () => {
  const f = await fixture()
  try {
    await f.prepare('《未收录法规》现行有效吗？')
    await f.request()
    const chunks: StreamChunk[] = [ { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '该法现行有效。' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '该法现行有效。' } },
      { type: 'finish', reason: { kind: 'stop' } } ]
    const visible: StreamChunk[] = []
    for await (const chunk of f.stream(chunks)) visible.push(chunk)
    const answer = visible.flatMap(c => c.type === 'text-delta' ? [c.text] : []).join('')
    expect(answer).toContain('尚不能确认')
    expect(answer).toContain('法规名称未唯一匹配')
    expect(answer).not.toContain('该法现行有效。')
  } finally { await f.ctx.fiber.dispose() }
})


it('model mode does not retrieve on admission and permits the first model request without evidence', async () => {
  const f = await fixture(false, true)
  try {
    const search = vi.spyOn(f.ctx.environmentPolicyV2, 'search')
    const read = vi.spyOn(f.ctx.environmentPolicyV2, 'read')
    const decision = await f.prepare('你好')
    if (decision.kind !== 'enter') throw new Error('Expected admitted step')
    expect(decision.messages).toHaveLength(1)
    expect(search).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
    expect(await f.request()).not.toHaveProperty('requiredTool')
    const chunks: StreamChunk[] = [{ type: 'text-delta', index: 0, text: '你好！' }, { type: 'finish', reason: { kind: 'stop' } }]
    const visible: StreamChunk[] = []
    for await (const c of f.stream(chunks)) visible.push(c)
    expect(visible).toEqual(chunks)
  } finally { await f.ctx.fiber.dispose() }
})

it('model tools preserve explicit routing and refuse unread IDs across turns', async () => {
  const f = await fixture(false, true)
  try {
    const search = vi.spyOn(f.ctx.environmentPolicyV2, 'search')
    await f.prepare('水污染防治法是什么')
    expect((await f.execute('policy_read', { document_id: 'short' })).isError).toBe(true)
    expect((await f.execute('policy_search', { question: '水污染防治法', target: 'documents' })).isError).toBe(false)
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ mode: 'documents' }), expect.anything())
    expect((await f.execute('policy_read', { document_id: 'short', scope: 'article', selector: '第一条' })).isError).toBe(false)
    expect((await f.execute('policy_read', { document_id: 'short', version_id: 'u-fake' })).isError).toBe(true)
    await f.execute('policy_graph', { question: '水污染防治法沿革' })
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'history' }), expect.anything())
    await f.prepare('另一个问题', 2)
    expect((await f.execute('policy_read', { document_id: 'short' })).isError).toBe(true)
  } finally { await f.ctx.fiber.dispose() }
})

it('model mode withholds an unsupported answer and queues a logged repair at the stop boundary', async () => {
  const f = await fixture(false, true)
  try {
    const steer = vi.fn<(message: UserMessage) => void>(); f.agent.steer = steer
    await f.prepare('水污染防治法规定什么？'); await f.request()
    const visible: StreamChunk[] = []
    for await (const c of f.stream([{ type: 'text-delta', index: 0, text: '法规规定罚款一万元。' }, { type: 'finish', reason: { kind: 'stop' } }])) visible.push(c)
    expect(visible).toContainEqual({ type: 'text-delta', index: 0, text: '正在核对答案中的引用和适用条件。' })
    await f.ctx.serial('agent/turn-stopping', { agent: f.agent, turn: 1, signal: f.signal })
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'policy-read-check' } }))
  } finally { await f.ctx.fiber.dispose() }
})


it('checks missing originals, citation identity and Chinese output without rejecting a greeting', () => {
  expect(modelAnswerIssue('Hello, I will search the law.', '你好', [])).toContain('中文')
  expect(modelAnswerIssue('你好！', '你好', [])).toBeUndefined()
  expect(modelAnswerIssue('请提供完整法规名称。', '有效吗？', [])).toBeUndefined()
  expect(modelAnswerIssue('这部法规现行有效。', '有效吗？', [])).toContain('原文')
})

it('stops repair after the configured bound instead of looping forever', async () => {
  const f = await fixture(false, true)
  try {
    const steer = vi.fn<(message: UserMessage) => void>(); f.agent.steer = steer
    await f.prepare('水污染防治法规定什么？'); await f.request()
    for (let attempt = 0; attempt < 3; attempt++) {
      const visible: StreamChunk[] = []
      for await (const c of f.stream([{ type: 'text-delta', index: 0, text: '罚款一万元。' }, { type: 'finish', reason: { kind: 'stop' } }])) visible.push(c)
      await f.ctx.serial('agent/turn-stopping', { agent: f.agent, turn: 1, signal: f.signal })
      if (attempt === 2) expect(visible.some(c => c.type === 'text-delta' && c.text.includes('尚未取得足够原文'))).toBe(true)
    }
    expect(steer).toHaveBeenCalledTimes(2)
    const block = steer.mock.calls[0]?.[0].content[0]
    expect(block?.type === 'text' ? block.text : '').toContain('水污染防治法规定什么')
  } finally { await f.ctx.fiber.dispose() }
})


it('allows a repealed law named by an original but does not allow it as a separately read citation', async () => {
  const f = await fixture()
  try {
    const result = await f.ctx.environmentPolicyV2.read({ document_id: 'short', scope: 'article', selector: '第一条' })
    const sources: PolicyEvidence['sources'] = [{ document: result.document, text: '第一条 《旧条例》同时废止。',
      labels: ['第一条'], source_complete: true, selection_complete: true, text_role: 'body' }]
    expect(modelAnswerIssue('《旧条例》同时废止。\n来源：《水污染防治法》第一条', '替代哪部条例？', sources)).toBeUndefined()
    expect(modelAnswerIssue('来源：《旧条例》', '替代哪部条例？', sources)).toContain('尚无本轮原文')
    expect(modelAnswerIssue('《旧条例》第二条规定了条件。', '有什么条件？', sources)).toContain('尚无本轮原文')
  } finally { await f.ctx.fiber.dispose() }
})


it('enforces a shared ten-call budget including failed reads, hides tools and resets next turn', async () => {
  const f = await fixture(false, true)
  try {
    const search = vi.spyOn(f.ctx.environmentPolicyV2, 'search')
    await f.prepare('水污染防治法规定什么？')
    for (let i = 0; i < 10; i++) expect((await f.execute('policy_read', { document_id: 'not-returned' })).isError).toBe(true)
    await f.execute('policy_search', { question: '水污染防治法' })
    await f.execute('policy_graph', { question: '水污染防治法沿革' })
    expect(search).not.toHaveBeenCalled()
    const assembly = await f.ctx.systemPrompt.assemble({ signal: f.signal })
    expect(assembly.tools).toEqual([])
    expect(renderPrompt(assembly)).toContain('不要再调用工具')
    await f.prepare('水污染防治法是什么？', 2)
    await f.execute('policy_search', { question: '水污染防治法' })
    expect(search).toHaveBeenCalledTimes(1)
    expect((await f.ctx.systemPrompt.assemble({ signal: f.signal })).tools?.length).toBeGreaterThan(0)
  } finally { await f.ctx.fiber.dispose() }
})


it('does not confuse licence durations or effective measures with statute validity', () => {
  for (const q of ['许可证有效期多久，延续应提前多久申请？', '许可证是否有效？', '应采取哪些有效措施？', '记录需要保存多久？']) {
    expect(assessPolicyValidity(q, undefined, [])).toBeUndefined()
  }
  expect(assessPolicyValidity('《水污染防治法》现在还有效吗？', undefined, [])?.status).toBe('unknown')
})

it('uses stable selection IDs, rejects unknown IDs, and renders history attribution from the source', async () => {
  const f = await fixture()
  try {
    const result = await f.ctx.environmentPolicyV2.read({ document_id: 'short', scope: 'article', selector: '第一条' })
    const sources: ModelSource[] = []
    const original = { document: result.document, text: '第一条 《旧条例》同时废止。', labels: ['第一条'],
      source_complete: false, selection_complete: true, text_role: 'history_evidence' }
    const first = registerOriginal(sources, original)
    expect(registerOriginal(sources, original).source_id).toBe(first.source_id)
    expect(sources).toHaveLength(1)
    expect(sourceAnswerIssue('《旧条例》同时废止。[S1]', '哪些旧条例同时废止？', sources)).toBeUndefined()
    expect(sourceAnswerIssue('结论。[S99]', '问题', sources)).toContain('引文错误')
    expect(sourceAnswerIssue('第二条规定。[S1]', '问题', sources)).toContain('条款缺口')
    expect(renderSourceAnswer('旧条例同时废止。[S1]', sources)).toContain('不是当年独立完整正文')
    expect(sourceFailureAnswer('【引文错误】文件名称不匹配', sources)).toContain('已取得的原文节选')
    expect(sourceFailureAnswer('【引文错误】文件名称不匹配', sources)).not.toContain('尚未取得足够原文')
  } finally { await f.ctx.fiber.dispose() }
})

it('rejects unasked validity additions and explicit province-wide extrapolation from watershed sources', async () => {
  const f = await fixture()
  try {
    const result = await f.ctx.environmentPolicyV2.read({ document_id: 'short', scope: 'article', selector: '第一条' })
    const sources: ModelSource[] = []
    registerOriginal(sources, { document: { ...result.document, title: '江苏省太湖水污染防治条例' }, text: '第一条 本条例适用于太湖流域。',
      labels: ['第一条'], source_complete: true, selection_complete: true, text_role: 'body' })
    expect(sourceAnswerIssue('该法已废止。[S1]', '有哪些要求？', sources)).toContain('效力依据')
    expect(sourceAnswerIssue('全省所有企业必须设置采样口。[S1]', '有哪些要求？', sources)).toContain('适用范围')
    expect(sourceAnswerIssue('太湖流域适用这些要求。[S1]', '有哪些要求？', sources)).toBeUndefined()
  } finally { await f.ctx.fiber.dispose() }
})

it('reuses successful identical search/read results without charging another backend execution', async () => {
  const f = await fixture(false, true)
  try {
    const search = vi.spyOn(f.ctx.environmentPolicyV2, 'search')
    const read = vi.spyOn(f.ctx.environmentPolicyV2, 'read')
    await f.prepare('水污染防治法第一条')
    await f.execute('policy_search', { question: '水污染防治法第一条' })
    const repeated = await f.execute('policy_search', { question: '水污染防治法第一条' })
    expect(JSON.stringify(repeated)).toContain('cached')
    expect(search).toHaveBeenCalledTimes(1)
    await f.execute('policy_read', { document_id: 'short', scope: 'article', selector: '第一条' })
    await f.execute('policy_read', { document_id: 'short', scope: 'article', selector: '第一条' })
    expect(read).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(repeated)).toContain('remaining_tool_calls')
  } finally { await f.ctx.fiber.dispose() }
})
