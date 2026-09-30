import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildEditorGrantPayload,
  mintEditorHandoffToken,
  readEditorGrants,
} from '@/lib/server/teaching-package/editor-grant';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  intersectWithPolicy,
  mintStudentHandoff,
  redeemStudentHandoff,
  STUDENT_GRANT_PREFIX,
  verifyStudentGrant,
  verifyStudentHandoff,
} from '@/lib/server/tutor/student-grant';
import type { StudentSubject } from '@/lib/server/tutor/student-context';

/**
 * Student handoff + grant (Kafuo R1 contracts §3.1, §5; plan §9.3 P5):
 * mint → redeem → verify, distinct kinds, expiry, the policy intersection
 * and tamper resistance.
 */

const SERVICE_KEY = 'student-grant-test-key';
const STUDENT_REF = 'abcdefghijklmnopqrstuvwx';
const NOW = 1_800_000_000_000;

const SUBJECTS: StudentSubject[] = [
  { code: 'MATH', offeringId: '10', nameAr: 'الرياضيات', nameEn: 'Math', academicLanguage: 'ar' },
  {
    code: 'PHYSICS',
    offeringId: '11',
    nameAr: 'الفيزياء',
    nameEn: 'Physics',
    academicLanguage: 'ar',
  },
  {
    code: 'FRENCH',
    offeringId: '12',
    nameAr: 'الفرنسية',
    nameEn: 'French',
    academicLanguage: 'en',
  },
  { code: 'MATH', offeringId: '13', nameAr: 'رياضيات ٢', nameEn: 'Math 2', academicLanguage: 'ar' },
];

function handoffInput(overrides: Partial<Parameters<typeof mintStudentHandoff>[0]> = {}) {
  return {
    tenantId: '1',
    studentRef: STUDENT_REF,
    academic: {
      curriculumId: '27',
      curriculumName: 'National',
      curriculumVersionLabel: '2026',
      gradeLabel: 'Grade 9',
    },
    allowedSubjects: SUBJECTS,
    localeHint: 'ar',
    entitlements: { freeChat: true, help: true },
    now: NOW,
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof TeachingPackageError) return error.code;
    throw error;
  }
  throw new Error('expected a TeachingPackageError');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
});

describe('student handoff', () => {
  it('mints a 5-minute handoff that verifies as kind student-handoff', () => {
    const { token, expiresAt } = mintStudentHandoff(handoffInput());
    expect(expiresAt - NOW).toBe(5 * 60 * 1000);
    const payload = verifyStudentHandoff(token, NOW);
    expect(payload).toMatchObject({
      v: 1,
      kind: 'student-handoff',
      tenantId: '1',
      studentRef: STUDENT_REF,
      localeHint: 'ar',
      entitlements: { freeChat: true, help: true },
    });
    expect(payload.allowedSubjects).toHaveLength(4);
    expect(payload.nonce).toEqual(expect.any(String));
  });

  it('refuses an expired handoff with GRANT_EXPIRED', () => {
    const { token } = mintStudentHandoff(handoffInput());
    expect(codeOf(() => verifyStudentHandoff(token, NOW + 6 * 60 * 1000))).toBe('GRANT_EXPIRED');
  });

  it('refuses a tampered or mis-signed handoff with GRANT_INVALID', () => {
    const { token } = mintStudentHandoff(handoffInput());
    const last = token.at(-1)!;
    const tampered = `${token.slice(0, -1)}${last === '0' ? '1' : '0'}`;
    expect(codeOf(() => verifyStudentHandoff(tampered, NOW))).toBe('GRANT_INVALID');
    expect(codeOf(() => verifyStudentHandoff('garbage', NOW))).toBe('GRANT_INVALID');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'another-key');
    expect(codeOf(() => verifyStudentHandoff(token, NOW))).toBe('GRANT_INVALID');
  });

  it('refuses an editor handoff presented as a student handoff', () => {
    const { token } = mintEditorHandoffToken({
      tenantId: '1',
      versionId: 'tpv-1',
      stageId: 'stage-1',
      capability: 'read',
      purpose: 'learner',
      now: NOW,
    });
    expect(codeOf(() => verifyStudentHandoff(token, NOW))).toBe('GRANT_INVALID');
  });
});

describe('redeem → student grant', () => {
  it('issues a tsg. bearer with the policy intersection and a 60-minute TTL', () => {
    const { token } = mintStudentHandoff(handoffInput());
    const redeemed = redeemStudentHandoff(token, NOW);
    expect(redeemed.grant.startsWith(STUDENT_GRANT_PREFIX)).toBe(true);
    expect(redeemed.expiresAt - NOW).toBe(3600 * 1000);
    // FRENCH is not routed; the duplicate MATH offering is dropped.
    expect(redeemed.subjects.map((s) => s.code)).toEqual(['MATH', 'PHYSICS']);
    expect(redeemed.subjects[0]!.offeringId).toBe('10');
    expect(redeemed.academic).toEqual(handoffInput().academic);

    const grant = verifyStudentGrant(`Bearer ${redeemed.grant}`, NOW + 1000);
    expect(grant).toMatchObject({
      kind: 'student-grant',
      tenantId: '1',
      studentRef: STUDENT_REF,
      localeHint: 'ar',
      entitlements: { freeChat: true, help: true },
    });
    expect(grant.allowedSubjects.map((s) => s.code)).toEqual(['MATH', 'PHYSICS']);
    expect(grant.exp).toBe(redeemed.expiresAt);
  });

  it('an empty intersection is a valid grant with no subjects', () => {
    const { token } = mintStudentHandoff(handoffInput({ allowedSubjects: [SUBJECTS[2]!] }));
    const redeemed = redeemStudentHandoff(token, NOW);
    expect(redeemed.subjects).toEqual([]);
    expect(verifyStudentGrant(`Bearer ${redeemed.grant}`, NOW).allowedSubjects).toEqual([]);
  });

  it('honours TUTOR_STUDENT_GRANT_TTL_SECONDS', () => {
    vi.stubEnv('TUTOR_STUDENT_GRANT_TTL_SECONDS', '120');
    const { token } = mintStudentHandoff(handoffInput());
    const redeemed = redeemStudentHandoff(token, NOW);
    expect(redeemed.expiresAt - NOW).toBe(120_000);
    expect(codeOf(() => verifyStudentGrant(`Bearer ${redeemed.grant}`, NOW + 121_000))).toBe(
      'GRANT_EXPIRED',
    );
  });

  it('cannot redeem an expired handoff, and a grant is not a handoff', () => {
    const { token } = mintStudentHandoff(handoffInput());
    expect(codeOf(() => redeemStudentHandoff(token, NOW + 10 * 60 * 1000))).toBe('GRANT_EXPIRED');
    const { grant } = redeemStudentHandoff(token, NOW);
    // The bare grant (without the prefix) is a signed payload of the wrong kind.
    expect(codeOf(() => redeemStudentHandoff(grant.slice(STUDENT_GRANT_PREFIX.length), NOW))).toBe(
      'GRANT_INVALID',
    );
  });

  it('intersectWithPolicy keeps order and drops unrouted / duplicate codes', () => {
    expect(intersectWithPolicy(SUBJECTS).map((s) => s.code)).toEqual(['MATH', 'PHYSICS']);
    expect(intersectWithPolicy([])).toEqual([]);
  });
});

describe('student grant verification', () => {
  function freshGrant(): string {
    const { token } = mintStudentHandoff(handoffInput());
    return redeemStudentHandoff(token, NOW).grant;
  }

  it('refuses a missing, non-bearer, or unprefixed header', () => {
    expect(codeOf(() => verifyStudentGrant(null, NOW))).toBe('GRANT_INVALID');
    expect(codeOf(() => verifyStudentGrant('Basic abc', NOW))).toBe('GRANT_INVALID');
    const grant = freshGrant();
    expect(
      codeOf(() => verifyStudentGrant(`Bearer ${grant.slice(STUDENT_GRANT_PREFIX.length)}`, NOW)),
    ).toBe('GRANT_INVALID');
  });

  it('refuses a tampered grant and one signed with another secret', () => {
    const grant = freshGrant();
    const last = grant.at(-1)!;
    const tampered = `${grant.slice(0, -1)}${last === '0' ? '1' : '0'}`;
    expect(codeOf(() => verifyStudentGrant(`Bearer ${tampered}`, NOW))).toBe('GRANT_INVALID');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', 'rotated');
    expect(codeOf(() => verifyStudentGrant(`Bearer ${grant}`, NOW))).toBe('GRANT_INVALID');
  });

  it('a payload whose studentRef was edited fails the signature', () => {
    const grant = freshGrant();
    const [payload, signature] = grant.slice(STUDENT_GRANT_PREFIX.length).split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    decoded.studentRef = 'zzzzzzzzzzzzzzzzzzzzzzzz';
    const forged = `${STUDENT_GRANT_PREFIX}${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;
    expect(codeOf(() => verifyStudentGrant(`Bearer ${forged}`, NOW))).toBe('GRANT_INVALID');
  });

  it('kinds are never interchangeable: learner grant ≠ student grant ≠ editor cookie', () => {
    // A learner (cookie) grant presented as a student bearer.
    const { token: learnerToken } = buildEditorGrantPayload({
      tenantId: '1',
      versionId: 'tpv-1',
      stageId: 'stage-1',
      capability: 'read',
      purpose: 'learner',
      now: NOW,
    });
    expect(
      codeOf(() => verifyStudentGrant(`Bearer ${STUDENT_GRANT_PREFIX}${learnerToken}`, NOW)),
    ).toBe('GRANT_INVALID');
    // A student handoff presented as a student grant.
    const { token: handoff } = mintStudentHandoff(handoffInput());
    expect(codeOf(() => verifyStudentGrant(`Bearer ${STUDENT_GRANT_PREFIX}${handoff}`, NOW))).toBe(
      'GRANT_INVALID',
    );
    // A student grant smuggled into the editor grant cookie array.
    const grant = freshGrant().slice(STUDENT_GRANT_PREFIX.length);
    const headers = new Headers({
      cookie: `teaching_package_grant=${encodeURIComponent(JSON.stringify([grant]))}`,
    });
    expect(readEditorGrants(headers)).toEqual([]);
  });
});

describe('nullable Kafuo labels (cross-repo parity)', () => {
  it('accepts null display labels and a null learner subject code without refusing the handoff', async () => {
    const { parseAcademic, parseStudentSubject, parseLearnerSubject } =
      await import('@/lib/server/tutor/student-context');
    expect(
      parseAcademic(
        {
          curriculumId: '27',
          curriculumName: 'National',
          curriculumVersionLabel: null,
          gradeLabel: null,
        },
        { requireCurriculumId: true },
      ),
    ).toEqual({
      curriculumId: '27',
      curriculumName: 'National',
      curriculumVersionLabel: null,
      gradeLabel: null,
    });
    expect(
      parseStudentSubject({
        code: 'MATH',
        offeringId: '10',
        nameAr: null,
        nameEn: 'Math',
        academicLanguage: 'ar',
      }),
    ).toMatchObject({ code: 'MATH', nameAr: null, nameEn: 'Math' });
    // An unrouted lesson: the Stage must still open; only Help refuses later.
    expect(
      parseLearnerSubject({
        code: null,
        nameAr: 'الفرنسية',
        nameEn: 'French',
        academicLanguage: 'ar',
      }),
    ).toMatchObject({ code: null });
    expect(() =>
      parseLearnerSubject({ code: null, nameAr: null, nameEn: null, academicLanguage: null }),
    ).toThrow(/academicLanguage/);
  });
});
