/**
 * The three approval dead ends (27 Nov 2026), closed through the existing
 * Regenerate-flagged route and the existing review webhook, with no new field:
 *  (a) an edit successor (no attempt of its own) gets ONE first review of its Stage;
 *  (b) a finding whose re-check could not run is re-checked (only re-checked) per press;
 *  (c) a review `unavailable` before its first answer is asked again from the start.
 * Fakes only: no model, no TTS, no database.
 */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readVersionForUpdate: vi.fn(),
  readAttemptById: vi.fn(),
  readProducingAttemptId: vi.fn(),
  readStageReviewForUpdate: vi.fn(),
  requeueReviewForRefix: vi.fn(),
  insertQueuedReview: vi.fn(),
  readPackageReview: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/persistence/teaching-package', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/teaching-package')>()),
  readVersionForUpdate: mocks.readVersionForUpdate,
  readAttemptById: mocks.readAttemptById,
}));
vi.mock('@/lib/server/teaching-package/successor-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/successor-model')>()),
  readProducingAttemptId: mocks.readProducingAttemptId,
}));
vi.mock('@/lib/server/teaching-package/package-review-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/teaching-package/package-review-store')>()),
  readStageReviewForUpdate: mocks.readStageReviewForUpdate,
  requeueReviewForRefix: mocks.requeueReviewForRefix,
  insertQueuedReview: mocks.insertQueuedReview,
  readPackageReview: mocks.readPackageReview,
}));
vi.mock('@openmaic/storage/server/reference', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/storage/server/reference')>()),
  // No generation in flight: the only raw query the refix makes.
  nodePostgresTransaction: () => (work: (tx: unknown) => unknown) =>
    work({ query: async () => ({ rows: [] }) }),
}));

import { stampReviewedDigests } from '@/lib/server/teaching-package/package-review';
import { createPackageReviewFixLoop } from '@/lib/server/teaching-package/package-review-fix-loop';
import {
  reviewedSceneDigest,
  reviewSlidesOf,
} from '@/lib/server/teaching-package/package-review-input';
import {
  queueFlaggedSlideRefix,
  queueSuccessorStageReview,
  refixReviewId,
} from '@/lib/server/teaching-package/package-review-refix';
import {
  isPressedFirstReview,
  packageReviewWire,
  reviewSourceAttemptId,
  stageReviewAttemptId,
  type PackageReview,
  type StoredFinding,
} from '@/lib/server/teaching-package/package-review-store';
import type { AppScene } from '@/lib/types/stage';

const KEY = 'learning_item_tp_command:1:regeneration:stamp:1:abc';
const NEW_ID = refixReviewId('t-1', 'tpv-2', KEY);

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

const REVIEW: PackageReview = {
  id: 'tpr-old',
  tenantId: 't-1',
  learningItem: { type: 'lesson', id: '227' },
  versionId: 'tpv-2',
  attemptId: 'tpa-1',
  stageId: 'stage-2',
  subjectCode: 'CHEMISTRY',
  status: 'needs_teacher',
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
  leaseOwner: null,
  leaseUntil: null,
  reviewedAt: 5,
  createdAt: 1,
  startedAt: 1,
  completedAt: 6,
};

function finding(id: string, extra: Partial<StoredFinding> = {}): StoredFinding {
  return {
    id,
    targetId: 's2',
    targetTitle: 'شريحة 2',
    targetOrder: 2,
    check: 'S2',
    severity: 'high',
    bookEvidence: { quote: 'q', unitId: 'u1' },
    whatIsWrong: 'w',
    fixNote: `صحح ${id}`,
    status: 'open',
    teacherReason: null,
    ...extra,
  };
}

function refix(
  version: Record<string, unknown>,
  review: PackageReview | null,
  producing: { attemptId: string; own: boolean } | null = { attemptId: 'tpa-1', own: false },
) {
  mocks.readVersionForUpdate.mockReset().mockResolvedValue({
    id: 'tpv-2',
    tenantId: 't-1',
    learningItem: { type: 'lesson', id: '227' },
    status: 'draft',
    currentStageId: 'stage-2',
    currentAttemptId: null,
    ...version,
  });
  mocks.readStageReviewForUpdate.mockReset().mockResolvedValue(review);
  mocks.readProducingAttemptId.mockReset().mockResolvedValue(producing);
  mocks.readAttemptById
    .mockReset()
    .mockResolvedValue({ inputSnapshot: { subjectCode: 'CHEMISTRY' } });
  mocks.insertQueuedReview.mockReset().mockImplementation(async (_tx, input) => input.id);
  mocks.readPackageReview
    .mockReset()
    .mockImplementation(async (_tx, id) => ({ ...REVIEW, id, status: 'queued', reviewedAt: null }));
  mocks.requeueReviewForRefix.mockReset().mockImplementation(async (_tx, input) => ({
    ...review,
    id: input.newReviewId,
    status: 'queued',
    findings: input.findings,
    fixes: [],
  }));
  return queueFlaggedSlideRefix(
    {} as never,
    {
      tenantId: 't-1',
      versionId: 'tpv-2',
      idempotencyKey: KEY,
    },
    { now: () => 9, loadScenes: async () => SCENES },
  );
}

describe('dead end (a): an edit successor gets one first review of its Stage', () => {
  it('a successor draft with no review: one queued review of its Stage, read from the producing attempt', async () => {
    const queued = await refix({}, null);
    expect(mocks.insertQueuedReview).toHaveBeenCalledTimes(1);
    expect(mocks.insertQueuedReview.mock.calls[0]![1]).toEqual({
      id: NEW_ID,
      aggregate: { tenantId: 't-1', learningItem: { type: 'lesson', id: '227' } },
      versionId: 'tpv-2',
      attemptId: 'tpa-1#stage:stage-2',
      stageId: 'stage-2',
      subjectCode: 'CHEMISTRY',
      now: 9,
    });
    expect(queued).toMatchObject({
      review: { id: NEW_ID, status: 'queued' },
      previousReviewId: null,
      sceneIds: [],
      replayed: false,
    });
    // Its wire names the producing attempt, never the row key.
    expect(packageReviewWire(queued.review).attemptId).toBe('tpa-1');
  });

  it('a press replayed with the same key returns the same review, never a second one', async () => {
    const replay = await refix({}, { ...REVIEW, id: NEW_ID, status: 'queued', reviewedAt: null });
    expect(replay).toMatchObject({ replayed: true, review: { id: NEW_ID } });
    expect(mocks.insertQueuedReview).not.toHaveBeenCalled();
  });

  it('a version with an attempt of its own and no review stays "not ready" (Kafuo keeps it cleared)', async () => {
    await expect(refix({ currentAttemptId: 'tpa-9' }, null)).rejects.toMatchObject({
      code: 'PACKAGE_REVIEW_NOT_READY',
    });
    expect(mocks.insertQueuedReview).not.toHaveBeenCalled();
  });

  it('a successor whose chain names no producing attempt has no book to review: "not ready"', async () => {
    await expect(refix({}, null, null)).rejects.toMatchObject({
      code: 'PACKAGE_REVIEW_NOT_READY',
    });
    expect(mocks.insertQueuedReview).not.toHaveBeenCalled();
  });

  it('at submit (slot-5 wires it): one review of a successor Stage that has none, else nothing', async () => {
    const submit = async (version: Record<string, unknown>, review: PackageReview | null) => {
      mocks.readVersionForUpdate.mockReset().mockResolvedValue({
        id: 'tpv-2',
        tenantId: 't-1',
        learningItem: { type: 'lesson', id: '227' },
        status: 'in_review',
        currentStageId: 'stage-2',
        currentAttemptId: null,
        ...version,
      });
      mocks.readStageReviewForUpdate.mockReset().mockResolvedValue(review);
      mocks.readProducingAttemptId
        .mockReset()
        .mockResolvedValue({ attemptId: 'tpa-1', own: false });
      mocks.readAttemptById.mockReset().mockResolvedValue({ inputSnapshot: {} });
      mocks.insertQueuedReview.mockReset().mockImplementation(async (_tx, input) => input.id);
      mocks.readPackageReview
        .mockReset()
        .mockImplementation(async (_tx, id) => ({ ...REVIEW, id, status: 'queued' }));
      return queueSuccessorStageReview({} as never, { tenantId: 't-1', versionId: 'tpv-2' });
    };
    expect(await submit({}, null)).toMatchObject({ status: 'queued' });
    expect(mocks.insertQueuedReview.mock.calls[0]![1]).toMatchObject({
      attemptId: 'tpa-1#stage:stage-2',
      subjectCode: null,
    });
    expect(await submit({}, REVIEW)).toBeNull();
    expect(await submit({ currentAttemptId: 'tpa-9' }, null)).toBeNull();
    expect(mocks.insertQueuedReview).not.toHaveBeenCalled();
  });

  it('the stage review key is one per Stage and resolves back to its producing attempt', () => {
    const key = stageReviewAttemptId('tpa-1', 'stage-2');
    expect(key).toBe('tpa-1#stage:stage-2');
    expect(reviewSourceAttemptId(key)).toBe('tpa-1');
    expect(reviewSourceAttemptId('tpa-1')).toBe('tpa-1');
  });
});

describe('dead end (c): a review unavailable before its first answer is asked again', () => {
  it('re-queues the same Stage with no findings and regenerates no slide', async () => {
    const queued = await refix(
      { currentAttemptId: 'tpa-1' },
      { ...REVIEW, status: 'unavailable', reviewedAt: null, errorCode: 'REVIEWER_UNAVAILABLE' },
    );
    expect(mocks.requeueReviewForRefix).toHaveBeenCalledWith(expect.anything(), {
      reviewId: 'tpr-old',
      newReviewId: NEW_ID,
      findings: [],
      now: 9,
    });
    expect(queued).toMatchObject({ previousReviewId: 'tpr-old', sceneIds: [], replayed: false });
  });

  it('a cause another run cannot cure is not re-asked (no book, no version)', async () => {
    await expect(
      refix(
        { currentAttemptId: 'tpa-1' },
        { ...REVIEW, status: 'unavailable', reviewedAt: null, errorCode: 'NO_BOOK_SOURCE' },
      ),
    ).rejects.toMatchObject({ code: 'PACKAGE_REVIEW_NOT_READY' });
    expect(mocks.requeueReviewForRefix).not.toHaveBeenCalled();
  });

  it('a first review still running is never re-queued (refused as before)', async () => {
    await expect(
      refix({ currentAttemptId: 'tpa-1' }, { ...REVIEW, status: 'running', reviewedAt: null }),
    ).rejects.toMatchObject({ code: 'PACKAGE_REVIEW_NOT_READY' });
    await expect(
      refix({ currentAttemptId: 'tpa-1' }, { ...REVIEW, status: 'running', reviewedAt: 5 }),
    ).rejects.toMatchObject({ code: 'PACKAGE_REVIEW_IN_PROGRESS' });
    expect(mocks.requeueReviewForRefix).not.toHaveBeenCalled();
  });
});

describe('dead end (b): a re-check that could not run is re-checked, without a regeneration', () => {
  it('a press re-queues the finding marked re-check only', async () => {
    const queued = await refix(
      { currentAttemptId: 'tpa-1' },
      {
        ...REVIEW,
        findings: [finding('f1', { teacherReason: 'REREVIEW_UNAVAILABLE' })],
        fixes: [
          {
            sceneId: 's2',
            findingIds: ['f1'],
            outcome: 'still_wrong',
            code: 'REREVIEW_UNAVAILABLE',
          },
        ],
      },
    );
    expect(mocks.requeueReviewForRefix.mock.calls[0]![1].findings).toEqual([
      expect.objectContaining({ id: 'f1', teacherReason: null, recheckOnly: true }),
    ]);
    expect(queued.sceneIds).toEqual(['s2']);
    // The marker never reaches the wire.
    expect(packageReviewWire(queued.review).findings[0]).not.toHaveProperty('recheckOnly');
  });

  it('what a finding waits for survives a press that wiped the fixes (review of c3f02fdc)', async () => {
    const waiting = (id: string, heldFor: StoredFinding['heldFor']) =>
      finding(id, { teacherReason: 'REREVIEW_UNAVAILABLE', heldFor });
    const queued = await refix(
      { currentAttemptId: 'tpa-1' },
      {
        ...REVIEW,
        // No fix entry left: an earlier press reset them.
        findings: [
          waiting('f1', 'recheck'),
          { ...waiting('f2', 'audio'), targetId: 's1' },
          { ...waiting('f3', 'person'), check: 'S3' },
        ],
        fixes: [],
      },
    );
    const seeded = mocks.requeueReviewForRefix.mock.calls[0]![1].findings as StoredFinding[];
    expect(seeded.map((f) => [f.id, f.teacherReason, f.recheckOnly, f.heldFor])).toEqual([
      // re-checked only
      ['f1', null, true, undefined],
      // its audio failed too: regenerated
      ['f2', null, undefined, undefined],
      // an unread figure: left for a person, and still says so on the next press
      ['f3', 'REREVIEW_UNAVAILABLE', undefined, 'person'],
    ]);
    expect(queued.sceneIds).toEqual(['s1', 's2']);
    expect(packageReviewWire(queued.review).findings[2]).not.toHaveProperty('heldFor');
  });

  function loop(
    rereview: () => Array<Record<string, unknown>>,
    heartbeat: () => Promise<boolean> = async () => true,
  ) {
    const regenerate = vi.fn();
    const regenerateAudio = vi.fn();
    const callReviewer = vi.fn(async () => ({
      answer: { summary: 's', findings: rereview() as never },
      call: { provider: 'openai' as const, modelString: 'openai:gpt-6-sol', usage: null },
    }));
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
    const run = (findings: StoredFinding[]) =>
      fixLoop({
        pool: {} as never,
        review: { ...REVIEW, status: 'running' },
        units: [{ id: 'u1', title: null, role: null, text: 'نص' }],
        slides: reviewSlidesOf(SCENES),
        scenes: SCENES,
        findings,
        heartbeat,
        callReviewer: callReviewer as never,
        recordProgress: vi.fn(async () => {}),
        now: () => 1,
      });
    return { run, regenerate, regenerateAudio, callReviewer };
  }

  it('a clean re-check of the live slide closes it: no regeneration, no audio, one re-review', async () => {
    const { run, regenerate, regenerateAudio, callReviewer } = loop(() => []);
    const result = await run([finding('f1', { recheckOnly: true })]);
    expect(regenerate).not.toHaveBeenCalled();
    expect(regenerateAudio).not.toHaveBeenCalled();
    expect(callReviewer).toHaveBeenCalledTimes(1);
    expect(result.findings).toEqual([
      expect.objectContaining({ id: 'f1', status: 'fixed', teacherReason: null }),
    ]);
    expect(result.findings[0]).not.toHaveProperty('recheckOnly');
    expect(result.fixes).toEqual([
      expect.objectContaining({
        sceneId: 's2',
        outcome: 'fixed',
        regenerationId: null,
        reviewModel: 'openai:gpt-6-sol',
      }),
    ]);
  });

  it('the re-check reports it again: still wrong, and the next press regenerates it', async () => {
    const { run, regenerate } = loop(() => [
      {
        targetId: 's2',
        check: 'S2',
        severity: 'high',
        bookEvidence: { quote: 'q', unitId: 'u1' },
        whatIsWrong: 'ما زال خطأ',
        fixNote: 'n',
      },
    ]);
    const result = await run([finding('f1', { recheckOnly: true })]);
    expect(regenerate).not.toHaveBeenCalled();
    expect(result.findings[0]).toMatchObject({
      id: 'f1',
      status: 'open',
      teacherReason: 'STILL_WRONG',
    });
  });

  it('the re-check fails again: it stays REREVIEW_UNAVAILABLE for the next press', async () => {
    const { run } = loop(() => {
      throw new Error('both reviewer routes failed');
    });
    const result = await run([finding('f1', { recheckOnly: true })]);
    expect(result.findings[0]).toMatchObject({
      status: 'open',
      teacherReason: 'REREVIEW_UNAVAILABLE',
    });
    expect(result.findings[0]).not.toHaveProperty('recheckOnly');
  });

  it('a slide that also has a finding to fix is regenerated, with every note', async () => {
    const { run, regenerate } = loop(() => []);
    regenerate.mockRejectedValue(new Error('refused'));
    await run([finding('f1', { recheckOnly: true }), finding('f2', { check: 'S3' })]);
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it('a run that stops before the re-check leaves it waiting for its re-check, never a regeneration', async () => {
    const { run, callReviewer } = loop(
      () => [],
      async () => false,
    );
    const result = await run([finding('f1', { recheckOnly: true })]);
    expect(callReviewer).not.toHaveBeenCalled();
    expect(result.findings[0]).toMatchObject({
      teacherReason: 'REREVIEW_UNAVAILABLE',
      heldFor: 'recheck',
    });
    expect(result.findings[0]).not.toHaveProperty('recheckOnly');
  });

  it('a lease check that throws on a re-check-only slide is no audio failure', async () => {
    let beats = 0;
    const { run, regenerateAudio } = loop(
      () => [],
      async () => {
        beats += 1;
        if (beats === 2) throw new Error('database blip');
        return true;
      },
    );
    const result = await run([finding('f1', { recheckOnly: true })]);
    expect(regenerateAudio).not.toHaveBeenCalled();
    expect(result.findings[0]).toMatchObject({ status: 'fixed' });
    expect(result.fixes[0]).toMatchObject({ outcome: 'fixed', code: null });
  });

  it('a re-checked slide records itself as the re-check saw it (review 27 Nov 2026, HIGH)', async () => {
    const { run } = loop(() => []);
    const result = await run([finding('f1', { recheckOnly: true, sceneDigest: 'before-edit' })]);
    expect(result.findings[0]!.sceneDigest).toBe(reviewedSceneDigest(SCENES[1]!));
  });
});

describe('review of c3f02fdc..97cc78c3: pressed first reviews and digests', () => {
  it('a second press while a pressed first review is on its way is "in progress" (Kafuo adopts it)', async () => {
    await expect(
      refix({}, { ...REVIEW, id: 'tpr-rf-earlier', status: 'queued', reviewedAt: null }),
    ).rejects.toMatchObject({ code: 'PACKAGE_REVIEW_IN_PROGRESS' });
    // A Stage review the submit queued (a plain id, the Stage key).
    await expect(
      refix(
        {},
        {
          ...REVIEW,
          id: 'tpr-submit',
          attemptId: 'tpa-1#stage:stage-2',
          status: 'running',
          reviewedAt: null,
        },
      ),
    ).rejects.toMatchObject({ code: 'PACKAGE_REVIEW_IN_PROGRESS' });
    expect(mocks.requeueReviewForRefix).not.toHaveBeenCalled();
    expect(mocks.insertQueuedReview).not.toHaveBeenCalled();
  });

  it('a review that used up its runs is re-asked once, never again after a press re-asked it', async () => {
    const exhausted = {
      ...REVIEW,
      status: 'unavailable' as const,
      reviewedAt: null,
      errorCode: 'REVIEW_ATTEMPTS_EXHAUSTED',
    };
    await refix({ currentAttemptId: 'tpa-1' }, exhausted);
    expect(mocks.requeueReviewForRefix).toHaveBeenCalledTimes(1);
    await expect(
      refix({ currentAttemptId: 'tpa-1' }, { ...exhausted, id: 'tpr-rf-earlier' }),
    ).rejects.toMatchObject({ code: 'PACKAGE_REVIEW_NOT_READY' });
    expect(mocks.requeueReviewForRefix).not.toHaveBeenCalled();
  });

  it('only a press or a submit asks for a review-only first answer', () => {
    expect(isPressedFirstReview({ id: 'tpr-rf-abc', attemptId: 'tpa-1' })).toBe(true);
    expect(isPressedFirstReview({ id: 'tpr-x', attemptId: 'tpa-1#stage:stage-2' })).toBe(true);
    expect(isPressedFirstReview({ id: 'tpr-x', attemptId: 'tpa-1' })).toBe(false);
  });

  it('the end of a run keeps each digest as the review saw it, never the Stage as it is then', () => {
    const edited = slide('s2', 2, 'عدّله المعلم');
    const stamped = stampReviewedDigests(
      [finding('f1', { sceneDigest: 'seen-by-fix' }), finding('f2', { targetId: 's1' })],
      // The run started from these; s2 was edited later, which this never reads.
      SCENES,
    );
    expect(stamped.map((f) => f.sceneDigest)).toEqual([
      'seen-by-fix',
      reviewedSceneDigest(SCENES[0]!),
    ]);
    expect(stamped[0]!.sceneDigest).not.toBe(reviewedSceneDigest(edited));
  });
});
