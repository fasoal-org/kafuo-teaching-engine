/**
 * g5.v11 (teacher-guide answer referee plan §8.6, 16 Nov 2026), wave 5: the reviewer
 * reads each solving slide's approved guide answers and compares with them instead of
 * re-solving (flag only); its fix notes state only the correct final answer.
 */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readAttemptById: vi.fn(), runReviewerCall: vi.fn() }));
vi.mock('@/lib/persistence/teaching-package', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/teaching-package')>()),
  readAttemptById: mocks.readAttemptById,
}));
vi.mock('@/lib/server/teaching-model/reviewer-call', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-model/reviewer-call')>()),
  runReviewerCall: mocks.runReviewerCall,
}));

import { callPackageReviewer } from '@/lib/server/teaching-package/package-review';
import {
  REVIEW_GUIDE_ANSWER_PREFIX,
  withGuideAnswers,
  type ReviewSlide,
} from '@/lib/server/teaching-package/package-review-input';
import {
  PACKAGE_REVIEW_SYSTEM,
  PACKAGE_REVIEW_SYSTEM_V11,
  PACKAGE_REVIEW_SYSTEM_V2,
  renderSlidesBlock,
} from '@/lib/server/teaching-package/package-review-prompt';
import type { KafuoTeacherGuide } from '@/lib/types/teaching-package';

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
  ],
};

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
  const reviewed = withGuideAnswers(slides, GUIDE);

  it('adds the approved and settled answers to the solving slides only', () => {
    expect(reviewed[0]!.guideAnswers).toEqual([`${REVIEW_GUIDE_ANSWER_PREFIX} (1A): 12`]);
    expect(reviewed[1]!.guideAnswers).toBeUndefined();
    expect(reviewed[2]!.guideAnswers).toEqual([`${REVIEW_GUIDE_ANSWER_PREFIX} (11): 71.9 ألف`]);
    expect(reviewed[3]!.guideAnswers).toBeUndefined();
  });

  it('renders the line only where it was added; a v2 slide renders as before', () => {
    const v11 = renderSlidesBlock(reviewed, undefined, { learnerFirst: true });
    const v2 = renderSlidesBlock(slides, undefined, { learnerFirst: true });
    expect(v11).toContain('إجابة دليل المعلم (1A): 12');
    expect(v2).not.toContain('إجابة دليل المعلم');
    expect(withGuideAnswers(slides, undefined)).toEqual(slides);
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
      inputSnapshot: { teacherGuide: GUIDE },
    });
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
    const request = await call('g5.v10');
    expect(request.system).toBe(PACKAGE_REVIEW_SYSTEM_V2);
    expect(request.prompt).not.toContain('دليل المعلم');
  });
});
