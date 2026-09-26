import { describe, expect, it } from 'vitest'
import {
  generatePolicyDescription,
  prepareDescriptionRequest,
  refreshDescriptionStatus,
  reviewPolicyDescription,
  validateDescriptionResponse,
} from '../src/description.ts'

const markdown = '# 环境保护办法\n第一条 为了保护环境，规范污染防治活动，制定本办法。\n第二条 企业应当采取污染防治措施。'
const description = '本办法围绕环境保护和污染防治活动作出规定，说明制定目的，并要求企业采取污染防治措施。文件面向相关环境管理和企业活动，可用于了解污染防治的基本要求，具体义务仍须查阅原文条款。'

describe('policy description framework', () => {
  it('prepares bounded numbered evidence and detects source changes', async () => {
    const request = prepareDescriptionRequest('source-test', markdown, { canonicalTitleCandidate: '环境保护办法', documentType: 'rule' })
    expect(request.chunks[1]).toEqual({ lineStart: 2, lineEnd: 2, text: '第一条 为了保护环境，规范污染防治活动，制定本办法。' })
    const model = {
      modelId: 'test-model',
      generate: () => Promise.resolve({
        description,
        citations: [{ lineStart: 2, lineEnd: 2, quote: '规范污染防治活动' }],
      }),
    }
    const saved = await generatePolicyDescription(model, request, markdown, '2026-09-25T00:00:00.000Z')
    expect(saved.status).toBe('generated')
    expect(reviewPolicyDescription(saved, 'reviewed', markdown).status).toBe('reviewed')
    expect(refreshDescriptionStatus(saved, `${markdown}\n新增条款`).status).toBe('stale')
    expect(() => reviewPolicyDescription(saved, 'reviewed', `${markdown}\n新增条款`)).toThrow('stale source')
  })

  it('rejects invented or unprovided citations and temporal fields', async () => {
    expect(() => validateDescriptionResponse({ description, citations: [{ lineStart: 2, lineEnd: 2, quote: '原文不存在的要求' }] }, markdown)).toThrow('absent')
    expect(() => validateDescriptionResponse({ description, citations: [{ lineStart: 2, lineEnd: 2, quote: '规范污染防治活动' }], legalStatus: '现行有效' }, markdown)).toThrow('unsupported fields')
    const truncatedMarkdown = `${'前言'.repeat(40)}\n${markdown}`
    const request = prepareDescriptionRequest('source-test', truncatedMarkdown, { documentType: 'rule' }, 100)
    const model = {
      modelId: 'test-model',
      generate: () => Promise.resolve({
        description,
        citations: [{ lineStart: 3, lineEnd: 3, quote: '第一条 为了保护环境' }],
      }),
    }
    await expect(generatePolicyDescription(model, request, truncatedMarkdown, '2026-09-25T00:00:00.000Z')).rejects.toThrow('omitted')
  })
})
