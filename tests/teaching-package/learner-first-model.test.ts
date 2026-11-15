/**
 * g5.v10 (learner-first), wave W0: the version switch.
 * Plan: `docs/frds/g5-v10-weak-student-fixes-plan-2026-11-15.md`. Owner decisions of
 * 15 Nov 2026: every weak-student fix ships on g5.v10 only (D-9 B), and v10 keeps
 * g5.v8's teacher-parity gates (with v10 variants added by the wave that needs them).
 */
import { describe, expect, it } from 'vitest';

import {
  isLearnerFirstModel,
  isTeacherParityModel,
  LEARNER_FIRST_TEACHING_MODEL,
} from '@/lib/server/teaching-package/book-coverage';

describe('g5.v10 learner-first switch', () => {
  it('names exactly g5/g5.v10', () => {
    expect(LEARNER_FIRST_TEACHING_MODEL).toEqual({ key: 'g5', version: 'g5.v10' });
    expect(isLearnerFirstModel({ key: 'g5', version: 'g5.v10' })).toBe(true);
  });

  it('is off for every earlier version, another key and a missing model', () => {
    for (const version of ['g5.v1', 'g5.v6', 'g5.v7', 'g5.v8', 'g5.v9', 'g5.v100', 'g5.v1 0']) {
      expect(isLearnerFirstModel({ key: 'g5', version })).toBe(false);
    }
    expect(isLearnerFirstModel({ key: 'other', version: 'g5.v10' })).toBe(false);
    expect(isLearnerFirstModel(null)).toBe(false);
    expect(isLearnerFirstModel(undefined)).toBe(false);
    expect(isLearnerFirstModel({ key: 'g5', version: null })).toBe(false);
  });

  it('keeps the teacher-parity gates on g5.v10, as on g5.v8 and g5.v9', () => {
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v10' })).toBe(true);
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v9' })).toBe(true);
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v8' })).toBe(true);
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v7' })).toBe(false);
  });
});
