/**
 * g5.v10 (learner-first), wave W0: the version switch.
 * Plan: `docs/frds/g5-v10-weak-student-fixes-plan-2026-11-15.md`. Owner decisions of
 * 15 Nov 2026: every weak-student fix ships on g5.v10 only (D-9 B), and v10 keeps
 * g5.v8's teacher-parity gates (with v10 variants added by the wave that needs them).
 */
import { describe, expect, it } from 'vitest';

import {
  AVERAGE_CHANGE_STEP,
  BOOK_PART_PLACEMENT_TEACHING_MODEL,
  bookStructureRequirement,
  GUIDE_ANSWER_TEACHING_MODEL,
  isBookPartPlacementModel,
  isGuideAnswerModel,
  isLearnerFirstModel,
  isTeacherParityModel,
  LEARNER_FIRST_TEACHING_MODEL,
  learnerFirstPlannerCatalogue,
  learnerFirstVisualsOf,
  teacherParityBook,
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

/** v10's one-idea sentence: the part of the DEFINITIONS line that g5.v12 replaces. */
const SAME_IDEA =
  ' Never two consecutive slides that teach the same idea: a key-concept box and its own first example share one slide unless the box is long.';

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
    // Follow-up (item 208 slide 28): the planner uses the engine labels, never local ones.
    expect(v10).toContain('EXERCISE LABELS of the block (numbered once across the lesson');
    expect(v10).not.toContain('numbers its items locally');
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

// g5.v11 (teacher-guide answer referee plan §2.8, 16 Nov 2026): v10 plus the guide answers.
describe('g5.v11 registration', () => {
  it('keeps every v10 learner-first behaviour and every v8 gate on g5.v11', () => {
    expect(isLearnerFirstModel({ key: 'g5', version: 'g5.v11' })).toBe(true);
    expect(isTeacherParityModel({ key: 'g5', version: 'g5.v11' })).toBe(true);
    expect(isLearnerFirstModel({ key: 'other', version: 'g5.v11' })).toBe(false);
  });

  it('has its own switch, on for g5.v11 (and g5.v12, built on it) only', () => {
    expect(GUIDE_ANSWER_TEACHING_MODEL).toEqual({ key: 'g5', version: 'g5.v11' });
    expect(isGuideAnswerModel({ key: 'g5', version: 'g5.v11' })).toBe(true);
    for (const version of ['g5.v8', 'g5.v9', 'g5.v10', 'g5.v110', 'g5.v1 1', 'g5.v13']) {
      expect(isGuideAnswerModel({ key: 'g5', version })).toBe(false);
    }
    expect(isGuideAnswerModel({ key: 'other', version: 'g5.v11' })).toBe(false);
    expect(isGuideAnswerModel(null)).toBe(false);
    expect(isGuideAnswerModel(undefined)).toBe(false);
    expect(isLearnerFirstModel({ key: 'g5', version: 'g5.v13' })).toBe(false);
  });

  it('marks a g5.v11 coverage book learner-first and teacher-parity, like g5.v10', () => {
    const v10 = teacherParityBook(BOOK, { key: 'g5', version: 'g5.v10' });
    const v11 = teacherParityBook(BOOK, { key: 'g5', version: 'g5.v11' });
    // Lesson 2-5 (17 Nov 2026): g5.v11 also keeps every book example's own slide.
    expect(v11).toEqual({ ...v10, examplesKept: true });
    expect(v10).not.toHaveProperty('examplesKept');
    expect(v11).toMatchObject({ teacherParity: true, learnerFirst: true });
  });
});

// g5.v12 (book section order plan, owner 25 Nov 2026): v11 plus book-part placement.
describe('g5.v12 registration', () => {
  it('keeps every g5.v11 behaviour: learner first, guide answers, teacher parity', () => {
    const model = { key: 'g5', version: 'g5.v12' };
    expect(isLearnerFirstModel(model)).toBe(true);
    expect(isGuideAnswerModel(model)).toBe(true);
    expect(isTeacherParityModel(model)).toBe(true);
    const v11 = teacherParityBook(BOOK, { key: 'g5', version: 'g5.v11' });
    // Critical items (27 Nov 2026): the book-part rules are marked on the v12 book alone.
    expect(teacherParityBook(BOOK, model)).toEqual({ ...v11, bookPartPlacement: true });
    expect(v11).not.toHaveProperty('bookPartPlacement');
  });

  it('gives the g5.v12 planner one idea per slide and one check per slide, v10 and v11 text unchanged (MG-4, MG-1)', () => {
    const v10 = bookStructureRequirement(BOOK, { teacherParity: true, learnerFirst: true });
    // A MATH lesson: every maths line stays (Wave 2: they go to MATH alone on g5.v12).
    const v12 = bookStructureRequirement(BOOK, {
      teacherParity: true,
      learnerFirst: true,
      bookPartPlacement: true,
      subjectCode: 'MATH',
    });
    // v10's line, gone on v12 only.
    expect(v10).toContain('a key-concept box and its own first example share one slide');
    expect(v12).not.toContain('share one slide');
    expect(v12).toContain('ONE IDEA PER SLIDE: a teaching slide teaches one unit of its part');
    expect(v12).toContain('ONE CHECK PER SLIDE');
    expect(v12).toContain('never checks of two lesson parts');
    expect(v12).toContain('BOOK-STRUCTURED LESSON (g5.v12)');
    expect(v12).not.toContain('BOOK-STRUCTURED LESSON (g5.v10)');
    // Everything else is v10's text.
    const strip = (text: string) =>
      text
        .replace('(g5.v12)', '(g5.v10)')
        .replace('LEARNER-FIRST (g5.v12)', 'LEARNER-FIRST (g5.v10)')
        .replace(/ ONE IDEA PER SLIDE:[^\n]*/, SAME_IDEA)
        .replace(/ONE CHECK PER SLIDE:[^\n]*\n[^\n]*\n/, '');
    expect(strip(v12)).toBe(v10);
  });

  it('Wave 2 (MI-2 / W2.6): on g5.v12 the maths-only lines go to a MATH lesson alone; v10 unchanged', () => {
    const forSubject = (subjectCode: string | null) =>
      bookStructureRequirement(BOOK, {
        teacherParity: true,
        learnerFirst: true,
        bookPartPlacement: true,
        subjectCode,
      });
    const maths = forSubject('MATH');
    const MATHS_LINES = [
      '- CLAIMS:',
      '- DATA:',
      '- CYCLES:',
      'examples do not prove a conjecture',
      'never an average-change calculation the book does not use',
    ];
    for (const line of MATHS_LINES) expect(maths).toContain(line);
    for (const subject of ['CHEM', 'PHYS', 'BIO', null]) {
      const other = forSubject(subject);
      for (const line of MATHS_LINES) expect(other).not.toContain(line);
      expect(other).toContain(
        'VISIBLE WORKING: every solution plans each step of its working as its own key point.',
      );
      expect(other).toContain('ONE CHECK PER SLIDE');
    }
    // g5.v10 (no book-part placement) keeps every line, whatever the subject.
    const v10 = bookStructureRequirement(BOOK, {
      teacherParity: true,
      learnerFirst: true,
      subjectCode: 'CHEM',
    });
    expect(v10).toBe(bookStructureRequirement(BOOK, { teacherParity: true, learnerFirst: true }));
    for (const line of MATHS_LINES) expect(v10).toContain(line);
  });

  it('has its own switch, on for g5.v12 only', () => {
    expect(BOOK_PART_PLACEMENT_TEACHING_MODEL).toEqual({ key: 'g5', version: 'g5.v12' });
    expect(isBookPartPlacementModel({ key: 'g5', version: 'g5.v12' })).toBe(true);
    for (const version of ['g5.v7', 'g5.v8', 'g5.v9', 'g5.v10', 'g5.v11', 'g5.v120', 'g5.v13']) {
      expect(isBookPartPlacementModel({ key: 'g5', version })).toBe(false);
    }
    expect(isBookPartPlacementModel({ key: 'other', version: 'g5.v12' })).toBe(false);
    expect(isBookPartPlacementModel(null)).toBe(false);
    expect(isBookPartPlacementModel(undefined)).toBe(false);
  });
});
