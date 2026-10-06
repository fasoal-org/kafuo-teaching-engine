/**
 * Server-side Stage access for narration requests (plan §7.2, §15). The
 * subject, language and reading mode always come from the persisted Stage,
 * and only for a caller authorised for it:
 *
 * - `write` (persisting generation/regeneration): the Stage owner, or a
 *   `write` editor grant for that Stage and tenant;
 * - `read` (dynamic speech, reviewer preview): any caller that may read the
 *   Stage — owner, any editor grant (learner grants included), or a holder of
 *   the Stage id (the owner-bound store's capability-by-id read).
 *
 * `diagnostics` additionally refuses learner grants (plan §16.3).
 * Returns `null` (general path) when unauthorised or when there is no server
 * store; throws `SpeechContextUnavailableError` when the store fails.
 */
import type { Stage as AppStage } from '@/lib/types/stage';
import type { StageSpeechFields } from './speech-context';
import { SpeechContextUnavailableError } from './speech-context';

export type SpeechStageNeed = 'write' | 'read' | 'diagnostics';

export interface SpeechStageAccess {
  stage: StageSpeechFields & Partial<Pick<AppStage, 'id'>>;
  access: 'owner' | 'grant-write' | 'grant-read' | 'reader';
  /** The full document, for callers that need scenes (diagnostics). */
  loadDocument: () => Promise<{ stage: AppStage; scenes: unknown[] } | null>;
}

export async function loadStageForSpeech(
  request: Pick<Request, 'headers'>,
  stageId: string,
  need: SpeechStageNeed,
): Promise<SpeechStageAccess | null> {
  const url = process.env.DATABASE_URL;
  if (!url || !stageId) return null;
  try {
    const [{ getServerPersistenceProvider }, { readEditorGrant }, { getOwnerScopedDocumentStore }] =
      await Promise.all([
        import('@/lib/persistence/server-provider'),
        import('@/lib/server/teaching-package/editor-grant'),
        import('@/lib/server/agent-runtime/owner-scoped-documents'),
      ]);
    const { pool } = await getServerPersistenceProvider(url);

    let ownerForStore: string | null = null;
    let access: SpeechStageAccess['access'] | null = null;

    const grant = readEditorGrant(request.headers as Headers, stageId);
    if (grant) {
      const { stageBelongsToTenant } = await import('@/lib/persistence/teaching-package');
      const belongs = await stageBelongsToTenant(pool, grant.stageId, grant.tenantId);
      if (belongs) {
        const learner = grant.purpose === 'learner';
        if (need === 'write' && grant.capability !== 'write') return null;
        if (need === 'diagnostics' && learner) return null;
        ownerForStore = null;
        access = grant.capability === 'write' ? 'grant-write' : 'grant-read';
      }
    }

    if (!access) {
      const [{ readStageMeta }, { resolveRequestOwnerId }] = await Promise.all([
        import('@/lib/persistence/stage-meta'),
        import('@/lib/server/agent-runtime/owner'),
      ]);
      const meta = await readStageMeta(pool, stageId);
      if (!meta || meta.deletedAt) return null;
      // A fresh Headers: never mint an anonymous cookie from a narration request.
      const ownerId = resolveRequestOwnerId(request, new Headers());
      if (meta.ownerId === ownerId) {
        access = 'owner';
      } else if (need === 'read') {
        access = 'reader';
      } else {
        return null;
      }
      ownerForStore = ownerId;
    }

    const document =
      ownerForStore === null
        ? await (
            await import('@/lib/server/teaching-package/speech-stage')
          ).loadGrantedPackageStageDocument(stageId)
        : await (await getOwnerScopedDocumentStore(ownerForStore)).loadDocument(stageId);
    if (!document) return null;
    const stage = document.stage as AppStage;
    return {
      stage: {
        id: stage.id,
        subjectCode: stage.subjectCode,
        language: stage.language,
        speechReadingMode: stage.speechReadingMode,
      },
      access,
      loadDocument: async () => document as unknown as { stage: AppStage; scenes: unknown[] },
    };
  } catch (error) {
    throw new SpeechContextUnavailableError(error instanceof Error ? error.message : String(error));
  }
}
