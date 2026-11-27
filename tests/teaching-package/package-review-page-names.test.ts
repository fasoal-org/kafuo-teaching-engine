/**
 * Review of 97cc78c3..4f6f8ddb (H-1, the reviewer's repro made a test): a page number
 * the book prints inside a quote («تمرين صفحة 45») is book text, never a page name. A page
 * name the Stage does not hold names nothing, so it never becomes a permanent person hold.
 * Unknown crops (`src_N`) keep their rule. Plus the LOW: a page that does not fit a call
 * still sends its cheaper crops. Fakes only.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createPackageReviewFixLoop } from '@/lib/server/teaching-package/package-review-fix-loop';
import {
  namedBookImages,
  pickReviewFigures,
  reviewSlidesOf,
  type ReviewFigure,
  type ReviewFigureSet,
} from '@/lib/server/teaching-package/package-review-input';
import type {
  PackageReview,
  StoredFinding,
} from '@/lib/server/teaching-package/package-review-store';
import type { AppScene } from '@/lib/types/stage';

function slide(id: string, order: number, text: string): AppScene {
  return {
    id,
    stageId: 'stage-2',
    title: `شريحة ${order}`,
    order,
    type: 'slide',
    sourceContentUnitIds: ['u1'],
    content: { type: 'slide', canvas: { elements: [{ id: 'e', type: 'text', content: text }] } },
    actions: [{ id: 'a', type: 'speech', text: `شرح ${text}` }],
  } as unknown as AppScene;
}
const SCENES = [slide('s1', 1, 'أ'), slide('s2', 2, 'ب')];
const REVIEW = {
  id: 'tpr-x',
  tenantId: 't-1',
  learningItem: { type: 'lesson', id: '227' },
  versionId: 'tpv-2',
  attemptId: 'tpa-1',
  stageId: 'stage-2',
  subjectCode: 'MATH',
  status: 'running',
  findings: [],
  fixes: [],
  reviewedAt: 5,
  runAttempts: 1,
} as unknown as PackageReview;

const crop = (name: string, pageNumber: number, tokens = 255): ReviewFigure => ({
  name,
  unitIds: ['u1'],
  pageNumber,
  mediaType: 'image/png',
  data: 'AAAA',
  tokens,
});
// Crops only: the g5.v12 state of every Stage stored before the page images.
const CROPS: ReviewFigureSet = { figures: [crop('src_2', 13)], unreadable: [], unsendable: [] };

function loop(set: ReviewFigureSet) {
  const regenerate = vi.fn(async () => ({
    status: 200,
    body: { regenerationId: 'rg-1', scene: slide('s2', 2, 'ب مصححة') },
  }));
  const regenerateAudio = vi.fn(async () => ({ scene: slide('s2', 2, 'ب مصححة'), missing: 0 }));
  const evidences: unknown[] = [];
  const callReviewer = vi.fn(async (request: { alsoFigures?: string[] }) => {
    const picked = pickReviewFigures(
      set,
      new Set(['u1']),
      60_000,
      request.alsoFigures ?? [],
      60_000,
    );
    evidences.push(picked.evidence);
    return {
      answer: { summary: 's', findings: [] },
      call: { provider: 'openai', modelString: 'openai:gpt-6-sol', usage: null },
      figureEvidence: picked.evidence,
    };
  });
  const fixLoop = createPackageReviewFixLoop({
    regenerate: regenerate as never,
    regenerateAudio: regenerateAudio as never,
    readVersion: (async () => ({
      id: 'tpv-2',
      tenantId: 't-1',
      status: 'draft',
      currentStageId: 'stage-2',
    })) as never,
    readScene: async (_pool, _stage, sceneId) => {
      const scene = SCENES.find((candidate) => candidate.id === sceneId);
      return scene ? { rev: 1, scene } : null;
    },
  });
  const run = (quote: string) =>
    fixLoop({
      pool: {} as never,
      review: REVIEW,
      units: [{ id: 'u1', title: null, role: null, text: 'نص' }],
      slides: reviewSlidesOf(SCENES),
      scenes: SCENES,
      findings: [
        {
          id: 'f1',
          targetId: 's2',
          targetTitle: 'شريحة 2',
          targetOrder: 2,
          check: 'S3',
          severity: 'high',
          bookEvidence: { quote, unitId: 'u1' },
          whatIsWrong: 'w',
          fixNote: 'n',
          status: 'open',
          teacherReason: null,
        } as StoredFinding,
      ],
      figureRoom: () => true,
      heartbeat: async () => true,
      callReviewer: callReviewer as never,
      recordProgress: vi.fn(async () => {}),
      now: () => 1,
    } as never);
  return { run, regenerate, callReviewer, evidences };
}

const QUOTE = '«[الشكل src_2]» العدد 25، كما في تمرين صفحة 45';

describe('H-1: a page number in a book quote is never a page name', () => {
  it('the printed «صفحة 45» names nothing; only the bracketed «[الصفحة N]» names a page', () => {
    expect(namedBookImages(QUOTE)).toEqual(['src_2']);
    expect(namedBookImages('«[الصفحة 45]» الجدول')).toEqual(['page_45']);
  });

  it('crops only: the paid fix whose clean re-check saw src_2 closes (the reviewer’s repro)', async () => {
    const { run, regenerate, callReviewer, evidences } = loop(CROPS);
    const result = await run(QUOTE);
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(callReviewer).toHaveBeenCalledTimes(1);
    expect(evidences[0]).toMatchObject({ sent: ['src_2'], unreadable: [] });
    expect(result.findings[0]).toMatchObject({ status: 'fixed', teacherReason: null });
    expect(result.findings[0]).not.toHaveProperty('heldFor');
  });

  it('crops only: even a bracketed page the Stage holds no image of names nothing', async () => {
    const { run } = loop(CROPS);
    const result = await run('«[الصفحة 13]» العدد 25');
    expect(result.findings[0]).toMatchObject({ status: 'fixed' });
  });

  it('pages: a named page outside the stored set names nothing; a stored one is wanted', () => {
    const page13: ReviewFigure = {
      name: 'page_13',
      unitIds: ['u1'],
      pageNumber: 13,
      mediaType: 'image/jpeg',
      data: 'PAGE',
      tokens: 2_317,
      kind: 'page',
      covers: ['src_2'],
    };
    const set: ReviewFigureSet = { figures: [page13], unreadable: [] };
    const outside = pickReviewFigures(set, new Set(['other']), 60_000, ['page_45'], 60_000);
    expect(outside.figures).toEqual([]);
    expect(outside.evidence.unreadable).toEqual([]);
    const stored = pickReviewFigures(set, new Set(['other']), 60_000, ['page_13'], 60_000);
    expect(stored.figures.map((figure) => figure.name)).toEqual(['page_13']);
    // An unknown crop keeps its rule: never seen, so unread.
    expect(
      pickReviewFigures(set, new Set(['other']), 60_000, ['src_99'], 60_000).evidence.unreadable,
    ).toEqual(['src_99']);
  });
});

describe('LOW: a whole page that does not fit still sends its cheaper crops', () => {
  it('the crops on a page too big for the call go instead; the page alone is held', () => {
    const page: ReviewFigure = {
      name: 'page_13',
      unitIds: ['u1'],
      pageNumber: 13,
      mediaType: 'image/jpeg',
      data: 'PAGE',
      tokens: 2_317,
      kind: 'page',
      covers: ['src_2', 'src_3'],
      coveredFigures: [crop('src_2', 13, 255), crop('src_3', 13, 900)],
    };
    const set: ReviewFigureSet = { figures: [page], unreadable: [] };
    // 1,000 tokens left: no page, but src_2 fits (src_3 does not).
    const picked = pickReviewFigures(set, new Set(['u1']), 1_000, [], 60_000);
    expect(picked.figures.map((figure) => figure.name)).toEqual(['src_2']);
    expect(picked.evidence.sent).toEqual(['src_2']);
    // What the call could not show: the page itself and the crop that did not fit.
    expect(picked.evidence.held).toEqual(['page_13', 'src_3']);
    // Room enough: the page, never its crops beside it.
    const whole = pickReviewFigures(set, new Set(['u1']), 60_000, [], 60_000);
    expect(whole.figures.map((figure) => figure.name)).toEqual(['page_13']);
  });
});
