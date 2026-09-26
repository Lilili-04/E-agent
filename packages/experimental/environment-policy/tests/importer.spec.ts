import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicyImportDocuments } from '../src/importer.ts'
import type { SourceInventory } from '../src/index.ts'
import { extractPolicyMetadata } from '../src/metadata.ts'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

describe('environment-policy local importer', () => {
  it('reads verified source bytes and joins path-qualified metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'environment-policy-import-'))
    const markdown = '# 环境管理办法\n\n第一条 加强生态环境管理。'
    await writeFile(join(root, 'full.md'), markdown)
    const sourceId = `source-${sha256(markdown).slice(0, 24)}`
    const inventory: SourceInventory = {
      schemaVersion: 1,
      sourceRoot: root,
      sourceCount: 1,
      duplicateGroups: [],
      records: [{ sourceId, relativePath: 'full.md', byteLength: Buffer.byteLength(markdown), sha256: sha256(markdown), headingCandidates: ['环境管理办法'], quality: [] }],
    }
    const metadata = extractPolicyMetadata(sourceId, markdown)
    const documents = await loadPolicyImportDocuments({ inventory, metadata: [{ sourceId, relativePath: 'full.md', metadata }] })
    expect(documents).toHaveLength(1)
    expect(documents[0]?.parsed.units.map(unit => unit.kind)).toEqual(['heading', 'article'])
    expect(documents[0]?.metadata).toBe(metadata)
  })

  it('rejects source bytes changed after inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'environment-policy-import-'))
    const original = '# 原始文件'
    const changed = '# 已修改文件'
    await writeFile(join(root, 'full.md'), changed)
    const sourceId = `source-${sha256(original).slice(0, 24)}`
    const metadata = extractPolicyMetadata(sourceId, original)
    const inventory: SourceInventory = {
      schemaVersion: 1,
      sourceRoot: root,
      sourceCount: 1,
      duplicateGroups: [],
      records: [{ sourceId, relativePath: 'full.md', byteLength: Buffer.byteLength(original), sha256: sha256(original), headingCandidates: ['原始文件'], quality: [] }],
    }
    await expect(loadPolicyImportDocuments({ inventory, metadata: [{ sourceId, relativePath: 'full.md', metadata }] })).rejects.toThrow(/source changed since inventory/)
  })
})
