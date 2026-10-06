/**
 * Review guards (upgrade plan P0 item 5). The 30 Sep audit found constructs
 * that are read with a WRONG meaning and no review-severity warning. Until the
 * phase that fixes a construct lands, its guard raises
 * `SATTS_W_UNVERIFIED_READING` so a reviewer keyed on review warnings catches
 * it. A phase that fixes a construct deletes its guard and enforces the
 * construct's target reading in `tests/speech/scientific/golden/audit/`.
 *
 * Pure, linear pattern checks on one expression's source; never changes text.
 */
import type { ScientificSubjectCode } from './context';
import type { ExpressionCandidate } from './detect';

interface Guard {
  id: string;
  subjects: readonly ScientificSubjectCode[];
  /** The upgrade-plan phase that removes this guard. */
  fixedIn: string;
  matches(source: string, candidate: ExpressionCandidate): boolean;
}


/**
 * Every audit construct is now read correctly or flagged by its own review
 * warning (`SATTS_W_AMBIGUOUS_UNIT`, `SATTS_W_AMBIGUOUS_CHARGE`): no guard is
 * left after P7. New guards may be added here for future findings.
 */
const GUARDS: readonly Guard[] = [];

/** Ids of the guards that match this expression (empty when none). */
export function reviewGuards(
  source: string,
  subject: ScientificSubjectCode,
  candidate: ExpressionCandidate,
): string[] {
  const out: string[] = [];
  for (const guard of GUARDS) {
    if (guard.subjects.includes(subject) && guard.matches(source, candidate)) out.push(guard.id);
  }
  return out;
}

/** Every guard id with the phase that removes it (tests and reports). */
export const REVIEW_GUARD_PHASES: Readonly<Record<string, string>> = Object.fromEntries(
  GUARDS.map((guard) => [guard.id, guard.fixedIn]),
);
