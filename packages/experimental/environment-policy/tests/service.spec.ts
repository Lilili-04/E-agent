import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { PolicyDatabase, type PolicyImportDocument } from '../src/database.ts'
import type { DocumentMetadata } from '../src/metadata.ts'
import { parsePolicyMarkdown } from '../src/parse.ts'
import SqliteEnvironmentPolicyKnowledge from '../src/sqlite-service.ts'
import * as PolicyTools from '../src/tools.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function policyDocument(options: {
  title?: string
  publishDate?: string
  relativePath?: string
} = {}): PolicyImportDocument {
  const title = options.title ?? '中华人民共和国水污染防治法'
  const publishDate = options.publishDate ?? '2017-06-27'
  const markdown = `# ${title}\n\n第一条 为了保护和改善环境，防治水污染，保护水生态，保障饮用水安全，维护公众健康。`
  const sourceId = `source-${sha256(markdown).slice(0, 24)}`
  const metadata: DocumentMetadata = {
    sourceId,
    canonicalTitleCandidate: title,
    titleCandidates: [title],
    regulationKeyCandidate: title,
    documentType: 'law',
    jurisdictionCandidate: 'national',
    documentNumberCandidate: '主席令第七十号',
    aliases: [],
    publishDateCandidate: publishDate,
    statusCandidate: '现行有效',
    legalStatus: '现行有效',
    dateCandidates: [],
    officialSourceUrls: [],
    evidence: [],
    issues: [],
    metadataStatus: 'auto-extracted',
  }
  return {
    source: {
      sourceId,
      relativePath: options.relativePath ?? 'laws/water/extracted/full.md',
      byteLength: Buffer.byteLength(markdown),
      sha256: sha256(markdown),
      headingCandidates: [title],
      quality: [],
    },
    markdown,
    metadata,
    parsed: parsePolicyMarkdown(sourceId, markdown),
  }
}

describe('environment-policy service and tool composition', () => {
  it('fails with a stable error and does not create a missing runtime index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'environment-policy-missing-'))
    directories.push(directory)
    const path = join(directory, 'missing.sqlite')
    const ctx = new Context()
    try {
      await expect(ctx.plugin(SqliteEnvironmentPolicyKnowledge, { path })).rejects.toMatchObject({
        code: 'ENVIRONMENT_POLICY_INDEX_UNAVAILABLE',
      })
      expect(existsSync(path)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('mounts the provider and tool, then returns source evidence with index identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'environment-policy-'))
    directories.push(directory)
    const path = join(directory, 'policy.sqlite')
    const database = new PolicyDatabase(path)
    database.rebuild({
      sourceRoot: join(directory, 'corpus'),
      builtAt: '2026-09-26T00:00:00.000Z',
      documents: [policyDocument()],
    })
    database.close()

    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SqliteEnvironmentPolicyKnowledge, { path })
      const toolFiber = await ctx.plugin(PolicyTools, { maxResults: 2, maxEvidenceCharacters: 500 })

      expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['policy_search'])
      const prompt = await ctx.systemPrompt.assemble()
      const policySection = prompt.sections.find(section => section.name === 'tool:environment-policy')
      expect(policySection?.text).toContain('不要把 full.md、relativePath、recordKey、sourceId、sectionPath、officialUrl 等内部字段展示给用户')
      expect(policySection?.text).toContain('不要把回答写成检索报告')
      expect(policySection?.text).toContain('只有用户明确要求比较、判断或分析时')
      expect(policySection?.text).toContain('来源暂时只显示普通文本，不生成任何超链接')
      expect(policySection?.text).toContain('法规清单按不同文档标题去重、归类')

      const result = await ctx.tools.execute({
        name: 'policy_search',
        arguments: { question: '《中华人民共和国水污染防治法》第一条规定了什么？' },
        callId: ToolCallId('policy-call-1'),
        signal: new AbortController().signal,
      })
      if (result.isError) throw new Error(JSON.stringify(result))
      expect(result.isError).toBe(false)
      const output = result.content.find(block => block.type === 'text')
      if (output?.type !== 'text') throw new Error('missing policy tool text output')
      const parsed = JSON.parse(output.text) as { results: Array<Record<string, unknown>> }
      expect(parsed.results).toHaveLength(1)
      expect(parsed.results[0]).toMatchObject({
        citationId: '1',
        label: '第一条',
      })
      expect(parsed.results[0]?.text).toContain('防治水污染')
      expect(parsed.results[0]).not.toHaveProperty('relativePath')
      expect(parsed.results[0]).not.toHaveProperty('recordKey')
      expect(parsed.results[0]).not.toHaveProperty('officialUrl')
      expect(parsed.results[0]).not.toHaveProperty('reviewStatus')
      expect(parsed.results[0]).not.toHaveProperty('temporalAssessment')
      await toolFiber.dispose()
      expect(ctx.tools.schemas()).toEqual([])
      expect((await ctx.systemPrompt.assemble()).sections.some(
        section => section.name === 'tool:environment-policy',
      )).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the latest matching version unless the question requests history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'environment-policy-versions-'))
    directories.push(directory)
    const path = join(directory, 'policy.sqlite')
    const database = new PolicyDatabase(path)
    database.rebuild({
      sourceRoot: join(directory, 'corpus'),
      builtAt: '2026-09-26T00:00:00.000Z',
      documents: [
        policyDocument({ title: '城市绿化条例', publishDate: '2017-03-01', relativePath: '2017/full.md' }),
        policyDocument({ title: '城市绿化条例', publishDate: '2026-01-30', relativePath: '2026/full.md' }),
        policyDocument({ title: '城市绿化条例', publishDate: '1992-06-22', relativePath: '1992/full.md' }),
      ],
    })
    database.close()

    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SqliteEnvironmentPolicyKnowledge, { path })
      await ctx.plugin(PolicyTools, { maxResults: 8, maxEvidenceCharacters: 2_000 })

      const latest = await ctx.tools.execute({
        name: 'policy_search',
        arguments: { question: '《城市绿化条例》第一条规定了什么？' },
        callId: ToolCallId('policy-latest-version'),
        signal: new AbortController().signal,
      })
      if (latest.isError) throw new Error(JSON.stringify(latest))
      const latestOutput = latest.content.find(block => block.type === 'text')
      if (latestOutput?.type !== 'text') throw new Error('missing latest-version output')
      const latestParsed = JSON.parse(latestOutput.text) as { results: Array<Record<string, unknown>> }
      expect(latestParsed.results).toHaveLength(1)
      expect(latestParsed.results[0]).toMatchObject({ citationId: '1', publishDate: '2026-01-30' })

      const history = await ctx.tools.execute({
        name: 'policy_search',
        arguments: { question: '《城市绿化条例》有哪些历史版本？' },
        callId: ToolCallId('policy-history-versions'),
        signal: new AbortController().signal,
      })
      if (history.isError) throw new Error(JSON.stringify(history))
      const historyOutput = history.content.find(block => block.type === 'text')
      if (historyOutput?.type !== 'text') throw new Error('missing history-version output')
      const historyParsed = JSON.parse(historyOutput.text) as { results: Array<Record<string, unknown>> }
      expect(historyParsed.results.map(item => item.citationId)).toEqual(['1', '2', '3'])
      expect(historyParsed.results.map(item => item.publishDate).sort()).toEqual([
        '1992-06-22',
        '2017-03-01',
        '2026-01-30',
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
