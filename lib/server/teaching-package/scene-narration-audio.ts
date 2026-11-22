/**
 * A reviewer's audio repair of ONE Teaching Package Scene
 * (scene-narration-audio-regeneration-plan, 4 Oct 2026).
 *
 * A Scene marked `NARRATION_AUDIO_FAILED` has spoken lines without audio. This
 * synthesizes exactly those lines with the Stage's TTS route — the package
 * build's provider, model and voice, never the browser's — and saves the Scene
 * with its audio references. Text, Actions and content are never changed.
 *
 *   write grant (route) → editable version, no running regeneration
 *   → read the Scene and its revision → synthesize (no transaction)
 *   → write under the revision precondition and the stage guard
 *
 * The mark is removed only when every spoken line has audio; a partial result
 * is saved and the mark keeps the new count. Nothing voiced → nothing written.
 */
import { DocumentVersionError } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { withPlainJsonDocumentWrites } from '@/lib/document-store/plain-json-store';
import type { AppDocument, AppStage } from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import {
  createOwnerBoundDocumentStore,
  type TransactionSource,
} from '@/lib/persistence/owner-bound-document-store';
import { omitUndefinedObjectMembers } from '@/lib/persistence/plain-json';
import { readVersionById } from '@/lib/persistence/teaching-package';
import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
import {
  deriveSceneAlignment,
  sceneMaterialFingerprint,
} from '@/lib/server/teaching-package/alignment';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  NARRATION_MISSING_ISSUE_CODE,
  issuesAfterAudioRepair,
  narrationAudioGap,
  narrationMissing,
} from '@/lib/server/teaching-package/narration-audio-issue';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  revisionPreconditionFence,
  type RevisionPreconditionState,
} from '@/lib/server/teaching-package/revision-precondition-fence';
import {
  sceneRegenerationActorRef,
  type RegenerationGrant,
} from '@/lib/server/teaching-package/scene-regeneration';
import {
  enqueueNarrationAudioFailedIfMarked,
  enqueueSceneChanged,
} from '@/lib/server/teaching-package/scene-webhook-events';
import {
  listRunningSceneRegenerations,
  readLiveScene,
} from '@/lib/server/teaching-package/scene-regeneration-store';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { SpeechAction } from '@/lib/types/action';
import type { AppScene, Scene } from '@/lib/types/stage';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';
import { createLogger } from '@/lib/logger';

const log = createLogger('SceneNarrationAudio');

const EDITABLE: readonly TeachingPackageStatus[] = ['draft', 'rejected'];

export interface NarrationAudioRegenerationResult {
  sceneId: string;
  /** What the database holds now. */
  scene: AppScene;
  rev: number;
  /** Spoken lines voiced by this run. */
  generated: number;
  /** Spoken lines still without audio (the mark stays when > 0). */
  missing: number;
}

export interface NarrationAudioDeps {
  pool: ConnectableQueryable;
  now?: () => number;
  /**
   * The AI reviewer's run signal (review fix LOW-1): synthesis stops with it,
   * and an aborted run writes no audio. Absent (the editor) → exactly as before.
   */
  signal?: AbortSignal;
  /** Who asked, for the `scene_changed` webhook; absent → the editor's actor ref. */
  actorRef?: string;
  /** Test seams. */
  synthesize?: typeof synthesizeSceneNarration;
  loadStage?: (pool: ConnectableQueryable, stageId: string) => Promise<AppStage | null>;
  writeScene?: (
    pool: ConnectableQueryable,
    target: { stageId: string; sceneId: string; baseRev: number },
    scene: AppScene,
    onCommitted?: (tx: Queryable) => Promise<void>,
  ) => Promise<number>;
}

const AUDIO_FIELDS = ['audioId', 'audioUrl', 'audioProvenance', 'audioInvalidated'] as const;

/** The Scene with every speech Action's audio reference removed. */
function withoutNarrationAudio(scene: AppScene): AppScene {
  return {
    ...scene,
    actions: (scene.actions ?? []).map((action) => {
      if (action.type !== 'speech') return action;
      const copy = { ...action } as Record<string, unknown>;
      for (const field of AUDIO_FIELDS) delete copy[field];
      return copy as unknown as typeof action;
    }),
  } as AppScene;
}

/**
 * The lines this run voiced drop their `audioInvalidated` flag: the flag marks
 * audio made stale by an edit, and the line now has audio for its current text.
 */
function clearInvalidationOfVoicedLines(before: AppScene, after: AppScene): AppScene {
  const previous = new Map(
    (before.actions ?? []).map((action) => [action.id, (action as SpeechAction).audioId]),
  );
  return {
    ...after,
    actions: (after.actions ?? []).map((action) => {
      if (action.type !== 'speech') return action;
      const speech = action as SpeechAction;
      if (!speech.audioId || speech.audioId === previous.get(action.id)) return action;
      const { audioInvalidated: _cleared, ...rest } = speech;
      return rest as typeof action;
    }),
  } as AppScene;
}

/**
 * Audio references are part of the material fingerprint (`actions` verbatim),
 * so voicing a line would turn an aligned Scene `stale / material-change` and
 * block Submit although no teaching content changed. When the Scene was
 * aligned before and ONLY audio references differ, its baseline is carried
 * forward with the new fingerprint (origin, actor and time kept). Anything
 * else keeps the baseline untouched.
 */
export function carryAlignmentBaselineForward(before: AppScene, after: AppScene): AppScene {
  const baseline = before.alignmentBaseline;
  if (!baseline || !deriveSceneAlignment(before).aligned) return after;
  if (
    sceneMaterialFingerprint(withoutNarrationAudio(before)) !==
    sceneMaterialFingerprint(withoutNarrationAudio(after))
  ) {
    return after;
  }
  return {
    ...after,
    alignmentBaseline: { ...baseline, fingerprint: sceneMaterialFingerprint(after) },
  };
}

function ownerBoundStore(pool: ConnectableQueryable) {
  return createOwnerBoundDocumentStore<AppScene, AppStage>({
    pool: pool as unknown as TransactionSource,
    ownerId: TEACHING_PACKAGE_STAGE_OWNER,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

async function loadStageFromStore(
  pool: ConnectableQueryable,
  stageId: string,
): Promise<AppStage | null> {
  const document = (await ownerBoundStore(pool).loadDocument(stageId)) as AppDocument | null;
  return document?.stage ?? null;
}

/**
 * Write one Scene under its revision precondition and the stage guard; returns the new rev.
 * `onCommitted` runs once, on the transaction that advanced the Scene's revision
 * (before its COMMIT), so what it enqueues commits or rolls back with the write.
 */
async function writeSceneAtRev(
  pool: ConnectableQueryable,
  target: { stageId: string; sceneId: string; baseRev: number },
  scene: AppScene,
  onCommitted?: (tx: Queryable) => Promise<void>,
): Promise<number> {
  const state: RevisionPreconditionState = {};
  const precondition = revisionPreconditionFence(
    { kind: 'scene', stageId: target.stageId, sceneId: target.sceneId, method: 'PUT' },
    { [target.sceneId]: target.baseRev },
    state,
  );
  // This write sends its own `scene_changed: narration_audio_regenerated`.
  const guard = teachingPackageStageGuardFence(undefined, { sceneEvents: false });
  let notified = false;
  const store = withPlainJsonDocumentWrites(
    createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool: pool as unknown as TransactionSource,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: async (queryable, operation, phase) => {
        await precondition(queryable, operation, phase);
        await guard(queryable, operation, phase);
        if (
          onCommitted &&
          !notified &&
          phase === 'after' &&
          operation.stageId === target.stageId &&
          operation.mode !== 'read'
        ) {
          const revision = await queryable.query<{ rev: number | string }>(
            'SELECT rev FROM document_scene_revision WHERE stage_id = $1 AND scene_id = $2',
            [target.stageId, target.sceneId],
          );
          const rev = revision.rows[0] ? Number(revision.rows[0].rev) : 0;
          if (rev > target.baseRev) {
            await onCommitted(queryable);
            notified = true;
          }
        }
      },
    }),
  );
  try {
    await store.putScene(target.stageId, scene);
  } catch (error) {
    if (state.refusal) {
      throw new TeachingPackageError('SCENE_REVISION_CONFLICT', state.refusal.message, {
        scenes: state.refusal.scenes,
      });
    }
    if (error instanceof DocumentVersionError && error.kind === 'not-current') {
      throw new TeachingPackageError(
        'DOCUMENT_NOT_CURRENT',
        'the stored stage is on an older document version; nothing was written',
      );
    }
    throw error;
  }
  const rev = state.resultRevs?.[target.sceneId];
  if (typeof rev !== 'number') {
    throw new TeachingPackageError(
      'REGENERATION_PERSISTENCE_FAILED',
      'the audio was generated but the slide could not be saved; try again',
    );
  }
  return rev;
}

/**
 * Synthesize the missing narration audio of one Scene and save it. Throws
 * `TeachingPackageError` / `TeachingPackageStageLockedError` for every refusal.
 */
export async function regenerateSceneNarrationAudio(
  grant: RegenerationGrant,
  sceneId: string,
  deps: NarrationAudioDeps,
): Promise<NarrationAudioRegenerationResult> {
  const { pool } = deps;
  const clock = deps.now ?? Date.now;

  const version = await readVersionById(pool, grant.versionId);
  if (!version || version.tenantId !== grant.tenantId || version.currentStageId !== grant.stageId) {
    throw new TeachingPackageError('NOT_FOUND', 'teaching package not found');
  }
  if (!EDITABLE.includes(version.status)) {
    throw new TeachingPackageError('STAGE_LOCKED', 'the teaching package is not editable');
  }
  const running = await listRunningSceneRegenerations(pool, grant.stageId, clock());
  if (running.some((entry) => entry.sceneId === sceneId)) {
    throw new TeachingPackageError(
      'SCENE_REGENERATION_IN_PROGRESS',
      'this slide is being regenerated; try the audio again when it finishes',
    );
  }
  const live = await readLiveScene(pool, grant.stageId, sceneId);
  if (!live) throw new TeachingPackageError('SCENE_NOT_FOUND', 'the slide was not found');
  const stage = await (deps.loadStage ?? loadStageFromStore)(pool, grant.stageId);
  if (!stage) throw new TeachingPackageError('STAGE_NOT_LIVE', 'the package stage is not live');

  // Synthesis on a copy: the live Scene is never touched until the write.
  const working = structuredClone(live.scene);
  let summary: Awaited<ReturnType<typeof synthesizeSceneNarration>>;
  try {
    summary = await (deps.synthesize ?? synthesizeSceneNarration)({
      scene: working as Scene,
      force: false,
      roster: stage.generatedAgentConfigs ?? null,
      stage: {
        subjectCode: stage.subjectCode,
        language: stage.language,
        speechReadingMode: stage.speechReadingMode,
        // A repaired slide speaks with the lesson's frozen configured route.
        ...(stage.ttsRoute !== undefined ? { ttsRoute: stage.ttsRoute } : {}),
      },
      // The package build's storage, retry and failure rule (batch TTS): a
      // provider error or timeout fails its own line, never the voiced ones.
      persist: { kind: 'audio-dir' },
      transientAttempts: 2,
      entry: 'batch',
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (error) {
    if (deps.signal?.aborted) {
      // LOW-4: synthesis stopped because the reviewer run was evicted.
      throw new TeachingPackageError(
        'ABORTED',
        'the narration audio was stopped: the review run that asked for it was evicted; nothing was written',
      );
    }
    log.warn(`narration audio for scene ${sceneId} could not be generated`, error);
    throw new TeachingPackageError(
      'NARRATION_AUDIO_GENERATION_FAILED',
      'the narration audio could not be generated (the voice provider did not answer); nothing was written — try again',
    );
  }
  if (!summary.available) {
    throw new TeachingPackageError(
      'NARRATION_AUDIO_UNAVAILABLE',
      'the voice provider for this subject is not available now; nothing was written',
    );
  }

  const gap = narrationAudioGap(working);
  if (summary.generated === 0 && gap.missing > 0) {
    throw new TeachingPackageError(
      'NARRATION_AUDIO_GENERATION_FAILED',
      `the narration audio could not be generated for ${gap.missing} of ${gap.spoken} spoken line(s); nothing was written — try again`,
      { missing: gap.missing, spoken: gap.spoken },
    );
  }

  // 21 Nov 2026: a scene that holds a spoken line again must not keep a stale
  // NARRATION_MISSING. The audio mark keeps its own post-repair `gap` semantics.
  const baseIssues = narrationMissing(live.scene)
    ? live.scene.generationIssues
    : (live.scene.generationIssues ?? []).filter(
        (issue) => issue.code !== NARRATION_MISSING_ISSUE_CODE,
      );
  const issues = issuesAfterAudioRepair(baseIssues, gap);
  const unchangedIssues =
    JSON.stringify(issues ?? null) === JSON.stringify(live.scene.generationIssues ?? null);
  if (summary.generated === 0 && unchangedIssues) {
    // Every line already had current audio and there was no mark to update.
    return { sceneId, scene: live.scene, rev: live.rev, generated: 0, missing: gap.missing };
  }

  if (deps.signal?.aborted) {
    // LOW-1: the reviewer run that asked for this audio was evicted.
    throw new TeachingPackageError(
      'ABORTED',
      'the narration audio was stopped: the review run that asked for it was evicted; nothing was written',
    );
  }
  const { generationIssues: _previous, ...rest } = clearInvalidationOfVoicedLines(
    live.scene,
    working,
  );
  const next = omitUndefinedObjectMembers(
    carryAlignmentBaselineForward(live.scene, {
      ...rest,
      ...(issues ? { generationIssues: issues } : {}),
      updatedAt: clock(),
    } as AppScene),
  );
  const rev = await (deps.writeScene ?? writeSceneAtRev)(
    pool,
    { stageId: grant.stageId, sceneId, baseRev: live.rev },
    next,
    // Agent API wave B: the change and a still-failed line, in the write's commit.
    async (tx) => {
      await enqueueSceneChanged(tx, {
        versionId: grant.versionId,
        stageId: grant.stageId,
        sceneId,
        change: 'narration_audio_regenerated',
        actorRef: deps.actorRef ?? sceneRegenerationActorRef(grant.stageId),
      });
      await enqueueNarrationAudioFailedIfMarked(tx, {
        versionId: grant.versionId,
        stageId: grant.stageId,
        scene: next,
      });
    },
  );
  log.info(
    `narration audio repaired for scene ${sceneId}: ${summary.generated} generated, ${gap.missing} still missing`,
  );
  return { sceneId, scene: next, rev, generated: summary.generated, missing: gap.missing };
}
