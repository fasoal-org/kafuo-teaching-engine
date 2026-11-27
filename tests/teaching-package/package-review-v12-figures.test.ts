/**
 * RV-1 (owner §2, 27 Nov 2026), g5.v12 only: the AI reviewer SEES the book's own figures
 * of the units each call judges, within about $0.30 a review, through the existing crop
 * reader; every other Teaching Model reviews from text exactly as before. Also RV-4's
 * evidence parity: a re-check that could not see its slide's figures closes no HIGH finding.
 * No model, no database, no paid call.
 */
import { createHash } from 'node:crypto';

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
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  callPackageReviewer,
  reviewerImageTokenPriceUsd,
  reviewImageTokenBudget,
  runPackageReview,
  type ReviewCallRequest,
} from '@/lib/server/teaching-package/package-review';
import {
  createPackageReviewFixLoop,
  REREVIEW_FIGURES_HELD,
} from '@/lib/server/teaching-package/package-review-fix-loop';
import {
  estimateImageTokens,
  figureRoomFor,
  judgedUnitIds,
  loadReviewFigures,
  namedFigures,
  pickReviewFigures,
  reviewBaselineOf,
  reviewInputDigest,
  reviewSlidesOf,
  sceneEditDigest,
  REVIEW_CALL_MAX_FIGURES,
  REVIEW_FIGURE_MAX_BASE64_CHARS,
  REVIEW_FIGURE_MAX_SIDE_PX,
  REVIEW_IMAGE_ATTEMPTS_PER_CALL,
  REVIEW_IMAGE_BUDGET_USD,
  REVIEW_IMAGE_MAX_TOKENS_PER_RUN,
  REVIEW_IMAGE_TOKENS_UNKNOWN_SIZE,
  type ReviewFigure,
  type ReviewFigureSet,
} from '@/lib/server/teaching-package/package-review-input';
import {
  BOOK_FIGURES_HEADING,
  BOOK_FIGURES_INCOMPLETE_NOTE,
  BOOK_PAGES_HEADING,
  PACKAGE_REVIEW_SYSTEM,
  PACKAGE_REVIEW_SYSTEM_V2,
  PACKAGE_REVIEW_SYSTEM_V11,
  PACKAGE_REVIEW_SYSTEM_V12,
} from '@/lib/server/teaching-package/package-review-prompt';
import type {
  PackageReview,
  StoredFinding,
} from '@/lib/server/teaching-package/package-review-store';
import {
  refixReviewId,
  seedRefixFindings,
} from '@/lib/server/teaching-package/package-review-refix';
import { TeachingModelUnavailableError } from '@/lib/server/teaching-model/execute';
import type { SourceVisualManifestEntry } from '@/lib/types/teaching-package';
import type { AppScene } from '@/lib/types/stage';

const { runReviewerCall: realRunReviewerCall } = await vi.importActual<
  typeof import('@/lib/server/teaching-model/reviewer-call')
>('@/lib/server/teaching-model/reviewer-call');

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('RV-1: v7–v11 rubrics are byte-identical (hashes taken at 693e2d42, before RV-1)', () => {
  it('package-review-v1, -v2 and the g5.v11 rubric are unchanged', () => {
    expect(sha(PACKAGE_REVIEW_SYSTEM)).toBe(
      'e6d48f615d6472ea88de9e54909eddf972c17051c95bfa1b4037f144281d274a',
    );
    expect(sha(PACKAGE_REVIEW_SYSTEM_V2)).toBe(
      '72f0be060550fcd15d12ed190bb5c80c12bf3cdb0f8f1331f366089f26388d65',
    );
    expect(sha(PACKAGE_REVIEW_SYSTEM_V11)).toBe(
      '20760c0d0e2c50322ea97074ea3a47f76ee4e7100aa25464db2500e094364c31',
    );
  });

  it('g5.v12 has its own rubric: it sees the figures instead of "you cannot see its content"', () => {
    expect(PACKAGE_REVIEW_SYSTEM_V12).not.toBe(PACKAGE_REVIEW_SYSTEM_V11);
    expect(PACKAGE_REVIEW_SYSTEM_V11).toContain(
      'a book picture by its id (you cannot see its content)',
    );
    expect(PACKAGE_REVIEW_SYSTEM_V12).not.toContain(
      'a book picture by its id (you cannot see its content)',
    );
    expect(PACKAGE_REVIEW_SYSTEM_V12).toContain(BOOK_FIGURES_HEADING);
    expect(PACKAGE_REVIEW_SYSTEM_V12).toContain('<<BOOK FIGURE src_N | unit_id=… | page=…>>');
    // Only the picture line changed: the v11 guide-answer rules are all still there.
    expect(PACKAGE_REVIEW_SYSTEM_V12).toContain('إجابة دليل المعلم');
  });
});

describe('RV-1: the figure token estimate and the cap', () => {
  it('estimates the larger of the two providers’ documented rules', () => {
    // 319×297: Anthropic 127, OpenAI one tile (85 + 170) = 255.
    expect(estimateImageTokens(319, 297)).toBe(255);
    // 659×433: OpenAI two tiles = 425.
    expect(estimateImageTokens(659, 433)).toBe(425);
    // Opus 5.5 is in the high-resolution tier (review 27 Nov 2026): a 2400×1800 crop is
    // 4.32 MP, scaled to 3.75 MP: about 4,784 tokens, never the old ~1,533.
    expect(estimateImageTokens(2400, 1800)).toBe(4_784);
    expect(REVIEW_IMAGE_TOKENS_UNKNOWN_SIZE).toBe(4_784);
    // 1500×1000 (1.5 MP, under every limit): 2,000 tokens.
    expect(estimateImageTokens(1500, 1000)).toBe(2_000);
    expect(estimateImageTokens(undefined, 200)).toBe(REVIEW_IMAGE_TOKENS_UNKNOWN_SIZE);
  });

  it('prices a figure token at the highest reviewer input or cache-write rate ($5/M today)', () => {
    expect(reviewerImageTokenPriceUsd()).toBeCloseTo(5 / 1_000_000, 12);
    const budget = reviewImageTokenBudget();
    // Page images (contract 27 Nov 2026): $0.60 worst case per review run, 60,000 tokens.
    expect(REVIEW_IMAGE_BUDGET_USD).toBe(0.6);
    expect(budget).toBe(60_000);
    // The worst case: every figure token paid on both attempts at the highest rate.
    expect(
      budget * reviewerImageTokenPriceUsd() * REVIEW_IMAGE_ATTEMPTS_PER_CALL,
    ).toBeLessThanOrEqual(REVIEW_IMAGE_BUDGET_USD + 1e-12);
    // An unpriced model sends no figure at all, never an unbounded cap.
    expect(reviewImageTokenBudget(0)).toBe(0);
    expect(reviewerImageTokenPriceUsd({ version: 'x', entries: {} } as never)).toBe(0);
    // An underpriced rate-card override never widens the budget.
    expect(reviewImageTokenBudget(1e-9)).toBe(REVIEW_IMAGE_MAX_TOKENS_PER_RUN);
  });
});

const entry = (
  n: number,
  unitIds: string[] | undefined,
  extra: Partial<SourceVisualManifestEntry> = {},
): SourceVisualManifestEntry => ({
  id: `src-${n}`,
  contentResourceId: '659',
  pageNumber: 10 + n,
  width: 319,
  height: 297,
  mimeType: 'image/jpeg',
  sha256: `${n}`.repeat(64).slice(0, 64),
  servingPath: `/api/classroom-media/stage-1/media/src_${n}_abcdef12.jpg`,
  ...(unitIds ? { sourceContentUnitIds: unitIds } : {}),
  ...extra,
});

describe('RV-1: the figures come from the existing crop reader, fail-soft', () => {
  it('reads only the figures linked to the judged units; a guide drawing never counts', async () => {
    const read = vi.fn(async (path: string, expected: { sha256?: string }) =>
      path.includes('src_3_')
        ? undefined
        : path.endsWith('.gif')
          ? 'data:image/gif;base64,R0lGODlh'
          : `data:image/jpeg;base64,${expected.sha256!.slice(0, 4)}`,
    );
    const set = await loadReviewFigures(
      [
        entry(1, ['6758']),
        entry(2, ['9999']),
        entry(3, ['6758']), // unreadable
        entry(4, ['6760'], { servingPath: '/api/classroom-media/stage-1/media/src_4_x.gif' }),
        entry(5, undefined, {
          servingPath: '/api/classroom-media/stage-1/media/guide_5_abcdef12.png',
        }),
      ],
      new Set(['6758', '6760']),
      { stageId: 'stage-1' },
      read as never,
    );
    expect(set.figures.map((figure) => [figure.name, figure.unitIds, figure.data])).toEqual([
      ['src_1', ['6758'], '1111'],
    ]);
    expect(set.figures[0]).toMatchObject({ mediaType: 'image/jpeg', pageNumber: 11, tokens: 255 });
    // src_3 (missing: unread) and src_4 (a GIF: never sendable) are listed, not thrown.
    expect(set.unreadable).toEqual([{ name: 'src_3', unitIds: ['6758'], pageNumber: 13 }]);
    expect(set.unsendable).toEqual([{ name: 'src_4', unitIds: ['6760'], pageNumber: 14 }]);
    expect(read).toHaveBeenCalledWith(entry(1, []).servingPath, { sha256: entry(1, []).sha256 });
    expect(read).not.toHaveBeenCalledWith(entry(2, []).servingPath, expect.anything());
  });

  it('guards the request size: no size, too wide, too large, or another Stage is never sent', async () => {
    const big = 'A'.repeat(REVIEW_FIGURE_MAX_BASE64_CHARS + 4);
    const read = vi.fn(async (path: string) =>
      path.includes('src_3_') ? `data:image/png;base64,${big}` : 'data:image/png;base64,AAAA',
    );
    const set = await loadReviewFigures(
      [
        entry(1, ['u'], { width: undefined }),
        entry(2, ['u'], { width: REVIEW_FIGURE_MAX_SIDE_PX + 1 }),
        entry(3, ['u']),
        entry(4, ['u'], { servingPath: '/api/classroom-media/stage-9/media/src_4_abcdef12.png' }),
        entry(5, ['u']),
      ],
      new Set(['u']),
      { stageId: 'stage-1' },
      read as never,
    );
    expect(set.figures.map((figure) => figure.name)).toEqual(['src_5']);
    // Never sendable: no call could ever carry them, so nothing was read from them.
    expect(set.unsendable?.map((figure) => figure.name)).toEqual(['src_1', 'src_2', 'src_3']);
    expect(set.unreadable).toEqual([]);
    // Another Stage's file is never read nor listed; a sizeless or too-wide one is not read.
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('null loads every book figure of the Stage, whichever unit owns it; never a guide drawing', async () => {
    const read = vi.fn(async () => 'data:image/png;base64,AAAA');
    const set = await loadReviewFigures(
      [entry(1, ['u']), entry(2, ['v']), entry(3, undefined)],
      null,
      { stageId: 'stage-1' },
      read as never,
    );
    expect(set.figures.map((figure) => figure.name)).toEqual(['src_1', 'src_2']);
  });

  it('reads a figure name the way a quote may write it', () => {
    expect(namedFigures('«[الشكل SRC-3]» و src ٤ و src_05 و src12')).toEqual([
      'src_3',
      'src_4',
      'src_5',
      'src_12',
    ]);
    expect(namedFigures('لا شكل هنا')).toEqual([]);
  });

  it('a run with no reviewer price sends nothing and holds nothing', () => {
    const set: ReviewFigureSet = {
      figures: [{ ...FIG_A }],
      unreadable: [],
    };
    expect(pickReviewFigures(set, new Set(['6758']), 0, [], 0).evidence).toEqual({
      sent: [],
      held: [],
      unreadable: [],
      unsendable: ['src_1'],
    });
  });

  it('room: a re-check that this run can still show its figures, never a budget it cannot', () => {
    const set: ReviewFigureSet = { figures: [{ ...FIG_A, tokens: 16_000 }], unreadable: [] };
    expect(figureRoomFor(set, new Set(['6758']), [], 16_000, 30_000)).toBe(true);
    expect(figureRoomFor(set, new Set(['6758']), [], 15_999, 30_000)).toBe(false);
    // No figure wanted, or more than any fresh run could carry: not a budget question.
    expect(figureRoomFor(set, new Set(['other']), [], 0, 30_000)).toBe(true);
    expect(figureRoomFor(set, new Set(['6758']), [], 0, 10_000)).toBe(true);
  });

  it('picks one call’s figures within its cap and counts what it held back', () => {
    const fig = (name: string, unit: string, tokens: number): ReviewFigure => ({
      name,
      unitIds: [unit],
      pageNumber: 1,
      mediaType: 'image/png',
      data: 'AAAA',
      tokens,
    });
    const set: ReviewFigureSet = {
      figures: [fig('src_1', 'a', 300), fig('src_2', 'b', 900), fig('src_3', 'a', 200)],
      unreadable: [{ name: 'src_7', unitIds: ['a'] }],
    };
    expect(pickReviewFigures(set, new Set(['a', 'b']), 600)).toMatchObject({
      tokens: 500,
      held: 1,
      figures: [{ name: 'src_1' }, { name: 'src_3' }],
      evidence: { sent: ['src_1', 'src_3'], held: ['src_2'], unreadable: ['src_7'] },
    });
    expect(pickReviewFigures(set, new Set(['b']), 10_000)).toMatchObject({ held: 0, tokens: 900 });
    expect(pickReviewFigures(set, new Set(['a']), 0)).toMatchObject({ figures: [], held: 2 });
    // A figure a finding was read from is wanted even when another unit owns it.
    expect(pickReviewFigures(set, new Set(['b']), 10_000, ['src_1'])).toMatchObject({
      figures: [{ name: 'src_1' }, { name: 'src_2' }],
    });
    // At most 20 figures in one call.
    const many: ReviewFigureSet = {
      figures: Array.from({ length: 25 }, (_, n) => fig(`src_${n + 1}`, 'a', 10)),
      unreadable: [],
    };
    // More than one call can ever carry: those holds are not curable (no paid retry loop).
    const overflow = pickReviewFigures(many, new Set(['a']), 10_000);
    expect(overflow.held).toBe(25 - REVIEW_CALL_MAX_FIGURES);
    expect(overflow.evidence.held).toEqual([]);
    expect(overflow.evidence.unreadable).toHaveLength(25 - REVIEW_CALL_MAX_FIGURES);
    // The figures could not be listed: a figure a finding names counts as unread.
    expect(
      pickReviewFigures({ figures: [], unreadable: [], loadFailed: true }, new Set(['a']), 10_000, [
        'src_9',
      ]).evidence,
    ).toEqual({ sent: [], held: [], unreadable: ['src_9'], unsendable: [] });
    expect(namedFigures('[الشكل src_2] 25 °C، وفي الشكل src_12 أيضًا src_2')).toEqual([
      'src_2',
      'src_12',
    ]);
    expect([
      ...judgedUnitIds(
        [
          { id: 's1', citedUnitIds: ['a'] },
          { id: 's2', citedUnitIds: ['b'] },
        ],
        new Set(['s2']),
      ),
    ]).toEqual(['b']);
  });
});

describe('RV-1: runReviewerCall places the figures after the cache-marked book text', () => {
  it('book (cache mark) → each figure after its label (no mark) → slides', async () => {
    const calls: unknown[] = [];
    const executeStream = vi.fn(async (_policy: unknown, _ctx: unknown, params: unknown) => {
      calls.push(params);
      return {
        text: '{}',
        parsed: {},
        servedBy: 'primary',
        attemptIds: [],
        outcomes: [],
        usage: null,
        timings: { startedAt: 0, ttftMs: null, totalMs: 1, primaryFailureMs: null },
      };
    });
    await realRunReviewerCall(
      {
        pool: {} as ConnectableQueryable,
        tenantId: 't',
        subjectCode: 'CHEMISTRY',
        capability: 'package_review',
        stage: 'package-review',
        association: { kind: 'generation', generationAttemptId: 'ga' },
        aggregate: { tenantId: 't', learningItem: { type: 'lesson', id: '1' } },
        system: 'S',
        stablePrompt: 'BOOK',
        images: [
          { label: 'F1', data: 'AAA=', mediaType: 'image/jpeg' },
          { label: 'F2', data: 'BBB=', mediaType: 'image/webp' },
        ],
        prompt: 'SLIDES',
        output: { kind: 'json', validate: (x: string) => x },
      },
      {
        chooseRoute: async () => ({ mode: 'opus', probe: false }),
        resolveRoute: (async () => ({
          policy: {
            primary: { role: 'primary', modelString: 'anthropic:claude-opus-5-5' },
            fallback: { role: 'fallback', modelString: 'openai:gpt-6-sol' },
          },
          primaryOnly: false,
        })) as never,
        executeStream: executeStream as never,
      },
    );
    const content = (calls[0] as { messages: Array<{ content: unknown[] }> }).messages[0]!.content;
    expect(content).toEqual([
      {
        type: 'text',
        text: 'BOOK',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      { type: 'text', text: 'F1' },
      { type: 'image', image: 'AAA=', mediaType: 'image/jpeg' },
      { type: 'text', text: 'F2' },
      { type: 'image', image: 'BBB=', mediaType: 'image/webp' },
      { type: 'text', text: 'SLIDES' },
    ]);
  });
});

function scene(id: string, order: number, units: string[], text = 'نص'): AppScene {
  return {
    id,
    stageId: 'stage-1',
    title: `شريحة ${order}`,
    order,
    type: 'slide',
    sourceContentUnitIds: units,
    content: {
      type: 'slide',
      contentRole: 'explanation',
      canvas: { elements: [{ id: 'e', type: 'text', content: `<p>${text}</p>` }] },
    },
    actions: [{ id: 'a', type: 'speech', text: 'شرح' }],
  } as unknown as AppScene;
}

const FIG_A: ReviewFigure = {
  name: 'src_1',
  unitIds: ['6758'],
  pageNumber: 12,
  mediaType: 'image/jpeg',
  data: 'AAAA',
  tokens: 255,
};
const FIG_B: ReviewFigure = { ...FIG_A, name: 'src_2', unitIds: ['6760'], data: 'BBBB' };

describe('RV-1: callPackageReviewer sends the figures on g5.v12 only', () => {
  const review = {
    id: 'review-1',
    attemptId: 'attempt-1',
    versionId: 'version-1',
    tenantId: 'tenant-1',
    subjectCode: 'CHEMISTRY',
    learningItem: { type: 'lesson', id: '227' },
  };

  async function call(version: string, request: Partial<ReviewCallRequest> = {}) {
    mocks.readAttemptById.mockResolvedValue({
      teachingModel: { key: 'g5', version },
      inputSnapshot: {},
    });
    mocks.readContentUnitsForAttempt.mockResolvedValue([]);
    mocks.runReviewerCall.mockReset().mockResolvedValue({
      parsed: { summary: 's', findings: [] },
      provider: 'anthropic',
      modelString: 'anthropic:claude-opus-5-5',
      attemptIds: [],
      usage: null,
      switched: null,
    });
    await callPackageReviewer({
      review: review as never,
      units: [{ id: '6758', title: null, role: null, text: 'x' }],
      slides: [],
      pool: {} as never,
      figures: [FIG_A, FIG_B],
      ...request,
    });
    return mocks.runReviewerCall.mock.calls.at(-1)![0] as {
      system: string;
      images?: Array<{ label: string; data: string; mediaType: string }>;
    };
  }

  it('g5.v12: its rubric, and each figure after its label (the heading on the first)', async () => {
    const sent = await call('g5.v12', { figuresIncomplete: true });
    expect(sent.system).toBe(PACKAGE_REVIEW_SYSTEM_V12);
    expect(sent.images).toEqual([
      {
        label: `${BOOK_FIGURES_HEADING}\n${BOOK_FIGURES_INCOMPLETE_NOTE}\n<<BOOK FIGURE src_1 | unit_id=6758 | page=12>>`,
        data: 'AAAA',
        mediaType: 'image/jpeg',
      },
      {
        label: '<<BOOK FIGURE src_2 | unit_id=6760 | page=12>>',
        data: 'BBBB',
        mediaType: 'image/jpeg',
      },
    ]);
  });

  it('g5.v11: the v11 rubric and no image, even when figures are passed', async () => {
    const sent = await call('g5.v11');
    expect(sent.system).toBe(PACKAGE_REVIEW_SYSTEM_V11);
    expect(sent.images).toBeUndefined();
  });
});

describe('RV-1 + RV-4: the review job', () => {
  const SCENES = [scene('s1', 1, ['6758']), scene('s2', 2, ['6760']), scene('s3', 3, ['6799'])];
  const CLAIMED: PackageReview = {
    id: 'review-1',
    tenantId: 'tenant-1',
    learningItem: { type: 'lesson', id: '227' },
    versionId: 'version-1',
    attemptId: 'attempt-1',
    stageId: 'stage-1',
    subjectCode: 'CHEMISTRY',
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
  const HIGH_ON_S2 = {
    targetId: 's2',
    check: 'S3',
    severity: 'high',
    bookEvidence: { quote: '[الشكل src_2] 25 °C', unitId: '6760' },
    whatIsWrong: 'الشريحة تقول 30 والشكل يقول 25',
    fixNote: 'اكتب 25',
  };

  const TEXT_HIGH_ON_S2 = {
    ...HIGH_ON_S2,
    bookEvidence: { quote: 'درجة الغليان 25', unitId: '6760' },
  };

  function job(
    version: string,
    claimed: Partial<PackageReview> = {},
    figureSet: ReviewFigureSet | Error = { figures: [FIG_A, FIG_B], unreadable: [] },
    options: {
      firstFindings?: Array<Record<string, unknown>>;
      /** The provider refuses every request that carries figures. */
      refuseFigures?: boolean;
      refusal?: 'request_rejected' | 'safety_refused';
      /** A-34: the Stage revision at the end of the run (absent: unreadable). */
      stageRev?: number;
      /** MEDIUM-2: the live slides at the run's start (absent: `SCENES`). */
      startScenes?: AppScene[];
      /** A-34: the live slides at the end of the run (absent: as they were at its start). */
      finalScenes?: AppScene[];
    } = {},
  ) {
    mocks.readAttemptById.mockReset().mockResolvedValue({
      teachingModel: { key: 'g5', version },
      inputSnapshot: {},
    });
    mocks.readContentUnitsForAttempt.mockReset().mockResolvedValue([
      { unitId: '6758', normalizedText: 'نص 6758', role: 'concept', title: null },
      { unitId: '6760', normalizedText: 'نص 6760', role: 'concept', title: null },
      { unitId: '6799', normalizedText: 'نص 6799', role: 'concept', title: null },
    ]);
    mocks.readVersionById.mockResolvedValue({
      id: 'version-1',
      tenantId: 'tenant-1',
      status: 'draft',
      currentStageId: 'stage-1',
    });
    mocks.claimReview.mockResolvedValue({ ...CLAIMED, ...claimed });
    mocks.renewReviewLease.mockResolvedValue(true);
    mocks.saveReviewProgress.mockReset().mockResolvedValue(true);
    mocks.sumReviewSpend.mockResolvedValue({ rows: 0 });
    mocks.enqueueWebhookEvent.mockResolvedValue(undefined);
    mocks.finishReview
      .mockReset()
      .mockImplementation(async (_tx: unknown, _id: string, _worker: string, outcome: object) => ({
        ...CLAIMED,
        ...outcome,
      }));
    const requests: ReviewCallRequest[] = [];
    const callReviewer = vi.fn(async (request: ReviewCallRequest) => {
      requests.push(request);
      if (options.refuseFigures && request.figures?.length) {
        throw new TeachingModelUnavailableError('rejected', {
          attemptIds: [],
          outcomes:
            options.refusal === 'safety_refused'
              ? [
                  { role: 'primary', outcome: 'safety_refused' },
                  { role: 'fallback', outcome: 'safety_refused' },
                ]
              : [{ role: 'primary', outcome: 'request_rejected' }],
          retryable: false,
        });
      }
      // The first review reports a HIGH error on s2; the re-check of s2 is clean.
      return {
        answer: {
          summary: 's',
          findings: request.focusIds ? [] : (options.firstFindings ?? [HIGH_ON_S2]),
        },
        call: {
          provider: 'anthropic' as const,
          modelString: 'anthropic:claude-opus-5-5',
          usage: null,
        },
      };
    });
    const FIXED = scene('s2', 2, ['6760'], 'مصحح');
    const regenerated: string[] = [];
    const fixLoop = createPackageReviewFixLoop({
      regenerate: (async (_grant: unknown, sceneId: string) => {
        regenerated.push(sceneId);
        return {
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
        };
      }) as never,
      regenerateAudio: (async (_grant: unknown, sceneId: string) => ({
        sceneId,
        scene: FIXED,
        rev: 3,
        generated: 1,
        missing: 0,
      })) as never,
      restore: (async () => ({ scene: SCENES[1]! })) as never,
      readVersion: (async () => ({
        id: 'version-1',
        tenantId: 'tenant-1',
        status: 'draft',
        currentStageId: 'stage-1',
      })) as never,
      readScene: async (_pool, _stage, sceneId) => {
        const found = SCENES.find((candidate) => candidate.id === sceneId);
        return found ? { rev: 1, scene: found } : null;
      },
    });
    const loadFigures = vi.fn(async () => {
      if (figureSet instanceof Error) throw figureSet;
      return figureSet;
    });
    let sceneLoads = 0;
    const run = () =>
      runPackageReview('review-1', {
        pool: {} as never,
        now: () => 5,
        workerId: 'w',
        callReviewer: callReviewer as never,
        fixLoop,
        // The run's read at its start, then A-34's read at its end.
        loadScenes: async () =>
          sceneLoads++ === 0
            ? (options.startScenes ?? SCENES)
            : (options.finalScenes ?? options.startScenes ?? SCENES),
        loadFigures,
        ...(options.stageRev !== undefined
          ? { readStageRev: async () => options.stageRev! }
          : { readStageRev: async () => Promise.reject(new Error('no revision')) }),
      });
    return { run, requests, loadFigures, regenerated };
  }

  const firstSave = () =>
    (mocks.saveReviewProgress.mock.calls[0] as unknown as [unknown, string, string, object])[3];

  it('g5.v12: the first review sees every judged figure, a re-check only its slide’s; the HIGH finding closes', async () => {
    const { run, requests, loadFigures } = job('g5.v12');
    const finished = await run();
    // Every book figure of the Stage, whichever unit owns it.
    expect(loadFigures).toHaveBeenCalledWith({}, 'stage-1', null);
    expect(requests.map((request) => (request.figures ?? []).map((figure) => figure.name))).toEqual(
      [['src_1', 'src_2'], ['src_2']],
    );
    // The re-check wants the figure its finding was read from.
    expect(requests[1]!.alsoFigures).toEqual(['src_2']);
    expect(firstSave()).toMatchObject({ bookTruncated: false });
    expect(finished).toMatchObject({
      status: 'fixed',
      findings: [{ id: 'f1', status: 'fixed', teacherReason: null }],
      fixes: [{ sceneId: 's2', outcome: 'fixed', code: null }],
    });
  });

  it('g5.v12: a provider that refuses the figures is asked once more without them; never unavailable', async () => {
    const { run, requests } = job('g5.v12', {}, undefined, { refuseFigures: true });
    const finished = await run();
    // First call refused with its figures, asked again without; the re-check likewise.
    expect(requests.map((request) => (request.figures ?? []).length)).toEqual([2, 0, 1, 0]);
    // The first review did not see the figures: the D-8 flag is set.
    expect(firstSave()).toMatchObject({ bookTruncated: true });
    // The re-check did not see src_2, which the finding was read from: it stays open,
    // and no Regenerate press retries it (the provider would refuse it again).
    expect(finished).toMatchObject({
      status: 'needs_teacher',
      findings: [{ id: 'f1', status: 'open', teacherReason: 'REREVIEW_UNAVAILABLE' }],
      fixes: [{ sceneId: 's2', outcome: 'still_wrong', code: REREVIEW_FIGURES_HELD }],
    });
    expect(finished!.fixes[0]!.retryForFigures).toBeUndefined();
  });

  it('g5.v12: a figure no call may send (over 2000 px) holds nothing; its finding closes', async () => {
    const { run, requests } = job(
      'g5.v12',
      {},
      { figures: [FIG_A], unreadable: [], unsendable: [{ name: 'src_2', unitIds: ['6760'] }] },
    );
    const finished = await run();
    expect(requests[1]!.figures).toBeUndefined();
    expect(finished).toMatchObject({
      status: 'fixed',
      findings: [{ id: 'f1', status: 'fixed' }],
    });
  });

  it('g5.v12: figures that cannot be listed at all keep a figure-read finding open, never retried', async () => {
    const failed = new Error('the stage outline could not be read');
    const fromFigure = job('g5.v12', {}, failed);
    const held = await fromFigure.run();
    expect(fromFigure.loadFigures).toHaveBeenCalledTimes(1);
    expect(held).toMatchObject({
      status: 'needs_teacher',
      findings: [{ id: 'f1', status: 'open', teacherReason: 'REREVIEW_UNAVAILABLE' }],
      fixes: [{ code: REREVIEW_FIGURES_HELD }],
    });
    expect(held!.fixes[0]!.retryForFigures).toBeUndefined();
    // The first review saw no figure at all: the D-8 flag says so.
    expect(firstSave()).toMatchObject({ bookTruncated: true });
    // A finding read from the text still closes; the review is never `unavailable`.
    const fromText = job('g5.v12', {}, failed, { firstFindings: [TEXT_HIGH_ON_S2] });
    expect(await fromText.run()).toMatchObject({ status: 'fixed' });
  });

  it('g5.v12: a safety decline over the figures is asked once more without them, too', async () => {
    const { run, requests } = job('g5.v12', {}, undefined, {
      refuseFigures: true,
      refusal: 'safety_refused',
    });
    const finished = await run();
    expect(requests.map((request) => (request.figures ?? []).length)).toEqual([2, 0, 1, 0]);
    expect(finished?.status).toBe('needs_teacher');
  });

  it('g5.v12: a figure a finding names is wanted whichever unit owns it; an unknown one waits', async () => {
    const FIG_C: ReviewFigure = { ...FIG_A, name: 'src_3', unitIds: ['9999'], data: 'CCCC' };
    const otherUnit = {
      ...HIGH_ON_S2,
      bookEvidence: { quote: '[الشكل src_3] 40', unitId: '9999' },
    };
    const owned = job(
      'g5.v12',
      {},
      { figures: [FIG_A, FIG_B, FIG_C], unreadable: [] },
      {
        firstFindings: [otherUnit],
      },
    );
    expect(await owned.run()).toMatchObject({ status: 'fixed' });
    expect((owned.requests[1]!.figures ?? []).map((figure) => figure.name)).toEqual([
      'src_2',
      'src_3',
    ]);
    // A name the Stage does not hold was never seen: the finding waits, never retried.
    const unknown = { ...HIGH_ON_S2, bookEvidence: { quote: '[الشكل src_99] 40', unitId: null } };
    const missing = job('g5.v12', {}, undefined, { firstFindings: [unknown] });
    const held = await missing.run();
    expect(held).toMatchObject({
      status: 'needs_teacher',
      findings: [{ id: 'f1', status: 'open', teacherReason: 'REREVIEW_UNAVAILABLE' }],
    });
    expect(held!.fixes[0]!.retryForFigures).toBeUndefined();
  });

  it('g5.v12: a slide whose re-check this run can no longer show its figures is not paid for', async () => {
    // 32,000 tokens each: the first call (its 40,000 share of 60,000) sends src_1 only,
    // leaving 28,000 -- too few for either slide's re-check.
    const big = (figure: ReviewFigure) => ({ ...figure, tokens: 32_000 });
    const onS1 = {
      ...TEXT_HIGH_ON_S2,
      targetId: 's1',
      bookEvidence: { quote: 'x', unitId: '6758' },
    };
    const { run, requests, regenerated } = job(
      'g5.v12',
      {},
      { figures: [big(FIG_A), big(FIG_B)], unreadable: [] },
      { firstFindings: [onS1, TEXT_HIGH_ON_S2] },
    );
    const finished = await run();
    expect(requests).toHaveLength(1);
    expect(regenerated).toEqual([]);
    // Never attempted: the next Regenerate press (a fresh run, with its own budget) takes them.
    expect(finished).toMatchObject({
      status: 'needs_teacher',
      findings: [
        { id: 'f1', status: 'open', teacherReason: 'NOT_ATTEMPTED' },
        { id: 'f2', status: 'open', teacherReason: 'NOT_ATTEMPTED' },
      ],
      fixes: [
        { sceneId: 's1', outcome: 'stopped', code: REREVIEW_FIGURES_HELD },
        { sceneId: 's2', outcome: 'stopped', code: REREVIEW_FIGURES_HELD },
      ],
    });
  });

  it('g5.v12, a resumed run: no figure is sent, and nothing is paid for a slide that needs one', async () => {
    const { run, requests, loadFigures, regenerated } = job('g5.v12', {
      runAttempts: 2,
      reviewedAt: 4,
      findings: [
        {
          id: 'f1',
          ...HIGH_ON_S2,
          targetTitle: 'شريحة 2',
          targetOrder: 2,
          status: 'open',
          teacherReason: null,
        } as never,
      ],
    });
    const finished = await run();
    expect(loadFigures).toHaveBeenCalledWith(expect.anything(), 'stage-1', null);
    // No first call (stored), no regeneration, no re-check: nothing is paid.
    expect(requests).toHaveLength(0);
    expect(regenerated).toEqual([]);
    // The next Regenerate press (a fresh first run) takes it.
    expect(finished).toMatchObject({
      status: 'needs_teacher',
      findings: [{ id: 'f1', status: 'open', teacherReason: 'NOT_ATTEMPTED' }],
      fixes: [{ sceneId: 's2', outcome: 'stopped', code: REREVIEW_FIGURES_HELD }],
    });
  });

  it('a curable hold after a paid re-check (W2’s second check, say) is retried by the next press', () => {
    const finding = {
      id: 'f1',
      targetId: 's2',
      targetTitle: 'شريحة 2',
      targetOrder: 2,
      check: 'S3',
      severity: 'high',
      bookEvidence: { quote: 'x', unitId: '6760' },
      whatIsWrong: 'w',
      fixNote: 'n',
      status: 'open',
      teacherReason: 'REREVIEW_UNAVAILABLE',
    } as StoredFinding;
    const seed = seedRefixFindings([finding], reviewSlidesOf(SCENES), new Map(), [
      {
        sceneId: 's2',
        findingIds: ['f1'],
        outcome: 'still_wrong',
        code: REREVIEW_FIGURES_HELD,
        retryForFigures: ['f1'],
      },
    ]);
    expect(seed.findings[0]!.teacherReason).toBeNull();
  });

  it('g5.v12: an unreadable figure reviews from text; only a finding read from it waits', async () => {
    const unreadable: ReviewFigureSet = {
      figures: [],
      unreadable: [{ name: 'src_2', unitIds: ['6760'] }],
    };
    // A finding read from the unreadable figure cannot be closed without it.
    const fromFigure = job('g5.v12', {}, unreadable);
    const held = await fromFigure.run();
    expect(fromFigure.requests.every((request) => request.figures === undefined)).toBe(true);
    expect(firstSave()).toMatchObject({ bookTruncated: true });
    expect(held).toMatchObject({
      status: 'needs_teacher',
      findings: [{ id: 'f1', status: 'open', teacherReason: 'REREVIEW_UNAVAILABLE' }],
    });
    // A finding read from the text closes on its re-check; never `unavailable`.
    const fromText = job('g5.v12', {}, unreadable, { firstFindings: [TEXT_HIGH_ON_S2] });
    expect(await fromText.run()).toMatchObject({
      status: 'fixed',
      findings: [{ id: 'f1', status: 'fixed' }],
    });
  });

  it('a flagged-slide regeneration re-checks a curable figure hold and a failed re-check, never an unread figure', () => {
    const open = (id: string, reason: string) =>
      ({
        id,
        targetId: 's2',
        targetTitle: 'شريحة 2',
        targetOrder: 2,
        check: 'S3',
        severity: 'high',
        bookEvidence: { quote: '[الشكل src_2] 25', unitId: '6760' },
        whatIsWrong: 'w',
        fixNote: 'n',
        status: 'open',
        teacherReason: reason,
      }) as StoredFinding;
    const seed = seedRefixFindings(
      [
        open('f1', 'REREVIEW_UNAVAILABLE'),
        { ...open('f2', 'REREVIEW_UNAVAILABLE'), check: 'S1' },
        { ...open('f3', 'REREVIEW_UNAVAILABLE'), check: 'S4' },
      ],
      reviewSlidesOf(SCENES),
      new Map(),
      [
        {
          sceneId: 's2',
          findingIds: ['f1', 'f2'],
          outcome: 'still_wrong',
          code: REREVIEW_FIGURES_HELD,
          // f1's hold was curable (the run's budget); f2's was not (an unread figure).
          retryForFigures: ['f1'],
        },
        { sceneId: 's2', findingIds: ['f3'], outcome: 'still_wrong', code: 'REREVIEW_UNAVAILABLE' },
      ],
    );
    // A row from before `heldFor` (review 27 Nov 2026): f3 (its re-check call failed, no
    // audio code) is re-checked only; f1 (a curable figure hold, whose code hid any audio
    // failure) is regenerated, its audio with it; f2 (an unread figure) waits.
    expect(
      seed.findings.map((finding) => [finding.id, finding.teacherReason, finding.recheckOnly]),
    ).toEqual([
      ['f1', null, undefined],
      ['f2', 'REREVIEW_UNAVAILABLE', undefined],
      ['f3', null, true],
    ]);
    expect(seed.sceneIds).toEqual(['s2']);
  });

  it('a held finding is re-checked once its slide is edited; a legacy audio code is regenerated', () => {
    const open = (id: string, extra: Partial<StoredFinding>) =>
      ({
        id,
        targetId: 's2',
        targetTitle: 'شريحة 2',
        targetOrder: 2,
        check: 'S3',
        severity: 'high',
        bookEvidence: { quote: '[الشكل src_2] 25', unitId: '6760' },
        whatIsWrong: 'w',
        fixNote: 'n',
        status: 'open',
        teacherReason: 'REREVIEW_UNAVAILABLE',
        sceneDigest: 'reviewed',
        ...extra,
      }) as StoredFinding;
    const findings = [
      open('p1', { heldFor: 'person' }),
      open('r1', { heldFor: 'recheck', check: 'S1' }),
      open('n1', { teacherReason: 'STILL_WRONG', check: 'S4' }),
    ];
    const slides = reviewSlidesOf(SCENES);
    // Not edited: the person hold waits, the curable one is re-checked.
    const asReviewed = seedRefixFindings(findings, slides, new Map([['s2', 'reviewed']]));
    expect(
      asReviewed.findings.map((finding) => [
        finding.id,
        finding.teacherReason,
        finding.recheckOnly,
      ]),
    ).toEqual([
      ['p1', 'REREVIEW_UNAVAILABLE', undefined],
      ['r1', null, true],
      ['n1', null, undefined],
    ]);
    // A person edited s2: every finding of it is re-checked as the person made it, in one
    // re-check, never regenerated (review H-2: the one that would regenerate too).
    const edited = seedRefixFindings(findings, slides, new Map([['s2', 'edited']]));
    expect(
      edited.findings.map((finding) => [finding.id, finding.teacherReason, finding.recheckOnly]),
    ).toEqual([
      ['p1', null, true],
      ['r1', null, true],
      ['n1', null, true],
    ]);
    // A row from before `heldFor` whose audio failed with any code: regenerated.
    const legacy = seedRefixFindings([open('a1', { sceneDigest: undefined })], slides, new Map(), [
      { sceneId: 's2', findingIds: ['a1'], outcome: 'still_wrong', code: 'ABORTED' },
    ]);
    expect(legacy.findings[0]).toMatchObject({ id: 'a1', teacherReason: null });
    expect(legacy.findings[0]!.recheckOnly).toBeUndefined();
  });

  it('dead end (a): a stage review reads its producing attempt, and its event names that attempt', async () => {
    const { run, regenerated } = job('g5.v11', { attemptId: 'attempt-1#stage:stage-1' });
    const finished = await run();
    // Review 27 Nov 2026: a Stage review only reviews -- the teacher's edit is never
    // regenerated in that run; its finding waits for the next press.
    expect(finished?.status).toBe('needs_teacher');
    expect(regenerated).toEqual([]);
    expect(finished?.findings).toMatchObject([{ id: 'f1', teacherReason: 'NOT_ATTEMPTED' }]);
    expect(mocks.readAttemptById).toHaveBeenCalledWith(expect.anything(), 'attempt-1');
    expect(mocks.readAttemptById).not.toHaveBeenCalledWith(
      expect.anything(),
      'attempt-1#stage:stage-1',
    );
    expect(mocks.readContentUnitsForAttempt).toHaveBeenCalledWith(
      expect.anything(),
      'attempt-1',
      expect.anything(),
    );
    const [, , type, payload] = mocks.enqueueWebhookEvent.mock.calls.at(-1) as unknown as [
      unknown,
      unknown,
      string,
      () => { review: { attemptId: string } },
    ];
    expect(type).toBe('teaching_package.review_completed');
    expect(payload().review.attemptId).toBe('attempt-1');
  });

  it('dead end (c): a first answer a press re-asked only reviews; a resume regenerates nothing either', async () => {
    const { run, regenerated } = job('g5.v11', {
      id: refixReviewId('tenant-1', 'version-1', 'a-key'),
      reviewedAt: null,
    });
    const finished = await run();
    expect(finished?.status).toBe('needs_teacher');
    expect(regenerated).toEqual([]);
    // The stored first answer already says it is the teacher's.
    expect(firstSave()).toMatchObject({
      findings: [expect.objectContaining({ id: 'f1', teacherReason: 'NOT_ATTEMPTED' })],
    });
  });

  /** Page images (contract 27 Nov 2026): whole pages, each naming the crops it holds. */
  const pageFig = (n: number, units: string[], covers: string[], tokens = 2_317): ReviewFigure => ({
    name: `page_${n}`,
    unitIds: units,
    pageNumber: n,
    mediaType: 'image/jpeg',
    data: `PAGE${n}`,
    tokens,
    kind: 'page',
    covers,
  });
  const PAGES: ReviewFigureSet = {
    figures: [
      pageFig(12, ['6758'], ['src_1']),
      pageFig(13, ['6760'], ['src_2']),
      // A page no slide cites (its unit is not taught): the first review sees it all the same.
      pageFig(14, [], []),
    ],
    unreadable: [],
  };

  it('page images, g5.v12: the first review gets the lesson’s pages; the re-check its slide’s', async () => {
    const { run, requests } = job('g5.v12', {}, PAGES);
    const finished = await run();
    expect(requests.map((request) => (request.figures ?? []).map((figure) => figure.name))).toEqual(
      [['page_12', 'page_13', 'page_14'], ['page_13']],
    );
    // The finding was read from «[الشكل src_2]»: page 13 holds it, so the re-check saw it.
    expect(finished).toMatchObject({ status: 'fixed', findings: [{ id: 'f1', status: 'fixed' }] });
    expect(firstSave()).toMatchObject({ bookTruncated: false });
  });

  it('page images: the pages open with their own heading, each labelled with its crops', async () => {
    mocks.readAttemptById.mockResolvedValue({
      teachingModel: { key: 'g5', version: 'g5.v12' },
      inputSnapshot: {},
    });
    mocks.readContentUnitsForAttempt.mockResolvedValue([]);
    mocks.runReviewerCall.mockReset().mockResolvedValue({
      parsed: { summary: 's', findings: [] },
      provider: 'anthropic',
      modelString: 'anthropic:claude-opus-5-5',
      attemptIds: [],
      usage: null,
      switched: null,
    });
    await callPackageReviewer({
      review: CLAIMED,
      units: [{ id: '6758', title: null, role: null, text: 'x' }],
      slides: [],
      pool: {} as never,
      figures: [PAGES.figures[0]!, { ...FIG_B, pageNumber: 20 }],
    });
    const sent = mocks.runReviewerCall.mock.calls.at(-1)![0] as {
      images: Array<{ label: string }>;
    };
    expect(sent.images.map((image) => image.label)).toEqual([
      `${BOOK_PAGES_HEADING}\n<<BOOK PAGE 12 | unit_id=6758 | figures=src_1>>`,
      // A crop whose page is not shown whole follows as a BOOK FIGURE.
      '<<BOOK FIGURE src_2 | unit_id=6760 | page=20>>',
    ]);
  });

  it('page images: the hard ceiling -- never more than 60,000 image tokens in one run, 40,000 in its first call', async () => {
    // 30 pages of 1568 px: more than any run may send.
    const many: ReviewFigureSet = {
      figures: Array.from({ length: 30 }, (_, n) =>
        pageFig(n + 1, [['6758', '6760', '6799'][n % 3]!], []),
      ),
      unreadable: [],
    };
    const { run, requests } = job('g5.v12', {}, many, { firstFindings: [TEXT_HIGH_ON_S2] });
    await run();
    const tokensOf = (request: ReviewCallRequest) =>
      (request.figures ?? []).reduce((sum, figure) => sum + figure.tokens, 0);
    expect(tokensOf(requests[0]!)).toBeLessThanOrEqual(40_000);
    expect(requests[0]!.figures).toHaveLength(17);
    expect(requests.reduce((sum, request) => sum + tokensOf(request), 0)).toBeLessThanOrEqual(
      REVIEW_IMAGE_MAX_TOKENS_PER_RUN,
    );
    // Worst case: every image token paid on both attempts, at today's highest rate.
    expect(
      REVIEW_IMAGE_MAX_TOKENS_PER_RUN *
        reviewerImageTokenPriceUsd() *
        REVIEW_IMAGE_ATTEMPTS_PER_CALL,
    ).toBeLessThanOrEqual(0.6 + 1e-12);
    // The first review did not see every page: the D-8 flag says so.
    expect(firstSave()).toMatchObject({ bookTruncated: true });
  });

  it('page images: a whole measured lesson fits the first call (214: 8 pages; 226: 4; 227: 6)', async () => {
    const eight: ReviewFigureSet = {
      figures: Array.from({ length: 8 }, (_, n) =>
        // 1216×1568, the widest measured page: 2,542 tokens each.
        pageFig(n + 1, [['6758', '6760', '6799'][n % 3]!], [], 2_542),
      ),
      unreadable: [],
    };
    const { run, requests } = job('g5.v12', {}, eight, { firstFindings: [TEXT_HIGH_ON_S2] });
    await run();
    expect(requests[0]!.figures).toHaveLength(8);
    expect(firstSave()).toMatchObject({ bookTruncated: false });
    // The rubric says which page number a finding names: the label's, never the printed one.
    expect(PACKAGE_REVIEW_SYSTEM_V12).toContain(
      "N is the number in that page's BOOK PAGE label, never the page number printed on the page",
    );
  });

  it('A-34: a finished review records the Stage revision it saw, its own fixes included', async () => {
    // No finding: the Stage is exactly what the review read.
    const clean = job('g5.v11', {}, undefined, { firstFindings: [], stageRev: 7 });
    expect(await clean.run()).toMatchObject({ status: 'passed', reviewedStageRev: 7 });
    // The fix loop regenerated s2: the Stage holds that fix, which the review re-checked.
    const FIXED = scene('s2', 2, ['6760'], 'مصحح');
    const fixed = job('g5.v11', {}, undefined, {
      stageRev: 9,
      finalScenes: [SCENES[0]!, FIXED, SCENES[2]!],
    });
    expect(await fixed.run()).toMatchObject({ status: 'fixed', reviewedStageRev: 9 });
  });

  it('A-34b: a layout-only change under the run (an auto-height pass) still stamps the verdict', async () => {
    const resized = {
      ...SCENES[0]!,
      content: {
        ...(SCENES[0]!.content as object),
        canvas: {
          elements: [{ id: 'e', type: 'text', content: '<p>نص</p>', height: 99, top: 40 }],
        },
      },
    } as AppScene;
    const finished = await job('g5.v11', {}, undefined, {
      firstFindings: [],
      stageRev: 8,
      finalScenes: [resized, SCENES[1]!, SCENES[2]!],
    }).run();
    expect(finished).toMatchObject({
      status: 'passed',
      reviewedStageRev: 8,
      reviewedStageDigest: reviewInputDigest(SCENES),
    });
  });

  describe('MEDIUM-2: a run that did not ask for the first answer stamps only from a reviewed start', () => {
    // A slide no finding is on: the fix loop never handles it, so only the baseline sees it.
    const edited = [SCENES[0]!, SCENES[1]!, scene('s3', 3, ['6799'], 'عدّله المعلم')];
    // The stored first answer (or the last verdict) read SCENES.
    const after = { reviewedAt: 4, reviewBaseline: reviewBaselineOf(SCENES) };

    it('a resume whose slides are the ones the first answer read: stamped', async () => {
      const resumed = job('g5.v11', { ...after, runAttempts: 2 }, undefined, { stageRev: 5 });
      expect(await resumed.run()).toMatchObject({ status: 'passed', reviewedStageRev: 5 });
    });

    it('an edit between the first answer and the resume: no stamp (stale)', async () => {
      const resumed = job('g5.v11', { ...after, runAttempts: 2 }, undefined, {
        stageRev: 5,
        startScenes: edited,
      });
      expect(await resumed.run()).toMatchObject({
        status: 'passed',
        reviewedStageRev: null,
        reviewedStageDigest: null,
      });
    });

    it('an edit between the press and the sweep: no stamp (stale)', async () => {
      // The press kept the verdict's baseline through the requeue; the sweep's run starts
      // on an edit made since.
      const flagged = job('g5.v11', { ...after, id: 'tpr-flagged', fixes: [] }, undefined, {
        stageRev: 6,
        startScenes: edited,
      });
      expect(await flagged.run()).toMatchObject({ reviewedStageRev: null });
    });

    it('a resume after the evicted run rewrote a slide: that slide is its own; the rest must match', async () => {
      const FIXED = scene('s2', 2, ['6760'], 'مصحح');
      const rewritten = [SCENES[0]!, FIXED, SCENES[2]!];
      const fix = {
        sceneId: 's2',
        findingIds: [],
        outcome: 'fixed' as const,
        code: null,
        regenerationId: 'tpsr-s2',
      };
      // The evicted run closed its finding and recorded the slide as its fix left it.
      const closed = {
        id: 'f1',
        ...HIGH_ON_S2,
        targetTitle: 'شريحة 2',
        targetOrder: 2,
        status: 'fixed' as const,
        teacherReason: null,
        sceneDigest: sceneEditDigest(FIXED),
      } as StoredFinding;
      const resumedWith = (startScenes: AppScene[]) =>
        job('g5.v11', { ...after, runAttempts: 2, fixes: [fix], findings: [closed] }, undefined, {
          stageRev: 7,
          startScenes,
        }).run();
      expect(await resumedWith(rewritten)).toMatchObject({ reviewedStageRev: 7 });
      // Another slide edited meanwhile: no stamp.
      expect(await resumedWith([SCENES[0]!, FIXED, edited[2]!])).toMatchObject({
        reviewedStageRev: null,
      });
      // Review of 9009dfc4 (LOW-B): the rewritten slide itself edited after its fix: no stamp.
      const editedAfterFix = scene('s2', 2, ['6760'], 'مصحح ثم عدّله المعلم');
      expect(await resumedWith([SCENES[0]!, editedAfterFix, SCENES[2]!])).toMatchObject({
        reviewedStageRev: null,
      });
    });

    it('a row from before A-34 (no baseline): no stamp', async () => {
      const legacy = job('g5.v11', { reviewedAt: 4, runAttempts: 2 }, undefined, { stageRev: 5 });
      expect(await legacy.run()).toMatchObject({ reviewedStageRev: null });
    });

    it('the first answer stores the baseline it read; the stamped verdict keeps the one it read', async () => {
      const first = job('g5.v11', {}, undefined, { firstFindings: [], stageRev: 3 });
      const finished = await first.run();
      expect(firstSave()).toMatchObject({ reviewBaseline: reviewBaselineOf(SCENES) });
      expect(finished).toMatchObject({ reviewBaseline: reviewBaselineOf(SCENES) });
    });
  });

  it('A-34: a slide changed under the run, or an unreadable revision: no revision (stale)', async () => {
    const edited = scene('s1', 1, ['6758'], 'عدّله المعلم');
    const under = job('g5.v11', {}, undefined, {
      firstFindings: [],
      stageRev: 7,
      finalScenes: [edited, SCENES[1]!, SCENES[2]!],
    });
    expect(await under.run()).toMatchObject({ status: 'passed', reviewedStageRev: null });
    // A slide added, or the fix loop's slide not what the Stage holds: none either.
    const added = job('g5.v11', {}, undefined, {
      firstFindings: [],
      stageRev: 7,
      finalScenes: [...SCENES, scene('s4', 4, ['6799'])],
    });
    expect(await added.run()).toMatchObject({ reviewedStageRev: null });
    const notTheFix = job('g5.v11', {}, undefined, { stageRev: 9 });
    expect(await notTheFix.run()).toMatchObject({ status: 'fixed', reviewedStageRev: null });
    const unreadable = job('g5.v11', {}, undefined, { firstFindings: [] });
    expect(await unreadable.run()).toMatchObject({ status: 'passed', reviewedStageRev: null });
  });

  it('page images, g5.v11: nothing is read or sent even when the Stage has pages', async () => {
    const { run, requests, loadFigures } = job('g5.v11', {}, PAGES);
    await run();
    expect(loadFigures).not.toHaveBeenCalled();
    expect(requests.every((request) => !('figures' in request))).toBe(true);
  });

  it('g5.v11: no figure is read or sent, and the review runs exactly as before', async () => {
    const { run, requests, loadFigures } = job('g5.v11');
    const finished = await run();
    expect(loadFigures).not.toHaveBeenCalled();
    expect(requests.every((request) => !('figures' in request))).toBe(true);
    expect(finished?.status).toBe('fixed');
  });
});
