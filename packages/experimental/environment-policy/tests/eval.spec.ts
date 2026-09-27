import { describe, expect, it } from 'vitest'
import { ENVIRONMENT_POLICY_EVALUATION_CASES } from '../eval/cases.ts'

describe('environment-policy Step9 evaluation set', () => {
  it('contains the fixed 90-case coverage baseline', () => {
    expect(ENVIRONMENT_POLICY_EVALUATION_CASES).toHaveLength(90)
    expect(new Set(ENVIRONMENT_POLICY_EVALUATION_CASES.map(item => item.id)).size).toBe(90)
    expect(new Set(ENVIRONMENT_POLICY_EVALUATION_CASES.map(item => item.category)).size).toBe(8)
    expect(ENVIRONMENT_POLICY_EVALUATION_CASES.filter(item => !item.expectResults)).toHaveLength(3)
    expect(ENVIRONMENT_POLICY_EVALUATION_CASES.every(item => item.question.length > 8)).toBe(true)
  })
})
