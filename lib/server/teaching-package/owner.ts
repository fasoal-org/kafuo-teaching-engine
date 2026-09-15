/**
 * The Teaching Package service owner (plan §4.4).
 *
 * Every Teaching-Package-owned Stage is claimed in `stage_meta` under this one
 * server-only principal, so server-to-server operations (clone, regeneration
 * relink, scene-objective writes, grant-authorized Editor writes executed by
 * the persistence route) go through the same owner-bound store the rest of the
 * app uses.
 *
 * The constant is fixed: it is not derived from any cookie, header, or env
 * value, and `resolveRequestOwnerId` can never produce it (it only yields
 * `anon:<uuid v4>` or a host-supplied authenticated id that nothing passes
 * today). A browser therefore cannot become the service owner; its only path
 * to a package Stage is a Stage-scoped Editor grant.
 */
export const TEACHING_PACKAGE_STAGE_OWNER = 'service:teaching-package';

export function isTeachingPackageStageOwner(ownerId: string | null | undefined): boolean {
  return ownerId === TEACHING_PACKAGE_STAGE_OWNER;
}
