/**
 * g5.v10 (learner-first plan W5, owner D-2.9 and D-5, 15 Nov 2026): a g5.v10 package is
 * reviewed with package-review-v2 — the weak-student checks S6/S7 and an S5 that knows
 * the deliberate omissions. Every other package keeps package-review-v1 byte for byte.
 */
import { describe, expect, it } from 'vitest';

import { teacherOnlyReason } from '@/lib/server/teaching-package/package-review-fix-loop';
import {
  PACKAGE_REVIEW_CHECKS,
  PACKAGE_REVIEW_CHECKS_V2,
  PACKAGE_REVIEW_PROMPT_VERSION,
  PACKAGE_REVIEW_PROMPT_VERSION_V2,
  PACKAGE_REVIEW_SCHEMA,
  PACKAGE_REVIEW_SCHEMA_V2,
  PACKAGE_REVIEW_SYSTEM,
  PACKAGE_REVIEW_SYSTEM_V2,
  parseReviewerAnswer,
} from '@/lib/server/teaching-package/package-review-prompt';

const enumOf = (schema: Record<string, unknown>) =>
  (
    schema.properties as {
      findings: { items: { properties: { check: { enum: string[] } } } };
    }
  ).findings.items.properties.check.enum;

const answer = (check: string) =>
  JSON.stringify({
    summary: 'ملخص',
    findings: [
      {
        target_id: 's10',
        check,
        severity: 'high',
        book_evidence: { quote: 'نص', unit_id: '6236' },
        what_is_wrong: 'الكلام يشرح البند أ فقط.',
        fix_note: 'اشرح البندين ب و ج.',
      },
    ],
  });

describe('package-review-v2 (g5.v10)', () => {
  it('leaves package-review-v1 unchanged: no S6/S7 in its prompt or schema', () => {
    expect(PACKAGE_REVIEW_PROMPT_VERSION).toBe('package-review-v1');
    expect(PACKAGE_REVIEW_PROMPT_VERSION_V2).toBe('package-review-v2');
    expect(PACKAGE_REVIEW_SYSTEM).not.toContain('- S6');
    expect(PACKAGE_REVIEW_SYSTEM).not.toContain('- S7');
    expect(enumOf(PACKAGE_REVIEW_SCHEMA)).toEqual([...PACKAGE_REVIEW_CHECKS]);
    expect(PACKAGE_REVIEW_CHECKS).not.toContain('S6');
  });

  it('adds the weak-student checks and the deliberate omissions to v2', () => {
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain(
      '- S6: The narration agrees with what the slide shows',
    );
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('explains EVERY item');
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('- S7: The slide serves a weak student');
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('never report those as missing');
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain('«فيما سبق», «والآن» and «المفردات»');
    expect(enumOf(PACKAGE_REVIEW_SCHEMA_V2)).toEqual([...PACKAGE_REVIEW_CHECKS_V2]);
    expect(PACKAGE_REVIEW_CHECKS_V2).toEqual([
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
      'S6',
      'S7',
      'Q1',
      'Q2',
      'Q5',
    ]);
  });

  it('accepts an S6 finding only on a v2 review', () => {
    const scope = { slideIds: new Set(['s10']), quizIds: new Set<string>() };
    expect(() => parseReviewerAnswer(answer('S6'), scope)).toThrow('unknown check S6');
    const parsed = parseReviewerAnswer(answer('S6'), { ...scope, learnerFirst: true });
    expect(parsed.findings.map((finding) => finding.check)).toEqual(['S6']);
  });

  it('auto-fixes S6 and leaves S7 to the teacher', () => {
    const slides = [{ id: 's10', sceneType: 'slide' }] as never;
    const finding = (check: string) => ({ targetId: 's10', check }) as never;
    expect(teacherOnlyReason(finding('S6'), slides)).toBeNull();
    expect(teacherOnlyReason(finding('S7'), slides)).toBe('REGENERATION_REFUSED');
    expect(teacherOnlyReason(finding('S1'), slides)).toBeNull();
  });
});
