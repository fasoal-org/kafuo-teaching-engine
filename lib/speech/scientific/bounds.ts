/**
 * Processing bounds (plan §15, FR-SATTS-033). Exceeding any bound yields a
 * literal reading of that expression plus `SATTS_W_BOUND_EXCEEDED`.
 */

/** An Action longer than this is not parsed at all: prose passthrough + warning. */
export const MAX_ORIGINAL_CHARS = 8_000;
/** Source characters per expression. */
export const MAX_EXPRESSION_SOURCE_CHARS = 512;
/** Tokens per expression. */
export const MAX_EXPRESSION_TOKENS = 400;
/** Combined nesting of groups, fractions, scripts and roots. */
export const MAX_NESTING_DEPTH = 12;
/** Expressions per Action; later runs stay prose. */
export const MAX_EXPRESSIONS_PER_ACTION = 64;
/** Prepared/original ratio per expression (natural mode) … */
export const MAX_EXPANSION_RATIO = 8;
/** … and in accessible mode, whose structural labels are longer by design. */
export const MAX_EXPANSION_RATIO_ACCESSIBLE = 16;
/**
 * … with a floor, so tiny expressions (`a/b` → a spoken fraction) are not
 * flagged: the ratio exists to bound blow-up, not to police short readings.
 */
export const MIN_EXPANSION_ALLOWANCE_CHARS = 160;
export const MIN_EXPANSION_ALLOWANCE_CHARS_ACCESSIBLE = 320;
/**
 * Prepared characters per expression. Kept under the 600-character provider
 * segment budget (Wave 0, plan §13.2) so any in-bound expression fits one
 * segment together with its surrounding pause.
 */
export const MAX_EXPRESSION_PREPARED_CHARS = 560;
/** Prepared characters per Action. */
export const MAX_PREPARED_CHARS = 20_000;

export function expansionAllowance(
  sourceLength: number,
  mode: 'natural' | 'accessible' = 'natural',
): number {
  const accessible = mode === 'accessible';
  return Math.min(
    MAX_EXPRESSION_PREPARED_CHARS,
    Math.max(
      accessible ? MIN_EXPANSION_ALLOWANCE_CHARS_ACCESSIBLE : MIN_EXPANSION_ALLOWANCE_CHARS,
      sourceLength * (accessible ? MAX_EXPANSION_RATIO_ACCESSIBLE : MAX_EXPANSION_RATIO),
    ),
  );
}
