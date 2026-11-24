/**
 * The I/O behind the agent read routes (Kafuo Agent API plan §3.3): every read
 * is a SELECT through the existing stores and readers — no lock, no lease
 * reclaim, no write. The mapping is the pure modules beside this one. Callers
 * pass a version ALREADY read under the caller's tenant
 * (`getTeachingPackageVersion`), so nothing here widens tenant scope.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { readAttemptById } from '@/lib/persistence/teaching-package';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import {
  agentAlignmentProof,
  loadSceneWriteEvents,
} from '@/lib/server/teaching-package/agent-alignment-proof';
import { deriveSceneAlignment } from '@/lib/server/teaching-package/alignment';
import {
  isTeachingPackageStageLockedError,
  TeachingPackageError,
} from '@/lib/server/teaching-package/errors';
import {
  readFlowForVersion,
  readTeachingSkillsGovernanceForVersion,
} from '@/lib/server/teaching-package/exact-flow';
import { submitBlockers } from '@/lib/server/teaching-package/lifecycle';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { listRunningSceneRegenerations } from '@/lib/server/teaching-package/scene-regeneration-store';
import { readContentUnitsForGrant } from '@/lib/server/teaching-package/scene-insertion';
import { readSectionCoverageForVersion } from '@/lib/server/teaching-package/successor-model';
import { runningSceneInsertionId } from '@/lib/server/teaching-package/stage-generation-mutex';
import { assertStageWritable } from '@/lib/server/teaching-package/stage-guard';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';
import type { TeachingPackageVersion } from '@/lib/types/teaching-package';

import { LruCache, sceneProjectionCacheKey } from './cache';
import { projectAgentParts, type AgentPart } from './parts';
import { buildAgentReadiness, type AgentReadiness } from './readiness';
import {
  projectAgentScenes,
  type AgentScenesProjection,
  type SceneRegenerationSummary,
} from './scenes';

/** At most this many projections stay in memory (one per version × revision). */
export const SCENE_PROJECTION_CACHE_SIZE = 32;
const sceneProjectionCache = new LruCache<AgentScenesProjection>(SCENE_PROJECTION_CACHE_SIZE);

/** Test seam: empty the process-local projection cache. */
export function clearAgentSceneProjectionCache(): void {
  sceneProjectionCache.clear();
}

function stageNotLive(): TeachingPackageError {
  return new TeachingPackageError('STAGE_NOT_LIVE', 'the package stage is not live');
}

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && /^\s*[{[]/.test(value)) return JSON.parse(value) as T;
  return value as T;
}

/** The latest regeneration record per scene of one version's Stage (any status). */
export async function readLatestSceneRegenerations(
  queryable: Queryable,
  versionId: string,
  stageId: string,
): Promise<Map<string, SceneRegenerationSummary>> {
  const result = await queryable.query<{
    scene_id: string;
    status: string;
    actor_ref: string;
    requested_at: number | string;
    completed_at: number | string | null;
    previous_scene: unknown;
  }>(
    `SELECT DISTINCT ON (scene_id) scene_id, status, actor_ref, requested_at, completed_at,
            previous_scene
       FROM teaching_package_scene_regenerations
      WHERE version_id = $1 AND stage_id = $2
      ORDER BY scene_id, requested_at DESC, id DESC`,
    [versionId, stageId],
  );
  // The latest SUCCEEDED record per scene, for `last_changed`: a later running or
  // failed attempt must not hide the change that did land.
  const succeeded = await queryable.query<{
    scene_id: string;
    actor_ref: string;
    requested_at: number | string;
    completed_at: number | string | null;
  }>(
    `SELECT DISTINCT ON (scene_id) scene_id, actor_ref, requested_at, completed_at
       FROM teaching_package_scene_regenerations
      WHERE version_id = $1 AND stage_id = $2 AND status = 'succeeded'
      ORDER BY scene_id, requested_at DESC, id DESC`,
    [versionId, stageId],
  );
  const lastSucceeded = new Map(
    succeeded.rows.map((row) => [
      row.scene_id,
      {
        actorRef: row.actor_ref,
        at: Number(row.completed_at ?? row.requested_at),
      },
    ]),
  );
  return new Map(
    result.rows.map((row) => [
      row.scene_id,
      {
        sceneId: row.scene_id,
        status: row.status as SceneRegenerationSummary['status'],
        actorRef: row.actor_ref,
        requestedAt: Number(row.requested_at),
        completedAt: row.completed_at === null ? null : Number(row.completed_at),
        previousScene: json<AppScene>(row.previous_scene),
        lastSucceeded: lastSucceeded.get(row.scene_id) ?? null,
      },
    ]),
  );
}

/** `GET agent-read/scenes`: cached by (version, stage, revision); a hit costs one revision read. */
export async function loadAgentScenes(
  pool: ConnectableQueryable,
  version: TeachingPackageVersion,
): Promise<AgentScenesProjection> {
  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const manifest = await store.readFreshnessManifest(version.currentStageId);
  if (!manifest) throw stageNotLive();
  const key = sceneProjectionCacheKey(version.id, version.currentStageId, manifest.rev);
  // The version status can change (submit, approve) without a stage revision:
  // it is never served from the cache, always the row just read under the tenant.
  const withLiveStatus = (projection: AgentScenesProjection): AgentScenesProjection => ({
    ...projection,
    status: version.status,
  });
  const cached = sceneProjectionCache.get(key);
  if (cached) return withLiveStatus(cached);

  const document = await store.loadDocument(version.currentStageId);
  if (!document) throw stageNotLive();
  const queryable = pool as unknown as Queryable;
  const flow = await readFlowForVersion(queryable as never, version.id);
  const governance = await readTeachingSkillsGovernanceForVersion(queryable as never, version.id);
  const regenerations = await readLatestSceneRegenerations(
    queryable,
    version.id,
    version.currentStageId,
  );
  // F2.6: the A8 proof for every stale slide of a governed package (the same proof
  // `alignment-confirm` runs, so the read never promises what the op refuses).
  const governed = Boolean(governance?.contract);
  const stale = governed
    ? document.scenes.filter((scene) => !deriveSceneAlignment(scene).aligned)
    : [];
  const agentConfirmable = new Set<string>();
  if (stale.length > 0) {
    const events = await loadSceneWriteEvents(
      queryable,
      version.id,
      version.currentStageId,
      stale.map((scene) => scene.id),
    );
    for (const scene of stale) {
      if (agentAlignmentProof(scene, events.get(scene.id) ?? []).ok) {
        agentConfirmable.add(scene.id);
      }
    }
  }
  const projection = projectAgentScenes({
    version,
    revision: manifest.rev,
    scenes: document.scenes,
    outline: (document.outline ?? null) as AppDocumentOutline | null,
    stage: document.stage,
    flow: flow && flow.length > 0 ? flow : null,
    governed,
    regenerations,
    agentConfirmable,
  });
  sceneProjectionCache.set(key, projection);
  return withLiveStatus(projection);
}

/** `GET agent-read/parts`: the editor's lesson parts, read without the editor grant. */
export async function loadAgentParts(
  pool: ConnectableQueryable,
  version: TeachingPackageVersion,
): Promise<{ version_id: string; revision: string; parts: AgentPart[] }> {
  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const manifest = await store.readFreshnessManifest(version.currentStageId);
  if (!manifest) throw stageNotLive();
  // The same read the editor grant route makes; `readInsertionContext` re-checks
  // the tenant and the Stage against the version row.
  const data = await readContentUnitsForGrant(pool, {
    tenantId: version.tenantId,
    versionId: version.id,
    stageId: version.currentStageId,
  });
  const queryable = pool as unknown as Queryable;
  const coverage = await readSectionCoverageForVersion(queryable, version.id);
  const attempt = version.currentAttemptId
    ? await readAttemptById(queryable as never, version.currentAttemptId)
    : null;
  return {
    version_id: version.id,
    revision: String(manifest.rev),
    parts: projectAgentParts({
      units: data.units,
      essentialUnitIds: coverage ? coverage.essentialContentUnitIds : null,
      bookUnits: attempt?.inputSnapshot.bookStructure?.units ?? null,
    }),
  };
}

/** `GET agent-read/readiness`: status, editor lock, every Submit blocker, counts. */
export async function loadAgentReadiness(
  pool: ConnectableQueryable,
  version: TeachingPackageVersion,
  now: number = Date.now(),
): Promise<AgentReadiness> {
  const queryable = pool as unknown as Queryable;
  let stageLockedReason: string | null = null;
  try {
    // A pure read: the guard SELECTs the Stage's version references only.
    await assertStageWritable(queryable, { stageId: version.currentStageId, mode: 'mutate' });
  } catch (error) {
    if (!isTeachingPackageStageLockedError(error)) throw error;
    stageLockedReason = error.reason;
  }
  const regenerations = await listRunningSceneRegenerations(queryable, version.currentStageId, now);
  const insertion = await runningSceneInsertionId(queryable, version.currentStageId, now);
  const attempt = version.currentAttemptId
    ? await readAttemptById(queryable as never, version.currentAttemptId)
    : null;
  const blockers = await submitBlockers(pool, version.id, version.tenantId);
  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  const document = await store.loadDocument(version.currentStageId);
  return buildAgentReadiness({
    version,
    lock: {
      stageLockedReason,
      runningRegenerations: regenerations.length,
      runningInsertion: insertion !== null,
      generationStatus: attempt?.status ?? null,
    },
    blockers,
    scenes: document?.scenes ?? [],
  });
}
