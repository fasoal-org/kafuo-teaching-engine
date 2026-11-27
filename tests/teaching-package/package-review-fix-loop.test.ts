import { describe, expect, it, vi } from 'vitest';

import type { AppScene } from '@/lib/types/stage';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  createPackageReviewFixLoop,
  fixIdempotencyKey,
  fixInstruction,
  fixRetryIdempotencyKey,
  PACKAGE_REVIEWER_ACTOR,
  REVIEWER_REGENERATION_LEASE_MAX_SECONDS,
  worseningFindings,
} from '@/lib/server/teaching-package/package-review-fix-loop';
import { REVIEW_LEASE_MS, reviewStatusOf } from '@/lib/server/teaching-package/package-review';
import {
  DEFAULT_SCENE_REGENERATION_LEASE_SECONDS,
  sceneRegenerationLeaseSeconds,
} from '@/lib/server/teaching-package/scene-regeneration-store';
import { reviewSlidesOf } from '@/lib/server/teaching-package/package-review-input';
import {
  packageReviewWire,
  type PackageReview,
  type StoredFinding,
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
  rereview?: (focus: string, focusText: string) => Array<Record<string, unknown>>;
  /** g5.v10 (quality plan W2). */
  learnerFirst?: boolean;
  restore?: ReturnType<typeof vi.fn>;
  /** The call log, shared with a test's own fakes. */
  order?: string[];
  /** RV-5: the route that served each re-review (default: Opus). */
  servedBy?: (focus: string) => { provider: 'anthropic' | 'openai'; modelString: string };
}) {
  const order: string[] = options.order ?? [];
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
      const focusText = request.slides.find((s) => s.id === focus)?.visibleText ?? '';
      return {
        answer: {
          summary: 's',
          findings: (options.rereview?.(focus, focusText) ?? []) as never,
        },
        call: {
          ...(options.servedBy?.(focus) ?? {
            provider: 'anthropic' as const,
            modelString: 'anthropic:claude-opus-5-5',
          }),
          usage: null,
        },
      };
    },
  );
  const recordProgress = vi.fn(async () => {});
  const loop = createPackageReviewFixLoop({
    regenerate: regenerate as never,
    regenerateAudio: regenerateAudio as never,
    ...(options.restore ? { restore: options.restore as never } : {}),
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
      ...(options.learnerFirst ? { learnerFirst: true as const } : {}),
      heartbeat: async () => true,
      callReviewer: callReviewer as never,
      recordProgress,
      now: () => 1,
    });
  return { run, regenerate, regenerateAudio, callReviewer, recordProgress, order };
}

/**
 * W2's regeneration fake: the first fix writes «مصحح», the retry (key `-w`) writes
 * «مصحح ثان»; every call is logged with its key and instruction.
 */
function regenerateByKey(order: string[], scenes: AppScene[]) {
  return vi.fn(async (_grant, sceneId: string, request: { idempotencyKey: string }) => {
    const retry = request.idempotencyKey.endsWith('-w');
    order.push(`regenerate:${sceneId}${retry ? ':retry' : ''}`);
    const base = scenes.find((scene) => scene.id === sceneId)!;
    const next = slide(sceneId, base.order, retry ? 'مصحح ثان' : 'مصحح');
    return {
      status: 200,
      body: {
        regenerationId: `tpsr-${sceneId}${retry ? '-w' : ''}`,
        status: 'succeeded',
        replayed: false,
        sceneId,
        scene: next,
        resultSceneRev: 2,
        current: { rev: 2, scene: next },
      },
    };
  });
}

const worse = (focus: string, check = 'S6', severity = 'high') => ({
  targetId: focus,
  check,
  severity,
  bookEvidence: { quote: 'q', unitId: null },
  whatIsWrong: 'الأوقات تُقرأ ثمانية وثلاثين',
  fixNote: 'اقرأ الوقت الثامنة والنصف',
});

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

  it('a second run (flagged-slide regeneration) never reuses an id an earlier run added', async () => {
    const { run } = setup({
      scenes,
      // The newest copy an earlier run added, reset to be tried again.
      findings: [finding('r-1-1', 's1', 'S2')],
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
    const ids = result.findings.map((f) => f.id);
    expect(ids).toEqual(['r-1-1', 'r-1-1-2']);
    expect(new Set(ids).size).toBe(ids.length);
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
    // RV-4: f2 is HIGH and the re-check still reports a HIGH error on its slide.
    expect(result.findings.map((f) => [f.id, f.check, f.status, f.teacherReason])).toEqual([
      ['f1', 'S2', 'open', 'STILL_WRONG'],
      ['f2', 'S4', 'open', 'STILL_WRONG'],
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

  describe('RV-4: a HIGH finding is closed only by a re-check that shows its slide clean', () => {
    const relabelled = (focus: string, severity: string) => ({
      targetId: focus,
      check: 'S3',
      severity,
      bookEvidence: { quote: 'q', unitId: null },
      whatIsWrong: 'الناتج ما زال يخالف الكتاب',
      fixNote: 'n',
    });

    it('a "fixed" HIGH finding stays open when the re-check reports the error under another check', async () => {
      const { run, regenerate } = setup({
        scenes,
        findings: [finding('f1', 's2', 'S2')],
        rereview: (focus) => [relabelled(focus, 'high')],
      });
      const result = await run();
      expect(regenerate).toHaveBeenCalledTimes(1);
      expect(result.findings.map((f) => [f.id, f.check, f.status, f.teacherReason])).toEqual([
        ['f1', 'S2', 'open', 'STILL_WRONG'],
        ['r-2-1', 'S3', 'open', 'NOT_ATTEMPTED'],
      ]);
      expect(result.fixes[0]).toMatchObject({ outcome: 'still_wrong' });
      expect(reviewStatusOf(result.findings)).toBe('needs_teacher');
    });

    it('a medium finding keeps L-2: another check at HIGH does not hold it, its own check does', async () => {
      const medium = { ...finding('f1', 's2', 'S2'), severity: 'medium' as const };
      const { run } = setup({
        scenes,
        findings: [medium],
        rereview: (focus) => [relabelled(focus, 'high')],
      });
      const result = await run();
      expect(result.findings.map((f) => [f.id, f.status, f.teacherReason])).toEqual([
        ['f1', 'fixed', null],
        ['r-2-1', 'open', 'NOT_ATTEMPTED'],
      ]);
    });

    it('a HIGH finding closes when the re-check reports only a lower error of another check', async () => {
      const { run } = setup({
        scenes,
        findings: [finding('f1', 's2', 'S2')],
        rereview: (focus) => [relabelled(focus, 'medium')],
      });
      const result = await run();
      expect(result.findings.map((f) => [f.id, f.status])).toEqual([
        ['f1', 'fixed'],
        ['r-2-1', 'open'],
      ]);
    });

    it('a G1 finding is decided by the live scene (its code re-check), not by other HIGH errors', async () => {
      const broken = slide('s2', 2, 'ب', {
        generationIssues: [{ code: 'NARRATION_MISSING', message: 'm' }],
      });
      const { run } = setup({
        scenes: [scenes[0]!, broken, scenes[2]!],
        findings: [{ ...finding('i1', 's2', 'G1') }],
        rereview: (focus) => [relabelled(focus, 'high')],
      });
      const result = await run();
      expect(result.findings.map((f) => [f.id, f.check, f.status])).toEqual([
        ['i1', 'G1', 'fixed'],
        ['r-2-1', 'S3', 'open'],
      ]);
    });

    it('no re-check, no closure: a failed re-review keeps every HIGH finding open', async () => {
      const { run } = setup({
        scenes,
        findings: [finding('f1', 's2', 'S2'), finding('f2', 's2', 'S1')],
        rereview: () => {
          throw new Error('unusable output on both routes');
        },
      });
      const result = await run();
      expect(result.findings.every((f) => f.status === 'open')).toBe(true);
      expect(result.findings.map((f) => f.teacherReason)).toEqual([
        'REREVIEW_UNAVAILABLE',
        'REREVIEW_UNAVAILABLE',
      ]);
    });
  });

  describe('RV-5: the served reviewer model of each re-check is on its fix entry', () => {
    it('names the route that served the re-review (Sol here), not the first review’s', async () => {
      const { run } = setup({
        scenes,
        findings: [finding('f1', 's1', 'S2'), finding('f2', 's3', 'S2')],
        servedBy: (focus) =>
          focus === 's3'
            ? { provider: 'openai', modelString: 'openai:gpt-6-sol' }
            : { provider: 'anthropic', modelString: 'anthropic:claude-opus-5-5' },
      });
      const result = await run();
      expect(result.fixes.map((fix) => [fix.sceneId, fix.reviewProvider, fix.reviewModel])).toEqual(
        [
          ['s1', 'anthropic', 'anthropic:claude-opus-5-5'],
          ['s3', 'openai', 'openai:gpt-6-sol'],
        ],
      );
    });

    it('a fix whose re-review never answered names no model', async () => {
      const { run } = setup({
        scenes,
        findings: [finding('f1', 's2', 'S2')],
        rereview: () => {
          throw new Error('both reviewer routes failed');
        },
      });
      const result = await run();
      expect(result.fixes[0]).toMatchObject({ reviewModel: null, reviewProvider: null });
    });

    it('stays off the signed read model (contract §4.1 unchanged)', () => {
      const wire = packageReviewWire({
        ...REVIEW,
        fixes: [
          {
            sceneId: 's1',
            findingIds: ['f1'],
            outcome: 'fixed',
            code: null,
            regenerationId: 'tpsr-s1',
            reviewModel: 'openai:gpt-6-sol',
            reviewProvider: 'openai',
          },
        ],
      });
      expect(wire.fixes).toEqual([
        { sceneId: 's1', findingIds: ['f1'], outcome: 'fixed', code: null },
      ]);
    });
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

  it('LOW-5: a re-review that reports an S5 already open on the slide adds no duplicate', async () => {
    const { run } = setup({
      scenes,
      findings: [finding('f1', 's2', 'S2'), finding('f2', 's2', 'S5')],
      rereview: (focus) => [
        {
          targetId: focus,
          check: 'S5',
          severity: 'medium',
          bookEvidence: { quote: 'q', unitId: null },
          whatIsWrong: 'جزء من الدرس خارج ترتيبه',
          fixNote: 'n',
        },
      ],
    });
    const result = await run();
    expect(result.findings.map((f) => [f.id, f.check, f.status, f.teacherReason])).toEqual([
      ['f1', 'S2', 'fixed', null],
      ['f2', 'S5', 'open', 'S5_TEACHER_ONLY'],
    ]);
  });

  it('LOW-4: a run that loses its lease during the regeneration never pays for the narration audio', async () => {
    const { regenerate, regenerateAudio, callReviewer } = setup({
      scenes,
      findings: [finding('f1', 's1', 'S1'), finding('f2', 's2', 'S1')],
    });
    // The lease is kept before the regeneration, then lost (another worker took over).
    const beats = [true, false];
    const loop = createPackageReviewFixLoop({
      regenerate: regenerate as never,
      regenerateAudio: regenerateAudio as never,
      readVersion: (async () => ({
        id: 'tpv-1',
        tenantId: 't-1',
        status: 'draft',
        currentStageId: 'stage-1',
      })) as never,
      readScene: async (_pool, _stage, sceneId) => {
        const scene = scenes.find((s) => s.id === sceneId);
        return scene ? { rev: 1, scene } : null;
      },
    });
    const result = await loop({
      pool: {} as never,
      review: REVIEW,
      units: [{ id: 'book', title: null, role: null, text: 'نص الكتاب' }],
      slides: reviewSlidesOf(scenes),
      scenes,
      findings: [finding('f1', 's1', 'S1'), finding('f2', 's2', 'S1')],
      heartbeat: async () => beats.shift() ?? false,
      callReviewer: callReviewer as never,
      recordProgress: vi.fn(async () => {}),
      now: () => 1,
    });
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerateAudio).not.toHaveBeenCalled();
    expect(callReviewer).not.toHaveBeenCalled();
    expect(result.findings.map((f) => [f.id, f.status, f.teacherReason])).toEqual([
      ['f1', 'open', 'VERSION_CHANGED'],
      ['f2', 'open', 'VERSION_CHANGED'],
    ]);
  });

  it('HIGH-1: a stall in the guard reads that loses the lease never reaches the paid regeneration', async () => {
    const { regenerate, regenerateAudio, callReviewer } = setup({
      scenes,
      findings: [finding('f1', 's1', 'S1')],
    });
    // The lease is ours until the scene read stalls past it.
    let leaseLost = false;
    const loop = createPackageReviewFixLoop({
      regenerate: regenerate as never,
      regenerateAudio: regenerateAudio as never,
      readVersion: (async () => ({
        id: 'tpv-1',
        tenantId: 't-1',
        status: 'draft',
        currentStageId: 'stage-1',
      })) as never,
      readScene: async (_pool, _stage, sceneId) => {
        leaseLost = true; // a long stall: the lease lapsed and was revoked meanwhile
        const scene = scenes.find((s) => s.id === sceneId);
        return scene ? { rev: 1, scene } : null;
      },
    });
    const heartbeat = vi.fn(async () => !leaseLost);
    const result = await loop({
      pool: {} as never,
      review: REVIEW,
      units: [{ id: 'book', title: null, role: null, text: 'نص الكتاب' }],
      slides: reviewSlidesOf(scenes),
      scenes,
      findings: [finding('f1', 's1', 'S1')],
      heartbeat,
      callReviewer: callReviewer as never,
      recordProgress: vi.fn(async () => {}),
      now: () => 1,
    });
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(regenerate).not.toHaveBeenCalled();
    expect(regenerateAudio).not.toHaveBeenCalled();
    expect(result.findings[0]).toMatchObject({ status: 'open', teacherReason: 'VERSION_CHANGED' });
  });

  it('L-3: a lease check that throws after a paid regeneration is an audio failure; the fix row keeps its regenerationId', async () => {
    const { regenerate, regenerateAudio, callReviewer } = setup({
      scenes,
      findings: [finding('f1', 's1', 'S1')],
    });
    const loop = createPackageReviewFixLoop({
      regenerate: regenerate as never,
      regenerateAudio: regenerateAudio as never,
      readVersion: (async () => ({
        id: 'tpv-1',
        tenantId: 't-1',
        status: 'draft',
        currentStageId: 'stage-1',
      })) as never,
      readScene: async (_pool, _stage, sceneId) => {
        const scene = scenes.find((s) => s.id === sceneId);
        return scene ? { rev: 1, scene } : null;
      },
    });
    // Before the regeneration: kept. After it: the check throws. Before the re-review: kept.
    const beats: Array<() => boolean> = [
      () => true,
      () => {
        throw new Error('database blip');
      },
      () => true,
    ];
    const result = await loop({
      pool: {} as never,
      review: REVIEW,
      units: [{ id: 'book', title: null, role: null, text: 'نص الكتاب' }],
      slides: reviewSlidesOf(scenes),
      scenes,
      findings: [finding('f1', 's1', 'S1')],
      heartbeat: async () => (beats.shift() ?? (() => false))(),
      callReviewer: callReviewer as never,
      recordProgress: vi.fn(async () => {}),
      now: () => 1,
    });
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerateAudio).not.toHaveBeenCalled();
    expect(callReviewer).toHaveBeenCalledTimes(1);
    expect(result.findings[0]).toMatchObject({
      status: 'open',
      teacherReason: 'NARRATION_AUDIO_FAILED',
    });
    expect(result.fixes).toEqual([
      expect.objectContaining({
        sceneId: 's1',
        outcome: 'fixed',
        code: 'NARRATION_AUDIO_FAILED',
        regenerationId: 'tpsr-s1',
      }),
    ]);
  });

  it('LOW-1: the run signal reaches the paid regeneration and the TTS; without one, neither gets a signal', async () => {
    const withSignal = setup({ scenes, findings: [finding('f1', 's1', 'S1')] });
    const controller = new AbortController();
    const loop = createPackageReviewFixLoop({
      regenerate: withSignal.regenerate as never,
      regenerateAudio: withSignal.regenerateAudio as never,
      readVersion: (async () => ({
        id: 'tpv-1',
        tenantId: 't-1',
        status: 'draft',
        currentStageId: 'stage-1',
      })) as never,
      readScene: async (_pool, _stage, sceneId) => {
        const scene = scenes.find((s) => s.id === sceneId);
        return scene ? { rev: 1, scene } : null;
      },
    });
    await loop({
      pool: {} as never,
      review: REVIEW,
      units: [{ id: 'book', title: null, role: null, text: 'نص الكتاب' }],
      slides: reviewSlidesOf(scenes),
      scenes,
      findings: [finding('f1', 's1', 'S1')],
      heartbeat: async () => true,
      callReviewer: withSignal.callReviewer as never,
      recordProgress: vi.fn(async () => {}),
      now: () => 1,
      signal: controller.signal,
    });
    expect(withSignal.regenerate.mock.calls[0]![3]).toMatchObject({ signal: controller.signal });
    expect(withSignal.regenerateAudio.mock.calls[0]![2]).toMatchObject({
      signal: controller.signal,
    });
    const plain = setup({ scenes, findings: [finding('f1', 's1', 'S1')] });
    await plain.run();
    expect(plain.regenerate.mock.calls[0]![3]).not.toHaveProperty('signal');
    expect(plain.regenerateAudio.mock.calls[0]![2]).not.toHaveProperty('signal');
  });

  describe('MEDIUM-1 (D-13): a regeneration an evicted run left uncommitted', () => {
    const abortedReplay = () =>
      new TeachingPackageError(
        'ABORTED',
        'this regeneration failed (ABORTED); nothing was written',
        {
          regenerationId: 'tsr-old',
          failureCode: 'ABORTED',
          replayed: true,
        },
      );
    const succeeded = (sceneId: string) => {
      const next = slide(sceneId, 1, 'مصحح');
      return {
        status: 200,
        body: {
          regenerationId: 'tsr-retry',
          status: 'succeeded',
          replayed: false,
          sceneId,
          scene: next,
          resultSceneRev: 2,
          current: { rev: 2, scene: next },
        },
      };
    };

    it('is fixed automatically on resume through the ONE derived key', async () => {
      const base = fixIdempotencyKey('tpr-abc', 's1');
      const regenerate = vi.fn(
        async (_grant: unknown, sceneId: string, request: { idempotencyKey: string }) => {
          if (request.idempotencyKey === base) throw abortedReplay();
          return succeeded(sceneId);
        },
      );
      const regenerateAudio = vi.fn(async (_grant: unknown, sceneId: string) => ({
        sceneId,
        scene: slide(sceneId, 1, 'مصحح'),
        rev: 3,
        generated: 1,
        missing: 0,
      }));
      const { run } = setup({
        scenes,
        findings: [finding('f1', 's1', 'S1')],
        regenerate,
        regenerateAudio,
      });
      const result = await run();
      expect(regenerate.mock.calls.map((call) => call[2].idempotencyKey)).toEqual([
        base,
        fixRetryIdempotencyKey('tpr-abc', 's1'),
      ]);
      expect(result.findings[0]).toMatchObject({ status: 'fixed', teacherReason: null });
      expect(result.fixes[0]).toMatchObject({ outcome: 'fixed', regenerationId: 'tsr-retry' });
    });

    it('a second ABORTED goes to the teacher, with no third regeneration', async () => {
      const regenerate = vi.fn(async () => {
        throw abortedReplay();
      });
      const { run } = setup({ scenes, findings: [finding('f1', 's1', 'S1')], regenerate });
      const result = await run();
      expect(regenerate).toHaveBeenCalledTimes(2);
      expect(result.findings[0]).toMatchObject({
        status: 'open',
        teacherReason: 'REGENERATION_REFUSED',
      });
      expect(result.fixes[0]).toMatchObject({ outcome: 'refused', code: 'ABORTED' });
    });

    it('MEDIUM: a key reclaimed as LEASE_EXPIRED, or a late commit refused (REGENERATION_LEASE_LOST), is retried once too', async () => {
      for (const failureCode of ['LEASE_EXPIRED', 'REGENERATION_LEASE_LOST']) {
        const base = fixIdempotencyKey('tpr-abc', 's1');
        const regenerate = vi.fn(
          async (_grant: unknown, sceneId: string, request: { idempotencyKey: string }) => {
            if (request.idempotencyKey === base) {
              throw new TeachingPackageError('REGENERATION_LEASE_LOST', 'lease lost', {
                regenerationId: 'tsr-old',
                failureCode,
                replayed: true,
              });
            }
            return succeeded(sceneId);
          },
        );
        const regenerateAudio = vi.fn(async (_grant: unknown, sceneId: string) => ({
          sceneId,
          scene: slide(sceneId, 1, 'مصحح'),
          rev: 3,
          generated: 1,
          missing: 0,
        }));
        const { run } = setup({
          scenes,
          findings: [finding('f1', 's1', 'S1')],
          regenerate,
          regenerateAudio,
        });
        const result = await run();
        expect(regenerate).toHaveBeenCalledTimes(2);
        expect(result.findings[0]).toMatchObject({ status: 'fixed' });
      }
      // A FRESH lease loss (this run's own, not a replay) is never retried.
      const fresh = vi.fn(async () => {
        throw new TeachingPackageError('REGENERATION_LEASE_LOST', 'lease lost');
      });
      const { run } = setup({ scenes, findings: [finding('f1', 's1', 'S1')], regenerate: fresh });
      await run();
      expect(fresh).toHaveBeenCalledTimes(1);
    });

    it('LOW: the lease is renewed right before the paid retry; lost → stop, no retry', async () => {
      const regenerate = vi.fn(async () => {
        throw abortedReplay();
      });
      const { regenerateAudio, callReviewer } = setup({ scenes, findings: [] });
      const beats = [true, false];
      const loop = createPackageReviewFixLoop({
        regenerate: regenerate as never,
        regenerateAudio: regenerateAudio as never,
        readVersion: (async () => ({
          id: 'tpv-1',
          tenantId: 't-1',
          status: 'draft',
          currentStageId: 'stage-1',
        })) as never,
        readScene: async (_pool, _stage, sceneId) => {
          const scene = scenes.find((s) => s.id === sceneId);
          return scene ? { rev: 1, scene } : null;
        },
      });
      const heartbeat = vi.fn(async () => beats.shift() ?? false);
      const result = await loop({
        pool: {} as never,
        review: REVIEW,
        units: [{ id: 'book', title: null, role: null, text: 'نص الكتاب' }],
        slides: reviewSlidesOf(scenes),
        scenes,
        findings: [finding('f1', 's1', 'S1')],
        heartbeat,
        callReviewer: callReviewer as never,
        recordProgress: vi.fn(async () => {}),
        now: () => 1,
      });
      expect(heartbeat).toHaveBeenCalledTimes(2);
      expect(regenerate).toHaveBeenCalledTimes(1);
      expect(result.findings[0]).toMatchObject({
        status: 'open',
        teacherReason: 'VERSION_CHANGED',
      });
    });

    it('any other refusal is not retried', async () => {
      const regenerate = vi.fn(async () => {
        throw new TeachingPackageError('SACRED_TEXT_ALTERED', 'sacred text protected');
      });
      const { run } = setup({ scenes, findings: [finding('f1', 's1', 'S1')], regenerate });
      await run();
      expect(regenerate).toHaveBeenCalledTimes(1);
    });

    it('the derived key stays within the key rules', () => {
      const long = fixRetryIdempotencyKey('tpr-'.padEnd(120, 'x'), 'scene/with spaces');
      expect(long).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
      expect(long.endsWith('-r')).toBe(true);
      expect(fixRetryIdempotencyKey('tpr-abc', 's1')).toBe(
        `${fixIdempotencyKey('tpr-abc', 's1')}-r`,
      );
    });
  });

  it('LOW-3: the slide regeneration lease stays below the review lease (an evicted run’s T2 can never commit after a resume)', () => {
    expect(DEFAULT_SCENE_REGENERATION_LEASE_SECONDS * 1000).toBeLessThan(REVIEW_LEASE_MS);
    // What the service uses when SCENE_REGENERATION_LEASE_SECONDS is not set.
    const saved = process.env.SCENE_REGENERATION_LEASE_SECONDS;
    delete process.env.SCENE_REGENERATION_LEASE_SECONDS;
    try {
      expect(sceneRegenerationLeaseSeconds() * 1000).toBeLessThan(REVIEW_LEASE_MS);
    } finally {
      if (saved !== undefined) process.env.SCENE_REGENERATION_LEASE_SECONDS = saved;
    }
  });

  it('LOW-1: even with SCENE_REGENERATION_LEASE_SECONDS=99999, the lease the fix loop passes stays below the review lease', async () => {
    vi.stubEnv('SCENE_REGENERATION_LEASE_SECONDS', '99999');
    try {
      expect(sceneRegenerationLeaseSeconds()).toBe(99_999); // the editor's lease: unclamped
      const { run, regenerate } = setup({ scenes, findings: [finding('f1', 's1', 'S1')] });
      await run();
      const passed = (regenerate.mock.calls[0]![3] as { leaseSeconds?: number }).leaseSeconds;
      expect(passed).toBe(REVIEWER_REGENERATION_LEASE_MAX_SECONDS);
      expect(passed! * 1000).toBeLessThan(REVIEW_LEASE_MS);
    } finally {
      vi.unstubAllEnvs();
    }
    // Unset: the default lease, already below the cap.
    const { run, regenerate } = setup({ scenes, findings: [finding('f1', 's1', 'S1')] });
    await run();
    expect((regenerate.mock.calls[0]![3] as { leaseSeconds?: number }).leaseSeconds).toBe(
      Math.min(sceneRegenerationLeaseSeconds(), REVIEWER_REGENERATION_LEASE_MAX_SECONDS),
    );
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

describe('g5.v10 quality plan W2: a fix never leaves a slide worse', () => {
  const scenes = [slide('s1', 1, 'أ'), slide('s2', 2, 'ب'), slide('s3', 3, 'ج')];
  const lowS6 = (): StoredFinding => ({ ...finding('f1', 's2', 'S6'), severity: 'low' });
  const audioOf = (order: string[]) =>
    vi.fn(async (_grant, sceneId: string) => {
      order.push(`audio:${sceneId}`);
      return { sceneId, scene: slide(sceneId, 2, 'مع الصوت'), rev: 3, generated: 1, missing: 0 };
    });

  it('worse, then fixed on the one retry: restored first, the retry carries «لا تفعل», audio only for the kept slide', async () => {
    const order: string[] = [];
    const regenerate = regenerateByKey(order, scenes);
    const restore = vi.fn(async (_pool, _grant, id: string) => {
      order.push(`restore:${id}`);
      return { scene: scenes[1]! };
    });
    const { run, callReviewer } = setup({
      scenes,
      findings: [lowS6()],
      learnerFirst: true,
      order,
      regenerate,
      regenerateAudio: audioOf(order),
      restore,
      // The first fix misreads the times (item 208's f1); the retry is clean.
      rereview: (focus, text) => (text === 'مصحح' ? [worse(focus)] : []),
    });
    const result = await run();
    expect(order).toEqual([
      'regenerate:s2',
      'rereview:s2',
      'restore:tpsr-s2',
      'regenerate:s2:retry',
      'rereview:s2',
      'audio:s2',
    ]);
    expect(callReviewer).toHaveBeenCalledTimes(2);
    const retry = regenerate.mock.calls[1]![2] as { instruction: string; idempotencyKey: string };
    expect(retry.idempotencyKey).toBe(`${fixIdempotencyKey('tpr-abc', 's2')}-w`);
    expect(retry.instruction).toContain('(S6) صحح f1');
    expect(retry.instruction).toContain('لا تفعل ذلك مرة أخرى');
    expect(retry.instruction).toContain('الأوقات تُقرأ ثمانية وثلاثين');
    expect(result.findings.map((f) => [f.id, f.status, f.teacherReason])).toEqual([
      ['f1', 'fixed', null],
    ]);
    expect(result.fixes).toEqual([
      expect.objectContaining({ outcome: 'fixed', regenerationId: 'tpsr-s2-w', code: null }),
    ]);
  });

  it('worse twice: the slide the review read is restored, no TTS is paid, the finding stays open', async () => {
    const order: string[] = [];
    const restore = vi.fn(async (_pool, _grant, id: string) => {
      order.push(`restore:${id}`);
      return { scene: scenes[1]! };
    });
    const regenerateAudio = audioOf(order);
    const { run } = setup({
      scenes,
      findings: [{ ...finding('f1', 's2', 'S1'), severity: 'medium' }],
      learnerFirst: true,
      order,
      regenerate: regenerateByKey(order, scenes),
      regenerateAudio,
      restore,
      // Both attempts bring in a wrong method (item 208's f15).
      rereview: (focus) => [worse(focus, 'S2')],
    });
    const result = await run();
    expect(order).toEqual([
      'regenerate:s2',
      'rereview:s2',
      'restore:tpsr-s2',
      'regenerate:s2:retry',
      'rereview:s2',
      'restore:tpsr-s2-w',
    ]);
    expect(regenerateAudio).not.toHaveBeenCalled();
    expect(result.findings.map((f) => [f.id, f.status, f.teacherReason])).toEqual([
      ['f1', 'open', 'STILL_WRONG'],
    ]);
    expect(result.fixes).toEqual([
      expect.objectContaining({
        outcome: 'still_wrong',
        code: 'FIX_ROLLED_BACK',
        regenerationId: 'tpsr-s2-w',
      }),
    ]);
  });

  it('review MED-3: a resumed run whose fix was already restored goes straight to the retry', async () => {
    const order: string[] = [];
    const base = regenerateByKey(order, scenes);
    // Key 1 replays: the evicted run restored the slide (live rev 3 ≠ its result rev 2).
    const regenerate = vi.fn(
      async (grant, sceneId: string, request: { idempotencyKey: string }) => {
        const answer = await base(grant, sceneId, request);
        if (request.idempotencyKey.endsWith('-w')) return answer;
        return {
          ...answer,
          body: {
            ...answer.body,
            replayed: true,
            current: { rev: 3, scene: scenes[1]! },
          },
        };
      },
    );
    const restore = vi.fn();
    const { run, callReviewer } = setup({
      scenes,
      findings: [lowS6()],
      learnerFirst: true,
      order,
      regenerate,
      regenerateAudio: audioOf(order),
      restore,
      rereview: () => [],
    });
    const result = await run();
    expect(order).toEqual(['regenerate:s2', 'regenerate:s2:retry', 'rereview:s2', 'audio:s2']);
    expect(callReviewer).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    expect(result.fixes).toEqual([
      expect.objectContaining({ outcome: 'fixed', regenerationId: 'tpsr-s2-w' }),
    ]);
  });

  it('the same check at the same severity is still wrong, not worse: no restore', async () => {
    const order: string[] = [];
    const restore = vi.fn();
    const { run } = setup({
      scenes,
      findings: [finding('f1', 's2', 'S2')],
      learnerFirst: true,
      order,
      regenerate: regenerateByKey(order, scenes),
      regenerateAudio: audioOf(order),
      restore,
      rereview: (focus) => [worse(focus, 'S2')],
    });
    const result = await run();
    expect(restore).not.toHaveBeenCalled();
    expect(order).toEqual(['regenerate:s2', 'rereview:s2', 'audio:s2']);
    expect(result.findings.map((f) => [f.id, f.teacherReason])).toEqual([
      ['f1', 'STILL_WRONG'],
      ['r-2-1', 'STILL_WRONG'],
    ]);
  });

  it('v1 (not learner-first) keeps the old flow: no restore, audio before the one re-review', async () => {
    const order: string[] = [];
    const restore = vi.fn();
    const { run } = setup({
      scenes,
      findings: [lowS6()],
      order,
      regenerate: regenerateByKey(order, scenes),
      regenerateAudio: audioOf(order),
      restore,
      rereview: (focus) => [worse(focus)],
    });
    await run();
    expect(restore).not.toHaveBeenCalled();
    expect(order).toEqual(['regenerate:s2', 'audio:s2', 'rereview:s2']);
  });

  it('worseningFindings: a new High/S2/S6 or a higher severity of the fixed check; never an error already open', () => {
    const fixed = [{ ...finding('f1', 's2', 'S6'), severity: 'low' as const }];
    const none = new Set<string>();
    const of = (check: string, severity: string) => worse('s2', check, severity) as never;
    expect(worseningFindings([of('S6', 'high')], fixed, none)).toHaveLength(1);
    expect(worseningFindings([of('S6', 'low')], fixed, none)).toHaveLength(0);
    expect(worseningFindings([of('S2', 'low')], fixed, none)).toHaveLength(1);
    expect(worseningFindings([of('S1', 'high')], fixed, none)).toHaveLength(1);
    expect(worseningFindings([of('S1', 'medium')], fixed, none)).toHaveLength(0);
    expect(worseningFindings([of('S2', 'high')], fixed, new Set(['S2']))).toHaveLength(0);
  });
});
