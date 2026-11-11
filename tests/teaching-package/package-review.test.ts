import { describe, expect, it } from 'vitest';

import type { AppScene } from '@/lib/types/stage';
import { REVIEWER_CALL_TIMEOUT_MS } from '@/lib/server/teaching-model/reviewer-policy';
import {
  MAX_PACKAGE_REVIEWS_IN_FLIGHT,
  REVIEW_LEASE_MS,
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
  PACKAGE_REVIEW_SCHEMA,
  PACKAGE_REVIEW_SYSTEM,
  parseReviewerAnswer,
  renderBookBlock,
  renderSlidesBlock,
} from '@/lib/server/teaching-package/package-review-prompt';
import type { StoredFinding } from '@/lib/server/teaching-package/package-review-store';

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
