import { describe, expect, it, vi } from 'vitest';

import type { AppScene } from '@/lib/types/stage';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  createPackageReviewFixLoop,
  fixIdempotencyKey,
  fixInstruction,
  PACKAGE_REVIEWER_ACTOR,
} from '@/lib/server/teaching-package/package-review-fix-loop';
import { reviewStatusOf } from '@/lib/server/teaching-package/package-review';
import { reviewSlidesOf } from '@/lib/server/teaching-package/package-review-input';
import type {
  PackageReview,
  StoredFinding,
} from '@/lib/server/teaching-package/package-review-store';

/**
 * The reviewer's fix loop (ai-reviewer-layer plan D-1, §4.4) with fakes for
 * the regeneration, the narration audio, the version and the reviewer: no
 * model, no TTS, no database.
 */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function slide(
  id: string,
  order: number,
  text: string,
  extra: Record<string, unknown> = {},
): AppScene {
  return {
    id,
    stageId: 'stage-1',
    title: `شريحة ${order}`,
    order,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [{ id: 'e', type: 'text', content: text }] } },
    actions: [{ id: 'a', type: 'speech', text: `شرح ${text}` }],
    ...extra,
  } as unknown as AppScene;
}

const REVIEW: PackageReview = {
  id: 'tpr-abc',
  tenantId: 't-1',
  learningItem: { type: 'lesson', id: '429' },
  versionId: 'tpv-1',
  attemptId: 'tpa-1',
  stageId: 'stage-1',
  subjectCode: 'MATH',
  status: 'running',
  provider: 'anthropic',
  model: 'anthropic:claude-opus-5-5',
  summary: 's',
  findings: [],
  fixes: [],
  errorCode: null,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  bookTruncated: false,
  runAttempts: 1,
  leaseOwner: 'w',
  leaseUntil: 1,
  reviewedAt: 1,
  createdAt: 1,
  startedAt: 1,
  completedAt: null,
};

function finding(id: string, targetId: string, check: StoredFinding['check']): StoredFinding {
  return {
    id,
    targetId,
    targetTitle: '',
    targetOrder: null,
    check,
    severity: 'high',
    bookEvidence: { quote: 'q', unitId: null },
    whatIsWrong: 'خطأ',
    fixNote: `صحح ${id}`,
    status: 'open',
    teacherReason: null,
  };
}

function setup(options: {
  scenes: AppScene[];
  findings: StoredFinding[];
  regenerate?: ReturnType<typeof vi.fn>;
  regenerateAudio?: ReturnType<typeof vi.fn>;
  versionStatus?: string;
  liveScenes?: Map<string, AppScene>;
  rereview?: (focus: string) => Array<Record<string, unknown>>;
}) {
  const order: string[] = [];
  const regenerated = new Map<string, AppScene>();
  const regenerate =
    options.regenerate ??
    vi.fn(async (_grant, sceneId: string) => {
      order.push(`regenerate:${sceneId}`);
      const base = options.scenes.find((scene) => scene.id === sceneId)!;
      const next = slide(sceneId, base.order, 'مصحح');
      regenerated.set(sceneId, next);
      return {
        status: 200,
        body: {
          regenerationId: `tpsr-${sceneId}`,
          status: 'succeeded',
          replayed: false,
          sceneId,
          scene: next,
          resultSceneRev: 2,
          current: { rev: 2, scene: next },
        },
      };
    });
  const regenerateAudio =
    options.regenerateAudio ??
    vi.fn(async (_grant, sceneId: string) => {
      order.push(`audio:${sceneId}`);
      return { sceneId, scene: regenerated.get(sceneId)!, rev: 3, generated: 1, missing: 0 };
    });
  const callReviewer = vi.fn(
    async (request: {
      focusIds?: Set<string>;
      slides: Array<{ id: string; visibleText: string }>;
    }) => {
      const focus = [...(request.focusIds ?? [])][0]!;
      order.push(`rereview:${focus}`);
      return {
        answer: { summary: 's', findings: (options.rereview?.(focus) ?? []) as never },
        call: {
          provider: 'anthropic' as const,
          modelString: 'anthropic:claude-opus-5-5',
          usage: null,
        },
      };
    },
  );
  const recordProgress = vi.fn(async () => {});
  const loop = createPackageReviewFixLoop({
    regenerate: regenerate as never,
    regenerateAudio: regenerateAudio as never,
    readVersion: (async () => ({
      id: 'tpv-1',
      tenantId: 't-1',
      status: options.versionStatus ?? 'draft',
      currentStageId: 'stage-1',
    })) as never,
    readScene: async (_pool, _stage, sceneId) => {
      const scene =
        options.liveScenes?.get(sceneId) ?? options.scenes.find((s) => s.id === sceneId);
      return scene ? { rev: 1, scene } : null;
    },
  });
  const run = () =>
    loop({
      pool: {} as never,
      review: REVIEW,
      units: [{ id: 'book', title: null, role: null, text: 'نص الكتاب' }],
      slides: reviewSlidesOf(options.scenes),
      scenes: options.scenes,
      findings: options.findings,
      heartbeat: async () => true,
      callReviewer: callReviewer as never,
      recordProgress,
      now: () => 1,
    });
  return { run, regenerate, regenerateAudio, callReviewer, recordProgress, order };
}

describe('package review fix loop (D-1)', () => {
  const scenes = [slide('s1', 1, 'أ'), slide('s2', 2, 'ب'), slide('s3', 3, 'ج')];

  it('fixed: one regeneration per slide under the system actor, audio AFTER it, then a re-review of that slide with its neighbours', async () => {
    const { run, regenerate, callReviewer, order } = setup({
      scenes,
      findings: [finding('f1', 's2', 'S2'), finding('f2', 's2', 'S4')],
    });
    const result = await run();
    expect(order).toEqual(['regenerate:s2', 'audio:s2', 'rereview:s2']);
    expect(regenerate).toHaveBeenCalledTimes(1);
    const [grant, sceneId, request, deps] = regenerate.mock.calls[0]!;
    expect(grant).toMatchObject({ tenantId: 't-1', versionId: 'tpv-1', stageId: 'stage-1' });
    expect(sceneId).toBe('s2');
    expect(request.instruction).toContain('(S2) صحح f1');
    expect(request.instruction).toContain('(S4) صحح f2');
    expect(request.idempotencyKey).toBe(fixIdempotencyKey('tpr-abc', 's2'));
    expect(deps.actor).toEqual({ actorRef: PACKAGE_REVIEWER_ACTOR, sessionRef: null });
    const [rereview] = callReviewer.mock.calls[0]!;
    expect(rereview.slides.map((s: { id: string }) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(rereview.slides[1].visibleText).toBe('مصحح');
    expect(result.findings.map((f) => [f.id, f.status, f.teacherReason])).toEqual([
      ['f1', 'fixed', null],
      ['f2', 'fixed', null],
    ]);
    expect(result.fixes).toEqual([
      expect.objectContaining({
        sceneId: 's2',
        findingIds: ['f1', 'f2'],
        outcome: 'fixed',
        code: null,
      }),
    ]);
  });

  it('still wrong after the one regeneration: the finding stays open (STILL_WRONG) and the new error is added; no second regeneration', async () => {
    const { run, regenerate } = setup({
      scenes,
      findings: [finding('f1', 's1', 'S2')],
      rereview: (focus) => [
        {
          targetId: focus,
          check: 'S2',
          severity: 'high',
          bookEvidence: { quote: 'q', unitId: null },
          whatIsWrong: 'ما زال الناتج خطأ',
          fixNote: 'n',
        },
      ],
    });
    const result = await run();
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(result.findings.map((f) => [f.id, f.status, f.teacherReason])).toEqual([
      ['f1', 'open', 'STILL_WRONG'],
      ['r-1-1', 'open', 'STILL_WRONG'],
    ]);
    expect(result.fixes[0]).toMatchObject({ outcome: 'still_wrong' });
  });

  it('refused: a regeneration refused by an invariant or sacred-text protection goes to the teacher, the loop goes on', async () => {
    const regenerate = vi.fn(async (_grant, sceneId: string) => {
      if (sceneId === 's1') {
        throw new TeachingPackageError('SACRED_TEXT_ALTERED', 'sacred text protected');
      }
      const next = slide(sceneId, 3, 'مصحح');
      return {
        status: 200,
        body: {
          regenerationId: 'r',
          status: 'succeeded',
          replayed: false,
          sceneId,
          scene: next,
          resultSceneRev: 2,
          current: { rev: 2, scene: next },
        },
      };
    });
    const regenerateAudio = vi.fn(async (_grant, sceneId: string) => ({
      sceneId,
      scene: slide(sceneId, 3, 'مصحح'),
      rev: 3,
      generated: 1,
      missing: 0,
    }));
    const { run } = setup({
      scenes,
      findings: [finding('f1', 's1', 'S1'), finding('f2', 's3', 'S3')],
      regenerate,
      regenerateAudio,
    });
    const result = await run();
    expect(regenerate).toHaveBeenCalledTimes(2);
    expect(result.findings.map((f) => [f.id, f.status, f.teacherReason])).toEqual([
      ['f1', 'open', 'REGENERATION_REFUSED'],
      ['f2', 'fixed', null],
    ]);
    expect(result.fixes[0]).toMatchObject({
      sceneId: 's1',
      outcome: 'refused',
      code: 'SACRED_TEXT_ALTERED',
    });
  });

  it('S5 and a bank quiz never reach a regeneration', async () => {
    const bank = {
      ...slide('bank', 4, 'x'),
      type: 'quiz',
      questionSource: 'bank',
      content: { type: 'quiz', questions: [] },
    } as unknown as AppScene;
    const { run, regenerate } = setup({
      scenes: [...scenes, bank],
      findings: [finding('f1', '', 'S5'), finding('f2', 'bank', 'Q1')],
    });
    const result = await run();
    expect(regenerate).not.toHaveBeenCalled();
    expect(result.findings.map((f) => f.teacherReason)).toEqual([
      'S5_TEACHER_ONLY',
      'BANK_QUIZ_NOT_REGENERABLE',
    ]);
  });

  it('revision changed: a slide edited since the review stops the loop before any paid call; the rest stays open', async () => {
    const { run, regenerate, callReviewer } = setup({
      scenes,
      findings: [finding('f1', 's1', 'S1'), finding('f2', 's2', 'S1')],
      liveScenes: new Map([['s1', slide('s1', 1, 'عدّله المعلم')]]),
    });
    const result = await run();
    expect(regenerate).not.toHaveBeenCalled();
    expect(callReviewer).not.toHaveBeenCalled();
    expect(result.findings.map((f) => [f.status, f.teacherReason])).toEqual([
      ['open', 'VERSION_CHANGED'],
      ['open', 'VERSION_CHANGED'],
    ]);
  });

  it('the version is no longer draft (submitted, approved) → stop cleanly, nothing regenerated', async () => {
    const { run, regenerate } = setup({
      scenes,
      findings: [finding('f1', 's1', 'S1')],
      versionStatus: 'in_review',
    });
    const result = await run();
    expect(regenerate).not.toHaveBeenCalled();
    expect(result.findings[0]).toMatchObject({ status: 'open', teacherReason: 'VERSION_CHANGED' });
  });

  it('D-5: a narration audio failure keeps the content fix but the finding stays open (NARRATION_AUDIO_FAILED)', async () => {
    const { run } = setup({
      scenes,
      findings: [finding('f1', 's1', 'S4')],
      regenerateAudio: vi.fn(async () => {
        throw new TeachingPackageError('NARRATION_AUDIO_UNAVAILABLE', 'voice down');
      }),
    });
    const result = await run();
    expect(result.findings[0]).toMatchObject({
      status: 'open',
      teacherReason: 'NARRATION_AUDIO_FAILED',
    });
    expect(reviewStatusOf(result.findings)).toBe('needs_teacher');
    expect(result.fixes[0]).toMatchObject({
      outcome: 'fixed',
      code: 'NARRATION_AUDIO_UNAVAILABLE',
    });
  });

  it('D-5: partial narration audio also keeps the finding open', async () => {
    const regenerated = slide('s1', 1, 'مصحح');
    const { run } = setup({
      scenes,
      findings: [finding('f1', 's1', 'S1')],
      regenerateAudio: vi.fn(async () => ({
        sceneId: 's1',
        scene: regenerated,
        rev: 3,
        generated: 1,
        missing: 2,
      })),
    });
    const result = await run();
    expect(result.findings[0]).toMatchObject({
      status: 'open',
      teacherReason: 'NARRATION_AUDIO_FAILED',
    });
    expect(result.fixes[0]).toMatchObject({ outcome: 'fixed', code: 'NARRATION_AUDIO_PARTIAL' });
  });

  it('L-2: a re-review that fails leaves the finding REREVIEW_UNAVAILABLE, never STILL_WRONG', async () => {
    const { run, regenerate } = setup({
      scenes,
      findings: [finding('f1', 's2', 'S2')],
      rereview: () => {
        throw new Error('both reviewer routes failed');
      },
    });
    const result = await run();
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(result.findings.map((f) => [f.id, f.status, f.teacherReason])).toEqual([
      ['f1', 'open', 'REREVIEW_UNAVAILABLE'],
    ]);
    expect(result.fixes[0]).toMatchObject({ code: 'REREVIEW_UNAVAILABLE' });
  });

  it('LOW-2: a failed re-review after an audio failure keeps the audio code on the fix row', async () => {
    const { run } = setup({
      scenes,
      findings: [finding('f1', 's2', 'S2')],
      regenerateAudio: vi.fn(async () => {
        throw new TeachingPackageError('NARRATION_AUDIO_UNAVAILABLE', 'voice down');
      }),
      rereview: () => {
        throw new Error('both reviewer routes failed');
      },
    });
    const result = await run();
    expect(result.findings[0]).toMatchObject({
      status: 'open',
      teacherReason: 'REREVIEW_UNAVAILABLE',
    });
    expect(result.fixes[0]).toMatchObject({
      outcome: 'still_wrong',
      code: 'NARRATION_AUDIO_UNAVAILABLE',
    });
  });

  it('L-2: a re-review with only a different error closes the original as fixed and adds the new one open', async () => {
    const { run } = setup({
      scenes,
      findings: [finding('f1', 's2', 'S2'), finding('f2', 's2', 'S4')],
      rereview: (focus) => [
        {
          targetId: focus,
          check: 'S2',
          severity: 'high',
          bookEvidence: { quote: 'q', unitId: null },
          whatIsWrong: 'ما زال الناتج خطأ',
          fixNote: 'n',
        },
        {
          targetId: focus,
          check: 'S3',
          severity: 'medium',
          bookEvidence: { quote: 'q', unitId: null },
          whatIsWrong: 'رقم جديد مختلف عن الكتاب',
          fixNote: 'n',
        },
      ],
    });
    const result = await run();
    expect(result.findings.map((f) => [f.id, f.check, f.status, f.teacherReason])).toEqual([
      ['f1', 'S2', 'open', 'STILL_WRONG'],
      ['f2', 'S4', 'fixed', null],
      ['r-2-1', 'S2', 'open', 'STILL_WRONG'],
      ['r-2-2', 'S3', 'open', 'NOT_ATTEMPTED'],
    ]);
    expect(result.fixes[0]).toMatchObject({ outcome: 'still_wrong' });

    const onlyDifferent = setup({
      scenes,
      findings: [finding('f1', 's2', 'S2')],
      rereview: (focus) => [
        {
          targetId: focus,
          check: 'S4',
          severity: 'low',
          bookEvidence: { quote: 'q', unitId: null },
          whatIsWrong: 'كلمة إنجليزية',
          fixNote: 'n',
        },
      ],
    });
    const closed = await onlyDifferent.run();
    expect(closed.findings.map((f) => [f.id, f.check, f.status, f.teacherReason])).toEqual([
      ['f1', 'S2', 'fixed', null],
      ['r-2-1', 'S4', 'open', 'NOT_ATTEMPTED'],
    ]);
    expect(closed.fixes[0]).toMatchObject({ outcome: 'fixed' });
    expect(reviewStatusOf(closed.findings)).toBe('needs_teacher');
  });

  it('L-3: a re-review sees a neighbour regenerated earlier in the same loop in its new form', async () => {
    const { run, callReviewer } = setup({
      scenes,
      findings: [finding('f1', 's1', 'S1'), finding('f2', 's2', 'S1')],
    });
    await run();
    expect(callReviewer).toHaveBeenCalledTimes(2);
    const [second] = callReviewer.mock.calls[1]!;
    expect(second.slides.map((s: { id: string }) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(second.slides.map((s: { visibleText: string }) => s.visibleText)).toEqual([
      'مصحح',
      'مصحح',
      'ج',
    ]);
  });

  it('instruction and key stay within the regeneration limits', () => {
    const long = Array.from({ length: 40 }, (_, i) => ({
      ...finding(`f${i}`, 's1', 'S1'),
      fixNote: 'x'.repeat(200),
    }));
    expect(fixInstruction(long).length).toBeLessThanOrEqual(2000);
    expect(fixInstruction([finding('f', 's', 'S1')]).length).toBeGreaterThanOrEqual(10);
    const key = fixIdempotencyKey('tpr-Ab_9', 'scene/with spaces');
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });
});
