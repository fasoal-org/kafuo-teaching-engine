/**
 * Approved-package resolver and read layer (plan §13), shaped like
 * `lib/server/stage-access.ts`: one focused query per question, an injectable
 * queryable as the test seam, and no transaction of its own.
 *
 * `resolveApprovedTeachingPackage` never falls back: `approved` is the sole
 * current/default state (BR-039/040), and a tombstoned or absent Stage behind
 * an approved version is an integrity violation that must be loud (422), never
 * a silent "none".
 */
import {
  listReviewEvents,
  listVersionsByItem,
  readApprovedVersion,
  readAttempt,
  readAttemptById,
  readVersion,
  readVersionById,
} from '@/lib/persistence/teaching-package';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { resolveStageAccess, type StageAccessQueryable } from '@/lib/server/stage-access';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type {
  GenerationAttempt,
  ReviewEvent,
  TeachingPackageAggregateKey,
  TeachingPackageVersion,
} from '@/lib/types/teaching-package';

async function defaultQueryable(): Promise<StageAccessQueryable> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return pool as unknown as StageAccessQueryable;
}

export type ApprovedTeachingPackageResolution =
  | { kind: 'approved'; version: TeachingPackageVersion; stageId: string }
  | { kind: 'none' };

/**
 * Resolve the approved/current Teaching Package for one aggregate scope. The
 * tenant-scoped single-approved partial unique index guarantees at most one row.
 */
export async function resolveApprovedTeachingPackage(
  aggregate: TeachingPackageAggregateKey,
  queryable?: StageAccessQueryable,
): Promise<ApprovedTeachingPackageResolution> {
  const db = queryable ?? (await defaultQueryable());
  const version = await readApprovedVersion(db, aggregate);
  if (!version) return { kind: 'none' };

  const access = await resolveStageAccess(version.currentStageId, db);
  if (!access) {
    throw new TeachingPackageError(
      'STAGE_NOT_LIVE',
      `approved teaching package version ${version.id} references a stage that is not live`,
      { stageId: version.currentStageId, versionId: version.id },
    );
  }
  return { kind: 'approved', version, stageId: version.currentStageId };
}

/** Version by id under the caller's tenant; throws NOT_FOUND (404) otherwise. */
export async function getTeachingPackageVersion(
  id: string,
  scope: { tenantId: string },
  queryable?: StageAccessQueryable,
): Promise<TeachingPackageVersion> {
  const db = queryable ?? (await defaultQueryable());
  const version = await readVersion(db, id, scope);
  if (!version) throw new TeachingPackageError('NOT_FOUND', `teaching package ${id} not found`);
  return version;
}

/**
 * Version by id WITHOUT a tenant filter — the temporary handoff-redeem seam
 * (the token carries no tenant until Phase 4); the HMAC token is the
 * capability. Service routes must use {@link getTeachingPackageVersion}.
 */
export async function getTeachingPackageVersionByToken(
  id: string,
  queryable?: StageAccessQueryable,
): Promise<TeachingPackageVersion> {
  const db = queryable ?? (await defaultQueryable());
  const version = await readVersionById(db, id);
  if (!version) throw new TeachingPackageError('NOT_FOUND', `teaching package ${id} not found`);
  return version;
}

/** All versions of one aggregate scope, stable version order (FR-007). */
export async function listTeachingPackageVersions(
  aggregate: TeachingPackageAggregateKey,
  queryable?: StageAccessQueryable,
): Promise<TeachingPackageVersion[]> {
  const db = queryable ?? (await defaultQueryable());
  return listVersionsByItem(db, aggregate);
}

/** Review history for one version, append order (FR-055). */
export async function listTeachingPackageReviewEvents(
  versionId: string,
  queryable?: StageAccessQueryable,
): Promise<ReviewEvent[]> {
  const db = queryable ?? (await defaultQueryable());
  return listReviewEvents(db, versionId);
}

/** Generation attempt by id under the caller's tenant; NOT_FOUND otherwise. */
export async function getGenerationAttempt(
  id: string,
  scope: { tenantId: string },
  queryable?: StageAccessQueryable,
): Promise<GenerationAttempt> {
  const db = queryable ?? (await defaultQueryable());
  const attempt = await readAttempt(db, id, scope);
  if (!attempt) throw new TeachingPackageError('NOT_FOUND', `generation attempt ${id} not found`);
  return attempt;
}

/** Internal by-id attempt read (runner paths); NOT_FOUND when absent. */
export async function getGenerationAttemptById(
  id: string,
  queryable?: StageAccessQueryable,
): Promise<GenerationAttempt> {
  const db = queryable ?? (await defaultQueryable());
  const attempt = await readAttemptById(db, id);
  if (!attempt) throw new TeachingPackageError('NOT_FOUND', `generation attempt ${id} not found`);
  return attempt;
}
