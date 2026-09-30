/**
 * Audit regression set (upgrade plan P0 item 2): every P0/P1 case of the
 * 30 Sep audit, with its TARGET reading under the approved decisions
 * (O-1 … O-10). A case is `pending` until its phase flips it to `enforced`;
 * enforced cases can never regress. Pending wrong-meaning cases must raise a
 * review-severity warning until they are fixed (P0 item 5).
 */
import { describe, expect, it } from 'vitest';

import { REVIEW_GUARD_PHASES } from '@/lib/speech/scientific/review-guards';
import { type AuditCase, loadAudit, render } from './helpers';

const CASES = loadAudit();

function run(c: AuditCase) {
  return render(c.original, c.subject, c.mode, { allowProposed: c.policy === 'proposed' });
}

describe('audit regression set (P0)', () => {
  it('has unique ids, known phases and statuses', () => {
    const ids = new Set<string>();
    for (const c of CASES) {
      expect(ids.has(c.id), c.id).toBe(false);
      ids.add(c.id);
      expect(['pending', 'enforced']).toContain(c.status);
      expect(/^P[0-9]$/.test(c.phase), c.id).toBe(true);
      if (c.distinctFrom) expect(CASES.some((other) => other.id === c.distinctFrom), c.id).toBe(true);
    }
  });

  it('reports the enforced / pending counts', () => {
    const enforced = CASES.filter((c) => c.status === 'enforced').length;
    const pending = CASES.length - enforced;
    console.info(`audit-p0: ${enforced} enforced, ${pending} pending of ${CASES.length}`);
    expect(enforced + pending).toBe(CASES.length);
  });

  describe.each(CASES.filter((c) => c.status === 'enforced').map((c) => [c.id, c] as const))(
    'enforced %s',
    (_id, c) => {
      it('reads exactly as the target', () => {
        const result = run(c);
        expect(result.preparedText, `${c.id} (${c.mode})`).toBe(c.expected);
        if (c.expectWarning) expect(result.warnings.map((w) => w.code)).toContain(c.expectWarning);
        // Enforced means read correctly, not rescued by the literal fallback.
        const review = result.warnings.filter((w) => w.severity === 'review' && w.code !== c.expectWarning);
        expect(review.map((w) => `${w.code}(${w.detail ?? ''})`), c.id).toEqual([]);
      });

      if (c.distinctFrom) {
        it('sounds different from its twin', () => {
          const twin = CASES.find((other) => other.id === c.distinctFrom)!;
          expect(run(c).preparedText).not.toBe(run(twin).preparedText);
        });
      }
    },
  );

  it.each(CASES.filter((c) => c.status === 'pending' && c.wrongMeaning).map((c) => [c.id, c] as const))(
    'pending wrong-meaning case %s raises a review-severity warning until fixed',
    (_id, c) => {
      const result = run(c);
      const review = result.warnings.filter((w) => w.severity === 'review');
      expect(review.length, `${c.id}: ${result.preparedText}`).toBeGreaterThan(0);
    },
  );

  it('every review guard names the phase that removes it', () => {
    for (const phase of Object.values(REVIEW_GUARD_PHASES)) expect(phase).toMatch(/^P[0-9]$/);
  });
});
