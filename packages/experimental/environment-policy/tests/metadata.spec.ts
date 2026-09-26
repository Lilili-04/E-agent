import { describe, expect, it } from 'vitest'
import { extractPolicyMetadata, mergePolicyCatalogMetadata } from '../src/metadata.ts'

describe('extractPolicyMetadata', () => {
  it('extracts explainable candidates from a national policy document', () => {
    const markdown = [
      '# 中华人民共和国环境保护法',
      '生态环境部 环发〔2021〕12号',
      '本文件于2021年6月1日发布，自2022年1月1日起施行。',
    ].join('\n')
    const metadata = extractPolicyMetadata('source-test', markdown)
    expect(metadata.canonicalTitleCandidate).toBe('中华人民共和国环境保护法')
    expect(metadata.documentType).toBe('law')
    expect(metadata.documentNumberCandidate).toBe('环发〔2021〕12号')
    expect(metadata.issuingAuthorityCandidate).toBe('生态环境部')
    expect(metadata.jurisdictionCandidate).toBe('national')
    expect(metadata.publishDateCandidate).toBe('2021-06-01')
    expect(metadata.effectiveFromCandidate).toBe('2022-01-01')
    expect(metadata.metadataStatus).toBe('auto-extracted')
    expect(metadata.evidence.some(item => item.field === 'canonical-title-candidate' && item.lineStart === 1)).toBe(true)
  })

  it('marks ambiguous or incomplete metadata for review', () => {
    const metadata = extractPolicyMetadata('source-review', '# 环境管理办法\n本办法适用于相关活动。')
    expect(metadata.documentType).toBe('rule')
    expect(metadata.issues).toContain('missing-publish-date')
    expect(metadata.metadataStatus).toBe('pending-review')
  })

  it('uses catalog publication date and legal status as the directory metadata source', () => {
    const metadata = extractPolicyMetadata('source-catalog', '# 环境管理办法\n本办法适用于相关活动。')
    const merged = mergePolicyCatalogMetadata(metadata, {
      title: '环境管理办法',
      publishDate: '2024-03-01',
      legalStatus: '现行有效',
      subjectArea: '综合环境管理',
    })
    expect(merged.publishDateCandidate).toBe('2024-03-01')
    expect(merged.legalStatus).toBe('现行有效')
    expect(merged.subjectArea).toBe('综合环境管理')
    expect(merged.issues).not.toContain('multiple-title-candidates')
  })
})
