/**
 * g5.v11 (teacher-guide answer referee plan §8.6, 16 Nov 2026), wave 5: the reviewer
 * reads each solving slide's approved guide answers and compares with them instead of
 * re-solving (flag only); its fix notes state only the correct final answer.
 */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readAttemptById: vi.fn(),
  readContentUnitsForAttempt: vi.fn(),
  readVersionById: vi.fn(),
  runReviewerCall: vi.fn(),
  claimReview: vi.fn(),
  renewReviewLease: vi.fn(),
  saveReviewProgress: vi.fn(),
  finishReview: vi.fn(),
  sumReviewSpend: vi.fn(),
  enqueueWebhookEvent: vi.fn(),
}));
vi.mock('@/lib/persistence/teaching-package', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/teaching-package')>()),
  readAttemptById: mocks.readAttemptById,
  readContentUnitsForAttempt: mocks.readContentUnitsForAttempt,
  readVersionById: mocks.readVersionById,
}));
vi.mock('@/lib/server/teaching-model/reviewer-call', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-model/reviewer-call')>()),
  runReviewerCall: mocks.runReviewerCall,
}));
// The review job's rows, ledger and outbox (re-review finding 5c tests): no database.
vi.mock('@/lib/server/teaching-package/package-review-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/package-review-store')>()),
  claimReview: mocks.claimReview,
  renewReviewLease: mocks.renewReviewLease,
  saveReviewProgress: mocks.saveReviewProgress,
  finishReview: mocks.finishReview,
}));
vi.mock('@/lib/persistence/teaching-model-attempts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/teaching-model-attempts')>()),
  sumReviewSpend: mocks.sumReviewSpend,
}));
vi.mock('@/lib/server/teaching-package/webhook-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/webhook-events')>()),
  enqueueWebhookEvent: mocks.enqueueWebhookEvent,
}));
vi.mock('@openmaic/storage/server/reference', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/storage/server/reference')>()),
  nodePostgresTransaction: () => (work: (tx: unknown) => unknown) => work({}),
}));

import {
  callPackageReviewer,
  guideLeakFindings,
  runPackageReview,
} from '@/lib/server/teaching-package/package-review';
import { createPackageReviewFixLoop } from '@/lib/server/teaching-package/package-review-fix-loop';
import {
  REVIEW_GUIDE_ANSWER_PREFIX,
  REVIEW_GUIDE_FIGURE_VISUAL,
  REVIEW_MODEL_ANSWER_PREFIX,
  sceneEditDigest,
  reviewSlidesOf,
  slideVisuals,
  withGuideAnswers,
  type ReviewSlide,
} from '@/lib/server/teaching-package/package-review-input';
import type { PackageReview } from '@/lib/server/teaching-package/package-review-store';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { guideLeakIssue } from '@/lib/server/teaching-package/guide-answer-guard';
import type { AppScene } from '@/lib/types/stage';
import {
  PACKAGE_REVIEW_SYSTEM,
  PACKAGE_REVIEW_SYSTEM_V11,
  PACKAGE_REVIEW_SYSTEM_V2,
  renderSlidesBlock,
} from '@/lib/server/teaching-package/package-review-prompt';
import { bookUnitFactsOf } from '@/lib/server/teaching-package/book-coverage';
import { resolveTeacherGuide } from '@/lib/server/teaching-package/guide-answers';
import type { KafuoBookStructure, KafuoTeacherGuide } from '@/lib/types/teaching-package';

const GUIDE: KafuoTeacherGuide = {
  guideId: 'tg-1',
  items: [
    {
      contentUnitId: '6234',
      label: '1A',
      status: 'approved',
      answer: { type: 'number', value: 12 },
    },
    { contentUnitId: '6234', label: '1B', status: 'doubtful' },
    {
      contentUnitId: '6249',
      label: '11',
      status: 'settled',
      answer: { type: 'number', value: 71.9, unit: 'ألف' },
    },
    // Review finding 10: an item matching no question of OUR book gets no line.
    {
      contentUnitId: '6249',
      label: '40',
      status: 'approved',
      answer: { type: 'number', value: 5 },
    },
  ],
};

const BOOK: KafuoBookStructure = {
  templateVersionId: '3',
  rules: [],
  units: [
    {
      contentUnitId: '6234',
      kind: 'UNDERSTANDING_CHECK',
      element: 'try_it',
      required: true,
      partIndex: 1,
    },
    { contentUnitId: '6249', kind: 'PRACTICE', element: 'exercise', required: false, partIndex: 2 },
  ],
};
const UNITS = [
  { unitId: '6234', normalizedText: '1A) الأعداد 3، 6، 9 … ما الحد التالي؟\n1B) هل التخمين صحيح؟' },
  {
    unitId: '6249',
    normalizedText: '11) إنتاج مصنع: 41.6، 51.8، 61.7. ما المتوقع؟\n12) ما الحد التالي في 1، 3، 5؟',
  },
];
const RESOLVED = resolveTeacherGuide(
  GUIDE,
  BOOK,
  bookUnitFactsOf(
    BOOK,
    UNITS.map((unit) => ({ id: unit.unitId, text: unit.normalizedText })),
  ),
);

const slide = (id: string, overrides: Partial<ReviewSlide>): ReviewSlide => ({
  id,
  order: 1,
  title: id,
  sceneType: 'slide',
  contentRole: 'worked_example',
  citedUnitIds: ['6234'],
  visibleText: 'الإجابة (1A): 12',
  narration: 'نضيف ٣',
  bankQuiz: false,
  ...overrides,
});

describe('package-review input on g5.v11', () => {
  const slides = [
    slide('sol', {}),
    slide('try', { contentRole: 'check_understanding' }),
    slide('quiz', { sceneType: 'quiz', contentRole: null, citedUnitIds: ['6249'] }),
    slide('other', { citedUnitIds: ['6230'] }),
  ];
  const reviewed = withGuideAnswers(slides, RESOLVED);

  it('adds the resolved approved and settled answers to the solving slides only', () => {
    expect(reviewed[0]!.guideAnswers).toEqual([`${REVIEW_GUIDE_ANSWER_PREFIX} (1A): 12`]);
    expect(reviewed[1]!.guideAnswers).toBeUndefined();
    // Named as the writers were told («س11»); the unresolved «40» adds nothing.
    expect(reviewed[2]!.guideAnswers).toEqual([`${REVIEW_GUIDE_ANSWER_PREFIX} (س11): 71.9 ألف`]);
    expect(reviewed[3]!.guideAnswers).toBeUndefined();
  });

  it('leaves out an exercise the run removed from the lesson', () => {
    const withoutRemoved = withGuideAnswers(slides, RESOLVED, new Set(['6249|11']));
    expect(withoutRemoved[2]!.guideAnswers).toBeUndefined();
  });

  it('renders the line only where it was added; a v2 slide renders as before', () => {
    const v11 = renderSlidesBlock(reviewed, undefined, { learnerFirst: true });
    const v2 = renderSlidesBlock(slides, undefined, { learnerFirst: true });
    expect(v11).toContain('إجابة دليل المعلم (1A): 12');
    expect(v2).not.toContain('إجابة دليل المعلم');
    expect(withGuideAnswers(slides, undefined)).toEqual(slides);
  });
});

describe('package-review input: the guide model answers (owner, 17 Nov 2026)', () => {
  const PROOF = 'نفرض أن الحد التالي 7؛\nإذن الفرق ثابت 2.';
  const POSSIBLE = 'إجابة ممكنة: 71.9 تقريبًا';
  const withModels = resolveTeacherGuide(
    {
      ...GUIDE,
      items: [
        ...GUIDE.items,
        {
          contentUnitId: '6249',
          label: '12',
          status: 'reference',
          modelAnswer: { kind: 'proof', text: PROOF },
        },
        {
          contentUnitId: '6249',
          label: '11b',
          status: 'reference',
          modelAnswer: { kind: 'possible', text: POSSIBLE },
        },
      ],
    },
    BOOK,
    bookUnitFactsOf(
      BOOK,
      UNITS.map((unit) => ({ id: unit.unitId, text: unit.normalizedText })),
    ),
  );
  const slides = [
    slide('sol', { citedUnitIds: ['6249'] }),
    slide('try', { contentRole: 'check_understanding', citedUnitIds: ['6249'] }),
    slide('quiz', { sceneType: 'quiz', contentRole: null, citedUnitIds: ['6249'] }),
  ];

  it('adds them to the solution slides only, after the keyed lines, never to a quiz', () => {
    const reviewed = withGuideAnswers(slides, withModels);
    expect(reviewed[0]!.guideAnswers).toEqual([
      `${REVIEW_GUIDE_ANSWER_PREFIX} (س11): 71.9 ألف`,
      `${REVIEW_MODEL_ANSWER_PREFIX} (س11b، إجابة ممكنة): ${POSSIBLE}`,
      `${REVIEW_MODEL_ANSWER_PREFIX} (س12، برهان): ${PROOF}`,
    ]);
    expect(reviewed[1]!.guideAnswers).toBeUndefined();
    expect(reviewed[2]!.guideAnswers).toEqual([`${REVIEW_GUIDE_ANSWER_PREFIX} (س11): 71.9 ألف`]);
    // The keyed lines alone are what the guide without model answers gives.
    expect(withGuideAnswers(slides, RESOLVED)[0]!.guideAnswers).toEqual([
      `${REVIEW_GUIDE_ANSWER_PREFIX} (س11): 71.9 ألف`,
    ]);
    expect(renderSlidesBlock(reviewed, undefined, { learnerFirst: true })).toContain(
      `${REVIEW_MODEL_ANSWER_PREFIX} (س12، برهان): نفرض أن الحد التالي 7؛\nإذن الفرق ثابت 2.`,
    );
  });

  it('leaves out the model answers of a question the run removed from the lesson', () => {
    const reviewed = withGuideAnswers(slides, withModels, new Set(['6249|11']));
    expect(reviewed[0]!.guideAnswers).toEqual([
      `${REVIEW_MODEL_ANSWER_PREFIX} (س12، برهان): ${PROOF}`,
    ]);
  });

  it('tells the reviewer to check the proof against it, flag only, never copy it', () => {
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain(
      "«الإجابة النموذجية في دليل المعلم (<item>، برهان|إجابة ممكنة): <text>» lines are the teacher guide's model answer",
    );
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain('A different correct proof');
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain('never copies the model answer whole');
    expect(PACKAGE_REVIEW_SYSTEM_V2).not.toContain('الإجابة النموذجية');
  });
});

describe('package-review input: the guide answer drawings (owner, 17 Nov 2026)', () => {
  const IMAGE = { checksumSha256: 'c'.repeat(64), mimeType: 'image/png' as const, sizeBytes: 900 };
  const NOTE = 'المستقيم يمر بالنقطتين (0، 1) و(2، 5).';
  const facts = bookUnitFactsOf(
    BOOK,
    UNITS.map((unit) => ({ id: unit.unitId, text: unit.normalizedText })),
  );
  const guide: KafuoTeacherGuide = {
    ...GUIDE,
    items: [
      ...GUIDE.items,
      {
        contentUnitId: '6249',
        label: '12',
        status: 'reference',
        modelAnswer: { kind: 'figure', image: IMAGE, text: NOTE },
      },
      {
        contentUnitId: '6249',
        label: '11b',
        status: 'reference',
        modelAnswer: { kind: 'figure', image: IMAGE },
      },
    ],
  };
  const at = GUIDE.items.length;
  const slides = [
    slide('sol', { citedUnitIds: ['6249'] }),
    slide('try', { contentRole: 'check_understanding', citedUnitIds: ['6249'] }),
    slide('quiz', { sceneType: 'quiz', contentRole: null, citedUnitIds: ['6249'] }),
  ];

  it('names a drawing on its solution slide only, with its note when sent', () => {
    const resolved = resolveTeacherGuide(guide, BOOK, facts, {
      attachedFigureIds: new Set([`src-guide-${at + 1}`, `src-guide-${at + 2}`]),
    });
    const reviewed = withGuideAnswers(slides, resolved);
    expect(reviewed[0]!.guideAnswers).toEqual([
      `${REVIEW_GUIDE_ANSWER_PREFIX} (س11): 71.9 ألف`,
      `${REVIEW_MODEL_ANSWER_PREFIX} (س11b، رسمة)`,
      `${REVIEW_MODEL_ANSWER_PREFIX} (س12، رسمة): ${NOTE}`,
    ]);
    expect(reviewed[1]!.guideAnswers).toBeUndefined();
    expect(reviewed[2]!.guideAnswers).toEqual([`${REVIEW_GUIDE_ANSWER_PREFIX} (س11): 71.9 ألف`]);
    // Read from the attempt snapshot (no stored drawing named), it adds nothing.
    expect(
      withGuideAnswers(slides, resolveTeacherGuide(guide, BOOK, facts))[0]!.guideAnswers,
    ).toEqual([`${REVIEW_GUIDE_ANSWER_PREFIX} (س11): 71.9 ألف`]);
  });

  it('shows a stored drawing on the canvas as the guide’s answer drawing, never a book image', () => {
    expect(
      slideVisuals([
        { type: 'image', src: '/api/classroom-media/stage-1/media/guide_3_0a1b2c3d.png' },
        { type: 'image', src: '/api/classroom-media/stage-1/media/src_4_0a1b2c3d.png' },
      ] as never),
    ).toEqual([REVIEW_GUIDE_FIGURE_VISUAL, '[صورة من الكتاب معروضة: src_4]']);
  });

  it('tells the reviewer it is there on purpose, never to copy it before the try', () => {
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain(`«${REVIEW_GUIDE_FIGURE_VISUAL}»`);
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain(
      'never ask to add, copy or describe it on a check_understanding slide or in a quiz',
    );
    expect(PACKAGE_REVIEW_SYSTEM_V2).not.toContain(REVIEW_GUIDE_FIGURE_VISUAL);
  });
});

describe('package-review rubric on g5.v11', () => {
  it('compares S2 and Q1 with the guide answer, flag only, and keeps re-solving otherwise', () => {
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain(
      'For an item whose slide gives a «إجابة دليل المعلم» line, do not re-solve it: compare the final answer',
    );
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain(
      'for a question on an item with a «إجابة دليل المعلم» line, do not re-solve it: compare the marked answer',
    );
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain('Every other item: re-solve it yourself');
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain('bent to reach the answer');
  });

  it('fix notes state only the correct final answer, never a method or the guide', () => {
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain(
      'state ONLY the correct final answer of that item; never prescribe a method or a working',
    );
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain(
      'Never mention the teacher guide («دليل المعلم») in a fix_note.',
    );
    // A try is never told an answer (the fix loop's regenerations are code-checked too).
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain(
      "A fix_note for a check_understanding slide, or for a quiz's question text, never states any answer",
    );
  });

  it('keeps every v2 check and leaves v1 and v2 without any guide wording', () => {
    for (const line of ['- S6:', '- S7:', 'PICTURES AND DRAWINGS', 'S5', 'Q2', 'Q5']) {
      expect(PACKAGE_REVIEW_SYSTEM_V11).toContain(line);
    }
    expect(PACKAGE_REVIEW_SYSTEM_V2).not.toContain('دليل المعلم');
    expect(PACKAGE_REVIEW_SYSTEM).not.toContain('دليل المعلم');
    expect(PACKAGE_REVIEW_SYSTEM_V2).toContain(
      '- S2: Every calculation and worked example is right. Re-solve each one yourself, step by step, before you judge it.',
    );
  });
});

describe('callPackageReviewer picks the rubric and the input by the Teaching Model', () => {
  const review = {
    id: 'review-1',
    attemptId: 'attempt-1',
    versionId: 'version-1',
    tenantId: 'tenant-1',
    subjectCode: 'MATH',
    learningItem: { type: 'lesson', id: '208' },
  };
  const slides = [slide('sol', {})];

  async function call(version: string) {
    mocks.readAttemptById.mockResolvedValue({
      teachingModel: { key: 'g5', version },
      inputSnapshot: { teacherGuide: GUIDE, bookStructure: BOOK },
    });
    mocks.readContentUnitsForAttempt.mockResolvedValue(UNITS);
    mocks.runReviewerCall.mockResolvedValue({
      parsed: { summary: 's', findings: [] },
      provider: 'anthropic',
      modelString: 'anthropic:model',
      attemptIds: [],
      usage: null,
      switched: null,
    });
    await callPackageReviewer({
      review: review as never,
      units: [{ id: 'book', title: null, role: null, text: 'x' }],
      slides,
      pool: {} as never,
    });
    return mocks.runReviewerCall.mock.calls.at(-1)![0] as { system: string; prompt: string };
  }

  it('g5.v11: the guide rubric and the guide answer lines', async () => {
    const request = await call('g5.v11');
    expect(request.system).toBe(PACKAGE_REVIEW_SYSTEM_V11);
    expect(request.prompt).toContain('إجابة دليل المعلم (1A): 12');
  });

  it('g5.v10: the v2 rubric and no guide line, even when a snapshot holds a guide', async () => {
    mocks.readContentUnitsForAttempt.mockClear();
    const request = await call('g5.v10');
    expect(request.system).toBe(PACKAGE_REVIEW_SYSTEM_V2);
    expect(request.prompt).not.toContain('دليل المعلم');
    // g5.v10 reads nothing new.
    expect(mocks.readContentUnitsForAttempt).not.toHaveBeenCalled();
  });
});

// Re-review finding 5c: a slide the run kept while it may still state a checked answer
// before the learner's try (its GUIDE_ANSWER_LEAK scene issue) is a must-fix finding the
// fix loop regenerates once, naming the item only. g5.v10 reviews exactly as before.
describe('the package review fixes a slide kept with a GUIDE_ANSWER_LEAK issue', () => {
  const ISSUE = guideLeakIssue([
    { code: 'GUIDE_ANSWER_LEAK', item: RESOLVED.keyed[0]!, where: 'canvas', detail: 'stated' },
  ]);
  /** The answer of item 1A (12), in either digit style. */
  const VALUE = /12|١٢/;
  const tryScene = (text: string, issues?: Array<{ code: string; message: string }>) =>
    ({
      id: 'try',
      stageId: 'stage-1',
      title: 'جرّب',
      order: 1,
      type: 'slide',
      sourceContentUnitIds: ['6234'],
      content: {
        type: 'slide',
        contentRole: 'check_understanding',
        canvas: { elements: [{ id: 'e', type: 'text', content: `<p>${text}</p>` }] },
      },
      actions: [{ id: 'a', type: 'speech', text: 'جرّب بنفسك.' }],
      ...(issues ? { generationIssues: issues } : {}),
    }) as unknown as AppScene;
  const LEAKING = tryScene('الأعداد 3، 6، 9 … والحد التالي هو العدد المطلوب', [ISSUE]);
  const FIXED = tryScene('الأعداد 3، 6، 9 … ما الحد التالي؟');

  const CLAIMED: PackageReview = {
    id: 'review-1',
    tenantId: 'tenant-1',
    learningItem: { type: 'lesson', id: '208' },
    versionId: 'version-1',
    attemptId: 'attempt-1',
    stageId: 'stage-1',
    subjectCode: 'MATH',
    status: 'running',
    provider: null,
    model: null,
    summary: null,
    findings: [],
    fixes: [],
    errorCode: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    bookTruncated: false,
    runAttempts: 1,
    leaseOwner: 'w',
    leaseUntil: 2,
    reviewedAt: null,
    reviewedStageRev: null,
    reviewedStageDigest: null,
    reviewBaseline: null,
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
  };

  function job(version: string, scenes: AppScene[], regenerate?: ReturnType<typeof vi.fn>) {
    mocks.readAttemptById.mockReset().mockResolvedValue({
      teachingModel: { key: 'g5', version },
      inputSnapshot: { teacherGuide: GUIDE, bookStructure: BOOK },
    });
    mocks.readContentUnitsForAttempt.mockResolvedValue(UNITS);
    mocks.readVersionById.mockResolvedValue({
      id: 'version-1',
      tenantId: 'tenant-1',
      status: 'draft',
      currentStageId: 'stage-1',
    });
    mocks.claimReview.mockResolvedValue({ ...CLAIMED });
    mocks.renewReviewLease.mockResolvedValue(true);
    mocks.saveReviewProgress.mockReset().mockResolvedValue(undefined);
    mocks.sumReviewSpend.mockResolvedValue({ rows: 0 });
    mocks.enqueueWebhookEvent.mockResolvedValue(undefined);
    mocks.finishReview
      .mockReset()
      .mockImplementation(async (_tx: unknown, _id: string, _worker: string, outcome: object) => ({
        ...CLAIMED,
        ...outcome,
      }));
    const regen =
      regenerate ??
      vi.fn(async (_grant: unknown, sceneId: string) => ({
        status: 200,
        body: {
          regenerationId: `tpsr-${sceneId}`,
          status: 'succeeded',
          replayed: false,
          sceneId,
          scene: FIXED,
          resultSceneRev: 2,
          current: { rev: 2, scene: FIXED },
        },
      }));
    const regenerateAudio = vi.fn(async (_grant: unknown, sceneId: string) => ({
      sceneId,
      scene: FIXED,
      rev: 3,
      generated: 1,
      missing: 0,
    }));
    const callReviewer = vi.fn(async () => ({
      answer: { summary: 's', findings: [] },
      call: { provider: 'anthropic' as const, modelString: 'anthropic:model', usage: null },
    }));
    const fixLoop = createPackageReviewFixLoop({
      regenerate: regen as never,
      regenerateAudio: regenerateAudio as never,
      readVersion: (async () => ({
        id: 'version-1',
        tenantId: 'tenant-1',
        status: 'draft',
        currentStageId: 'stage-1',
      })) as never,
      readScene: async (_pool, _stage, sceneId) => {
        const scene = scenes.find((candidate) => candidate.id === sceneId);
        return scene ? { rev: 1, scene } : null;
      },
    });
    const run = () =>
      runPackageReview('review-1', {
        pool: {} as never,
        now: () => 5,
        workerId: 'w',
        callReviewer: callReviewer as never,
        fixLoop,
        loadScenes: async () => scenes,
      });
    return { run, regenerate: regen, regenerateAudio };
  }

  it('g5.v11: the issue is a must-fix finding, stored with the first answer and regenerated once', async () => {
    // The reviewer itself reports nothing: the issue alone sends the slide to the fix loop.
    const { run, regenerate, regenerateAudio } = job('g5.v11', [LEAKING]);
    const finished = await run();
    expect(regenerate).toHaveBeenCalledTimes(1);
    const [, sceneId, request] = regenerate.mock.calls[0] as unknown as [
      unknown,
      string,
      { instruction: string; reason: string },
    ];
    expect(sceneId).toBe('try');
    expect(request.instruction).toContain('(S7) لا تذكر الإجابة النهائية للبند 1A');
    expect(regenerateAudio).toHaveBeenCalledTimes(1);
    expect(finished).toMatchObject({
      status: 'fixed',
      findings: [{ id: 'g1', targetId: 'try', check: 'S7', severity: 'high', status: 'fixed' }],
      fixes: [{ sceneId: 'try', outcome: 'fixed' }],
    });
    const stored = (
      mocks.saveReviewProgress.mock.calls[0] as unknown as [
        unknown,
        string,
        string,
        { findings: Array<{ id: string; status: string }>; reviewedAt: number },
      ]
    )[3];
    expect(stored.reviewedAt).toBe(5);
    expect(stored.findings).toMatchObject([{ id: 'g1', status: 'open' }]);
    // Never the answer: not in the regeneration's instruction, its reason, or the finding.
    const written = finished!.findings[0]!;
    for (const text of [
      request.instruction,
      request.reason,
      written.whatIsWrong,
      written.fixNote,
    ]) {
      expect(text).not.toMatch(VALUE);
      expect(text).not.toContain('دليل المعلم');
    }
  });

  it('g5.v11: a regeneration that still states it keeps the slide as it was, the finding open', async () => {
    const regenerate = vi.fn(async () => {
      throw new TeachingPackageError(
        'SCENE_CONTENT_GENERATION_FAILED',
        "the regenerated slide still states a checked answer before the learner's try; the slide was kept as it was",
        { regenerationId: 'tpsr-try', failure: 'GUIDE_ANSWER_LEAK' },
      );
    });
    const { run, regenerateAudio } = job('g5.v11', [LEAKING], regenerate);
    const finished = await run();
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerateAudio).not.toHaveBeenCalled();
    expect(finished).toMatchObject({
      status: 'needs_teacher',
      findings: [{ id: 'g1', status: 'open', teacherReason: 'REGENERATION_REFUSED' }],
      fixes: [{ sceneId: 'try', outcome: 'refused', code: 'SCENE_CONTENT_GENERATION_FAILED' }],
    });
    // Nothing was written: the review last saw the slide as it was, its issue in place.
    expect(finished!.findings[0]!.sceneDigest).toBe(sceneEditDigest(LEAKING));
    expect(LEAKING.generationIssues).toEqual([ISSUE]);
  });

  it('g5.v10: unchanged — no finding from the issue', async () => {
    const leaking = job('g5.v10', [LEAKING]);
    const finished = await leaking.run();
    expect(leaking.regenerate).not.toHaveBeenCalled();
    expect(finished).toMatchObject({ status: 'passed', findings: [], fixes: [] });
    // 21 Nov 2026 (D2): the attempt is read on every first review — the label-script
    // finding is model-gated too — but exactly once, for both model-gated checks.
    expect(mocks.readAttemptById).toHaveBeenCalledTimes(1);
    expect(mocks.readAttemptById).toHaveBeenCalledWith(expect.anything(), 'attempt-1');
    const clean = job('g5.v10', [FIXED]);
    expect(await clean.run()).toMatchObject({ status: 'passed', findings: [] });
    expect(mocks.readAttemptById).toHaveBeenCalledTimes(1);
  });

  it('names every item of the issue, or none when its wording is unknown; slides only', () => {
    const two = guideLeakIssue([
      { code: 'GUIDE_ANSWER_LEAK', item: RESOLVED.keyed[0]!, where: 'canvas', detail: 'x' },
      { code: 'GUIDE_ANSWER_LEAK', item: RESOLVED.keyed[1]!, where: 'narration', detail: 'x' },
    ]);
    const quiz = {
      ...tryScene('x', [ISSUE]),
      id: 'quiz',
      order: 3,
      type: 'quiz',
      content: { type: 'quiz', questions: [] },
    } as unknown as AppScene;
    const scenes = [
      tryScene('x', [two]),
      { ...tryScene('x', [{ code: 'GUIDE_ANSWER_LEAK', message: 'other' }]), id: 'b', order: 2 },
      quiz,
    ] as AppScene[];
    const findings = guideLeakFindings(scenes, reviewSlidesOf(scenes));
    expect(findings.map((finding) => [finding.id, finding.targetId])).toEqual([
      ['g1', 'try'],
      ['g2', 'b'],
    ]);
    expect(findings[0]!.fixNote).toContain('للبنود 1A، س11');
    expect(findings[1]!.fixNote).toContain('لأي بند');
    for (const finding of findings) expect(finding.fixNote).not.toMatch(/12|١٢|71\.9/);
  });

  it('a solution slide carrying the issue (a check tried later) keeps its other working', () => {
    const solution = {
      ...tryScene('الحل', [ISSUE]),
      id: 'sol',
      content: {
        type: 'slide',
        contentRole: 'worked_example',
        canvas: { elements: [{ id: 'e', type: 'text', content: '<p>الحل</p>' }] },
      },
    } as unknown as AppScene;
    const [finding] = guideLeakFindings([solution], reviewSlidesOf([solution]));
    expect(finding).toMatchObject({ targetId: 'sol', check: 'S7' });
    // Only the named item loses its answer; the rest of the slide stays as it is.
    expect(finding!.fixNote).toContain('لا تذكر الإجابة النهائية للبند 1A');
    expect(finding!.fixNote).toContain('وأبقِ كل ما سواه كما هو');
    expect(finding!.fixNote).not.toContain('فقط');
  });
});

// D2 (21 Nov 2026), review MEDIUM: the label-script finding through the whole review run —
// the Teaching Model gate (g5.v10/v11 only), the fix loop's G2 decision from the live
// scene (fixed versus STILL_WRONG), and a failed attempt read that adds nothing.
describe('the label-script check in the review run (D2)', () => {
  const LABEL_UNIT = {
    unitId: '6688',
    normalizedText: 'في الشكل المجاور، يُطابق الشكل الرباعي ABCD الشكل الرباعي WXYZ.',
  };
  const labelScene = (text: string, issues?: Array<{ code: string; message: string }>) =>
    ({
      id: 'label',
      stageId: 'stage-1',
      title: 'التطابق',
      order: 1,
      type: 'slide',
      sourceContentUnitIds: ['6688'],
      content: {
        type: 'slide',
        contentRole: 'worked_example',
        canvas: { elements: [{ id: 'e', type: 'text', content: `<p>${text}</p>` }] },
      },
      actions: [{ id: 'a', type: 'speech', text: 'نقرأ الشكل.' }],
      ...(issues ? { generationIssues: issues } : {}),
    }) as unknown as AppScene;
  const ARABIC = labelScene('الشكل الرباعي ز ي س و مطابق');
  const LATIN = labelScene('الشكل الرباعي WXYZ مطابق');

  function labelJob(
    version: string,
    scenes: AppScene[],
    after: AppScene,
    options: { attemptFails?: boolean } = {},
  ) {
    const attempt = mocks.readAttemptById.mockReset();
    if (options.attemptFails) attempt.mockRejectedValue(new Error('attempt read failed'));
    else attempt.mockResolvedValue({ teachingModel: { key: 'g5', version }, inputSnapshot: {} });
    mocks.readContentUnitsForAttempt.mockResolvedValue([...UNITS, LABEL_UNIT]);
    mocks.readVersionById.mockResolvedValue({
      id: 'version-1',
      tenantId: 'tenant-1',
      status: 'draft',
      currentStageId: 'stage-1',
    });
    const claimed = {
      id: 'review-1',
      tenantId: 'tenant-1',
      learningItem: { type: 'lesson', id: '203' },
      versionId: 'version-1',
      attemptId: 'attempt-1',
      stageId: 'stage-1',
      subjectCode: 'MATH',
      status: 'running',
      findings: [],
      fixes: [],
      runAttempts: 1,
      leaseOwner: 'w',
      leaseUntil: 2,
      reviewedAt: null,
      createdAt: 1,
      startedAt: 1,
    } as unknown as PackageReview;
    mocks.claimReview.mockResolvedValue({ ...claimed });
    mocks.renewReviewLease.mockResolvedValue(true);
    mocks.saveReviewProgress.mockReset().mockResolvedValue(undefined);
    mocks.sumReviewSpend.mockResolvedValue({ rows: 0 });
    mocks.enqueueWebhookEvent.mockResolvedValue(undefined);
    mocks.finishReview
      .mockReset()
      .mockImplementation(async (_tx: unknown, _id: string, _worker: string, outcome: object) => ({
        ...claimed,
        ...outcome,
      }));
    const regenerate = vi.fn(async (_grant: unknown, sceneId: string) => ({
      status: 200,
      body: {
        regenerationId: `tpsr-${sceneId}`,
        status: 'succeeded',
        replayed: false,
        sceneId,
        scene: after,
        resultSceneRev: 2,
        current: { rev: 2, scene: after },
      },
    }));
    // The loop's live scene is the one the audio step returns.
    const regenerateAudio = vi.fn(async (_grant: unknown, sceneId: string) => ({
      sceneId,
      scene: after,
      rev: 3,
      generated: 1,
      missing: 0,
    }));
    const callReviewer = vi.fn(async () => ({
      answer: { summary: 's', findings: [] },
      call: { provider: 'anthropic' as const, modelString: 'anthropic:model', usage: null },
    }));
    const fixLoop = createPackageReviewFixLoop({
      regenerate: regenerate as never,
      regenerateAudio: regenerateAudio as never,
      readVersion: (async () => ({
        id: 'version-1',
        tenantId: 'tenant-1',
        status: 'draft',
        currentStageId: 'stage-1',
      })) as never,
      readScene: async (_pool, _stage, sceneId) => {
        const scene = scenes.find((candidate) => candidate.id === sceneId);
        return scene ? { rev: 1, scene } : null;
      },
    });
    const run = () =>
      runPackageReview('review-1', {
        pool: {} as never,
        now: () => 5,
        workerId: 'w',
        callReviewer: callReviewer as never,
        fixLoop,
        loadScenes: async () => scenes,
      });
    return { run, regenerate };
  }

  it.each(['g5.v10', 'g5.v11'])(
    '%s: G2 regenerates the slide once; a canvas with the book’s labels closes it',
    async (version) => {
      const { run, regenerate } = labelJob(version, [ARABIC], LATIN);
      const finished = await run();
      expect(regenerate).toHaveBeenCalledTimes(1);
      const [, sceneId, request] = regenerate.mock.calls[0] as unknown as [
        unknown,
        string,
        { instruction: string },
      ];
      expect(sceneId).toBe('label');
      // The note names the book's own runs.
      expect(request.instruction).toContain('ABCD، WXYZ');
      expect(finished).toMatchObject({
        status: 'fixed',
        findings: [{ id: 'l1', targetId: 'label', check: 'G2', status: 'fixed' }],
        fixes: [{ sceneId: 'label', outcome: 'fixed' }],
      });
    },
  );

  it('a regeneration that writes the Arabic letters again stays open as STILL_WRONG', async () => {
    const { run, regenerate } = labelJob('g5.v10', [ARABIC], ARABIC);
    const finished = await run();
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(finished).toMatchObject({
      status: 'needs_teacher',
      findings: [{ id: 'l1', check: 'G2', status: 'open', teacherReason: 'STILL_WRONG' }],
    });
  });

  it('g5.v8: no G2 finding and no regeneration (the version gate)', async () => {
    const { run, regenerate } = labelJob('g5.v8', [ARABIC], LATIN);
    const finished = await run();
    expect(regenerate).not.toHaveBeenCalled();
    expect(finished).toMatchObject({ status: 'passed', findings: [], fixes: [] });
  });

  it('a failed attempt read adds no model-gated finding, and a G1 still stands', async () => {
    const broken = labelScene('الشكل الرباعي ز ي س و مطابق', [
      { code: 'NARRATION_MISSING', message: 'no spoken line' },
    ]);
    const { run } = labelJob('g5.v10', [broken], LATIN, { attemptFails: true });
    const finished = await run();
    // The review still finishes (never a new failure point); the fix loop's own W2 read
    // fails the same way and keeps the v1 flow.
    expect(finished!.findings.map((finding) => finding.check)).toEqual(['G1']);
    expect(finished!.findings[0]).toMatchObject({ status: 'fixed' });
  });
});
