/** Logged auxiliary LLM dispatch for retrieval planning and semantic coverage review. */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { PolicyModelCall } from './v2-plan.ts'

/** Auxiliary dispatch limits and explicit provider route. */
export interface PlanningModelSettings {
  provider: string
  model: string
  tokens: number
  timeoutMs: number
  inputCharacters: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only exact auxiliary input before dispatch and settled text or failure after dispatch. */
    'policy/retrieval-model': {
      turn: number
      call: number
      stage: 'plan' | 'coverage'
      phase: 'request' | 'response' | 'error'
      provider: string
      model: string
      max_tokens: number
      system?: string
      input?: string
      output?: string
      error?: string
    }
  }
}

/** Bind logged model calls to the owning turn; no auxiliary prompt enters the answer history.
 * @param ctx - Plugin context with an available LLM runtime.
 * @param agent - Owning agent and durable session.
 * @param turn - Accepted turn number.
 * @param settings - Route, full input and request limits.
 * @param signal - Caller cancellation.
 * @returns A text-only model dispatcher for the planning executor.
 */
export function policyModelCall(ctx: Context, agent: NonNullable<ToolExecutionInput['agent']>, turn: number,
  settings: PlanningModelSettings, signal: AbortSignal): PolicyModelCall {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('Policy planning requires the LLM runtime')
  let call = 0
  return async (stage, system, input) => {
    if (system.length + input.length > settings.inputCharacters) throw new Error('Policy planning input exceeds its budget')
    const id = ++call
    const common = { turn, call: id, stage, provider: settings.provider, model: settings.model, max_tokens: settings.tokens }
    agent.session.append('policy/retrieval-model', { ...common, phase: 'request', system, input })
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)])
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of llm.stream({ provider: settings.provider, model: settings.model, system,
        messages: [{ role: 'user', content: [{ type: 'text', text: input }] }], maxTokens: settings.tokens,
        temperature: 0, signal: boundedSignal, sessionId: agent.session.id })) {
        boundedSignal.throwIfAborted()
        assembler.push(chunk)
      }
      boundedSignal.throwIfAborted()
      if (assembler.finish.kind !== 'stop') throw new Error(`Policy ${stage} did not finish: ${assembler.finish.kind}`)
      const output = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      agent.session.append('policy/retrieval-model', { ...common, phase: 'response', output })
      return output
    } catch (error) {
      agent.session.append('policy/retrieval-model', { ...common, phase: 'error', error: String(error) })
      throw error
    }
  }
}
