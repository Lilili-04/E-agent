/** A verified repeal requires the original provision and its effective date. */
import type { GraphContext } from './v2-graph.ts'
import type { PolicyEvidence } from './v2-evidence.ts'

/** Backend conclusion and source titles presented to the answer model. */
export interface PolicyValidity {
  as_of: string
  status: 'repealed' | 'future_repeal' | 'presumed_valid' | 'unknown'
  date?: string
  needs_original?: true
  reason: string
  opening: string
  source_titles: string[]
  source_articles?: string[]
}

/** Detect explicit statute-validity questions, excluding licence validity and duration.
 * @param question - Original user question.
 * @returns Whether the user requested a statute-validity judgment.
 */
export function isPolicyValidityQuestion(question: string): boolean {
  const outside = question.replace(/《[^》]+》/gu, '').replace(/有效期限?/gu, '期限')
  if (/(?:许可证|许可|证书|登记证).{0,16}(?:是否|还|仍).{0,8}有效/u.test(outside) &&
    !/(?:法规|法律|条例|办法).{0,12}(?:现行|效力|废止)/u.test(outside)) return false
  return /现行|效力|(?:是否|是不是|还|仍然?|目前|现在).{0,6}有效|有效[吗么？?]|是不是.*废止|是否.*废止|被废止|废止了|失效了吗|还.*适用|仍.*适用/u.test(outside)
}

/** Assess explicit validity questions. The default applies to undated current-law questions after a complete identity check.
 * @param question - Accepted question, including an optional as-of date.
 * @param graph - Verified identity and bounded event context.
 * @param sources - Actual original text retained for generation.
 * @param today - Optional reference date for deterministic evaluation.
 * @returns An assessment for validity questions, otherwise no assessment.
 */
export function assessPolicyValidity(question: string, graph: GraphContext | undefined,
  sources: PolicyEvidence['sources'], today?: string): PolicyValidity | undefined {
  if (!isPolicyValidityQuestion(question)) return undefined
  const explicit = question.replace(/《[^》]+》/gu, '').match(/((?:19|20)\d{2})[年/-](\d{1,2})[月/-](\d{1,2})(?!\d|日?\s*版)日?/u)
  const [, year, month, day] = explicit ?? []
  const asOf = year && month && day ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    : today ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const unknown = (reason: string): PolicyValidity => ({ as_of: asOf, status: 'unknown', reason,
    opening: `截至${asOf}，尚不能确认该法规是否现行有效。`,
    source_titles: graph?.identity_matched ? [...new Set(sources.map(source => source.document.title))] : [],
    source_articles: [] })
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(asOf) || !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString().slice(0, 10) !== asOf) return unknown('查询日期无效，请确认日期。')
  if (!graph?.identity_matched) return unknown('法规名称未唯一匹配，请提供完整名称或地区。')
  const titleKey = (title: string) => title.normalize('NFKC').replace(/\((?:19|20)\d{2}[^)]*\)$/u, '').replace(/\s/gu, '')
  const selected = graph.versions.filter(v => graph.selected_version_ids.includes(v.id))
  const selectedNames = [...new Set(selected.map(v => titleKey(v.title)))]
  if (selectedNames.length !== 1) return unknown('存在多个法规身份或指定版本未收录，请明确法规名称、地区或版本。')
  const repeals = graph.events.filter(e => e.type === 'REPEALS' && e.scope === 'full')
  // Repeals of older versions do not establish repeal of the named law or a newer body.
  const candidates = repeals.filter(e => !e.target_version_id && titleKey(e.target_title) === selectedNames[0] ||
    !!e.target_version_id && graph.selected_version_ids.length === 1 && graph.selected_version_ids.includes(e.target_version_id))
  const proven = candidates.flatMap((event) => {
    const date = event.date
    if (!date || event.review_status !== 'verified' || !event.evidence.trim()) return []
    const originals = sources.filter(source => event.sources.some(ref => ref.document_id === source.document.id) &&
      source.text.replace(/\s/gu, '').includes(event.evidence.replace(/\s/gu, '')) && source.selection_complete)
    return originals.length ? [{ event, date, originals }] : []
  }).sort((a, b) => a.date.localeCompare(b.date))
  const found = proven[0]
  if (!found) {
    if (candidates.length) return { ...unknown('废止日期或对应原文尚未完整核实，不能作确定判断。'),
      ...(candidates.some(e => e.date && e.review_status === 'verified' && e.sources.length) ? { needs_original: true } : {}) }
    if (explicit || /旧版|旧法|原版|历史版|当时|此前|(?:19|20)\d{2}(?:年|[-/]\d|版|修订|修正|发布|公布)/u.test(question)) {
      return unknown('已收录材料不足以确认指定日期或历史版本的效力。')
    }
    if (graph.truncated) return unknown('法规沿革结果未完整返回，暂无法核实废止情况。')
    if (selected.every(v => v.effective_date && v.effective_date > asOf)) {
      return unknown('已匹配版本的施行日期晚于查询日期。')
    }
    const bodyIds = new Set(selected.flatMap(v => v.body_document_ids))
    return { as_of: asOf, status: 'presumed_valid',
      opening: `截至${asOf}，在已收录资料中未查到《${selectedNames[0]}》明确的整部废止依据，按现行有效处理。`,
      reason: '这是基于本次查询范围的默认效力判断。',
      source_titles: [...new Set(sources.filter(s => s.text_role === 'body' && bodyIds.has(s.document.id)).map(s => s.document.title))] }
  }
  const { event, date, originals } = found
  const title = event.target_title.replace(/（.*版）$/u, '')
  const status = date <= asOf ? 'repealed' : 'future_repeal'
  return { as_of: asOf, status, date, reason: '全文废止事件及其原文已核实。',
    opening: status === 'repealed' ? `截至${asOf}，《${title}》已于${event.date}废止。`
      : `截至${asOf}，《${title}》尚未因该废止条款而废止；该条款定于${event.date}生效。`,
    source_titles: [...new Set(originals.map(s => s.document.title))], source_articles: [...new Set(originals.flatMap(s => s.labels))] }
}

/** Reject generation that omits or contradicts the checked validity conclusion.
 * @param answer - Complete generated answer before publication.
 * @param validity - Date-bound backend decision.
 * @returns Original answer when consistent, otherwise a source-backed correction.
 */
export function checkedPolicyAnswer(answer: string, validity: PolicyValidity): string {
  if (validity.status === 'presumed_valid') {
    return validity.opening + (validity.source_titles.length
      ? '\n\n本次查阅：\n' + validity.source_titles.map(title => `- 《${title}》`).join('\n') : '')
  }
  const citations = validity.source_titles.map(title => `- 《${title}》${validity.source_articles?.join('、') ?? ''}`).join('\n')
  const sourceList = citations ? `\n\n来源：\n${citations}` : ''
  if (validity.status === 'unknown') return `${validity.opening}\n\n${validity.reason}${sourceList}`
  if (validity.status === 'future_repeal') return `${validity.opening}\n\n此处仅核对该废止条款的生效时间。${sourceList}`
  const fallback = `${validity.opening}\n\n该废止规定已于该日生效。${sourceList}`
  const normalized = answer.replace(/((?:19|20)\d{2})年(\d{1,2})月(\d{1,2})日/gu,
    (_match, year: string, month: string, day: string) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`)
    .replace(/\*|[ \t]/gu, '')
  const first = normalized.split(/\n\s*\n/u)[0] ?? ''
  const named = validity.opening.match(/《([^》]+)》/u)?.[1]
  if (!named || !first.includes(named) || !normalized.includes(validity.as_of) ||
    !validity.date || !normalized.includes(validity.date) ||
    !validity.source_titles.some(title => normalized.includes(title))) return fallback
  const assertions = normalized.replace(/(?:不再|并非|不是|不能认定为|不属于)现行有效/gu, '')
  if (!/已(?:经|被|于[^。；\n]*)?废止/u.test(first) || /现行有效|仍然有效|尚未废止|将被废止/u.test(assertions)) return fallback
  return answer
}
