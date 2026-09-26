import { Context, Service } from '@deepseek-ai/cordis'
import type { PolicyBuildManifest } from './database.ts'
import type { PolicyEvidenceBundle, PolicyQueryOptions } from './query.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read-only national environment-policy retrieval capability. */
    environmentPolicyKnowledge: EnvironmentPolicyKnowledge
  }
}

/** Closed error vocabulary exposed by the environment-policy service. */
export type EnvironmentPolicyErrorCode =
  | 'ENVIRONMENT_POLICY_ABORTED'
  | 'ENVIRONMENT_POLICY_INDEX_EMPTY'
  | 'ENVIRONMENT_POLICY_INDEX_UNAVAILABLE'
  | 'ENVIRONMENT_POLICY_SERVICE_CLOSED'

/** Expected operational failure from the environment-policy capability. */
export class EnvironmentPolicyError extends Error {
  /** Stable machine-readable operational error code. */
  readonly code: EnvironmentPolicyErrorCode

  constructor(message: string, code: EnvironmentPolicyErrorCode) {
    super(message)
    this.name = 'EnvironmentPolicyError'
    this.code = code
  }
}

/** Indexed corpus identity returned with every search result. */
export interface EnvironmentPolicyIndexIdentity {
  readonly schemaVersion: number
  readonly buildId: string
  readonly corpusHash: string
  readonly builtAt: string
  readonly sourceCount: number
}

/** Search output with the exact index generation used for its evidence. */
export interface EnvironmentPolicySearchResult {
  readonly index: EnvironmentPolicyIndexIdentity
  readonly evidence: PolicyEvidenceBundle
}

/** Execution controls for one service request. */
export interface EnvironmentPolicyExecContext {
  readonly signal?: AbortSignal
}

/** Service Definition for environment-policy evidence retrieval. */
export abstract class EnvironmentPolicyKnowledge extends Service {
  protected constructor(ctx: Context) {
    super(ctx, 'environmentPolicyKnowledge')
  }

  /**
   * Return the currently opened immutable build identity.
   * @returns committed SQLite build manifest.
   */
  abstract getManifest(): PolicyBuildManifest

  /**
   * Retrieve bounded authoritative evidence for one natural-language question.
   * @param question - user policy question.
   * @param options - structured filters and evidence limits.
   * @param exec - optional cooperative cancellation.
   * @returns evidence bundle with the exact index identity used.
   */
  abstract search(
    question: string,
    options?: PolicyQueryOptions,
    exec?: EnvironmentPolicyExecContext,
  ): Promise<EnvironmentPolicySearchResult>
}

export default EnvironmentPolicyKnowledge
