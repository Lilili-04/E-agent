import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSourceInventory } from '../src/index.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-environment-policy-'))
  temporaryRoots.push(root)
  return root
}

describe('environment-policy source inventory', () => {
  it('assigns content-based ids and reports duplicate and missing companions', async () => {
    const root = await fixtureRoot()
    const first = join(root, 'first', 'extracted')
    const second = join(root, 'second', 'extracted')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    const content = '# Sample\n\n第一条 内容。\n'
    await writeFile(join(first, 'full.md'), content)
    await writeFile(join(second, 'full.md'), content)
    await writeFile(join(first, 'source.pdf'), 'pdf')

    const inventory = await buildSourceInventory({ sourceRoot: root })

    expect(inventory.sourceCount).toBe(2)
    expect(inventory.duplicateGroups).toHaveLength(1)
    expect(inventory.records[0]?.sourceId).toBe(inventory.records[1]?.sourceId)
    expect(inventory.records[0]?.quality).toContain('duplicate-content')
    expect(inventory.records[1]?.quality).toContain('missing-pdf')
    expect(inventory.records[0]?.headingCandidates).toEqual(['Sample'])
  })

  it('sorts records by normalized relative path and marks short content', async () => {
    const root = await fixtureRoot()
    const extracted = join(root, 'a', 'extracted')
    await mkdir(extracted, { recursive: true })
    await writeFile(join(extracted, 'full.md'), 'short')

    const inventory = await buildSourceInventory({ sourceRoot: root })

    expect(inventory.records.map(record => record.relativePath)).toEqual(['a/extracted/full.md'])
    expect(inventory.records[0]?.quality).toContain('short-content')
  })
})
