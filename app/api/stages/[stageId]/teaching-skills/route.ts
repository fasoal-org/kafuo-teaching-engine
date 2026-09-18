/**
 * /api/stages/[stageId]/teaching-skills — the reviewer's per-Scene Teaching
 * Skills inspection surface (Module 2 W16, plan §P Step 17 · §J · FR-TS-038/
 * 045/053 · AC-TS-26).
 *
 * GET returns all eight per-Scene fields (classification · Primary ·
 * Supporting · exact versions · policy relationship · flow position ·
 * alignment state · actionable failures) for every Scene type; PUT applies the
 * policy-constrained Skill/classification change through the same service
 * function the Kafuo route uses (W14's setSceneTeachingSkills).
 *
 * Authorization reuses the Editor grant — no new machinery (plan §J): the
 * Stage-scoped HttpOnly capability the handoff minted, `read` for inspection
 * and `write` for mutation, plus the existing status guard underneath (the
 * service refuses anything but draft|rejected). A Stage without a grant
 * answers 404, non-enumerating.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { readVersionById } from '@/lib/persistence/teaching-package';
import { readEditorGrant } from '@/lib/server/teaching-package/editor-grant';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import {
  readFlowForVersion,
  readTeachingSkillsGovernanceForVersion,
} from '@/lib/server/teaching-package/exact-flow';
import { buildStageTeachingSkillsInspection } from '@/lib/server/teaching-package/scene-inspection';
import {
  normalizeSkillAssignment,
  setSceneTeachingSkills,
} from '@/lib/server/teaching-package/scene-skills';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ stageId: string }> };

/** Resolve the grant's version and prove it still owns this Stage. */
async function resolveGrantVersion(
  req: NextRequest,
  stageId: string,
): Promise<
  | { ok: true; versionId: string; tenantId: string; capability: 'read' | 'write' }
  | { ok: false; response: Response }
> {
  const grant = readEditorGrant(req.headers, stageId);
  if (!grant) {
    return { ok: false, response: new Response('Not found', { status: 404 }) };
  }
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const version = await readVersionById(pool, grant.versionId);
  if (!version || version.tenantId !== grant.tenantId || version.currentStageId !== stageId) {
    // A regeneration between mint and now invalidates what the grant names —
    // non-enumerating, exactly like the handoff redeem.
    return { ok: false, response: new Response('Not found', { status: 404 }) };
  }
  return {
    ok: true,
    versionId: version.id,
    tenantId: version.tenantId,
    capability: grant.capability,
  };
}

export async function GET(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  try {
    const { stageId } = await params;
    const grant = await resolveGrantVersion(req, stageId);
    if (!grant.ok) return grant.response;
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');

    const governance = await readTeachingSkillsGovernanceForVersion(pool, grant.versionId);
    if (!governance?.contract) {
      // Legacy stage: nothing pedagogical to inspect; the panel stays hidden.
      return NextResponse.json({ governed: false });
    }
    const flow = await readFlowForVersion(pool, grant.versionId);
    const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
    const document = await store.loadDocument(stageId);
    if (!document || !flow || flow.length === 0) {
      throw new TeachingPackageError(
        'STAGE_NOT_LIVE',
        'the governed version’s stage or flow is not readable',
      );
    }
    const inspection = buildStageTeachingSkillsInspection(document.scenes, flow, {
      // W5 (plan §7.5): the loaded stage, so discussion.agentId resolves
      // against the real roster exactly as the submit gate would.
      stage: document.stage,
    });
    const version = await readVersionById(pool, grant.versionId);
    return NextResponse.json({
      governed: true,
      capability: grant.capability,
      versionStatus: version!.status,
      // The existing status guard, stated once for the panel: mutation is a
      // draft/rejected concern (FR-TS-039).
      editable: version!.status === 'draft' || version!.status === 'rejected',
      teachingModel: version!.teachingModel,
      flowStages: flow.map((entry) => entry.stage),
      scenes: inspection.scenes,
    });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('teaching-skills inspection failed', error);
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  try {
    const { stageId } = await params;
    const grant = await resolveGrantVersion(req, stageId);
    if (!grant.ok) return grant.response;
    if (grant.capability !== 'write') {
      return NextResponse.json(
        {
          error: {
            code: 'READ_ONLY_GRANT',
            message: 'a read grant cannot change Skill assignments',
          },
        },
        { status: 403 },
      );
    }
    const body = (await req.json().catch(() => null)) as {
      assignments?: unknown;
    } | null;
    if (!body || !Array.isArray(body.assignments)) {
      throw new TeachingPackageError('INVALID_REQUEST', 'assignments must be an array');
    }
    const assignments = body.assignments.map((assignment) =>
      normalizeSkillAssignment(assignment as { sceneId: unknown; teachingSkills: unknown }),
    );
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const result = await setSceneTeachingSkills(
      pool,
      grant.versionId,
      { tenantId: grant.tenantId },
      assignments,
    );
    return NextResponse.json(result);
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('teaching-skills mutation failed', error);
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });
  }
}
