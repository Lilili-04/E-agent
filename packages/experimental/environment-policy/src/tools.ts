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
  'Use policy_search for questions about national environmental laws, regulations, standards, plans, and policy documents.',
  'Base the answer on returned source evidence and cite each claim with the relative path and line range.',
  'Treat publication date, effective date, and reported legal status as different fields.',
  'Do not claim that a document is currently effective when temporalAssessment is unconfirmed.',
  'State when the local corpus has no authoritative evidence or when evidence is truncated.',
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
