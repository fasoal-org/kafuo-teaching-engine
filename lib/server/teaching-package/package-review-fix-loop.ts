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
 * slide's narration audio failed (`NARRATION_AUDIO_FAILED`, D-5). Reported
 * again, refused, not re-reviewed (`REREVIEW_UNAVAILABLE`) or not attempted →
 * it stays open with the reason the teacher reads; a new, different error the
 * re-review found is added open (`NOT_ATTEMPTED`).
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

import { createLogger } from '@/lib/logger';
import { readVersionById } from '@/lib/persistence/teaching-package';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  sceneToReviewSlide,
  type ReviewSlide,
} from '@/lib/server/teaching-package/package-review-input';
import {
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
  SCENE_REGENERATION_LIMITS,
  type RegenerationGrant,
} from '@/lib/server/teaching-package/scene-regeneration';
import { readLiveScene } from '@/lib/server/teaching-package/scene-regeneration-store';
import type { AppScene } from '@/lib/types/stage';
import type { FixLoop, FixLoopContext } from '@/lib/server/teaching-package/package-review';

const log = createLogger('PackageReviewFixLoop');

/** The system actor every reviewer regeneration is recorded under (plan §4.4). */
export const PACKAGE_REVIEWER_ACTOR = 'system:package-reviewer';

/** The checks a regeneration may fix (plan §4.3); S5 is the teacher's. */
const AUTO_FIX_CHECKS: ReadonlySet<string> = new Set(['S1', 'S2', 'S3', 'S4', 'Q1', 'Q2', 'Q5']);

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

/** One instruction for one regeneration: every open note of the slide, within the limits. */
export function fixInstruction(findings: readonly StoredFinding[]): string {
  const lines = findings.map((finding) => `- (${finding.check}) ${finding.fixNote}`);
  const text = `صحّح هذه الشريحة حسب ملاحظات مراجعة الكتاب، ولا تغيّر غير ذلك:\n${lines.join('\n')}`;
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
 * MEDIUM-1 (D-13): the one derived key used after an evicted run's
 * regeneration of this slide was stopped mid-call (stored `ABORTED`, never
 * committed). Deterministic, so a later resume replays it too.
 */
export function fixRetryIdempotencyKey(reviewId: string, sceneId: string): string {
  const base = fixIdempotencyKey(reviewId, sceneId);
  const max = SCENE_REGENERATION_LIMITS.idempotencyKey.max;
  return `${base.length > max - 2 ? base.slice(0, max - 2) : base}-r`;
}

/** A replay of a regeneration an evicted reviewer run stopped mid-call. */
function isAbortedReplay(error: unknown): boolean {
  if (!(error instanceof TeachingPackageError) || error.code !== 'ABORTED') return false;
  const details = error.details as { replayed?: unknown; failureCode?: unknown } | undefined;
  return details?.replayed === true && details.failureCode === 'ABORTED';
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
      const regenerateWith = (idempotencyKey: string) =>
        regenerate(
          grant,
          slide.id,
          {
            instruction: fixInstruction(sceneFindings),
            reason: `مراجعة الذكاء الاصطناعي ${review.id}: ${[...new Set(sceneFindings.map((f) => f.check))].join(', ')}`,
            idempotencyKey,
          },
          {
            pool,
            actor: { actorRef: PACKAGE_REVIEWER_ACTOR, sessionRef: null },
            // LOW-1: an evicted run's regeneration stops with its signal.
            ...(context.signal ? { signal: context.signal } : {}),
          },
        );
      try {
        let response: Awaited<ReturnType<typeof regenerate>>;
        try {
          response = await regenerateWith(fixIdempotencyKey(review.id, slide.id));
        } catch (error) {
          // MEDIUM-1 (D-13, zero manual corrections): an evicted run stopped
          // this slide's regeneration mid-call, so its key replays ABORTED
          // although no slide was ever committed. Regenerate ONCE more under
          // the derived key; a second ABORTED goes to the teacher.
          if (!isAbortedReplay(error)) throw error;
          log.warn(`review ${review.id}: ${slide.id} was stopped by an evicted run; one retry`);
          response = await regenerateWith(fixRetryIdempotencyKey(review.id, slide.id));
        }
        if (response.status !== 200) {
          throw new TeachingPackageError(
            'SCENE_REGENERATION_IN_PROGRESS',
            'another regeneration of this slide is in progress',
          );
        }
        regenerationId = response.body.regenerationId;
        regenerated = response.body.current?.scene ?? response.body.scene;
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
      let rereview: ReviewerFinding[] | null = null;
      try {
        if (!(await context.heartbeat())) throw new Error('lease lost');
        const { answer } = await context.callReviewer({
          review,
          units: context.units,
          slides: neighbourhood(nowSlides, changed),
          focusIds: new Set([slide.id]),
        });
        rereview = answer.findings.filter((finding) => finding.targetId === slide.id);
      } catch (error) {
        log.warn(
          `review ${review.id}: re-review of ${slide.id} failed`,
          JSON.stringify(describeErrorSafely(error)),
        );
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
        });
        await context.recordProgress(findings, fixes);
        continue;
      }

      // L-2: an original finding stays wrong only when the re-review reports its
      // check again; a re-review with only different findings closes it.
      const reportedChecks = new Set(rereview.map((finding) => finding.check));
      let stillWrong = false;
      for (const finding of sceneFindings) {
        if (reportedChecks.has(finding.check)) {
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
      findings.push(
        ...rereview
          .filter((finding) => !alreadyOpen.has(finding.check))
          .map((finding, index) => {
            const added: StoredFinding = {
              id: `r-${slide.order}-${index + 1}`,
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
      });
      await context.recordProgress(findings, fixes);
    }
    return { findings, fixes };
  };
}
