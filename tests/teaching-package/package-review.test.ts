import { describe, expect, it } from 'vitest';

import type { AppScene } from '@/lib/types/stage';
import { REVIEWER_CALL_TIMEOUT_MS } from '@/lib/server/teaching-model/reviewer-policy';
import {
  MAX_PACKAGE_REVIEWS_IN_FLIGHT,
  REVIEW_LEASE_MS,
  generationIssueFindings,
  labelScriptFindings,
  reviewStatusOf,
  teacherOnlyReason,
  toStoredFindings,
} from '@/lib/server/teaching-package/package-review';
import {
  MAX_QUESTION_REVIEWS_IN_FLIGHT,
  QUESTION_REVIEW_LEASE_MS,
} from '@/lib/server/teaching-package/question-review';
import {
  reviewSlidesOf,
  sceneToReviewSlide,
  stripTags,
} from '@/lib/server/teaching-package/package-review-input';
import {
  BOOK_TRUNCATED_NOTE,
  PACKAGE_REVIEW_SCHEMA,
  PACKAGE_REVIEW_SYSTEM,
  parseReviewerAnswer,
  renderBookBlock,
  renderSlidesBlock,
} from '@/lib/server/teaching-package/package-review-prompt';
import type { StoredFinding } from '@/lib/server/teaching-package/package-review-store';
import { slidesNeedingRegeneration } from '@/lib/server/teaching-package/lifecycle';
import { scenePlayPositions } from '@/lib/server/teaching-package/scene-position';
import {
  refixReviewId,
  seedRefixFindings,
} from '@/lib/server/teaching-package/package-review-refix';

/**
 * The package reviewer's input, prompt and answer handling with a fake
 * reviewer (ai-reviewer-layer plan §4.2, §4.3, D-9). No model is called.
 */

function slideScene(id: string, order: number, overrides: Record<string, unknown> = {}): AppScene {
  return {
    id,
    stageId: 'stage-1',
    title: `عنوان ${order}`,
    order,
    type: 'slide',
    sourceContentUnitIds: ['4489'],
    content: {
      type: 'slide',
      contentRole: 'explanation',
      canvas: {
        elements: [
          {
            id: 'e1',
            type: 'text',
            content: '<p>المساحة <b>تساوي</b> الطول&nbsp;×&nbsp;العرض</p>',
          },
          { id: 'e2', type: 'latex', latex: '\\frac{a}{b}' },
          { id: 'e3', type: 'image', src: '/api/classroom-media/s/media/x.png' },
        ],
      },
    },
    actions: [
      { id: 'a1', type: 'speech', text: 'نحسب المساحة.' },
      { id: 'a2', type: 'spotlight', elementId: 'e1' },
    ],
    ...overrides,
  } as unknown as AppScene;
}

function quizScene(id: string, order: number, overrides: Record<string, unknown> = {}): AppScene {
  return {
    id,
    stageId: 'stage-1',
    title: 'اختبر نفسك',
    order,
    type: 'quiz',
    content: {
      type: 'quiz',
      questions: [
        {
          id: 'q1',
          type: 'single',
          question: 'كم يساوي ٣ × ٤؟',
          options: [
            { value: 'A', label: '١٢' },
            { value: 'B', label: '٧' },
          ],
          answer: ['A'],
          analysis: 'لأن ٣ × ٤ = ١٢',
        },
      ],
    },
    actions: [],
    ...overrides,
  } as unknown as AppScene;
}

describe('package review input (text only, D-9)', () => {
  it('a slide: visible text with tags stripped, LaTeX kept, narration separate, no image', () => {
    const slide = sceneToReviewSlide(slideScene('s1', 3));
    expect(slide).toMatchObject({
      id: 's1',
      order: 3,
      title: 'عنوان 3',
      sceneType: 'slide',
      contentRole: 'explanation',
      citedUnitIds: ['4489'],
      narration: 'نحسب المساحة.',
      bankQuiz: false,
    });
    expect(slide.visibleText).toBe('المساحة تساوي الطول × العرض\n$\\frac{a}{b}$');
    expect(JSON.stringify(slide)).not.toContain('classroom-media');
  });

  it('a quiz: question, options, the MARKED answer and the explanation (for Q1/Q2/Q5)', () => {
    const slide = sceneToReviewSlide(quizScene('q', 5));
    expect(slide.sceneType).toBe('quiz');
    expect(slide.questions).toEqual([
      {
        question: 'كم يساوي ٣ × ٤؟',
        options: [
          { value: 'A', label: '١٢' },
          { value: 'B', label: '٧' },
        ],
        answer: ['A'],
        explanation: 'لأن ٣ × ٤ = ١٢',
      },
    ]);
    expect(renderSlidesBlock([slide])).toContain('MARKED ANSWER: A');
  });

  it('slides come in display order; a bank quiz is flagged', () => {
    const slides = reviewSlidesOf([
      quizScene('bank', 2, { questionSource: 'bank' }),
      slideScene('first', 1),
    ]);
    expect(slides.map((slide) => [slide.id, slide.bankQuiz])).toEqual([
      ['first', false],
      ['bank', true],
    ]);
  });

  it('stripTags keeps line breaks of block tags and decodes entities', () => {
    expect(stripTags('<p>أ</p><p>ب &amp; ج</p>')).toBe('أ\nب & ج');
  });
});

describe('package review prompt', () => {
  it('the checklist sits in the fixed system prompt; the book is its own stable block, before the slides', () => {
    for (const code of ['S1', 'S2', 'S3', 'S4', 'S5', 'Q1', 'Q2', 'Q5']) {
      expect(PACKAGE_REVIEW_SYSTEM).toContain(`- ${code}`);
    }
    const book = renderBookBlock([{ id: '4489', title: 'تأكد', role: 'exercise', text: 'نص' }]);
    expect(book).toContain('unit_id=4489');
    expect(book.indexOf('BOOK TEXT')).toBe(0);
    const schemaFinding = (
      PACKAGE_REVIEW_SCHEMA.properties as Record<string, { items: { required: string[] } }>
    ).findings.items;
    expect(schemaFinding.required).toEqual([
      'target_id',
      'check',
      'severity',
      'book_evidence',
      'what_is_wrong',
      'fix_note',
    ]);
  });

  it('D-8: a cut book adds one sentence saying so; an uncut book renders exactly as before', () => {
    const units = [{ id: '4489', title: null, role: null, text: 'نص' }];
    const whole = renderBookBlock(units);
    expect(whole).toBe('BOOK TEXT (the authority):\n<<UNIT unit_id=4489>>\nنص\n<<END UNIT>>');
    expect(renderBookBlock(units, { truncated: false })).toBe(whole);
    const cut = renderBookBlock(units, { truncated: true });
    expect(cut).toBe(
      `BOOK TEXT (the authority):\n${BOOK_TRUNCATED_NOTE}\n<<UNIT unit_id=4489>>\nنص\n<<END UNIT>>`,
    );
    expect(BOOK_TRUNCATED_NOTE).toMatch(/cut/);
    expect(BOOK_TRUNCATED_NOTE.split('. ')).toHaveLength(1);
  });

  it('a re-review names the focus slides and keeps the neighbours as context', () => {
    const slides = reviewSlidesOf([slideScene('a', 1), slideScene('b', 2), slideScene('c', 3)]);
    const block = renderSlidesBlock(slides, new Set(['b']));
    expect(block).toMatch(/^RE-REVIEW\. Check ONLY these slides: b\./);
    expect(block).toContain('id=a');
    expect(block).toContain('id=c');
  });
});

describe('parseReviewerAnswer', () => {
  const scope = { slideIds: new Set(['s1', 'q1']), quizIds: new Set(['q1']) };
  const finding = (overrides: Record<string, unknown> = {}) => ({
    target_id: 's1',
    check: 'S2',
    severity: 'high',
    book_evidence: { quote: 'نص', unit_id: '4489' },
    what_is_wrong: 'خطأ',
    fix_note: 'صحح',
    ...overrides,
  });

  it('maps a valid answer', () => {
    const answer = parseReviewerAnswer(
      JSON.stringify({ summary: 'ملخص', findings: [finding()] }),
      scope,
    );
    expect(answer).toEqual({
      summary: 'ملخص',
      findings: [
        {
          targetId: 's1',
          check: 'S2',
          severity: 'high',
          bookEvidence: { quote: 'نص', unitId: '4489' },
          whatIsWrong: 'خطأ',
          fixNote: 'صحح',
        },
      ],
    });
  });

  it('H-1: Sol answers in text mode — the system prompt carries the exact schema, and a fenced answer parses', () => {
    expect(PACKAGE_REVIEW_SYSTEM).toContain(JSON.stringify(PACKAGE_REVIEW_SCHEMA));
    expect(PACKAGE_REVIEW_SYSTEM).toContain('"findings"');
    const solAnswer =
      '```json\n' + JSON.stringify({ summary: 'ملخص', findings: [finding()] }) + '\n```';
    expect(parseReviewerAnswer(solAnswer, scope).findings).toHaveLength(1);
    expect(parseReviewerAnswer('```\n{"summary":"s","findings":[]}\n```', scope).findings).toEqual(
      [],
    );
  });

  it('throws on a malformed answer (→ unusable_output → the fallback route)', () => {
    expect(() => parseReviewerAnswer('not json', scope)).toThrow();
    expect(() => parseReviewerAnswer(JSON.stringify({ findings: [] }), scope)).toThrow(/summary/);
    expect(() =>
      parseReviewerAnswer(
        JSON.stringify({ summary: 's', findings: [finding({ check: 'S9' })] }),
        scope,
      ),
    ).toThrow(/unknown check/);
  });

  it('drops findings outside the review: unknown slide, quiz check on a slide, slide check on a quiz, duplicates', () => {
    const answer = parseReviewerAnswer(
      JSON.stringify({
        summary: 's',
        findings: [
          finding({ target_id: 'ghost' }),
          finding({ check: 'Q1' }),
          finding({ target_id: 'q1', check: 'S1' }),
          finding({ target_id: 'q1', check: 'Q1' }),
          finding(),
          finding(),
          finding({ target_id: '', check: 'S5' }),
        ],
      }),
      scope,
    );
    expect(answer.findings.map((f) => `${f.targetId}:${f.check}`)).toEqual([
      'q1:Q1',
      's1:S2',
      ':S5',
    ]);
  });

  it('a re-review keeps only findings on its focus slides and never a package-level S5', () => {
    const answer = parseReviewerAnswer(
      JSON.stringify({
        summary: 's',
        findings: [
          finding(),
          finding({ target_id: 'q1', check: 'Q2' }),
          finding({ target_id: '', check: 'S5' }),
        ],
      }),
      { ...scope, focusIds: new Set(['q1']) },
    );
    expect(answer.findings.map((f) => `${f.targetId}:${f.check}`)).toEqual(['q1:Q2']);
  });
});

describe('findings and status', () => {
  const slides = reviewSlidesOf([
    slideScene('s1', 1),
    quizScene('bank', 2, { questionSource: 'bank' }),
  ]);
  const stored = (overrides: Partial<StoredFinding>): StoredFinding => ({
    id: 'f1',
    targetId: 's1',
    targetTitle: '',
    targetOrder: 1,
    check: 'S1',
    severity: 'high',
    bookEvidence: { quote: 'q', unitId: null },
    whatIsWrong: 'w',
    fixNote: 'n',
    status: 'open',
    teacherReason: null,
    ...overrides,
  });

  it('toStoredFindings anchors each finding to its slide title and order', () => {
    const findings = toStoredFindings(
      {
        summary: 's',
        findings: [
          {
            targetId: 's1',
            check: 'S3',
            severity: 'medium',
            bookEvidence: { quote: 'q', unitId: null },
            whatIsWrong: 'w',
            fixNote: 'n',
          },
        ],
      },
      slides,
    );
    expect(findings).toEqual([
      expect.objectContaining({ id: 'f1', targetTitle: 'عنوان 1', targetOrder: 1, status: 'open' }),
    ]);
  });

  it('S5 and a bank quiz go straight to the teacher', () => {
    expect(teacherOnlyReason(stored({ check: 'S5' }), slides)).toBe('S5_TEACHER_ONLY');
    expect(teacherOnlyReason(stored({ targetId: 'bank', check: 'Q1' }), slides)).toBe(
      'BANK_QUIZ_NOT_REGENERABLE',
    );
    expect(teacherOnlyReason(stored({}), slides)).toBeNull();
  });

  it('no findings → passed; all fixed → fixed; anything open → needs_teacher (never a partial pass)', () => {
    expect(reviewStatusOf([])).toBe('passed');
    expect(reviewStatusOf([stored({ status: 'fixed' })])).toBe('fixed');
    expect(reviewStatusOf([stored({ status: 'fixed' }), stored({ id: 'f2' })])).toBe(
      'needs_teacher',
    );
  });

  it('flagged-slide regeneration: only stayed-wrong, never-attempted and stopped findings are tried again', () => {
    const seed = seedRefixFindings(
      [
        stored({ id: 'still', teacherReason: 'STILL_WRONG' }),
        stored({ id: 'new', check: 'S2', teacherReason: 'NOT_ATTEMPTED' }),
        stored({ id: 'changed', check: 'S3', teacherReason: 'VERSION_CHANGED' }),
        // Content fixed, audio failed: the audio has its own remedy, no new paid slide.
        stored({ id: 'audio', check: 'S4', teacherReason: 'NARRATION_AUDIO_FAILED' }),
        stored({ id: 'unchecked', check: 'S4', teacherReason: 'REREVIEW_UNAVAILABLE' }),
        stored({ id: 'refused', check: 'S4', teacherReason: 'REGENERATION_REFUSED' }),
        stored({ id: 'missing', targetId: '', check: 'S5', teacherReason: 'S5_TEACHER_ONLY' }),
        stored({ id: 'bank', targetId: 'bank', check: 'Q1', teacherReason: 'STILL_WRONG' }),
        stored({ id: 'done', status: 'fixed' }),
      ],
      slides,
    );
    // Dead end (b), 27 Nov 2026: a finding whose re-check could not run is re-checked
    // (only re-checked: `recheckOnly`) on every press, never left for good.
    expect(seed.findings.map((f) => [f.id, f.status, f.teacherReason, f.recheckOnly])).toEqual([
      ['still', 'open', null, undefined],
      ['new', 'open', null, undefined],
      ['changed', 'open', null, undefined],
      ['audio', 'open', 'NARRATION_AUDIO_FAILED', undefined],
      ['unchecked', 'open', null, true],
      ['refused', 'open', 'REGENERATION_REFUSED', undefined],
      ['missing', 'open', 'S5_TEACHER_ONLY', undefined],
      ['bank', 'open', 'BANK_QUIZ_NOT_REGENERABLE', undefined],
      ['done', 'fixed', null, undefined],
    ]);
    expect(seed.sceneIds).toEqual(['s1']);
  });

  it('flagged-slide regeneration: a slide a person edited since the review is left as they made it', () => {
    const seed = seedRefixFindings(
      [stored({ id: 'still', teacherReason: 'STILL_WRONG', sceneDigest: 'as-reviewed' })],
      slides,
      new Map([['s1', 'edited-by-teacher']]),
    );
    expect(seed.findings.map((f) => f.teacherReason)).toEqual(['VERSION_CHANGED']);
    expect(seed.sceneIds).toEqual([]);
    // Unchanged slide, or a review finished before digests existed: tried again.
    const unchanged = seedRefixFindings(
      [stored({ id: 'still', teacherReason: 'STILL_WRONG', sceneDigest: 'same' })],
      slides,
      new Map([['s1', 'same']]),
    );
    expect(unchanged.sceneIds).toEqual(['s1']);
    const older = seedRefixFindings(
      [stored({ id: 'still', teacherReason: 'STILL_WRONG' })],
      slides,
      new Map([['s1', 'whatever']]),
    );
    expect(older.sceneIds).toEqual(['s1']);
  });

  it('flagged-slide regeneration: one problem is one finding, however often it was re-reported', () => {
    const seed = seedRefixFindings(
      [
        stored({ id: 'f1', check: 'S1', teacherReason: 'STILL_WRONG', fixNote: 'old' }),
        stored({ id: 'r-1-1', check: 'S1', teacherReason: 'STILL_WRONG', fixNote: 'newest' }),
        stored({ id: 'f2', check: 'S3', teacherReason: 'STILL_WRONG' }),
      ],
      slides,
    );
    expect(seed.findings.map((f) => [f.id, f.fixNote])).toEqual([
      ['r-1-1', 'newest'],
      ['f2', 'n'],
    ]);
  });

  it('flagged-slide regeneration: nothing a regeneration may fix → no slides', () => {
    const seed = seedRefixFindings(
      [stored({ id: 'missing', targetId: '', check: 'S5', teacherReason: 'S5_TEACHER_ONLY' })],
      slides,
    );
    expect(seed.sceneIds).toEqual([]);
  });

  it('the re-queued review id is the same for one request key and different for the next press', () => {
    const first = refixReviewId('7', 'tpv-1', 'key-00000001');
    expect(refixReviewId('7', 'tpv-1', 'key-00000001')).toBe(first);
    expect(refixReviewId('7', 'tpv-1', 'key-00000002')).not.toBe(first);
    expect(first).toMatch(/^tpr-rf-[A-Za-z0-9_-]{16}$/);
  });
});

describe('leases and in-flight caps (D-6, D-7)', () => {
  it('each lease outlasts one worst-case reviewer call (primary + fallback) with margin', () => {
    const worstCall = 2 * REVIEWER_CALL_TIMEOUT_MS;
    expect(REVIEW_LEASE_MS).toBeGreaterThan(worstCall);
    expect(QUESTION_REVIEW_LEASE_MS).toBeGreaterThan(worstCall);
    expect(REVIEW_LEASE_MS).toBe(40 * 60 * 1000);
    expect(QUESTION_REVIEW_LEASE_MS).toBe(40 * 60 * 1000);
  });

  it('at most 2 package reviews and 2 question reviews run at once per process', () => {
    expect(MAX_PACKAGE_REVIEWS_IN_FLIGHT).toBe(2);
    expect(MAX_QUESTION_REVIEWS_IN_FLIGHT).toBe(2);
  });
});

describe('every kept generation issue becomes a review finding (21 Nov 2026)', () => {
  const broken = slideScene('s1', 3, {
    title: 'مثال 1 – إذا وفقط إذا',
    generationIssues: [
      { code: 'PLACEHOLDER_SLIDE', message: 'the slide could not be generated' },
      { code: 'NARRATION_MISSING', message: 'no spoken line' },
    ],
  });

  it('one G1 finding per scene, naming the slide by position and title with its codes', () => {
    const scenes = [slideScene('s0', 1), broken];
    const [finding] = generationIssueFindings(scenes, reviewSlidesOf(scenes));
    expect(finding).toMatchObject({
      id: 'i1',
      targetId: 's1',
      targetTitle: 'مثال 1 – إذا وفقط إذا',
      targetOrder: 3,
      check: 'G1',
      severity: 'high',
      status: 'open',
    });
    // The play position (second slide), not the raw `order` 3 (review 21 Nov 2026).
    expect(finding!.whatIsWrong).toContain('الشريحة 2:');
    expect(finding!.whatIsWrong).toContain('مثال 1 – إذا وفقط إذا');
    expect(finding!.whatIsWrong).toContain('PLACEHOLDER_SLIDE');
    // Auto-fixable: the fix loop regenerates the slide once, like any other finding.
    expect(teacherOnlyReason(finding, reviewSlidesOf(scenes))).toBeNull();
  });

  it('the finding and the submit/approve gate name the same position (gaps, any array order)', () => {
    const issue = [{ code: 'NARRATION_MISSING', message: 'no spoken line' }];
    // Stored out of play order, with a gap in `order` (1, 3, 7).
    const scenes = [
      slideScene('c', 7, { title: 'ج', generationIssues: issue }),
      slideScene('a', 1, { title: 'أ' }),
      slideScene('b', 3, { title: 'ب', generationIssues: issue }),
    ];
    const gate = slidesNeedingRegeneration(scenes);
    expect(gate).toEqual([
      { position: 2, title: 'ب', codes: ['NARRATION_MISSING'] },
      { position: 3, title: 'ج', codes: ['NARRATION_MISSING'] },
    ]);
    const findings = generationIssueFindings(scenes, reviewSlidesOf(scenes));
    expect(findings.map((finding) => finding.whatIsWrong.split(':')[0])).toEqual([
      'الشريحة 2',
      'الشريحة 3',
    ]);
    expect(scenePlayPositions(scenes)).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]),
    );
  });

  it('a GUIDE_ANSWER_LEAK scene is not duplicated: it already has its own finding', () => {
    const leaking = slideScene('s1', 2, {
      generationIssues: [{ code: 'GUIDE_ANSWER_LEAK', message: 'stated the answer' }],
    });
    expect(generationIssueFindings([leaking], reviewSlidesOf([leaking]))).toEqual([]);
  });

  it('a clean stage gives no finding, and a placeholder quiz scene gets one too', () => {
    const clean = slideScene('s0', 1);
    expect(generationIssueFindings([clean], reviewSlidesOf([clean]))).toEqual([]);
    const quiz = {
      ...slideScene('q1', 2),
      type: 'quiz',
      generationIssues: [{ code: 'PLACEHOLDER_QUIZ', message: 'not generated' }],
    } as unknown as AppScene;
    const [finding] = generationIssueFindings([quiz], reviewSlidesOf([quiz]));
    expect(finding!.check).toBe('G1');
  });
});

describe('the label-script finding (D2, 21 Nov 2026)', () => {
  const units = [
    { id: '6688', text: 'ABCD ≅ WXYZ', order: 1, role: 'EXAMPLE', title: 'مثال' },
    { id: '6690', text: 'المثلث س ص ع', order: 2, role: 'EXAMPLE', title: 'مثال 2' },
  ] as never;

  function slideOf(id: string, order: number, visibleText: string, cited: string[]) {
    return {
      ...slideScene(id, order),
      content: {
        type: 'slide',
        contentRole: 'worked_example',
        canvas: {
          elements: [{ id: 'e1', type: 'text', content: `<p>${visibleText}</p>` }],
        },
      },
      sourceContentUnitIds: cited,
    } as unknown as AppScene;
  }

  it('a slide writing the book’s Latin labels as Arabic letters gets one G2 finding', () => {
    const scenes = [
      slideOf('s0', 3, 'مقدمة', ['6690']),
      slideOf('s1', 12, 'المثلث ز ي س و مطابق', ['6688']),
    ];
    const slides = reviewSlidesOf(scenes);
    const [finding] = labelScriptFindings(slides, units);
    expect(finding).toMatchObject({
      id: 'l1',
      targetId: 's1',
      targetOrder: 12,
      check: 'G2',
      severity: 'high',
      status: 'open',
    });
    // The play position (second slide), as the gate and the G1 findings name it.
    expect(finding!.whatIsWrong).toContain('الشريحة 2:');
    expect(finding!.whatIsWrong).toContain('LABEL_SCRIPT_CHANGED');
    expect(finding!.fixNote).toContain('(ABCD، WXYZ)');
    expect(teacherOnlyReason(finding, slides)).toBeNull();
  });

  it('the fix note names the cited units’ own Latin runs, never a fixed example (review)', () => {
    const own = [
      {
        id: '6700',
        text: 'الشكل PQRS يطابق الشكل △K′L′M′N′',
        order: 1,
        role: 'EXAMPLE',
        title: 'م',
      },
    ] as never;
    const scenes = [slideOf('s1', 1, 'الشكل ز ي س و', ['6700'])];
    const [finding] = labelScriptFindings(reviewSlidesOf(scenes), own);
    expect(finding!.fixNote).toContain('(PQRS، K′L′M′N′)');
    expect(finding!.fixNote).not.toContain('ABCD');
    expect(finding!.fixNote).not.toContain('WXYZ');
  });

  it('ordinary Arabic maths text on the canvas gives no finding (review H5)', () => {
    const geometry = [
      { id: '6710', text: 'في △ABC، AB = 3 m', order: 1, role: 'EXAMPLE', title: 'م' },
    ] as never;
    const scenes = [
      slideOf('s1', 1, 'أوجد قيمتي س و ص', ['6710']),
      slideOf('s2', 2, 'طولا الضلعين ٣ م و ٤ م', ['6710']),
    ];
    expect(labelScriptFindings(reviewSlidesOf(scenes), geometry)).toEqual([]);
  });

  it('Arabic labels in the book give no finding, and clean Latin labels neither', () => {
    const arabic = [slideOf('s1', 3, 'المثلث س ص ع قائم', ['6690'])];
    expect(labelScriptFindings(reviewSlidesOf(arabic), units)).toEqual([]);
    const clean = [slideOf('s2', 4, 'المثلث ABCD مطابق', ['6688'])];
    expect(labelScriptFindings(reviewSlidesOf(clean), units)).toEqual([]);
  });
});
