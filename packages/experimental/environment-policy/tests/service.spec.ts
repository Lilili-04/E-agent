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

function policyDocument(): PolicyImportDocument {
  const markdown = '# 中华人民共和国水污染防治法\n\n第一条 为了保护和改善环境，防治水污染，保护水生态，保障饮用水安全，维护公众健康。'
  const sourceId = `source-${sha256(markdown).slice(0, 24)}`
  const metadata: DocumentMetadata = {
    sourceId,
    canonicalTitleCandidate: '中华人民共和国水污染防治法',
    titleCandidates: ['中华人民共和国水污染防治法'],
    regulationKeyCandidate: '中华人民共和国水污染防治法',
    documentType: 'law',
    jurisdictionCandidate: 'national',
    documentNumberCandidate: '主席令第七十号',
    aliases: [],
    publishDateCandidate: '2017-06-27',
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
      relativePath: 'laws/water/extracted/full.md',
      byteLength: Buffer.byteLength(markdown),
      sha256: sha256(markdown),
      headingCandidates: ['中华人民共和国水污染防治法'],
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
      expect(policySection?.text).toContain('不要把 full.md、relativePath、recordKey、sectionPath 等内部字段展示给用户')
      expect(policySection?.text).toContain('不要把回答写成检索报告')
      expect(policySection?.text).toContain('只有用户明确要求比较、判断或分析时')
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
        relativePath: 'laws/water/extracted/full.md',
        label: '第一条',
      })
      expect(parsed.results[0]?.text).toContain('防治水污染')
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
})
