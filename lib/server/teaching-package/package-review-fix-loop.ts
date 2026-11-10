/**
 * The package reviewer's fix loop (ai-reviewer-layer plan D-1, §4.3, §4.4).
 *
 * For each slide with an auto-fixable open finding, ONCE:
 *   1. regenerate it through `regenerateSlideScene` under the system actor
 *      `system:package-reviewer`, with the finding's fix note as the
 *      instruction (the only text the slide writer sees);
 *   2. re-synthesise its narration through `scene-narration-audio.ts`, so a
 *      learner never hears old audio over a new slide;
 *   3. re-review ONLY that slide, with its neighbours as context.
 * Clean → its findings are `fixed`. Still wrong, refused, or not attempted →
 * they stay open with the reason the teacher reads.
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
import { PACKAGE_QUIZ_CHECKS } from '@/lib/server/teaching-package/package-review-prompt';
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
      if (!(await context.heartbeat())) {
        stopped = true;
        mark(slide.id, 'VERSION_CHANGED');
        continue;
      }
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

      let regenerated: AppScene;
      let regenerationId: string | null = null;
      try {
        const response = await regenerate(
          grant,
          slide.id,
          {
            instruction: fixInstruction(sceneFindings),
            reason: `مراجعة الذكاء الاصطناعي ${review.id}: ${[...new Set(sceneFindings.map((f) => f.check))].join(', ')}`,
            idempotencyKey: fixIdempotencyKey(review.id, slide.id),
          },
          { pool, actor: { actorRef: PACKAGE_REVIEWER_ACTOR, sessionRef: null } },
        );
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

      // The new slide's narration audio (a regeneration never runs TTS).
      let audioCode: string | null = null;
      try {
        const audio = await regenerateAudio(grant, slide.id, { pool });
        regenerated = audio.scene;
        if (audio.missing > 0) audioCode = 'NARRATION_AUDIO_PARTIAL';
      } catch (error) {
        audioCode = error instanceof TeachingPackageError ? error.code : 'NARRATION_AUDIO_FAILED';
        log.warn(
          `review ${review.id}: narration audio for ${slide.id} not regenerated (${audioCode})`,
        );
      }
      scenesById.set(slide.id, regenerated);

      // Re-review this slide only, with its neighbours as context.
      const changed = sceneToReviewSlide(regenerated);
      let stillWrong: StoredFinding[] = [];
      let rereviewCode: string | null = null;
      try {
        if (!(await context.heartbeat())) throw new Error('lease lost');
        const { answer } = await context.callReviewer({
          review,
          units: context.units,
          slides: neighbourhood(slides, changed),
          focusIds: new Set([slide.id]),
        });
        stillWrong = answer.findings
          .filter((finding) => finding.targetId === slide.id)
          .map((finding, index) => ({
            id: `r-${slide.order}-${index + 1}`,
            targetId: slide.id,
            targetTitle: changed.title,
            targetOrder: changed.order,
            check: finding.check,
            severity: finding.severity,
            bookEvidence: finding.bookEvidence,
            whatIsWrong: finding.whatIsWrong,
            fixNote: finding.fixNote,
            status: 'open' as const,
            teacherReason: 'STILL_WRONG' as const,
          }));
      } catch (error) {
        rereviewCode = 'REREVIEW_UNAVAILABLE';
        log.warn(
          `review ${review.id}: re-review of ${slide.id} failed`,
          JSON.stringify(describeErrorSafely(error)),
        );
      }

      if (rereviewCode === null && stillWrong.length === 0) {
        for (const finding of sceneFindings) {
          finding.status = 'fixed';
          finding.teacherReason = null;
        }
        fixes.push({
          sceneId: slide.id,
          findingIds: sceneFindings.map((f) => f.id),
          outcome: 'fixed',
          code: audioCode,
          regenerationId,
        });
      } else {
        mark(slide.id, 'STILL_WRONG');
        findings.push(...stillWrong);
        fixes.push({
          sceneId: slide.id,
          findingIds: sceneFindings.map((f) => f.id),
          outcome: 'still_wrong',
          code: rereviewCode ?? audioCode,
          regenerationId,
        });
      }
      await context.recordProgress(findings, fixes);
    }
    return { findings, fixes };
  };
}
