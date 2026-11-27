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
  judgedUnitIds,
  loadReviewFigures,
  namedFigures,
  pickReviewFigures,
  reviewSlidesOf,
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
  PACKAGE_REVIEW_SYSTEM,
  PACKAGE_REVIEW_SYSTEM_V2,
  PACKAGE_REVIEW_SYSTEM_V11,
  PACKAGE_REVIEW_SYSTEM_V12,
} from '@/lib/server/teaching-package/package-review-prompt';
import type {
  PackageReview,
  StoredFinding,
} from '@/lib/server/teaching-package/package-review-store';
import { seedRefixFindings } from '@/lib/server/teaching-package/package-review-refix';
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
    expect(budget).toBe(30_000);
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
    expect(set.unreadable).toEqual([{ name: 'src_3', unitIds: ['6758'] }]);
    expect(set.unsendable).toEqual([{ name: 'src_4', unitIds: ['6760'] }]);
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

  it('a run that may send nothing lists the figures without reading a file', async () => {
    const read = vi.fn(async () => 'data:image/png;base64,AAAA');
    const set = await loadReviewFigures(
      [entry(1, ['u'])],
      new Set(['u']),
      { withBytes: false },
      read as never,
    );
    expect(read).not.toHaveBeenCalled();
    expect(set.figures).toMatchObject([{ name: 'src_1', data: '' }]);
    // A figure without its bytes is never sent, whatever the cap.
    expect(pickReviewFigures(set, new Set(['u']), 10_000)).toMatchObject({
      figures: [],
      evidence: { sent: [], held: ['src_1'], unreadable: [] },
    });
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
          outcomes: [{ role: 'primary', outcome: 'request_rejected' }],
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
    const fixLoop = createPackageReviewFixLoop({
      regenerate: (async (_grant: unknown, sceneId: string) => ({
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
      })) as never,
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
    const run = () =>
      runPackageReview('review-1', {
        pool: {} as never,
        now: () => 5,
        workerId: 'w',
        callReviewer: callReviewer as never,
        fixLoop,
        loadScenes: async () => SCENES,
        loadFigures,
      });
    return { run, requests, loadFigures };
  }

  const firstSave = () =>
    (mocks.saveReviewProgress.mock.calls[0] as unknown as [unknown, string, string, object])[3];

  it('g5.v12: the first review sees every judged figure, a re-check only its slide’s; the HIGH finding closes', async () => {
    const { run, requests, loadFigures } = job('g5.v12');
    const finished = await run();
    expect(loadFigures).toHaveBeenCalledWith({}, 'stage-1', new Set(['6758', '6760', '6799']), {
      withBytes: true,
    });
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
    // A finding read from the text still closes; the review is never `unavailable`.
    const fromText = job('g5.v12', {}, failed, { firstFindings: [TEXT_HIGH_ON_S2] });
    expect(await fromText.run()).toMatchObject({ status: 'fixed' });
  });

  it('g5.v12, a resumed run: no figure is read or sent, and its re-check closes no HIGH finding', async () => {
    const { run, requests, loadFigures } = job('g5.v12', {
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
    expect(loadFigures).toHaveBeenCalledWith(expect.anything(), 'stage-1', expect.any(Set), {
      withBytes: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.figures).toBeUndefined();
    // A curable hold: the next Regenerate press (a fresh first run) retries it.
    expect(finished).toMatchObject({
      status: 'needs_teacher',
      findings: [{ id: 'f1', status: 'open', teacherReason: 'REREVIEW_UNAVAILABLE' }],
      fixes: [
        {
          sceneId: 's2',
          outcome: 'still_wrong',
          code: REREVIEW_FIGURES_HELD,
          retryForFigures: ['f1'],
        },
      ],
    });
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

  it('a flagged-slide regeneration retries only a curable figure hold, nothing else', () => {
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
    expect(seed.findings.map((finding) => [finding.id, finding.teacherReason])).toEqual([
      ['f1', null],
      ['f2', 'REREVIEW_UNAVAILABLE'],
      ['f3', 'REREVIEW_UNAVAILABLE'],
    ]);
    expect(seed.sceneIds).toEqual(['s2']);
  });

  it('g5.v11: no figure is read or sent, and the review runs exactly as before', async () => {
    const { run, requests, loadFigures } = job('g5.v11');
    const finished = await run();
    expect(loadFigures).not.toHaveBeenCalled();
    expect(requests.every((request) => !('figures' in request))).toBe(true);
    expect(finished?.status).toBe('fixed');
  });
});
