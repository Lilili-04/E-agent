import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadPolicyRelease } from '../src/release.ts'
import type { PolicyBuildManifest } from '../src/database.ts'

const database: PolicyBuildManifest = { schemaVersion: 1, buildId: 'build-a', corpusHash: 'corpus-a', sourceRoot: 'fixture',
  builtAt: '2026-10-15T00:00:00.000Z', sourceCount: 1, unitCount: 2, descriptionCount: 1 }
const release = { formatVersion: 1, databaseFile: 'policy-build-a.sqlite', buildId: 'build-a', corpusHash: 'corpus-a',
  model: 'qwen3-embedding-4b', modelRevision: 'weights-a', dimension: 2560, chunkVersion: 'chars1200-overlap120-v1',
  queryInstructionVersion: 'environment-policy-query-v1',
  documents: { collection: 'documents-a', count: 1, metric: 'l2', inputVersion: 'title-description-overview-v1' },
  passages: { collection: 'passages-a', count: 2, metric: 'cosine', inputVersion: 'title-section-body-v1' } }

it.each([
  {}, { buildId: 'build-b' }, { corpusHash: 'corpus-b' }, { databaseFile: '../policy-build-a.sqlite' },
  { modelRevision: '' }, { dimension: 128 }, { formatVersion: 2 },
  { queryInstructionVersion: 'different-query-instruction' },
  { passages: { ...release.passages, count: 0 } }, { passages: { ...release.passages, metric: 'l2' } },
])('loads only a complete release matching the opened SQLite snapshot: %j', async (changes) => {
  const root = await mkdtemp(join(tmpdir(), 'policy-release-parser-'))
  try {
    const path = join(root, 'release.json')
    await writeFile(path, JSON.stringify({ ...release, ...changes }))
    if (Object.keys(changes).length === 0) expect(loadPolicyRelease(path, database, 'policy-build-a.sqlite')).toEqual(release)
    else expect(() => loadPolicyRelease(path, database, 'policy-build-a.sqlite')).toThrow('does not match')
  } finally { await rm(root, { recursive: true, force: true }) }
})
