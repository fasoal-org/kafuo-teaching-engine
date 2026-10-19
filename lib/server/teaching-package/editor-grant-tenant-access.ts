/**
 * Roles Module phase 1, D-O1-1 / D-O1-2 (owner decision, 19 Oct 2026): with
 * `ACCESS_CODE` on, a teacher who holds no access cookie reads `stage-meta` and
 * the Stage's `classroom-media` with their Stage-scoped editor grant, the same
 * grant an admin's edit or preview handoff produces.
 *
 * Only an `edit` or `preview` grant counts, never a learner grant (learners keep
 * the signed media links and their Kafuo revocation check), and only for a Stage
 * that belongs to the grant's own tenant (`stageBelongsToTenant`, the check
 * `stage-meta` already applies to `isOwner`). Fails closed when persistence is
 * not configured or the lookup fails.
 *
 * D-O1-6 (owner, 19 Oct 2026), media only: a grant also reads the media of any
 * other Stage of the same lesson in the same tenant, because a successor Stage
 * keeps its predecessor's media links (`stage-clone.ts`).
 */
import { verifyAccessToken } from '@/lib/server/access-token';
import {
  readEditorGrant,
  readEditorGrants,
  type VerifiedEditorGrant,
} from '@/lib/server/teaching-package/editor-grant';

/** Whether the request carries a valid admin access cookie for this `ACCESS_CODE`. */
export function hasValidAccessCookie(cookieValue: string | undefined, accessCode: string): boolean {
  return Boolean(cookieValue) && verifyAccessToken(cookieValue!, accessCode);
}

/** Whether the request holds a non-learner editor grant for a Stage of its own tenant. */
export async function holdsTenantEditorGrant(headers: Headers, stageId: string): Promise<boolean> {
  const grant = readEditorGrant(headers, stageId);
  if (!grant || grant.purpose === 'learner') return false;
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  try {
    const [{ getServerPersistenceProvider }, { stageBelongsToTenant }] = await Promise.all([
      import('@/lib/persistence/server-provider'),
      import('@/lib/persistence/teaching-package'),
    ]);
    const { pool } = await getServerPersistenceProvider(url);
    return await stageBelongsToTenant(pool, stageId, grant.tenantId);
  } catch {
    return false;
  }
}

/**
 * Media reads (D-O1-1 + D-O1-6): a non-learner grant for this Stage of its own
 * tenant, or for another Stage of the same lesson and tenant whose media this
 * Stage's scenes may still reference.
 */
export async function holdsLessonEditorGrant(headers: Headers, stageId: string): Promise<boolean> {
  const grants = readEditorGrants(headers).filter(
    (grant: VerifiedEditorGrant) => grant.purpose !== 'learner',
  );
  if (grants.length === 0) return false;
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  try {
    const [
      { getServerPersistenceProvider },
      { stageBelongsToTenant, stageBelongsToVersionLesson },
    ] = await Promise.all([
      import('@/lib/persistence/server-provider'),
      import('@/lib/persistence/teaching-package'),
    ]);
    const { pool } = await getServerPersistenceProvider(url);
    for (const grant of grants) {
      const allowed =
        grant.stageId === stageId
          ? await stageBelongsToTenant(pool, stageId, grant.tenantId)
          : await stageBelongsToVersionLesson(pool, stageId, grant.versionId, grant.tenantId);
      if (allowed) return true;
    }
    return false;
  } catch {
    return false;
  }
}
