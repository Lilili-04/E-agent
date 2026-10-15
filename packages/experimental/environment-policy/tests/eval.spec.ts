import { describe, expect, it } from 'vitest'
import { ENVIRONMENT_POLICY_EVALUATION_CASES } from '../eval/cases.ts'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('environment-policy Step9 evaluation set', () => {
  it('contains the fixed 90-case coverage baseline', () => {
    expect(ENVIRONMENT_POLICY_EVALUATION_CASES).toHaveLength(90)
    expect(new Set(ENVIRONMENT_POLICY_EVALUATION_CASES.map(item => item.id)).size).toBe(90)
    expect(new Set(ENVIRONMENT_POLICY_EVALUATION_CASES.map(item => item.category)).size).toBe(8)
    expect(ENVIRONMENT_POLICY_EVALUATION_CASES.filter(item => !item.expectResults)).toHaveLength(3)
    expect(ENVIRONMENT_POLICY_EVALUATION_CASES.every(item => item.question.length > 8)).toBe(true)
  })

  it('rejects an existing report path before opening or changing the requested database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'policy-evaluation-output-'))
    try {
      const database = join(root, 'existing.sqlite')
      await writeFile(database, 'existing source data')
      const result = spawnSync(process.execPath, ['--experimental-strip-types',
        fileURLToPath(new URL('../eval/run.ts', import.meta.url)), '--database', database, '--output', database,
      ], { encoding: 'utf8', timeout: 10000 })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Report output already exists')
      expect(await readFile(database, 'utf8')).toBe('existing source data')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
