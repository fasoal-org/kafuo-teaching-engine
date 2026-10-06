/**
 * Stage access for narration (plan §7.2, §15, §16.3): persisting needs owner
 * or a write grant; dynamic speech may read; diagnostics refuse learner grants.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  grant: null as null | Record<string, unknown>,
  meta: null as null | Record<string, unknown>,
  owner: 'anon:owner',
  packageDoc: vi.fn(),
  ownerDoc: vi.fn(),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/server/teaching-package/editor-grant', () => ({ readEditorGrant: () => mocks.grant }));
vi.mock('@/lib/persistence/teaching-package', () => ({ stageBelongsToTenant: async () => true }));
vi.mock('@/lib/persistence/stage-meta', () => ({ readStageMeta: async () => mocks.meta }));
vi.mock('@/lib/server/agent-runtime/owner', () => ({ resolveRequestOwnerId: () => mocks.owner }));
vi.mock('@/lib/server/teaching-package/speech-stage', () => ({ loadGrantedPackageStageDocument: mocks.packageDoc }));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => ({ loadDocument: mocks.ownerDoc }),
}));

import { loadStageForSpeech } from '@/lib/server/speech/stage-access';

const doc = { stage: { id: 'stage-1', subjectCode: 'MATH', language: 'ar-SA' }, scenes: [] };
const request = { headers: new Headers() };

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  mocks.grant = null;
  mocks.meta = { ownerId: 'anon:owner', deletedAt: null };
  mocks.owner = 'anon:owner';
  mocks.packageDoc.mockReset().mockResolvedValue(doc);
  mocks.ownerDoc.mockReset().mockResolvedValue(doc);
});

describe('loadStageForSpeech', () => {
  it('owner: write, read and diagnostics allowed', async () => {
    for (const need of ['write', 'read', 'diagnostics'] as const) {
      expect(await loadStageForSpeech(request, 'stage-1', need)).toMatchObject({ access: 'owner', stage: { subjectCode: 'MATH' } });
    }
  });

  it('non-owner without a grant: read only (capability-by-id), never write or diagnostics', async () => {
    mocks.owner = 'anon:visitor';
    expect(await loadStageForSpeech(request, 'stage-1', 'read')).toMatchObject({ access: 'reader' });
    expect(await loadStageForSpeech(request, 'stage-1', 'write')).toBeNull();
    expect(await loadStageForSpeech(request, 'stage-1', 'diagnostics')).toBeNull();
  });

  it('learner grant: dynamic read allowed; diagnostics and writes refused', async () => {
    mocks.grant = { stageId: 'stage-1', tenantId: 't', capability: 'read', purpose: 'learner' };
    expect(await loadStageForSpeech(request, 'stage-1', 'read')).toMatchObject({ access: 'grant-read' });
    expect(await loadStageForSpeech(request, 'stage-1', 'diagnostics')).toBeNull();
    expect(await loadStageForSpeech(request, 'stage-1', 'write')).toBeNull();
  });

  it('editor write grant: persisting generation allowed through the package surface', async () => {
    mocks.grant = { stageId: 'stage-1', tenantId: 't', capability: 'write', purpose: 'edit' };
    expect(await loadStageForSpeech(request, 'stage-1', 'write')).toMatchObject({ access: 'grant-write' });
    expect(mocks.packageDoc).toHaveBeenCalledWith('stage-1');
  });

  it('no database: general path (null)', async () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(await loadStageForSpeech(request, 'stage-1', 'read')).toBeNull();
  });
});
