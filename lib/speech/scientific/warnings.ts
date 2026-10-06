/**
 * Renderer warning and blocking-error codes (plan §14.1, §14.2).
 */

export type RenderWarningCode =
  | 'SATTS_W_UNSUPPORTED_NOTATION'
  | 'SATTS_W_MALFORMED_EXPRESSION'
  | 'SATTS_W_UNKNOWN_COMMAND'
  | 'SATTS_W_AMBIGUOUS_SYMBOL'
  | 'SATTS_W_UNKNOWN_ELEMENT'
  | 'SATTS_W_MISSING_DICTIONARY_ENTRY'
  | 'SATTS_W_BOUND_EXCEEDED'
  | 'SATTS_W_RENDERER_FAULT'
  | 'SATTS_W_UNPROMOTED_POLICY_ENTRY'
  /**
   * A construct the 30 Sep audit found read with a wrong meaning and no
   * warning. Raised until the construct's fix lands (upgrade plan P0 item 5),
   * so a reviewer keyed on review-severity warnings can catch it.
   */
  | 'SATTS_W_UNVERIFIED_READING'
  /**
   * O-4: the policy manifest is not approved, so the governed path sent the
   * narration as authored (no SATTS rewriting). Recorded by the synthesis plan.
   */
  | 'SATTS_W_POLICY_NOT_APPROVED'
  /**
   * O-7: a unit-shaped symbol without contextual evidence (`x = 5s`, a bare
   * `m/s`) was read as its letters, never guessed to be a unit.
   */
  | 'SATTS_W_AMBIGUOUS_UNIT'
  /** P7: an ASCII charge (`Fe3+`, `SO42-`) read by the last-digit convention. */
  | 'SATTS_W_AMBIGUOUS_CHARGE';

export type RenderWarningSeverity = 'info' | 'warning' | 'review';

export const WARNING_SEVERITY: Readonly<Record<RenderWarningCode, RenderWarningSeverity>> = {
  SATTS_W_UNSUPPORTED_NOTATION: 'review',
  SATTS_W_MALFORMED_EXPRESSION: 'review',
  SATTS_W_UNKNOWN_COMMAND: 'review',
  SATTS_W_AMBIGUOUS_SYMBOL: 'info',
  SATTS_W_UNKNOWN_ELEMENT: 'review',
  SATTS_W_MISSING_DICTIONARY_ENTRY: 'info',
  SATTS_W_BOUND_EXCEEDED: 'review',
  SATTS_W_RENDERER_FAULT: 'review',
  SATTS_W_UNPROMOTED_POLICY_ENTRY: 'info',
  SATTS_W_UNVERIFIED_READING: 'review',
  SATTS_W_POLICY_NOT_APPROVED: 'warning',
  SATTS_W_AMBIGUOUS_UNIT: 'review',
  SATTS_W_AMBIGUOUS_CHARGE: 'review',
};

export type RenderBlockingCode = 'SATTS_E_EMPTY_RESULT' | 'SATTS_E_SEGMENT_UNSPLITTABLE';

export interface RenderWarning {
  code: RenderWarningCode;
  severity: RenderWarningSeverity;
  /** Offsets into `originalText`. */
  source: { start: number; end: number };
  /** Machine detail; never contains the full narration. */
  detail?: string;
}

export interface RenderBlockingError {
  code: RenderBlockingCode;
  message: string;
}

export function makeWarning(
  code: RenderWarningCode,
  start: number,
  end: number,
  detail?: string,
): RenderWarning {
  return {
    code,
    severity: WARNING_SEVERITY[code],
    source: { start, end },
    ...(detail !== undefined ? { detail } : {}),
  };
}
