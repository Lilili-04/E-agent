/** Stable per-turn citations and conservative checks over tool-returned originals. */
import type { PolicyEvidence } from './v2-evidence.ts'
import { isPolicyValidityQuestion } from './v2-validity.ts'
export type Original = PolicyEvidence['sources'][number] & {
  graph_version_title?: string
  graph_source_id?: string
  line_start?: number
  line_end?: number
}
/** A locator identifies one original selection, not every clause in its document. */
export interface ModelSource extends Original {
  source_id: string
  catalog_region: string | null
  scope_hint: string
  scope_original: string
  source_note: string
}
/** Register an original once, preserving version, selected text and historical text role. */
export function registerOriginal(sources: ModelSource[], source: Original): ModelSource {
  const existing = sources.find(s => s.document.id === source.document.id && s.version_id === source.version_id &&
    s.graph_source_id === source.graph_source_id && s.text_role === source.text_role &&
    s.text === source.text && s.labels.join() === source.labels.join())
  if (existing) return existing
  const scope = source.document.title.match(/太湖|通榆河|长江|淮河|滇池/u)?.[0]
  const scopeOriginal = source.text.split(/\n|(?<=。)/u).filter(line => /适用于|适用本|适用范围|保护区范围/u.test(line)).join('\n')
  const value: ModelSource = { ...source, source_id: `S${sources.length + 1}`, catalog_region: source.document.region,
    scope_hint: scope ? `文件标题涉及${scope}，不得泛化为全省要求；请读取适用范围条款确认。` : '文件归属地区不等于适用范围；涉及地域适用时请核对适用范围原文。',
    scope_original: scopeOriginal,
    source_note: source.text_role === 'history_evidence' ? '后续文本保留的沿革记载；不是当年独立完整正文。'
      : source.text_role === 'attachment' ? '已核实的附件选段；不能声称读取整份历史正文。' : source.text_role === 'event_evidence' ? '沿革事件的原文依据。' : '本轮实际读取的正文选段。' }
  sources.push(value)
  return value
}
/** Validate citation IDs, explicit article locators, unasked validity claims and bounded regional assertions. */
export function sourceAnswerIssue(answer: string, question: string, sources: ModelSource[]): string | undefined {
  if (/\b(?:scope|legal_status|effective_date|source_id|document_id|version_id|catalog_region)\b/u.test(answer)) {
    return '【表达问题】请用自然中文说明结论，不展示内部字段名。保留原文引用编号。'
  }
  const matches = [...answer.matchAll(/\[S(\d+)\]/gu)]
  for (const match of matches) if (!sources.some(s => s.source_id === `S${match[1]}`)) return `【引文错误】[S${match[1]}]不是本轮工具返回的来源编号。请修正编号，不必为名称写法重复检索。`
  if (!matches.length) {
    if (/^(?:你好|您好|谢谢|感谢|再见|你是谁)[！!。？?\s]*$/u.test(question)) return undefined
    if (/无法|未找到|资料不足|请提供|请补充|请明确|未能核实/u.test(answer)) return undefined
    return sources.length ? '【引文错误】已有原文，但答案没有[S编号]引用。请给事实结论标注对应来源，不要只列法规名称。'
      : '【证据缺口】尚未取得本轮原文。请选择工具核实，或明确说明具体缺口。'
  }
  const used = sources.filter(s => matches.some(m => s.source_id === `S${m[1]}`))
  const historicalQuestion = isPolicyValidityQuestion(question) || /废止|沿革|替代/u.test(question)
  if (!historicalQuestion && /现行有效|已(?:经|被|于[^。\n]{0,30})?废止|于[^。\n]{0,30}废止|法典.{0,20}施行/u.test(answer)) {
    return '【效力依据】用户未问法规效力。请删除额外的现行有效、废止日期或法典衔接说明，只回答原问题；不要根据状态标签推断原因。'
  }
  for (const paragraph of answer.split(/\n\s*\n/u)) {
    const cited = used.filter(s => paragraph.includes(`[${s.source_id}]`))
    if (!cited.length) continue
    const articles = [...paragraph.matchAll(/第[零〇一二三四五六七八九十百千万两\d]+条/gu)].map(m => m[0])
    for (const article of articles) if (!cited.some(s => s.labels.includes(article) || s.text.includes(article))) {
      return `【条款缺口】该段引用的原文未出现${article}。请读取对应条款或修正条号。`
    }
    for (const s of cited) {
      const scope = s.document.title.match(/太湖|通榆河|长江|淮河|滇池/u)?.[0]
      const before = answer.slice(0, answer.indexOf(paragraph))
      const heading = before.split('\n').filter(line => /^#{1,6}\s|^\*\*[^*]+\*\*$/u.test(line.trim())).at(-1) ?? ''
      if (scope && !paragraph.includes(scope) && !heading.includes(scope) && !question.includes(scope)) {
        return `【适用范围】[${s.source_id}]涉及${scope}，不能直接写成全省通则。请明确范围或补读适用范围条款。`
      }
    }
    if (/(?:已|同时|予以|自.{0,30})废止|取代|替代/u.test(paragraph) && !cited.some(s => /废止|取代|替代/u.test(s.text))) {
      return '【效力依据】该段引用原文未载明所述废止或替代关系，请补读事件原文，或说明尚未核实。'
    }
  }
  return undefined
}
/** Replace stable IDs with user-facing references derived from actual selections, including text-role caveats. */
export function renderSourceAnswer(answer: string, sources: ModelSource[]): string {
  const used = sources.filter(s => answer.includes(`[${s.source_id}]`))
  if (!used.length) return answer
  const body = answer.replace(/\[S(\d+)\]/gu, '[$1]')
  const references = used.map((s) => {
    const labels = [...new Set(s.labels.filter(Boolean))]
    const location = labels.length > 4 ? `${labels.slice(0, 3).join('、')}等${labels.length}处已读位置` : labels.join('、') || (s.line_start ? `第${s.line_start}–${s.line_end}行` : '已读选段')
    const version = s.graph_version_title ? `（关联版本：${s.graph_version_title}）` : ''
    return `[${s.source_id.slice(1)}] 《${s.document.title}》${location}${version}${s.text_role === 'body' ? '' : `（${s.source_note}）`}`
  })
  return body + '\n\n原文来源：\n' + references.join('\n')
}
/** Preserve only literal originals after repair exhaustion; never relabel a citation failure as an empty database. */
export function sourceFailureAnswer(issue: string, sources: ModelSource[]): string {
  const reason = issue.replace(/【([^】]+)】/gu, '$1：').replace(/\[S\d+\]/gu, '该引用')
  if (!sources.length) return `尚未取得足够原文，无法可靠回答。\n\n待核实事项：${reason}`
  const excerpts = sources.slice(0, 3).map(s => `《${s.document.title}》${s.labels.join('、')}：\n> ${s.text.slice(0, 220).replace(/\n/gu, '\n> ')}${s.text.length > 220 ? '…（节选）' : ''}\n${s.text_role === 'body' ? '' : s.source_note}`)
  return `尚未完成以下核对，不能给出完整结论：${reason}\n\n已取得的原文节选如下，不能据此推断未核实部分：\n\n${excerpts.join('\n\n')}`
}
/** Canonicalize parameter ordering and surrounding whitespace without altering query semantics. */
export function policyRequestKey(value: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, typeof v === 'string' ? v.trim().normalize('NFC') : v])))
}
