/**
 * Loads a package Stage document for narration under a VERIFIED editor grant
 * (SATTS plan §7.2). The caller must already have checked the grant for this
 * Stage and tenant; this module only owns the package-owner store access so
 * the owner identity stays inside the teaching-package surface.
 */
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';

export async function loadGrantedPackageStageDocument(stageId: string) {
  const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
  return store.loadDocument(stageId);
}
