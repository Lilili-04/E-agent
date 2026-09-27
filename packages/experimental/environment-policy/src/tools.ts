import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-environment-policy'

/** Services required by the model-facing policy tool. */
export const inject = ['tools', 'systemPrompt', 'environmentPolicyKnowledge']

/** Deployment-owned output bounds. */
export interface Config {
  /** Maximum evidence records returned by a search. Defaults to 8. */
  maxResults?: number
  /** Maximum total source characters returned by a search. Defaults to 12000. */
  maxEvidenceCharacters?: number
}

/** Schemastery configuration for Loader. */
export const Config: z<Config> = z.object({
  maxResults: z.number().step(1).min(1).max(50).default(8),
  maxEvidenceCharacters: z.number().step(1).min(1).max(100_000).default(12_000),
})

const OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const PROMPT_TEXT = [
  '你是环境政策法规助手，服务于环境管理人员、企业人员、研究人员和普通用户。',
  '涉及国家级环境法律、法规、标准、规划、通知或政策文件时，先使用 policy_search，再根据返回的原文证据回答。',
  '先判断问题类型：条款解释、法规清单、主题查找、环境合规咨询、版本比较、时效查询或概念解释，并选择最合适的回答方式。',
  '问题清楚时直接回答；只有缺失信息会明显改变结论时，才追问一个最关键的问题，不要连续提出多个问题。',
  '条款解释先用通俗中文说明，再给出必要的原文依据；法规清单按不同文档标题去重、归类，并说明清单仅限当前本地语料；合规问题按主体、行为、条件和可能后果组织。',
  '回答要像熟悉环境管理的同事解释问题：先说结论，再说依据；简单问题控制在两到五段；不要把回答写成检索报告。',
  '每个重要结论都必须能由返回的原文证据支持。可见引用使用“法规标题＋文号（如有）＋条款或章节”；不要把 full.md、relativePath、recordKey、sectionPath、pending-review 等内部字段展示给用户。',
  '来源路径只用于链接目标或核查定位，不得单独显示为来源名称。description 只能帮助发现文档，不能替代法规原文证据。',
  '区分发布日期、生效日期和报告中的效力状态。只有用户询问当前有效性、适用性、版本或时效会影响结论时，才重点说明时间不确定性。',
  '当 temporalAssessment 未确认时，不得声称文件当前有效；证据不足时明确说当前本地语料无法确认，不要用常识补全文本。',
  '没有结果或证据被截断时，用简短自然语言说明；不要输出检索分数、命中渠道、内部 JSON 或检索诊断信息，除非用户明确要求。',
].join(' ')

/** Register national environment-policy retrieval and its model guidance. */
export function apply(ctx: Context, config: Config = {}): void {
  const maxResults = config.maxResults ?? 8
  const maxEvidenceCharacters = config.maxEvidenceCharacters ?? 12_000
  ctx.systemPrompt.section({
    name: 'tool:environment-policy',
    order: ctx.systemPrompt.getSectionOrder('TOOL_ENVIRONMENT_POLICY'),
    text: PROMPT_TEXT,
  })
  ctx.tools.register(defineTool({
    name: 'policy_search',
    description: 'Search the local national environment-policy index and return bounded source passages with paths, line ranges, metadata, and temporal uncertainty.',
    parameters: {
      question: { type: 'string', required: true, description: 'Natural-language policy or regulation question.' },
      current_date: { type: 'string', description: 'ISO date (YYYY-MM-DD) required when asking what is current or presently effective.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const result = await ctx.environmentPolicyKnowledge.search(args.question, {
        maxResults,
        maxEvidenceCharacters,
        ...(args.current_date === undefined ? {} : { currentDate: args.current_date }),
      }, { signal: exec.signal })
      return JSON.stringify(result)
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Search environment policy',
      kind: 'search',
      rawInput: args.question,
    }),
  }))
}
