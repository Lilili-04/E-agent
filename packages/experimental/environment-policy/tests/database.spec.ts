import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PolicyDescription } from '../src/description.ts'
import { ENVIRONMENT_POLICY_SCHEMA_VERSION, PolicyDatabase, policyRecordKey, tokenizePolicyText, type PolicyDatabaseBuild, type PolicyImportDocument } from '../src/database.ts'
import type { DocumentMetadata } from '../src/metadata.ts'
import { parsePolicyMarkdown } from '../src/parse.ts'
import type { SourceRecord } from '../src/index.ts'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function document(relativePath: string, markdown = '# 水污染防治法\n\n第一条 为了保护和改善环境，防治水污染，制定本法。'): PolicyImportDocument {
  const sourceId = `source-${sha256(markdown).slice(0, 24)}`
  const source: SourceRecord = {
    sourceId,
    relativePath,
    byteLength: Buffer.byteLength(markdown),
    sha256: sha256(markdown),
    headingCandidates: ['水污染防治法'],
    quality: [],
  }
  const metadata: DocumentMetadata = {
    sourceId,
    canonicalTitleCandidate: '中华人民共和国水污染防治法',
    titleCandidates: ['中华人民共和国水污染防治法'],
    regulationKeyCandidate: '中华人民共和国水污染防治法',
    documentType: 'law',
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
  const description: PolicyDescription = {
    sourceId,
    sourceHash: source.sha256,
    description: '该法围绕水污染防治建立监督管理和污染控制制度，规定有关主体保护水环境、防治污染的职责，并为执法、治理及责任认定提供法律依据，查询具体义务时应结合对应条款及其适用条件。',
    citations: [{ lineStart: 3, lineEnd: 3, quote: '防治水污染' }],
    promptRevision: 'environment-policy-description-v1',
    modelId: 'test-model',
    generatedAt: '2026-09-26T00:00:00.000Z',
    status: 'generated',
  }
  return { source, markdown, metadata, parsed: parsePolicyMarkdown(sourceId, markdown), description }
}

function build(documents: readonly PolicyImportDocument[], builtAt = '2026-09-26T00:00:00.000Z'): PolicyDatabaseBuild {
  return { sourceRoot: 'D:/corpus', builtAt, documents }
}

describe('environment-policy SQLite database', () => {
  it('rebuilds sources, metadata, units, descriptions, and a manifest', () => {
    const database = new PolicyDatabase(':memory:')
    try {
      const first = document('a/full.md')
      const duplicate = document('duplicate/full.md')
      const manifest = database.rebuild(build([first, duplicate]))
      expect(manifest).toMatchObject({ schemaVersion: ENVIRONMENT_POLICY_SCHEMA_VERSION, sourceCount: 2, descriptionCount: 2 })
      expect(manifest.unitCount).toBe(first.parsed.units.length + duplicate.parsed.units.length)
      expect(database.getManifest()).toEqual(manifest)
      const rows = database.findSourcesByExact({ sourceId: first.source.sourceId })
      expect(rows).toHaveLength(2)
      expect(rows.map(row => row.recordKey)).toEqual([
        policyRecordKey(first.source.sourceId, 'a/full.md'),
        policyRecordKey(first.source.sourceId, 'duplicate/full.md'),
      ])
      expect(database.findSourcesByExact({ documentNumber: '主席令第七十号', legalStatus: '现行有效' })).toHaveLength(2)
      expect(database.searchDescriptions('监督管理')).toHaveLength(2)
      expect(database.readContentUnits({ recordKeys: [rows[0]!.recordKey], label: '第一条' }))
        .toMatchObject([{ relativePath: 'a/full.md', label: '第一条' }])
    } finally {
      database.close()
    }
  })

  it('finds Chinese phrases through portable bigram terms and preserves spans', () => {
    expect(tokenizePolicyText('水污染防治 Water-2026')).toEqual(['水污', '污染', '染防', '防治', 'water', '2026'])
    const database = new PolicyDatabase(':memory:')
    try {
      database.rebuild(build([document('water/full.md')]))
      const hits = database.searchContent('防治水污染')
      expect(hits.length).toBeGreaterThanOrEqual(1)
      expect(hits[0]).toMatchObject({ relativePath: 'water/full.md', kind: 'article', label: '第一条', lineStart: 3, lineEnd: 3, metadataStatus: 'auto-extracted' })
      expect(hits[0]?.sectionPath).toEqual(['水污染防治法'])
      expect(database.searchContent('大气污染').length).toBeGreaterThanOrEqual(1)
    } finally {
      database.close()
    }
  })

  it('rolls a failed rebuild back to the prior committed index', () => {
    const database = new PolicyDatabase(':memory:')
    try {
      const original = database.rebuild(build([document('old/full.md')]))
      const collision = document('same/full.md')
      expect(() => database.rebuild(build([collision, collision], '2026-09-26T01:00:00.000Z'))).toThrow(/UNIQUE constraint failed/)
      expect(database.getManifest()).toEqual(original)
      expect(database.findSourcesByExact({ relativePath: 'old/full.md' })).toHaveLength(1)
      expect(database.findSourcesByExact({ relativePath: 'same/full.md' })).toEqual([])
    } finally {
      database.close()
    }
  })

  it('clears the corpus and can rebuild it again', () => {
    const database = new PolicyDatabase(':memory:')
    try {
      database.rebuild(build([document('first/full.md')]))
      database.clear()
      expect(database.getManifest()).toBeUndefined()
      expect(database.findSourcesByExact({})).toEqual([])
      expect(database.rebuild(build([document('second/full.md')])).sourceCount).toBe(1)
    } finally {
      database.close()
    }
  })

  it('changes the build identity when reviewed metadata changes', () => {
    const database = new PolicyDatabase(':memory:')
    try {
      const original = document('policy/full.md')
      const first = database.rebuild(build([original]))
      const changed = {
        ...original,
        metadata: { ...original.metadata, legalStatus: '废止或失效', statusCandidate: '废止或失效' },
      }
      const second = database.rebuild(build([changed], '2026-09-26T01:00:00.000Z'))
      expect(second.corpusHash).not.toBe(first.corpusHash)
      expect(second.buildId).not.toBe(first.buildId)
    } finally {
      database.close()
    }
  })
})
