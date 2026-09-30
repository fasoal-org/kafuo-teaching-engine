import type { ScientificSubjectCode } from './context';
import type { RenderBlockingError, RenderWarning } from './warnings';

export type { RenderBlockingError, RenderWarning } from './warnings';

export interface RenderedSpan {
  kind: 'prose' | 'expression';
  subject?: ScientificSubjectCode;
  /** Offsets into `originalText`. */
  source: { start: number; end: number };
  /** Offsets into `preparedText`. */
  prepared: { start: number; end: number };
  /** `true` ⇒ the segmenter must not cut inside. */
  atomic: boolean;
  /** `true` ⇒ literal/structural fallback used. */
  fallback: boolean;
  /** Why the expression fell back (only when `fallback`). */
  fallbackReason?: FallbackReason;
}

/**
 * - `notation`: unsupported, malformed or unknown notation (whole expression literal);
 * - `policy`: parsed, but at least one wording was unusable (missing, or
 *   unapproved in production) and was spoken in its literal form;
 * - `bound`: a processing bound was exceeded;
 * - `fault`: a contained renderer fault.
 */
export type FallbackReason = 'notation' | 'policy' | 'bound' | 'fault';

export interface SpeechRenderStats {
  originalChars: number;
  preparedChars: number;
  expressions: number;
  /** Expressions with `fallback: true`, for any reason … */
  expressionsFallback: number;
  /** … and per reason. */
  fallbackReasons: Record<FallbackReason, number>;
  maxDepth: number;
  elapsedTokens: number;
  /** Proposed (unapproved) policy entries consulted; non-zero only when allowed. */
  proposedEntriesUsed: number;
}

export interface SpeechRenderResult {
  /** Provider-bound text (before segmentation). */
  preparedText: string;
  /** Ordered; cover `preparedText` exactly once. */
  spans: RenderedSpan[];
  warnings: RenderWarning[];
  /** Non-null ⇒ the caller must not synthesise this Action. */
  blocking: RenderBlockingError | null;
  stats: SpeechRenderStats;
  /** `null` on the general path. */
  policyVersion: string | null;
  path: 'general' | 'scientific';
}
