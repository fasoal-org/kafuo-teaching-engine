/**
 * The package reviewer's fix loop (ai-reviewer-layer plan D-1, §4.3, §4.4).
 *
 * For each slide with an auto-fixable open finding, ONCE:
 *   1. regenerate it through `regenerateSlideScene` under the system actor
 *      `system:package-reviewer`, with the finding's fix note as the
 *      instruction (the only text the slide writer sees);
 *   2. re-synthesise its narration through `scene-narration-audio.ts`, so a
 *      learner never hears old audio over a new slide;
 *   3. re-review ONLY that slide, with its neighbours (as they are now) as context.
 * A finding whose check the re-review no longer reports is `fixed` — unless the
 * slide's narration audio failed (`NARRATION_AUDIO_FAILED`, D-5), or (RV-4) it is
 * a HIGH finding and the re-review still reports any HIGH error on the slide. `fixed`
 * is written here only, always after a re-check of the regenerated slide. Reported
 * again, refused, not re-reviewed (`REREVIEW_UNAVAILABLE`) or not attempted →
 * it stays open with the reason the teacher reads; a new, different error the
 * re-review found is added open (`NOT_ATTEMPTED`).
 *
 * g5.v10 (quality plan W2): the re-review runs before the audio. A fix that made
 * the slide worse (`worseningFindings`) is restored from its pre-image and runs
 * once more with what it broke as «لا تفعل»; worse again → restored, and the
 * finding stays open (`STILL_WRONG`, fix code `FIX_ROLLED_BACK`).
 *
 * Teacher-only, never regenerated: S5 (a slide cannot be added or moved after
 * Scenes exist), a bank quiz, and a quiz check on a non-quiz Scene.
 *
 * Stops cleanly — before any further paid call — when the version is no
 * longer the `draft` on the reviewed Stage, or a slide changed since the
 * review read it; every finding not yet handled stays open (`VERSION_CHANGED`).
 * The idempotency key is derived from the review and the Scene, so a resumed
 * review replays a finished regeneration instead of paying for it again.
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { labelScriptChanged } from '@/lib/server/teaching-package/label-script-check';
import { createLogger } from '@/lib/logger';
import { readVersionById } from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  sceneToReviewSlide,
  type ReviewSlide,
} from '@/lib/server/teaching-package/package-review-input';
import {
  GENERATION_ISSUE_CHECK,
  LABEL_SCRIPT_CHECK,
  PACKAGE_QUIZ_CHECKS,
  type ReviewerFinding,
} from '@/lib/server/teaching-package/package-review-prompt';
import type {
  StoredFinding,
  StoredFix,
  TeacherReason,
} from '@/lib/server/teaching-package/package-review-store';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import { regenerateSceneNarrationAudio } from '@/lib/server/teaching-package/scene-narration-audio';
import {
  regenerateSlideScene,
  restoreSlideScene,
  SCENE_REGENERATION_LIMITS,
  type RegenerationGrant,
} from '@/lib/server/teaching-package/scene-regeneration';
import {
  readLiveScene,
  sceneRegenerationLeaseSeconds,
} from '@/lib/server/teaching-package/scene-regeneration-store';
import type { AppScene } from '@/lib/types/stage';
import type {
  FixLoop,
  FixLoopContext,
  ReviewCallAnswer,
} from '@/lib/server/teaching-package/package-review';

const log = createLogger('PackageReviewFixLoop');

/** The system actor every reviewer regeneration is recorded under (plan §4.4). */
export const PACKAGE_REVIEWER_ACTOR = 'system:package-reviewer';

/**
 * The checks a regeneration may fix (plan §4.3); S5 is the teacher's. g5.v10's S6
 * (screen and narration disagree, an item left unexplained) is fixed by regenerating
 * the slide. Its S7 (a weak-student call: a letter read by its Arabic name, a claim
 * tested before it is stated, a drawing against its givens) is fixed the same way
 * since the quality plan W2 (owner: zero manual corrections, 15 Nov 2026). S6/S7
 * exist only in package-review-v2, so v1 reviews are unchanged.
 */
const AUTO_FIX_CHECKS: ReadonlySet<string> = new Set([
  // 21 Nov 2026: G1 is the server-stated "kept generation issue" finding; the slide is
  // regenerated once exactly like any other auto-fixable finding.
  'G1',
  'G2',
  'S1',
  'S2',
  'S3',
  'S4',
  'S6',
  'S7',
  'Q1',
  'Q2',
  'Q5',
]);

const SEVERITY_RANK: Readonly<Record<string, number>> = { low: 1, medium: 2, high: 3 };

/**
 * RV-4: the server's own findings, each closed by a deterministic re-check of the
 * live scene (G1: no kept generation issue; G2: the book's Latin labels), never by
 * the reviewer's re-review alone.
 */
const SERVER_CHECKS: ReadonlySet<string> = new Set([GENERATION_ISSUE_CHECK, LABEL_SCRIPT_CHECK]);

/**
 * g5.v10 quality plan W2: the re-review findings that show a fix made its slide
 * WORSE — a new High, S2 (wrong working) or S6 (screen and voice disagree) that
 * the fix did not target, or a targeted check reported at a higher severity than
 * the finding it fixed (item 208's f1: a Low S6 note gave a High S6 misread time).
 * An error already open on the slide outside the fix is not "new".
 */
export function worseningFindings(
  rereview: readonly ReviewerFinding[],
  targeted: readonly StoredFinding[],
  alreadyOpenChecks: ReadonlySet<string>,
): ReviewerFinding[] {
  const targetedRank = new Map<string, number>();
  for (const finding of targeted) {
    const rank = SEVERITY_RANK[finding.severity] ?? 0;
    targetedRank.set(finding.check, Math.max(rank, targetedRank.get(finding.check) ?? 0));
  }
  return rereview.filter((finding) => {
    if (alreadyOpenChecks.has(finding.check)) return false;
    const rank = SEVERITY_RANK[finding.severity] ?? 0;
    const before = targetedRank.get(finding.check);
    if (before !== undefined) return rank > before;
    return finding.severity === 'high' || finding.check === 'S2' || finding.check === 'S6';
  });
}

/** Findings no regeneration can fix (plan §4.3): they go straight to the teacher. */
export function teacherOnlyReason(
  finding: StoredFinding,
  slides: readonly ReviewSlide[],
): TeacherReason | null {
  if (finding.check === 'S5') return 'S5_TEACHER_ONLY';
  const slide = slides.find((candidate) => candidate.id === finding.targetId);
  if (!slide) return 'S5_TEACHER_ONLY';
  if (slide.bankQuiz) return 'BANK_QUIZ_NOT_REGENERABLE';
  const isQuizCheck = (PACKAGE_QUIZ_CHECKS as readonly string[]).includes(finding.check);
  if (isQuizCheck && slide.sceneType !== 'quiz') return 'REGENERATION_REFUSED';
  if (!AUTO_FIX_CHECKS.has(finding.check)) return 'REGENERATION_REFUSED';
  return null;
}

/**
 * One instruction for one regeneration: every open note of the slide, within the
 * limits. W2's retry adds what the rolled-back attempt broke, as «لا تفعل».
 */
export function fixInstruction(
  findings: readonly StoredFinding[],
  avoid: readonly ReviewerFinding[] = [],
): string {
  const lines = findings.map((finding) => `- (${finding.check}) ${finding.fixNote}`);
  let text = `صحّح هذه الشريحة حسب ملاحظات مراجعة الكتاب، ولا تغيّر غير ذلك:\n${lines.join('\n')}`;
  if (avoid.length > 0) {
    const broke = avoid.map((finding) => `- ${finding.whatIsWrong}`);
    text += `\nمحاولة سابقة لهذا التصحيح أفسدت الشريحة؛ لا تفعل ذلك مرة أخرى، واحتفظ بكل ما كان صحيحًا:\n${broke.join('\n')}`;
  }
  const { max } = SCENE_REGENERATION_LIMITS.instruction;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Deterministic, within the key rules (`[A-Za-z0-9_-]`, 8–128). */
export function fixIdempotencyKey(reviewId: string, sceneId: string): string {
  const key = `rv-${reviewId}-${sceneId}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return key.length > SCENE_REGENERATION_LIMITS.idempotencyKey.max
    ? key.slice(0, SCENE_REGENERATION_LIMITS.idempotencyKey.max)
    : key;
}

/**
 * LOW-1: the reviewer's slide regenerations never hold a lease as long as the
 * review lease (40 min), whatever `SCENE_REGENERATION_LEASE_SECONDS` says, so
 * an evicted run's T2 can never commit after the review was resumed. A local
 * constant: importing the review lease from `package-review` would close an
 * import cycle. The editor's own regenerations are untouched.
 */
export const REVIEWER_REGENERATION_LEASE_MAX_SECONDS = 20 * 60;

/** The lease the reviewer's slide regenerations run under. */
export function reviewerRegenerationLeaseSeconds(): number {
  return Math.min(sceneRegenerationLeaseSeconds(), REVIEWER_REGENERATION_LEASE_MAX_SECONDS);
}

/**
 * MEDIUM-1 (D-13): the one derived key used after this slide's regeneration
 * was left uncommitted. Deterministic, so a later resume replays it too (a
 * succeeded K-r costs nothing again).
 */
export function fixRetryIdempotencyKey(reviewId: string, sceneId: string): string {
  const base = fixIdempotencyKey(reviewId, sceneId);
  const max = SCENE_REGENERATION_LIMITS.idempotencyKey.max;
  return `${base.length > max - 2 ? base.slice(0, max - 2) : base}-r`;
}

/** W2: the one derived key of the retry after a fix made the slide worse. */
export function fixWorseRetryIdempotencyKey(reviewId: string, sceneId: string): string {
  const base = fixIdempotencyKey(reviewId, sceneId);
  const max = SCENE_REGENERATION_LIMITS.idempotencyKey.max;
  return `${base.length > max - 2 ? base.slice(0, max - 2) : base}-w`;
}

/**
 * The stored failures of a regeneration left uncommitted — nothing of it was
 * ever committed: T2's scene write and the move to `succeeded` are one
 * transaction, and the failure write and the lease reclaim touch only
 * `running` rows. After an eviction (regeneration lease ≤ 20 min, review
 * lease 40 min) the resumed run usually finds the row reclaimed
 * (`LEASE_EXPIRED`) or its late commit refused (`REGENERATION_LEASE_LOST`);
 * `ABORTED` is a call the eviction stopped.
 */
const UNCOMMITTED_FAILURES: ReadonlySet<string> = new Set([
  'ABORTED',
  'LEASE_EXPIRED',
  'REGENERATION_LEASE_LOST',
]);

/** A replay of a regeneration left uncommitted. */
function isUncommittedReplay(error: unknown): boolean {
  if (!(error instanceof TeachingPackageError)) return false;
  const details = error.details as { replayed?: unknown; failureCode?: unknown } | undefined;
  return (
    details?.replayed === true &&
    typeof details.failureCode === 'string' &&
    UNCOMMITTED_FAILURES.has(details.failureCode)
  );
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/** The slide and its neighbours by display order, the changed slide replaced. */
function neighbourhood(slides: readonly ReviewSlide[], changed: ReviewSlide): ReviewSlide[] {
  const ordered = slides.map((slide) => (slide.id === changed.id ? changed : slide));
  const index = ordered.findIndex((slide) => slide.id === changed.id);
  return ordered.slice(Math.max(0, index - 1), index + 2);
}

/** What the reviewer saw, compared with what the database holds now. */
function sceneChanged(live: AppScene, reviewed: AppScene | undefined): boolean {
  if (!reviewed) return true;
  const material = (scene: AppScene) =>
    JSON.stringify({ content: scene.content, actions: scene.actions, title: scene.title });
  return material(live) !== material(reviewed);
}

export interface FixLoopDeps {
  regenerate?: typeof regenerateSlideScene;
  /** W2: puts a regeneration's pre-image back (production: `restoreSlideScene`). */
  restore?: (
    pool: ConnectableQueryable,
    grant: RegenerationGrant,
    regenerationId: string,
  ) => Promise<{ scene: AppScene }>;
  regenerateAudio?: typeof regenerateSceneNarrationAudio;
  readVersion?: typeof readVersionById;
  readScene?: (
    pool: ConnectableQueryable,
    stageId: string,
    sceneId: string,
  ) => Promise<{ rev: number; scene: AppScene } | null>;
}

export function createPackageReviewFixLoop(deps: FixLoopDeps = {}): FixLoop {
  const regenerate = deps.regenerate ?? regenerateSlideScene;
  const restore = deps.restore ?? restoreSlideScene;
  const regenerateAudio = deps.regenerateAudio ?? regenerateSceneNarrationAudio;
  const readVersion = deps.readVersion ?? readVersionById;
  const readScene =
    deps.readScene ?? ((pool, stageId, sceneId) => readLiveScene(pool, stageId, sceneId));

  return async (context: FixLoopContext) => {
    const { pool, review, slides } = context;
    const findings = context.findings.map((finding) => ({ ...finding }));
    const fixes: StoredFix[] = [...review.fixes];
    const handled = new Set(fixes.map((fix) => fix.sceneId));
    const grant: RegenerationGrant = {
      tenantId: review.tenantId,
      versionId: review.versionId,
      stageId: review.stageId,
      learnerKey: PACKAGE_REVIEWER_ACTOR,
    };

    // 1. Teacher-only findings are marked first and never regenerated.
    for (const finding of findings) {
      if (finding.status !== 'open' || finding.teacherReason !== null) continue;
      const reason = teacherOnlyReason(finding, slides);
      if (reason) finding.teacherReason = reason;
    }

    // 2. One regeneration per slide, in display order.
    const targets = slides.filter((slide) =>
      findings.some(
        (finding) =>
          finding.targetId === slide.id &&
          finding.status === 'open' &&
          finding.teacherReason === null,
      ),
    );
    const scenesById = new Map(context.scenes.map((scene) => [scene.id, scene]));
    // L-3: the slides as they are now — a slide regenerated earlier in this loop
    // is shown to a later re-review in its new form.
    const currentSlides = new Map(slides.map((candidate) => [candidate.id, candidate]));
    const mark = (sceneId: string, reason: TeacherReason) => {
      for (const finding of findings) {
        if (
          finding.targetId === sceneId &&
          finding.status === 'open' &&
          finding.teacherReason === null
        ) {
          finding.teacherReason = reason;
        }
      }
    };
    let stopped = false;

    for (const slide of targets) {
      if (stopped) {
        mark(slide.id, 'VERSION_CHANGED');
        continue;
      }
      if (handled.has(slide.id)) {
        // A resume: this slide was already handled by an earlier run.
        mark(slide.id, 'STILL_WRONG');
        continue;
      }
      const sceneFindings = findings.filter(
        (finding) =>
          finding.targetId === slide.id &&
          finding.status === 'open' &&
          finding.teacherReason === null,
      );
      // The second guard (plan §4.6): still the draft on the reviewed Stage, and
      // the slide is what the reviewer read. Checked before every paid step.
      const version = await readVersion(pool, review.versionId);
      const live = await readScene(pool, review.stageId, slide.id);
      if (
        !version ||
        version.status !== 'draft' ||
        version.currentStageId !== review.stageId ||
        !live ||
        sceneChanged(live.scene, scenesById.get(slide.id))
      ) {
        stopped = true;
        mark(slide.id, 'VERSION_CHANGED');
        fixes.push({
          sceneId: slide.id,
          findingIds: sceneFindings.map((f) => f.id),
          outcome: 'stopped',
          code: 'VERSION_CHANGED',
        });
        await context.recordProgress(findings, fixes);
        continue;
      }
      // HIGH-1: the lease, renewed AFTER those reads and right before the paid
      // regeneration — a stall in the reads never pays under a lost lease.
      if (!(await context.heartbeat())) {
        stopped = true;
        mark(slide.id, 'VERSION_CHANGED');
        continue;
      }

      let regenerated: AppScene;
      let regenerationId: string | null = null;
      // RV-5: the model that served this slide's last answered re-review.
      let served: Pick<StoredFix, 'reviewModel' | 'reviewProvider'> = {
        reviewModel: null,
        reviewProvider: null,
      };
      const noteServed = (call: ReviewCallAnswer['call']) => {
        served = { reviewModel: call.modelString ?? null, reviewProvider: call.provider ?? null };
      };
      // W2 resume (review MED-3): this slide's fix is a replay whose live slide is no
      // longer its result — an evicted run already restored it (or retried it).
      let replayedAway = false;
      const regenerateWith = (idempotencyKey: string, avoid: readonly ReviewerFinding[] = []) =>
        regenerate(
          grant,
          slide.id,
          {
            instruction: fixInstruction(sceneFindings, avoid),
            reason: `مراجعة الذكاء الاصطناعي ${review.id}: ${[...new Set(sceneFindings.map((f) => f.check))].join(', ')}`,
            idempotencyKey,
          },
          {
            pool,
            actor: { actorRef: PACKAGE_REVIEWER_ACTOR, sessionRef: null },
            // LOW-1: an evicted run's regeneration stops with its signal.
            ...(context.signal ? { signal: context.signal } : {}),
            // LOW-1 (last round): never a lease as long as the review lease.
            leaseSeconds: reviewerRegenerationLeaseSeconds(),
            // Owner, 25 Nov 2026: an editor regeneration is voiced before it is saved; this
            // loop voices a fix only after its re-review keeps it (no TTS paid for a fix
            // that is undone), so the regeneration itself stays silent here.
            voice: async (candidate) => candidate,
          },
        );
      let attempt = await settle(regenerateWith(fixIdempotencyKey(review.id, slide.id)));
      if (!attempt.ok && isUncommittedReplay(attempt.error)) {
        // MEDIUM-1 (D-13, zero manual corrections): an evicted run's
        // regeneration of this slide ended without a commit, so its key
        // replays a failure. Regenerate ONCE more under the derived key; a
        // failure of that one goes to the teacher.
        log.warn(
          `review ${review.id}: ${slide.id} was left uncommitted by an evicted run; one retry`,
        );
        // LOW: the lease again, right before the paid retry (as before the first).
        if (!(await context.heartbeat())) {
          stopped = true;
          mark(slide.id, 'VERSION_CHANGED');
          continue;
        }
        attempt = await settle(regenerateWith(fixRetryIdempotencyKey(review.id, slide.id)));
      }
      try {
        if (!attempt.ok) throw attempt.error;
        const response = attempt.value;
        if (response.status !== 200) {
          throw new TeachingPackageError(
            'SCENE_REGENERATION_IN_PROGRESS',
            'another regeneration of this slide is in progress',
          );
        }
        regenerationId = response.body.regenerationId;
        regenerated = response.body.current?.scene ?? response.body.scene;
        replayedAway =
          response.body.replayed === true &&
          response.body.current != null &&
          response.body.current.rev !== response.body.resultSceneRev;
      } catch (error) {
        const code = error instanceof TeachingPackageError ? error.code : 'REGENERATION_FAILED';
        log.warn(
          `review ${review.id}: regeneration of ${slide.id} refused (${code})`,
          JSON.stringify(describeErrorSafely(error)),
        );
        if (code === 'STAGE_LOCKED' || code === 'NOT_FOUND' || code === 'STAGE_NOT_LIVE') {
          stopped = true;
          mark(slide.id, 'VERSION_CHANGED');
          fixes.push({
            sceneId: slide.id,
            findingIds: sceneFindings.map((f) => f.id),
            outcome: 'stopped',
            code,
          });
        } else {
          mark(slide.id, 'REGENERATION_REFUSED');
          fixes.push({
            sceneId: slide.id,
            findingIds: sceneFindings.map((f) => f.id),
            outcome: 'refused',
            code,
          });
        }
        await context.recordProgress(findings, fixes);
        continue;
      }

      // g5.v10 quality plan W2: re-review BEFORE the narration audio, so a fix that
      // made the slide worse is undone before any TTS is paid for it. Worse → the
      // pre-image is restored and the fix runs once more with «لا تفعل»; worse again
      // → restored for good. Item 208 kept f1 (times misread) and f15 (average change).
      let rereview: ReviewerFinding[] | null = null;
      let reviewed = false;
      if (context.learnerFirst) {
        const targetedIds = new Set(sceneFindings.map((finding) => finding.id));
        const openOutside = new Set(
          findings
            .filter(
              (finding) =>
                finding.targetId === slide.id &&
                finding.status === 'open' &&
                !targetedIds.has(finding.id),
            )
            .map((finding) => finding.check),
        );
        const rereviewOf = async (scene: AppScene): Promise<ReviewerFinding[] | null> => {
          const candidate = sceneToReviewSlide(scene);
          const around = slides.map((other) =>
            other.id === slide.id ? candidate : (currentSlides.get(other.id) ?? other),
          );
          try {
            if (!(await context.heartbeat())) throw new Error('lease lost');
            const { answer, call } = await context.callReviewer({
              review,
              units: context.units,
              slides: neighbourhood(around, candidate),
              focusIds: new Set([slide.id]),
            });
            noteServed(call);
            return answer.findings.filter((finding) => finding.targetId === slide.id);
          } catch (error) {
            log.warn(
              `review ${review.id}: re-review of ${slide.id} failed`,
              JSON.stringify(describeErrorSafely(error)),
            );
            return null;
          }
        };
        /** Puts the pre-image back; null when the store refused (the slide stays as it is). */
        const restoreOf = async (id: string): Promise<AppScene | null> => {
          try {
            return (await restore(pool, grant, id)).scene;
          } catch (error) {
            log.warn(
              `review ${review.id}: restoring ${slide.id} failed`,
              JSON.stringify(describeErrorSafely(error)),
            );
            return null;
          }
        };
        const rollBack = async (restored: AppScene, id: string | null) => {
          scenesById.set(slide.id, restored);
          currentSlides.set(slide.id, sceneToReviewSlide(restored));
          for (const finding of sceneFindings) finding.teacherReason = 'STILL_WRONG';
          fixes.push({
            sceneId: slide.id,
            findingIds: sceneFindings.map((f) => f.id),
            outcome: 'still_wrong',
            code: 'FIX_ROLLED_BACK',
            regenerationId: id,
            ...served,
          });
          log.info(`review ${review.id}: ${slide.id} rolled back (the fix made it worse)`);
          await context.recordProgress(findings, fixes);
        };

        // A replay an earlier run already restored is never re-reviewed as the fix:
        // it goes straight to the one retry (whose `-w` replay returns and checks any
        // retry that run left unchecked).
        const first = replayedAway ? null : await rereviewOf(regenerated);
        const firstWorse = first ? worseningFindings(first, sceneFindings, openOutside) : [];
        if (first && firstWorse.length === 0) {
          rereview = first;
          reviewed = true;
        } else if ((first && regenerationId) || replayedAway) {
          const original = replayedAway ? regenerated : await restoreOf(regenerationId!);
          if (!original) {
            // The store refused the restore: the old flow (the new errors are recorded).
            rereview = first;
            reviewed = true;
          } else if (!(await context.heartbeat())) {
            stopped = true;
            scenesById.set(slide.id, original);
            mark(slide.id, 'VERSION_CHANGED');
            continue;
          } else {
            const retry = await settle(
              regenerateWith(fixWorseRetryIdempotencyKey(review.id, slide.id), firstWorse),
            );
            const retried =
              retry.ok && retry.value.status === 200
                ? {
                    scene: retry.value.body.current?.scene ?? retry.value.body.scene,
                    id: retry.value.body.regenerationId,
                  }
                : null;
            const second = retried ? await rereviewOf(retried.scene) : null;
            const secondWorse = second ? worseningFindings(second, sceneFindings, openOutside) : [];
            if (retried && second && secondWorse.length === 0) {
              regenerated = retried.scene;
              regenerationId = retried.id;
              rereview = second;
              reviewed = true;
            } else {
              // The retry failed, went unchecked or was worse again: the slide the
              // review read stays live (its audio with it), and the finding stays open.
              const restored = retried ? await restoreOf(retried.id) : original;
              if (restored) {
                await rollBack(restored, retried?.id ?? regenerationId);
                continue;
              }
              // The retried slide could not be undone: keep it, with what was found.
              regenerated = retried!.scene;
              regenerationId = retried!.id;
              rereview = second;
              reviewed = second !== null;
            }
          }
        }
      }

      // LOW-4: the regeneration may have taken long; a run that lost its lease
      // never pays for the narration audio (TTS) — the run that took over does.
      let audioCode: string | null = null;
      let leaseKept: boolean;
      try {
        leaseKept = await context.heartbeat();
      } catch (error) {
        // L-3: the slide is already regenerated (paid); a lease check that
        // fails is an audio failure, never a review that ends without the
        // fix row of a live regenerated slide.
        log.warn(
          `review ${review.id}: lease check after regenerating ${slide.id} failed; no audio`,
          JSON.stringify(describeErrorSafely(error)),
        );
        audioCode = 'NARRATION_AUDIO_FAILED';
        leaseKept = true;
      }
      if (!leaseKept) {
        stopped = true;
        mark(slide.id, 'VERSION_CHANGED');
        continue;
      }

      // The new slide's narration audio (a regeneration never runs TTS).
      if (audioCode === null) {
        try {
          const audio = await regenerateAudio(grant, slide.id, {
            pool,
            actorRef: PACKAGE_REVIEWER_ACTOR,
            // LOW-1: an evicted run's TTS stops with its signal and writes no audio.
            ...(context.signal ? { signal: context.signal } : {}),
          });
          regenerated = audio.scene;
          if (audio.missing > 0) audioCode = 'NARRATION_AUDIO_PARTIAL';
        } catch (error) {
          audioCode = error instanceof TeachingPackageError ? error.code : 'NARRATION_AUDIO_FAILED';
          log.warn(
            `review ${review.id}: narration audio for ${slide.id} not regenerated (${audioCode})`,
          );
        }
      }
      scenesById.set(slide.id, regenerated);

      // Re-review this slide only, with its neighbours (as they are now) as context.
      const changed = sceneToReviewSlide(regenerated);
      currentSlides.set(slide.id, changed);
      const nowSlides = slides.map((candidate) => currentSlides.get(candidate.id) ?? candidate);
      // W2: a v10 slide was already re-reviewed before its audio (the text is the same).
      if (!reviewed) {
        try {
          if (!(await context.heartbeat())) throw new Error('lease lost');
          const { answer, call } = await context.callReviewer({
            review,
            units: context.units,
            slides: neighbourhood(nowSlides, changed),
            focusIds: new Set([slide.id]),
          });
          noteServed(call);
          rereview = answer.findings.filter((finding) => finding.targetId === slide.id);
        } catch (error) {
          log.warn(
            `review ${review.id}: re-review of ${slide.id} failed`,
            JSON.stringify(describeErrorSafely(error)),
          );
        }
      }

      if (rereview === null) {
        // L-2: the new slide was never checked again — not "still wrong" (the
        // finding's reason says so). LOW-2: an audio failure keeps its code here.
        mark(slide.id, 'REREVIEW_UNAVAILABLE');
        fixes.push({
          sceneId: slide.id,
          findingIds: sceneFindings.map((f) => f.id),
          outcome: 'still_wrong',
          code: audioCode ?? 'REREVIEW_UNAVAILABLE',
          regenerationId,
          ...served,
        });
        await context.recordProgress(findings, fixes);
        continue;
      }

      // L-2: an original finding stays wrong only when the re-review reports its
      // check again; a re-review with only different findings closes it.
      const reportedChecks = new Set(rereview.map((finding) => finding.check));
      // g5.v10 (learner-first plan W4): a fix that leaves the narration disagreeing
      // with the new canvas (a new S6, package-review-v2 only) did not fix the slide —
      // item 208's «اليمين»/«اليسار» fix was closed as fixed. Never reached on v1.
      const fixBrokeNarration = reportedChecks.has('S6');
      // 21 Nov 2026: a G1 (kept generation issue) is decided from the live scene, not
      // the re-review — the reviewer's rubric never reports it. Still broken after the
      // one regeneration ⇒ stays open for a person; clean ⇒ fixed.
      const liveIssueCodes = (regenerated.generationIssues ?? [])
        .filter((issue) => issue.code !== 'GUIDE_ANSWER_LEAK')
        .map((issue) => issue.code);
      // D2: a G2 (label script) is decided from the live scene too — the regenerated
      // canvas either kept the book's Latin labels or rewrote them again.
      const liveSlide = sceneToReviewSlide(regenerated);
      const unitTextOf = new Map(context.units.map((unit) => [String(unit.id), unit.text ?? '']));
      const liveLabelWrong = sceneFindings.some(
        (finding) =>
          finding.check === 'G2' &&
          labelScriptChanged(
            liveSlide.visibleText,
            (liveSlide.citedUnitIds ?? []).map((id) => unitTextOf.get(String(id)) ?? '').join('\n'),
          ),
      );
      // RV-4 (27 Nov 2026): a HIGH finding the reviewer raised is closed only by a
      // re-check that shows its slide clean of HIGH errors. Under L-2 alone, a
      // re-review that names the same error under another check code (S1 → S3,
      // say) closed the original; a HIGH one now stays open (`STILL_WRONG`) while
      // the re-check of its slide reports any HIGH error. G1/G2 keep their own
      // deterministic re-check from the live scene (above). Medium and low
      // findings keep L-2. No new status, no extra regeneration.
      const rereviewHasHigh = rereview.some((finding) => finding.severity === 'high');
      const highStillOpen = (finding: StoredFinding) =>
        finding.severity === 'high' && !SERVER_CHECKS.has(finding.check) && rereviewHasHigh;
      let stillWrong = false;
      for (const finding of sceneFindings) {
        if (finding.check === 'G1' && liveIssueCodes.length > 0) {
          finding.teacherReason = 'STILL_WRONG';
          stillWrong = true;
        } else if (finding.check === 'G2' && liveLabelWrong) {
          finding.teacherReason = 'STILL_WRONG';
          stillWrong = true;
        } else if (
          reportedChecks.has(finding.check) ||
          fixBrokeNarration ||
          highStillOpen(finding)
        ) {
          finding.teacherReason = 'STILL_WRONG';
          stillWrong = true;
        } else if (audioCode !== null) {
          // D-5: the content is fixed, but the slide has no (or partial) audio.
          finding.teacherReason = 'NARRATION_AUDIO_FAILED';
        } else {
          finding.status = 'fixed';
          finding.teacherReason = null;
        }
      }
      const originalChecks = new Set(sceneFindings.map((finding) => finding.check));
      // LOW-5: an error already open on this slide outside this regeneration
      // (a teacher-only S5, say) is not added a second time.
      const targetedIds = new Set(sceneFindings.map((finding) => finding.id));
      const alreadyOpen = new Set(
        findings
          .filter(
            (finding) =>
              finding.targetId === slide.id &&
              finding.status === 'open' &&
              !targetedIds.has(finding.id),
          )
          .map((finding) => finding.check),
      );
      // 15 Nov 2026: an id never repeats in one review. A flagged-slide
      // regeneration runs this loop again on findings an earlier run added
      // (`r-<order>-<n>`), so the plain id could already be taken.
      const usedIds = new Set(findings.map((finding) => finding.id));
      const freshId = (base: string) => {
        let id = base;
        for (let n = 2; usedIds.has(id); n += 1) id = `${base}-${n}`;
        usedIds.add(id);
        return id;
      };
      findings.push(
        ...rereview
          .filter((finding) => !alreadyOpen.has(finding.check))
          .map((finding, index) => {
            const added: StoredFinding = {
              id: freshId(`r-${slide.order}-${index + 1}`),
              targetId: slide.id,
              targetTitle: changed.title,
              targetOrder: changed.order,
              check: finding.check,
              severity: finding.severity,
              bookEvidence: finding.bookEvidence,
              whatIsWrong: finding.whatIsWrong,
              fixNote: finding.fixNote,
              status: 'open',
              teacherReason: null,
            };
            // A new error the one regeneration did not target was never attempted.
            added.teacherReason = originalChecks.has(finding.check)
              ? 'STILL_WRONG'
              : (teacherOnlyReason(added, nowSlides) ?? 'NOT_ATTEMPTED');
            return added;
          }),
      );
      fixes.push({
        sceneId: slide.id,
        findingIds: sceneFindings.map((f) => f.id),
        outcome: stillWrong ? 'still_wrong' : 'fixed',
        code: audioCode,
        regenerationId,
        ...served,
      });
      await context.recordProgress(findings, fixes);
    }
    return { findings, fixes };
  };
}
