/**
 * Server-side Stage clone for successor creation (plan §7): load the approved
 * Stage, rewrite ids onto a freshly minted random id, and save in create mode
 * through the owner-bound store under the service owner — one atomic storage
 * transaction that claims `stage_meta`.
 *
 * Everything is copied by spread: scene ids are preserved (`document_scenes`
 * PK is `(stage_id, id)`; `assertStorableScene` requires
 * `scene.stageId === stage.id`), and scene/stage media references — including
 * `/api/classroom-media/<sourceStageId>/…` paths — are copied verbatim. Server
 * asset entries are content-hash shared and never inspected by the collector,
 * so no byte copy is needed. The source is `approved`/`superseded` and
 * permanent, so the clone's references never dangle.
 */
import { randomBytes } from 'node:crypto';

import { StageAccessError } from '@/lib/persistence/stage-meta';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { OwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';

/** `stage-` + 12 base64url chars — the `app/api/stages/route.ts` scheme. */
export function createPackageStageId(): string {
  return `stage-${randomBytes(9).toString('base64url')}`;
}

export interface CloneStageOptions {
  producerRef: string;
  now?: number;
  /** Test seam; production callers use the random default id scheme. */
  createStageId?: () => string;
}

/**
 * Clone one Stage under the service owner. Throws `STAGE_NOT_LIVE` when the
 * source cannot be loaded. An id collision (`reserved-document`) re-mints and
 * retries up to 3 times, mirroring `reserveGeneratedClassroom`.
 */
export async function cloneStageForSuccessor(
  store: OwnerScopedDocumentStore,
  sourceStageId: string,
  options: CloneStageOptions,
): Promise<{ stageId: string }> {
  const source = await store.loadDocument(sourceStageId);
  if (!source) {
    throw new TeachingPackageError(
      'STAGE_NOT_LIVE',
      `stage ${sourceStageId} cannot be cloned because it is not live`,
    );
  }

  const mintId = options.createStageId ?? createPackageStageId;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stageId = mintId();
    const now = options.now ?? Date.now();
    const clone = {
      stage: { ...source.stage, id: stageId, createdAt: now, updatedAt: now },
      scenes: source.scenes.map((scene) => ({ ...scene, stageId, updatedAt: now })),
      outline: {
        ...(source.outline as AppDocumentOutline),
        producer: 'server-job',
        producerRef: options.producerRef,
        generationComplete: true,
        updatedAt: now,
      },
      // The store re-stamps dslVersion on save.
    };
    try {
      await store.saveDocument(clone);
      return { stageId };
    } catch (error) {
      if (error instanceof StageAccessError && error.refusal === 'reserved-document') {
        continue;
      }
      throw error;
    }
  }
  throw new TeachingPackageError(
    'INVALID_REQUEST',
    'could not mint a free stage id for the successor clone',
  );
}
