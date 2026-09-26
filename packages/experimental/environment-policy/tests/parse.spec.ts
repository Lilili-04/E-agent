import { describe, expect, it } from 'vitest'
import { parsePolicyMarkdown } from '../src/index.ts'

describe('environment-policy Markdown parser', () => {
  it('preserves legal sections, articles, tables, lists, and source spans', () => {
    const markdown = [
      '# 发布令',
      '',
      '## 第一章 总则',
      '',
      '第一条 为了保护环境，制定本法。',
      '',
      '第二条 本法适用于相关活动。',
      '',
      '## 附件',
      '',
      '- 项目清单',
      '',
      '| 项目 | 限值 |',
      '| --- | --- |',
      '| 水 | 50 |',
    ].join('\n')

    const parsed = parsePolicyMarkdown('source-test', markdown)
    expect(parsed.quality).not.toContain('no-article')
    expect(parsed.units.map(unit => unit.kind)).toEqual([
      'heading', 'chapter', 'article', 'article', 'attachment', 'list-item', 'table',
    ])
    expect(parsed.units[2]).toMatchObject({
      kind: 'article',
      label: '第一条',
      lineStart: 5,
      lineEnd: 5,
      sectionPath: ['发布令', '第一章 总则'],
      text: '第一条 为了保护环境，制定本法。',
    })
    expect(parsed.units.at(-1)).toMatchObject({ kind: 'table', lineStart: 13, lineEnd: 15 })
  })

  it('keeps unnumbered plans as structured paragraphs', () => {
    const parsed = parsePolicyMarkdown('source-plan', '# 规划\n\n## 一、总体要求\n\n（一）指导思想\n\n推动绿色发展。')
    expect(parsed.quality).toContain('no-article')
    expect(parsed.quality).not.toContain('unstructured-document')
    expect(parsed.units.map(unit => unit.kind)).toEqual(['heading', 'heading', 'paragraph', 'paragraph'])
    expect(parsed.units.at(-1)?.sectionPath).toEqual(['规划', '一、总体要求'])
  })

  it('produces stable unit ids for identical source text', () => {
    const markdown = '## 第一章\n\n第一条 内容。\n'
    const first = parsePolicyMarkdown('source-stable', markdown)
    const second = parsePolicyMarkdown('source-stable', markdown)
    expect(second).toEqual(first)
    expect(first.units.every(unit => unit.unitId.startsWith('unit-'))).toBe(true)
  })
})
