/**
 * The PostgreSQL persistence sink for Teaching Package generation (plan §8.2).
 *
 * `reserve` mints the Stage id WITHOUT any database write (a failed run leaves
 * nothing to release); media/TTS bytes are written under
 * `CLASSROOMS_DIR/<stageId>` by the unchanged media module before `persist`
 * runs — the same order as the filesystem path — so the media directory and
 * the document agree on the Stage id. `persist` normalizes narration
 * references (§8.4) and saves through the owner-bound store under the service
 * owner, so `saveDocument`'s validation is the "valid Stage" gate and the
 * stage guard applies. `release` is a no-op.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ClassroomPersistenceSink } from '@/lib/server/classroom-generation';
import type {
  SourceVisualManifestEntry,
  TeachingFlowEntry,
} from '@/lib/types/teaching-package';
import { StageAccessError } from '@/lib/persistence/stage-meta';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { createPackageStageId } from '@/lib/server/teaching-package/stage-clone';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';

const CLASSROOM_MEDIA_PATH_PREFIX = '/api/classroom-media/';

/** Rewrite every `/api/classroom-media/<oldId>/…` reference onto the new id. */
function rewriteMediaReferences(value: unknown, oldId: string, newId: string): unknown {
  if (typeof value === 'string') {
    const oldPrefix = `${CLASSROOM_MEDIA_PATH_PREFIX}${oldId}/`;
    return value.startsWith(oldPrefix)
      ? `${CLASSROOM_MEDIA_PATH_PREFIX}${newId}/${value.slice(oldPrefix.length)}`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteMediaReferences(item, oldId, newId));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = rewriteMediaReferences(item, oldId, newId);
    }
    return out;
  }
  return value;
}

/**
 * Normalize speech narration the agent runtime's way: when `audioUrl` is a
 * classroom-media audio path, `audioId` becomes the same concrete address, so
 * playback is not dependent on the legacy pair fallback (§8.4).
 */
export function normalizeNarrationReferences(scenes: AppScene[], stageId: string): void {
  const audioPrefix = `${CLASSROOM_MEDIA_PATH_PREFIX}${stageId}/audio/`;
  for (const scene of scenes) {
    if (!Array.isArray(scene.actions)) continue;
    for (const action of scene.actions) {
      const record = action as { type?: unknown; audioUrl?: unknown; audioId?: unknown };
      if (record.type === 'speech' && typeof record.audioUrl === 'string') {
        if (
          record.audioUrl.startsWith(audioPrefix) ||
          /^\/api\/classroom-media\/[^/?]+\/audio\//.test(record.audioUrl)
        ) {
          record.audioId = record.audioUrl;
        }
      }
    }
  }
}

export interface TeachingPackageSinkOptions {
  /** Test seam; production callers use the random default id scheme. */
  createStageId?: () => string;
}

export function createTeachingPackagePersistenceSink(
  attemptId: string,
  options: TeachingPackageSinkOptions = {},
): ClassroomPersistenceSink {
  const mintId = options.createStageId ?? createPackageStageId;

  return {
    reserve: async (buildStage) => {
      const id = mintId();
      return { id, stage: buildStage(id) };
    },

    persist: async (data, baseUrl) => {
      normalizeNarrationReferences(data.scenes as AppScene[], data.id);
      const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
      const now = Date.now();

      for (let attempt = 0; ; attempt += 1) {
        const document: AppDocument = {
          stage: data.stage,
          scenes: data.scenes as AppScene[],
          // The requirement text travels in the execution input only; the
          // outline record is not a lineage home (audit §6.7), so it stays out.
          // The Kafuo teaching flow and source-visual provenance DO belong to
          // the record: the pre-submit exact-flow gate and Editor insertion
          // inheritance read them, and they must survive every save.
          outline: {
            outlines: data.outlines,
            generationComplete: true,
            producer: 'server-job',
            producerRef: attemptId,
            createdAt: now,
            updatedAt: now,
            ...(data.teachingFlow ? { teachingFlow: data.teachingFlow as TeachingFlowEntry[] } : {}),
            ...(data.sourceVisuals
              ? { sourceVisuals: data.sourceVisuals as SourceVisualManifestEntry[] }
              : {}),
          },
        };
        try {
          await store.saveDocument(document);
          return {
            id: data.id,
            url: `${baseUrl}/classroom/${data.id}`,
            stage: data.stage,
            scenes: data.scenes as AppScene[],
            createdAt: new Date(now).toISOString(),
          };
        } catch (error) {
          if (!(error instanceof StageAccessError) || error.refusal !== 'reserved-document') {
            throw error;
          }
          if (attempt >= 2) {
            throw new TeachingPackageError(
              'INVALID_REQUEST',
              'could not claim a free stage id for the generated package stage',
            );
          }
          // Collision (negligible with 72 random bits, but the contract stays
          // total): re-mint, rewrite ids and media references, move the media
          // directory, and retry — mirroring reserveGeneratedClassroom.
          const oldId = data.id;
          const newId = mintId();
          const rewritten = rewriteMediaReferences(
            data.scenes as AppScene[],
            oldId,
            newId,
          ) as AppScene[];
          data = {
            ...data,
            id: newId,
            stage: { ...data.stage, id: newId },
            scenes: rewritten.map((scene) => ({ ...scene, stageId: newId })),
          };
          normalizeNarrationReferences(data.scenes, newId);
          await fs
            .rename(path.join(CLASSROOMS_DIR, oldId), path.join(CLASSROOMS_DIR, newId))
            .catch(() => {});
        }
      }
    },

    release: async () => {},
  };
}
