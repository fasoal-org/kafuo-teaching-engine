/**
 * g5.v10 (learner-first), wave W0: the version switch.
 * Plan: `docs/frds/g5-v10-weak-student-fixes-plan-2026-11-15.md`. Owner decisions of
 * 15 Nov 2026: every weak-student fix ships on g5.v10 only (D-9 B), and v10 keeps
 * g5.v8's teacher-parity gates (with v10 variants added by the wave that needs them).
 */
import { describe, expect, it } from 'vitest';

import {
  AVERAGE_CHANGE_STEP,
  bookStructureRequirement,
  isLearnerFirstModel,
  isTeacherParityModel,
  LEARNER_FIRST_TEACHING_MODEL,
  learnerFirstPlannerCatalogue,
  learnerFirstVisualsOf,
} from '@/lib/server/teaching-package/book-coverage';
import type { KafuoBookStructure } from '@/lib/types/teaching-package';

// Item 208's shape (lesson 330, 15 Nov 2026): a check, a «قراءة الرياضيات» box, exercises.
const BOOK: KafuoBookStructure = {
  templateVersionId: '3',
  rules: [
    { kind: 'WORKED_EXAMPLE', element: 'worked_example', required: true },
    { kind: 'UNDERSTANDING_CHECK', element: 'try_it', required: true },
    { kind: 'MATH_READING', element: 'supporting', required: false },
    { kind: 'GUIDED_PRACTICE', element: 'exercise', required: false },
  ],
  units: [
    {
      contentUnitId: '6230',
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 1,
    },
    {
      contentUnitId: '6234',
      kind: 'UNDERSTANDING_CHECK',
      element: 'try_it',
      required: true,
      partIndex: 1,
      pairedExampleUnitId: '6230',
    },
    {
      contentUnitId: '6246',
      kind: 'MATH_READING',
      element: 'supporting',
      required: false,
      partIndex: 2,
    },
    {
      contentUnitId: '6247',
      kind: 'GUIDED_PRACTICE',
      element: 'exercise',
      required: false,
      partIndex: 2,
      pairedExampleUnitId: '6230',
    },
  ],
  exercisePolicy: { maxExercises: 6, maxExerciseSlides: 3, minExercises: 4, minExerciseSlides: 1 },
};

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

  it('gives the g5.v10 planner its own text and leaves g5.v8/v9 text unchanged (W3)', () => {
    const v8 = bookStructureRequirement(BOOK, { teacherParity: true });
    const v10 = bookStructureRequirement(BOOK, { teacherParity: true, learnerFirst: true });
    expect(v8).toContain('(g5.v8)');
    expect(v8).not.toContain('LEARNER-FIRST');
    expect(bookStructureRequirement(BOOK, { teacherParity: true, learnerFirst: false })).toBe(v8);

    expect(v10).toContain('BOOK-STRUCTURED LESSON (g5.v10)');
    expect(v10).not.toContain('RECALL');
    expect(v10).toContain('states\nevery one of the check');
    expect(v10).toContain("The engine adds the learner's attempt right after it.");
    expect(v10).toContain('solves and explains EVERY item');
    expect(v10).toContain('each check has exactly one solution slide');
    expect(v10).toContain('«(س٣٥ في كتابك)»');
    expect(v10).toContain('easiest\nfirst');
    expect(v10).toContain('study tip');
    expect(v10).toContain('DEFINITIONS');
    expect(v10).toContain('kind=MATH_READING («قراءة الرياضيات»)');
    expect(v10).toContain('states the conjecture itself first');
    expect(v10).toContain('never plan a quiz for a check or an exercise');
    expect(v10).not.toContain(AVERAGE_CHANGE_STEP);
    // Quality plan W4 (item 208, 15 Nov 2026).
    expect(v10).toContain('a title only (a study tip is taught where the book prints it');
    expect(v10).toContain('add the last difference again');
    expect(v10).toContain('- CYCLES: an item on a fixed named cycle');
    expect(v10).toContain("- PICTURES: a unit's book picture is shown once");
    expect(v8).not.toContain('- CYCLES');
  });

  it('quality plan W4: the learner-first visual rules carry the exercise units only', () => {
    expect(
      learnerFirstVisualsOf({
        units: [
          { contentUnitId: 6247, element: 'exercise' },
          { contentUnitId: 6234, element: 'try_it' },
          { contentUnitId: 6230, element: 'worked_example' },
        ],
      }),
    ).toEqual({ exerciseUnitIds: ['6247'] });
    expect(learnerFirstVisualsOf(undefined)).toEqual({ exerciseUnitIds: [] });
  });

  it("rewrites the catalogue's average-change row for g5.v10 only (D-2.5)", () => {
    const catalogue = learnerFirstPlannerCatalogue();
    expect(catalogue).not.toContain(AVERAGE_CHANGE_STEP);
    expect(catalogue).toContain('never an average-change calculation the book does not use');
    expect(bookStructureRequirement(BOOK, { teacherParity: true })).toContain(AVERAGE_CHANGE_STEP);
  });

  it('keeps the teacher-parity gates on g5.v10, as on g5.v8 and g5.v9', () => {
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v10' })).toBe(true);
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v9' })).toBe(true);
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v8' })).toBe(true);
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v7' })).toBe(false);
  });
});
