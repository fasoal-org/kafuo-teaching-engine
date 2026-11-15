/**
 * g5.v10 (learner-first), W6 finding of 15 Nov 2026: item 195's planner put one exercise
 * per slide (five exercise slides for a block the engine split into two), and the run
 * paused on EXERCISE_CAP_EXCEEDED. The exercise slides are now regrouped onto the
 * engine's selection without a model call, on g5.v10 only.
 */
import { describe, expect, it, vi } from 'vitest';

import type { AICallFn } from '@openmaic/generation';

import {
  bookStructureRequirement,
  type CoverageBookStructure,
  EXERCISE_CAP_EXCEEDED,
  findBookCoverageDiagnostics,
} from '@/lib/server/teaching-package/book-coverage';
import {
  mergeExerciseSlides,
  repairBookCoverageGaps,
} from '@/lib/server/teaching-package/book-coverage-repair';
import { selectExercises } from '@/lib/server/teaching-package/exercise-selection';
import type { SceneOutline } from '@/lib/types/generation';
import type { KafuoBookStructureUnit } from '@/lib/types/teaching-package';

const facts = (questionNumbers: number[]) => ({ itemLabels: [], hiddenSteps: [], questionNumbers });

// Item 195's exercises (15 Nov 2026): 5523/5524 are number-only, 5521 holds 31 questions.
const exercise = (id: string, usable = true): KafuoBookStructureUnit => ({
  contentUnitId: id,
  kind: 'PRACTICE',
  element: 'exercise',
  required: false,
  partIndex: 2,
  ...(usable ? {} : { exerciseUsable: false, exerciseUnusableReason: 'number_only' as const }),
});

const V10_BOOK: CoverageBookStructure = {
  templateVersionId: '3',
  teacherParity: true,
  learnerFirst: true,
  rules: [
    { kind: 'WORKED_EXAMPLE', element: 'worked_example', required: true },
    { kind: 'PRACTICE', element: 'exercise', required: false },
  ],
  units: [
    {
      contentUnitId: '5518',
      kind: 'WORKED_EXAMPLE',
      element: 'worked_example',
      required: true,
      partIndex: 2,
    },
    exercise('5521'),
    exercise('5522'),
    exercise('5523', false),
    exercise('5524', false),
    exercise('5525'),
    exercise('5526'),
    exercise('5527'),
  ],
  exercisePolicy: { maxExercises: 6, minExercises: 4, maxExerciseSlides: 3, minExerciseSlides: 2 },
  unitFacts: {
    '5521': facts([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 19, 20]),
    '5522': facts([35]),
    '5523': facts([36]),
    '5524': facts([37]),
    '5525': facts([39]),
    '5526': facts([40, 41, 43, 45, 47]),
    '5527': facts([49, 51, 50]),
  },
};

const slide = (id: string, title: string, units: string[], extra: Partial<SceneOutline> = {}) =>
  ({
    id,
    type: 'slide',
    slideType: 'content',
    contentRole: 'worked_example',
    title,
    description: title,
    keyPoints: [`${title}: الحل`],
    sourceContentUnitIds: units,
    order: 0,
    ...extra,
  }) as unknown as SceneOutline;

// Item 195's plan, scenes 30–39: one slide per «تمرين».
const PLAN: SceneOutline[] = [
  slide('scene_30', 'تطبيق الدالة المتعددة التعريف', ['5518']),
  slide('scene_33', 'تمارين', ['5521', '5522'], {
    slideType: 'transition',
    contentRole: undefined,
  }),
  slide('scene_34', 'تمارين ١–٢', ['5521'], {
    keyPoints: ['تمرين ١ (س١ في كتابك)', 'تمرين ٢ (س٢ في كتابك)'],
  }),
  slide('scene_35', 'تمرين ٣: ربح التوزيع', ['5522']),
  slide('scene_36', 'تمرين ٤: مساحة الدائرة', ['5525']),
  slide('scene_37', 'تمرين ٥: مجال قيمة الحاسوب', ['5526']),
  slide('scene_38', 'تمرين ٦: مساحة الغلاف', ['5527']),
  slide('scene_39', 'خلاصة الدوال', ['5518'], { slideType: 'end', contentRole: 'summary' }),
].map((outline, index) => ({ ...outline, order: index + 1 }));

const exerciseUnits = (outlines: readonly SceneOutline[]) =>
  outlines
    .filter((o) => o.slideType === 'content' && o.contentRole === 'worked_example')
    .slice(1)
    .map((o) => o.sourceContentUnitIds);

describe('g5.v10 exercise slides regrouped onto the engine selection', () => {
  it("pauses item 195's plan today: five exercise slides, three allowed", () => {
    expect(selectExercises(V10_BOOK, V10_BOOK.unitFacts)?.slides).toEqual([
      ['5521', '5522'],
      ['5525', '5526', '5527'],
    ]);
    const codes = findBookCoverageDiagnostics(PLAN, V10_BOOK).map((issue) => issue.code);
    expect(codes).toEqual([EXERCISE_CAP_EXCEEDED]);
  });

  it('merges the five slides into the two the engine chose, in place, keeping every key point', () => {
    const { outlines, merged } = mergeExerciseSlides(PLAN, V10_BOOK);
    expect(merged).toBe(3);
    expect(outlines.map((o) => o.id)).toEqual([
      'scene_30',
      'scene_33',
      'scene_34',
      'scene_36',
      'scene_39',
    ]);
    expect(exerciseUnits(outlines)).toEqual([
      ['5521', '5522'],
      ['5525', '5526', '5527'],
    ]);
    expect(outlines[2]!.title).toBe('تمارين (١)');
    expect(outlines[3]!.title).toBe('تمارين (٢)');
    expect(outlines[2]!.keyPoints).toEqual([
      'تمارين ١–٢',
      'تمرين ١ (س١ في كتابك)',
      'تمرين ٢ (س٢ في كتابك)',
      'تمرين ٣: ربح التوزيع',
      'تمرين ٣: ربح التوزيع: الحل',
    ]);
    expect(findBookCoverageDiagnostics(outlines, V10_BOOK)).toEqual([]);
  });

  it('runs inside the coverage repair without a model call and closes the finding', async () => {
    const aiCall = vi.fn() as unknown as AICallFn;
    const blocking = findBookCoverageDiagnostics(PLAN, V10_BOOK);
    const result = await repairBookCoverageGaps(PLAN, blocking, aiCall, {
      book: V10_BOOK,
      flow: [],
      units: [],
      skillOptions: null,
      language: 'ar',
      languageDirective: '',
      visuals: [],
      diagnose: (outlines) => ({
        outlines,
        blocking: findBookCoverageDiagnostics(outlines, V10_BOOK),
      }),
    });
    expect(aiCall).not.toHaveBeenCalled();
    expect(result.blocking).toEqual([]);
    expect(result.restructured).toBe(3);
    expect(exerciseUnits(result.outlines)).toHaveLength(2);
  });

  it('leaves g5.v8 and g5.v9 plans exactly as planned (D-9 B)', () => {
    const v9: CoverageBookStructure = { ...V10_BOOK, learnerFirst: undefined };
    expect(mergeExerciseSlides(PLAN, v9)).toEqual({ outlines: PLAN, merged: 0 });
  });

  it('leaves a plan within the cap, or one citing a unit outside the selection, unchanged', () => {
    const withinCap = PLAN.filter((o) => o.id !== 'scene_37' && o.id !== 'scene_38');
    expect(mergeExerciseSlides(withinCap, V10_BOOK).merged).toBe(0);
    const outside = PLAN.map((o) =>
      o.id === 'scene_38' ? { ...o, sourceContentUnitIds: ['5523'] } : o,
    );
    expect(mergeExerciseSlides(outside, V10_BOOK)).toEqual({ outlines: outside, merged: 0 });
  });

  it('leaves the plan unchanged when a unit spans two selection slides', () => {
    // 5521 alone, 8+ questions: the engine splits it over two slides.
    const book: CoverageBookStructure = {
      ...V10_BOOK,
      units: V10_BOOK.units.filter((u) => u.contentUnitId === '5518' || u.contentUnitId === '5521'),
    };
    expect(selectExercises(book, book.unitFacts)?.slides).toEqual([['5521'], ['5521']]);
    const plan = [1, 2, 3, 4].map((n) => slide(`ex_${n}`, `تمرين ${n}`, ['5521']));
    expect(mergeExerciseSlides(plan, book)).toEqual({ outlines: plan, merged: 0 });
  });

  it('tells the g5.v10 planner that one exercise slide carries several exercises', () => {
    const v10 = bookStructureRequirement(V10_BOOK, { teacherParity: true, learnerFirst: true });
    expect(v10).toContain('never one slide per exercise');
    expect(v10).toContain('Plan EXACTLY the\nexercise slides the EXERCISES BLOCK lists');
    expect(bookStructureRequirement(V10_BOOK, { teacherParity: true })).not.toContain(
      'never one slide per exercise',
    );
  });
});
