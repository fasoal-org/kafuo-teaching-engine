/**
 * g5.v12 book-part placement (plan `docs/frds/book-section-order-fix-plan-2026-11-25.md`,
 * owner 25 Nov 2026). Shaped after the production lesson «4-1 القوة والحركة»: more book
 * parts than objectives, and a planner that put a later part's slides into an earlier
 * objective's block (Newton's second law taught inside the first-law block).
 */
import { describe, expect, it } from 'vitest';

import {
  bookPartsRequirement,
  buildBookPartMap,
  placeOutlinesByBookPart,
  placeWithGuard,
  type BookPartMap,
} from '@/lib/server/teaching-package/book-part-placement';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  KafuoBookStructure,
  LearningObjectiveRef,
  TeachingFlowEntry,
} from '@/lib/types/teaching-package';

// g5.v11/v12 shape: no learning map; per objective, its slides then its quiz.
const FLOW: TeachingFlowEntry[] = [
  { stage: 'lesson_opener', instructions: 'cover' },
  { stage: 'outcome_visual_explanations', instructions: 'O1' },
  { stage: 'outcome_check_understanding', instructions: 'Q1' },
  { stage: 'outcome_visual_explanations', instructions: 'O2' },
  { stage: 'outcome_check_understanding', instructions: 'Q2' },
  { stage: 'outcome_visual_explanations', instructions: 'O3' },
  { stage: 'outcome_check_understanding', instructions: 'Q3' },
] as TeachingFlowEntry[];

const unit = (
  contentUnitId: string,
  element: string,
  partIndex?: number,
  extra: Partial<KafuoBookStructure['units'][number]> = {},
): KafuoBookStructure['units'][number] => ({
  contentUnitId,
  kind: null,
  element,
  required: element !== 'exercise' && element !== 'objective_source',
  ...(partIndex !== undefined ? { partIndex } : {}),
  ...extra,
});

// Book order: goals box, part 1 (force), part 2 (combining forces), part 3 (second law with
// its example and check), part 4 (first law), part 5 (inertia), then the lesson review.
const BOOK: KafuoBookStructure = {
  templateVersionId: '4',
  rules: [],
  units: [
    unit('goals', 'objective_source'),
    unit('p1-kc', 'key_concept', 1),
    unit('p1-note', 'supporting', 1),
    unit('p2-kc', 'key_concept', 2),
    unit('p3-kc', 'key_concept', 3),
    unit('p3-ex', 'worked_example', 3),
    unit('p3-check', 'try_it', 3, { pairedExampleUnitId: 'p3-ex' }),
    unit('p4-kc', 'key_concept', 4),
    unit('p5-kc', 'key_concept', 5),
    unit('rev-1', 'exercise', 5),
    unit('rev-2', 'exercise', 5),
  ],
};

// Objective 1 owns part 1; objective 2 owns parts 2–3; objective 3 owns parts 4–5 (and,
// as the backend sends it, the exercise units of its last part).
const OBJECTIVES: LearningObjectiveRef[] = [
  {
    objectiveRef: 'o1',
    snapshot: { statement: 'تعريف القوة' },
    contentUnitIds: ['p1-kc', 'p1-note'],
  },
  {
    objectiveRef: 'o2',
    snapshot: { statement: 'قانون نيوتن الثاني' },
    contentUnitIds: ['p2-kc', 'p3-kc', 'p3-ex', 'p3-check'],
  },
  {
    objectiveRef: 'o3',
    snapshot: { statement: 'قانون نيوتن الأول' },
    contentUnitIds: ['p4-kc', 'p5-kc', 'rev-1', 'rev-2'],
  },
];

const stage = (flowIndex: number) => ({ key: FLOW[flowIndex]!.stage, flowIndex });

const slide = (
  id: string,
  flowIndex: number,
  units: string[],
  extra: Partial<SceneOutline> = {},
): SceneOutline => ({
  id,
  type: 'slide',
  title: id,
  description: '',
  keyPoints: [],
  order: 0,
  slideType: 'content' as SceneOutline['slideType'],
  contentRole: 'explanation',
  teachingStage: stage(flowIndex),
  sourceContentUnitIds: units,
  ...extra,
});

const quiz = (id: string, flowIndex: number): SceneOutline => ({
  id,
  type: 'quiz',
  title: id,
  description: '',
  keyPoints: [],
  order: 0,
  teachingStage: stage(flowIndex),
});

const transition = (id: string, flowIndex: number, units: string[] = []) =>
  slide(id, flowIndex, units, { slideType: 'transition' as SceneOutline['slideType'] });

function map(): BookPartMap {
  const built = buildBookPartMap(BOOK, OBJECTIVES, FLOW);
  if (!built) throw new Error('expected a book part map');
  return built;
}

const ids = (outlines: readonly SceneOutline[]) => outlines.map((outline) => outline.id);
const stages = (outlines: readonly SceneOutline[]) =>
  Object.fromEntries(outlines.map((outline) => [outline.id, outline.teachingStage?.flowIndex]));

describe('buildBookPartMap', () => {
  it('maps every part, in book order, to the objective block that owns it', () => {
    const built = map();
    expect(built.blocks).toEqual([1, 3, 5]);
    expect(built.parts.map((part) => [part.partIndex, part.flowIndex, part.objectiveRef])).toEqual([
      [1, 1, 'o1'],
      [2, 3, 'o2'],
      [3, 3, 'o2'],
      [4, 5, 'o3'],
      [5, 5, 'o3'],
    ]);
    // Exercises and the goals box are placed by rule, never listed as a part's units.
    expect(built.parts.flatMap((part) => part.unitIds)).not.toContain('rev-1');
    expect(built.parts.flatMap((part) => part.unitIds)).not.toContain('goals');
    expect([...built.exerciseUnitIds]).toEqual(['rev-1', 'rev-2']);
  });

  it('is null when the request cannot carry the parts', () => {
    expect(buildBookPartMap(undefined, OBJECTIVES, FLOW)).toBeNull();
    // An objective without its unit list (a pre-g5.v7 wire).
    const noUnits = OBJECTIVES.map(({ contentUnitIds: _units, ...rest }) => rest);
    expect(buildBookPartMap(BOOK, noUnits, FLOW)).toBeNull();
    // As many objective blocks as objectives, or nothing.
    expect(buildBookPartMap(BOOK, OBJECTIVES.slice(0, 2), FLOW)).toBeNull();
    // A part split between two objectives.
    const split = [
      { ...OBJECTIVES[0]!, contentUnitIds: ['p1-kc'] },
      { ...OBJECTIVES[1]!, contentUnitIds: ['p1-note', 'p2-kc', 'p3-kc', 'p3-ex', 'p3-check'] },
      OBJECTIVES[2]!,
    ];
    expect(buildBookPartMap(BOOK, split, FLOW)).toBeNull();
  });
});

describe('bookPartsRequirement', () => {
  it('lists the parts in book order with the block each must carry', () => {
    const text = bookPartsRequirement(map(), FLOW);
    expect(text).toContain('LESSON PARTS IN BOOK ORDER');
    const lines = text.split('\n').filter((line) => line.startsWith('- Part '));
    expect(lines).toEqual([
      '- Part 1 → teachingStage { "key": "outcome_visual_explanations", "flowIndex": 1 } (objective [o1]): units p1-kc, p1-note',
      '- Part 2 → teachingStage { "key": "outcome_visual_explanations", "flowIndex": 3 } (objective [o2]): units p2-kc',
      '- Part 3 → teachingStage { "key": "outcome_visual_explanations", "flowIndex": 3 } (objective [o2]): units p3-kc, p3-ex, p3-check',
      '- Part 4 → teachingStage { "key": "outcome_visual_explanations", "flowIndex": 5 } (objective [o3]): units p4-kc',
      '- Part 5 → teachingStage { "key": "outcome_visual_explanations", "flowIndex": 5 } (objective [o3]): units p5-kc',
    ]);
  });
});

describe('placeOutlinesByBookPart', () => {
  it('puts each slide in book order, in the block that owns its part (lesson 4-1 shape)', () => {
    // The planner put the second law (part 3) inside the first-law block and the first
    // law (part 4) before it; the second-law block holds only part 2.
    const planned = [
      slide('cover', 0, [], { slideType: 'cover' as SceneOutline['slideType'] }),
      transition('t1', 1),
      slide('force', 1, ['p1-kc', 'p1-note']),
      quiz('q1', 2),
      slide('combining', 3, ['p2-kc']),
      quiz('q2', 4),
      transition('t4', 5),
      slide('first-law', 5, ['p4-kc']),
      slide('inertia', 5, ['p5-kc']),
      transition('t3', 5),
      slide('second-law', 5, ['p3-kc']),
      slide('example', 5, ['p3-ex'], { contentRole: 'worked_example' }),
      slide('try-it', 5, ['p3-check', 'p3-ex'], { contentRole: 'check_understanding' }),
      slide('solution', 5, ['p3-check'], { contentRole: 'worked_example' }),
      transition('exercises', 5),
      slide('ex-1', 5, ['rev-1', 'rev-2'], { contentRole: 'worked_example' }),
      slide('closing', 5, ['p4-kc', 'p5-kc'], { contentRole: 'summary' }),
      quiz('q3', 6),
    ];
    const result = placeOutlinesByBookPart(planned, map(), FLOW);
    expect(result).not.toBeNull();
    expect(ids(result!.outlines)).toEqual([
      'cover',
      't1',
      'force',
      'q1',
      'combining',
      't3',
      'second-law',
      'example',
      'try-it',
      'solution',
      'q2',
      't4',
      'first-law',
      'inertia',
      'exercises',
      'ex-1',
      'closing',
      'q3',
    ]);
    // The second-law part moved into the block of the objective that owns it.
    expect(stages(result!.outlines)).toMatchObject({
      t3: 3,
      'second-law': 3,
      example: 3,
      'try-it': 3,
      solution: 3,
      'first-law': 5,
      exercises: 5,
      closing: 5,
    });
    expect(result!.restaged).toBe(5);
    expect(result!.outlines.map((outline) => outline.order)).toEqual(
      planned.map((_, index) => index + 1),
    );
    expect(result!.mixedOutlineIds).toEqual([]);
  });

  it('never puts a solution before its try-it slide, even when the try-it cites the example', () => {
    const planned = [
      transition('t1', 1),
      slide('force', 1, ['p1-kc']),
      quiz('q1', 2),
      slide('combining', 3, ['p2-kc']),
      slide('example', 3, ['p3-ex'], { contentRole: 'worked_example' }),
      slide('try-it', 3, ['p3-ex', 'p3-check'], { contentRole: 'check_understanding' }),
      slide('solution', 3, ['p3-check'], { contentRole: 'worked_example' }),
      quiz('q2', 4),
      slide('first-law', 5, ['p4-kc']),
      quiz('q3', 6),
    ];
    // Already in book order and in the right blocks: nothing to change.
    expect(placeOutlinesByBookPart(planned, map(), FLOW)).toBeNull();
  });

  it('keeps an attempt quiz right after the slide it follows', () => {
    const planned = [
      slide('force', 1, ['p1-kc']),
      quiz('q1', 2),
      slide('try-it', 3, ['p3-check'], { contentRole: 'check_understanding' }),
      quiz('attempt', 3),
      slide('combining', 3, ['p2-kc']),
      quiz('q2', 4),
      slide('first-law', 5, ['p4-kc']),
      quiz('q3', 6),
    ];
    const result = placeOutlinesByBookPart(planned, map(), FLOW);
    expect(ids(result!.outlines)).toEqual([
      'force',
      'q1',
      'combining',
      'try-it',
      'attempt',
      'q2',
      'first-law',
      'q3',
    ]);
  });

  it('places a slide teaching parts of two blocks by its first part and reports it', () => {
    const planned = [
      slide('force', 1, ['p1-kc']),
      quiz('q1', 2),
      slide('combining', 3, ['p2-kc']),
      quiz('q2', 4),
      slide('mixed', 5, ['p4-kc', 'p3-kc']),
      slide('inertia', 5, ['p5-kc']),
      quiz('q3', 6),
    ];
    const result = placeOutlinesByBookPart(planned, map(), FLOW);
    expect(stages(result!.outlines).mixed).toBe(3);
    expect(result!.mixedOutlineIds).toEqual(['mixed']);
  });

  it('leaves the plan as it is when a block would be left without any slide', () => {
    // Every slide of the second-law block teaches the first objective's part.
    const planned = [
      slide('force', 1, ['p1-kc']),
      quiz('q1', 2),
      slide('note', 3, ['p1-note']),
      quiz('q2', 4),
      slide('first-law', 5, ['p4-kc']),
      quiz('q3', 6),
    ];
    expect(placeOutlinesByBookPart(planned, map(), FLOW)).toBeNull();
  });

  it('never changes its input', () => {
    const planned = [
      slide('force', 1, ['p1-kc']),
      quiz('q1', 2),
      slide('first-law', 3, ['p4-kc']),
      slide('combining', 3, ['p2-kc']),
      quiz('q2', 4),
      slide('inertia', 5, ['p5-kc']),
      quiz('q3', 6),
    ];
    const copy = structuredClone(planned);
    const result = placeOutlinesByBookPart(planned, map(), FLOW);
    expect(planned).toEqual(copy);
    expect(ids(result!.outlines)).toEqual([
      'force',
      'q1',
      'combining',
      'q2',
      'first-law',
      'inertia',
      'q3',
    ]);
  });
});

// Review 1 (25 Nov 2026) findings, each pinned.
describe('placeOutlinesByBookPart after review 1', () => {
  it('HIGH 1: a check quiz is grounded again on what its block now teaches', () => {
    const planned = [
      slide('force', 1, ['p1-kc'], { keyPoints: ['force'] }),
      slide('second-law', 1, ['p3-kc'], { keyPoints: ['second law'] }),
      {
        ...quiz('q1', 2),
        sourceContentUnitIds: ['p1-kc', 'p3-kc'],
        keyPoints: ['force', 'second law'],
      },
      slide('combining', 3, ['p2-kc'], { keyPoints: ['combining'] }),
      { ...quiz('q2', 4), sourceContentUnitIds: ['p2-kc'], keyPoints: ['combining'] },
      slide('first-law', 5, ['p4-kc'], { keyPoints: ['first law'] }),
      { ...quiz('q3', 6), sourceContentUnitIds: ['p4-kc'], keyPoints: ['first law'] },
    ];
    const result = placeOutlinesByBookPart(planned, map(), FLOW)!;
    const byId = Object.fromEntries(result.outlines.map((outline) => [outline.id, outline]));
    expect(byId['q1']!.sourceContentUnitIds).toEqual(['p1-kc']);
    expect(byId['q1']!.keyPoints).toEqual(['force']);
    expect(byId['q2']!.sourceContentUnitIds).toEqual(['p2-kc', 'p3-kc']);
    expect(byId['q2']!.keyPoints).toEqual(['combining', 'second law']);
    // A block whose taught parts did not change keeps its quiz as planned.
    expect(byId['q3']!.sourceContentUnitIds).toEqual(['p4-kc']);
    expect(result.regroundedQuizIds.sort()).toEqual(['q1', 'q2']);
  });

  it('MEDIUM 2: the transition before the closing slide stays with it', () => {
    const planned = [
      slide('force', 1, ['p1-kc']),
      quiz('q1', 2),
      slide('combining', 3, ['p2-kc']),
      quiz('q2', 4),
      slide('inertia', 5, ['p5-kc']),
      slide('first-law', 5, ['p4-kc']),
      transition('to-summary', 5),
      slide('closing', 5, ['p1-kc', 'p4-kc'], { contentRole: 'summary' }),
      quiz('q3', 6),
    ];
    const result = placeOutlinesByBookPart(planned, map(), FLOW)!;
    expect(ids(result.outlines)).toEqual([
      'force',
      'q1',
      'combining',
      'q2',
      'first-law',
      'inertia',
      'to-summary',
      'closing',
      'q3',
    ]);
    expect(stages(result.outlines)['to-summary']).toBe(5);
  });

  it('MEDIUM 4: a solution of two checks comes after the try-it of its last check', () => {
    const book: KafuoBookStructure = {
      ...BOOK,
      units: [
        ...BOOK.units.slice(0, 7),
        unit('p3-check2', 'try_it', 3, { pairedExampleUnitId: 'p3-ex' }),
        ...BOOK.units.slice(7),
      ],
    };
    const objectives = OBJECTIVES.map((objective) =>
      objective.objectiveRef === 'o2'
        ? { ...objective, contentUnitIds: [...objective.contentUnitIds!, 'p3-check2'] }
        : objective,
    );
    const twoChecks = buildBookPartMap(book, objectives, FLOW)!;
    const planned = [
      slide('force', 1, ['p1-kc']),
      quiz('q1', 2),
      slide('solution', 3, ['p3-check', 'p3-check2'], { contentRole: 'worked_example' }),
      slide('try-1', 3, ['p3-check'], { contentRole: 'check_understanding' }),
      slide('try-2', 3, ['p3-check2'], { contentRole: 'check_understanding' }),
      quiz('q2', 4),
      slide('first-law', 5, ['p4-kc']),
      quiz('q3', 6),
    ];
    const result = placeOutlinesByBookPart(planned, twoChecks, FLOW)!;
    expect(ids(result.outlines).slice(2, 5)).toEqual(['try-1', 'try-2', 'solution']);
  });

  it('MEDIUM 5: an untyped unit (no template element) is no part content', () => {
    const book: KafuoBookStructure = {
      ...BOOK,
      units: [
        ...BOOK.units.slice(0, 4),
        unit('p2-practice', null as never, 2),
        ...BOOK.units.slice(4),
      ],
    };
    const objectives = OBJECTIVES.map((objective) =>
      objective.objectiveRef === 'o2'
        ? { ...objective, contentUnitIds: [...objective.contentUnitIds!, 'p2-practice'] }
        : objective,
    );
    const built = buildBookPartMap(book, objectives, FLOW)!;
    expect(built.units.has('p2-practice')).toBe(false);
    expect(bookPartsRequirement(built, FLOW)).not.toContain('p2-practice');
  });

  it('LOW 6: a slide that follows another stays right behind it, even on a tied key', () => {
    const planned = [
      slide('force', 1, ['p1-kc']),
      quiz('q1', 2),
      slide('try-it', 3, ['p3-check'], { contentRole: 'check_understanding' }),
      quiz('attempt', 3),
      slide('solution', 3, ['p3-check'], { contentRole: 'worked_example' }),
      slide('combining', 3, ['p2-kc']),
      quiz('q2', 4),
      slide('first-law', 5, ['p4-kc']),
      quiz('q3', 6),
    ];
    const result = placeOutlinesByBookPart(planned, map(), FLOW)!;
    expect(ids(result.outlines).slice(2, 6)).toEqual([
      'combining',
      'try-it',
      'attempt',
      'solution',
    ]);
  });

  it("LOW 7: a slide moved to another block teaches under that block's objective", () => {
    const planned = [
      slide('force', 1, ['p1-kc'], { teachingObjective: 'تعريف القوة' }),
      quiz('q1', 2),
      slide('combining', 3, ['p2-kc'], { teachingObjective: 'قانون نيوتن الثاني' }),
      quiz('q2', 4),
      slide('first-law', 5, ['p4-kc'], { teachingObjective: 'قانون نيوتن الأول' }),
      slide('second-law', 5, ['p3-kc'], { teachingObjective: 'قانون نيوتن الأول' }),
      quiz('q3', 6),
    ];
    const result = placeOutlinesByBookPart(planned, map(), FLOW)!;
    const moved = result.outlines.find((outline) => outline.id === 'second-law')!;
    expect(moved.teachingStage?.flowIndex).toBe(3);
    expect(moved.teachingObjective).toBe('قانون نيوتن الثاني');
  });
});

// Review 2 (25 Nov 2026) findings, each pinned.
describe('placeOutlinesByBookPart after review 2', () => {
  it('HIGH 1: a re-grounded quiz is described by its block and tests every slide of it', () => {
    const planned = [
      slide('force', 1, ['p1-kc'], { keyPoints: ['f1', 'f2'] }),
      quiz('q1', 2),
      slide('combining', 3, ['p2-kc'], { keyPoints: ['c1', 'c2', 'c3'] }),
      {
        ...quiz('q2', 4),
        description: 'about the first law',
        keyPoints: ['first law'],
        sourceContentUnitIds: ['p4-kc'],
      },
      slide('first-law', 5, ['p4-kc'], { keyPoints: ['l1'] }),
      slide('second-law', 5, ['p3-kc'], { keyPoints: ['s1', 's2'] }),
      slide('example', 5, ['p3-ex'], { contentRole: 'worked_example', keyPoints: ['e1'] }),
      quiz('q3', 6),
    ];
    const result = placeOutlinesByBookPart(planned, map(), FLOW)!;
    const q2 = result.outlines.find((outline) => outline.id === 'q2')!;
    expect(q2.description).toBe('combining • second-law • example');
    // Every slide's first point, then every slide's second, …
    expect(q2.keyPoints).toEqual(['c1', 's1', 'e1', 'c2', 's2', 'c3']);
    expect(q2.description).not.toContain('first law');
  });

  it('MEDIUM 1: an exercise slide that also cites its rule stays in the exercises block', () => {
    const planned = [
      slide('force', 1, ['p1-kc']),
      quiz('q1', 2),
      slide('combining', 3, ['p2-kc']),
      slide('second-law', 3, ['p3-kc']),
      slide('example', 3, ['p3-ex'], { contentRole: 'worked_example' }),
      quiz('q2', 4),
      slide('inertia', 5, ['p5-kc']),
      slide('first-law', 5, ['p4-kc']),
      transition('exercises', 5),
      slide('ex-1', 5, ['rev-1', 'p4-kc'], { contentRole: 'worked_example' }),
      quiz('q3', 6),
    ];
    const result = placeOutlinesByBookPart(planned, map(), FLOW)!;
    expect(ids(result.outlines).slice(-4)).toEqual(['inertia', 'exercises', 'ex-1', 'q3']);
    expect(stages(result.outlines)['ex-1']).toBe(5);
  });

  it("MEDIUM 3: a block's opening transition stays first; a transition with nothing after it stays behind its slide", () => {
    const planned = [
      slide('force', 1, ['p1-kc']),
      quiz('q1', 2),
      transition('open-2', 3),
      slide('combining', 3, ['p2-kc']),
      quiz('q2', 4),
      transition('open-3', 5),
      slide('first-law', 5, ['p4-kc']),
      slide('second-law', 5, ['p3-kc']),
      transition('trailing', 5),
      quiz('q3', 6),
    ];
    const result = placeOutlinesByBookPart(planned, map(), FLOW)!;
    expect(ids(result.outlines)).toEqual([
      'force',
      'q1',
      'open-2',
      'combining',
      'second-law',
      // It stays behind the slide it followed, wherever that slide's part belongs.
      'trailing',
      'q2',
      'open-3',
      'first-law',
      'q3',
    ]);
  });
});

describe('placeOutlinesByBookPart after the final review', () => {
  it('leaves the plan as it is when a block would keep only its transition', () => {
    const planned = [
      slide('force', 1, ['p1-kc', 'p2-kc']),
      slide('note', 1, ['p1-note', 'p3-kc']),
      quiz('q1', 2),
      transition('open-2', 3),
      slide('first-law', 3, ['p4-kc']),
      quiz('q2', 4),
      slide('inertia', 5, ['p5-kc']),
      quiz('q3', 6),
    ];
    // Block 3 taught `first-law`; after a placement only its opening transition would
    // stay, so nothing is placed (its check quiz would test a part taught after it).
    expect(placeOutlinesByBookPart(planned, map(), FLOW)).toBeNull();
  });
});

describe('placeWithGuard', () => {
  const planned = [
    slide('force', 1, ['p1-kc']),
    quiz('q1', 2),
    slide('first-law', 3, ['p4-kc']),
    slide('combining', 3, ['p2-kc']),
    quiz('q2', 4),
    slide('inertia', 5, ['p5-kc']),
    quiz('q3', 6),
  ];

  it('keeps the placement when the re-diagnosis finds nothing new', () => {
    const guarded = placeWithGuard(planned, map(), FLOW, () => ['SOME_OPEN_CODE']);
    expect(guarded.placement).not.toBeNull();
    expect(ids(guarded.outlines)).toContain('combining');
    expect(guarded.rolledBackFor).toEqual([]);
  });

  it('rolls back on a new code, and on one more of a code already open', () => {
    const newCode = placeWithGuard(planned, map(), FLOW, (candidate) =>
      candidate === planned ? [] : ['FLOW_SEQUENCE_INVALID'],
    );
    expect(newCode.outlines).toBe(planned);
    expect(newCode.rolledBackFor).toEqual(['FLOW_SEQUENCE_INVALID']);
    const oneMore = placeWithGuard(planned, map(), FLOW, (candidate) =>
      candidate === planned
        ? ['BOOK_COVERAGE_INCOMPLETE']
        : ['BOOK_COVERAGE_INCOMPLETE', 'BOOK_COVERAGE_INCOMPLETE'],
    );
    expect(oneMore.outlines).toBe(planned);
    expect(oneMore.rolledBackFor).toEqual(['BOOK_COVERAGE_INCOMPLETE']);
  });
});
