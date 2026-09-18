/**
 * W16 — the reviewer's Teaching Skills inspection routes (teaching-skills plan
 * §P Step 17 · §J · FR-TS-038/045/053 · AC-TS-026).
 *
 * GET /api/stages/[stageId]/teaching-skills returns all eight per-Scene fields
 * for every Scene type — interactive and PBL explicitly included, the exact
 * exclusion the plan warns the surfaces/ layer would cause. PUT applies the
 * policy-constrained mutation through the W14 service; the confirmation route
 * records W15 baselines. Authorization is the Editor grant (read/write) plus
 * the existing status guard — no new machinery.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
} from '@/lib/persistence/teaching-package';
import {
  buildEditorGrantPayload,
  grantCookieValueForRedeem,
} from '@/lib/server/teaching-package/editor-grant';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { TeachingFlowEntry } from '@/lib/types/teaching-package';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const FEYNMAN = { skillId: 'feynman-learning', version: 'v1' };
const LECTURE = { skillId: 'lecture-style', version: 'v1' };
const FIXED_NOW = 1_700_000_000_000;

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const FLOW: TeachingFlowEntry[] = [
  {
    stage: 'lesson_introduction',
    instructions: 'i',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [FEYNMAN, LECTURE],
      combinationRestrictions: [],
    },
  },
  {
    stage: 'outcome_teaching_cards',
    instructions: 'c',
    skillPolicy: {
      required: [],
      preferred: [],
      allowed: [FEYNMAN, LECTURE],
      combinationRestrictions: [],
    },
  },
];

describe('W16 stage teaching-skills inspection routes', () => {
  let pool: PGlitePool;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-w16-${(counter += 1)}`;
  const qp = () => pool as never;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://w16-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await ensureTeachingPackageSchema(qp());
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  function makeStore() {
    return createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
  }

  /** Slide + interactive + PBL scenes at position 0; slide at position 1. */
  function allFourTypeScenes(stageId: string): AppScene[] {
    const slide = {
      ...makeSlideScene('s-slide', stageId, 1),
      teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
      teachingSkills: { primary: FEYNMAN, classification: 'instructional' as const },
    };
    const interactive = {
      id: 's-interactive',
      stageId,
      title: 'Interactive',
      order: 2,
      type: 'interactive',
      content: { type: 'interactive', url: 'https://example.test/widget' },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
      teachingSkills: { primary: LECTURE, classification: 'instructional' as const },
    } as unknown as AppScene;
    const pbl = {
      id: 's-pbl',
      stageId,
      title: 'PBL',
      order: 3,
      type: 'pbl',
      content: { type: 'pbl' },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      teachingStage: { key: 'outcome_teaching_cards', flowIndex: 1 },
      teachingSkills: { classification: 'non-instructional' as const },
    } as unknown as AppScene;
    return [slide, interactive, pbl];
  }

  async function seedVersion(options: {
    status?: 'draft' | 'in_review' | 'approved';
    contract?: string | null;
    scenes?: (stageId: string) => AppScene[];
  }): Promise<{ versionId: string; stageId: string }> {
    const item = { type: 'lesson' as const, id: nextId('li') };
    const stageId = nextId('stage');
    await makeStore().saveDocument(
      makeDocument(stageId, 'W16', (options.scenes ?? allFourTypeScenes)(stageId)),
    );
    const versionId = nextId('tpv');
    const attemptId = nextId('tpa');
    await insertVersion(qp(), {
      id: versionId,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      version: 1,
      status: options.status ?? 'draft',
      currentStageId: stageId,
      currentAttemptId: attemptId,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    await insertAttempt(qp(), {
      id: attemptId,
      aggregate: { tenantId: 'tenant-test', learningItem: item },
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'actor-1',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      teachingSkillsContract:
        options.contract === undefined ? 'kafuo.teaching-skills.v1' : options.contract,
      inputSnapshot: {
        learningItem: item,
        teachingModel: { key: 'g5', version: 'g5.v1' },
        learningObjectives: [],
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
        teachingFlow: FLOW,
      },
      now: 1,
    });
    return { versionId, stageId };
  }

  function request(
    stageId: string,
    init: { method?: 'GET' | 'PUT'; capability?: 'read' | 'write'; body?: unknown } = {},
  ): NextRequest {
    const { token } = buildEditorGrantPayload({
      tenantId: 'tenant-test',
      versionId: `tpv-${stageId}` /* replaced below by the real one via cookie value */,
      stageId,
      capability: init.capability ?? 'read',
    });
    void token;
    // Build the cookie through the same helper the redeem route uses; the
    // versionId inside the grant must match the seeded version, so the seed
    // controls it: the grant is minted per-test with the real versionId.
    const headers = new Headers();
    if (init.capability !== undefined || init.method === 'PUT') {
      // populated by the caller through grantHeaders
    }
    if (init.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    return new NextRequest(`http://localhost/api/stages/${stageId}/teaching-skills`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  /** A request whose grant cookie names the real seeded version. */
  function grantedRequest(
    stageId: string,
    versionId: string,
    init: { method?: 'GET' | 'PUT'; capability?: 'read' | 'write'; body?: unknown } = {},
  ): NextRequest {
    const { token } = buildEditorGrantPayload({
      tenantId: 'tenant-test',
      versionId,
      stageId,
      capability: init.capability ?? 'read',
    });
    const headers = new Headers({
      cookie: `teaching_package_grant=${encodeURIComponent(
        grantCookieValueForRedeem(new Headers(), token, stageId),
      )}`,
    });
    const requestInit: RequestInit = {
      method: init.method ?? 'GET',
      headers,
    };
    if (init.body !== undefined) {
      requestInit.body = JSON.stringify(init.body);
      headers.set('content-type', 'application/json');
    }
    const path =
      (init.method ?? 'GET') === 'PUT' &&
      init.body &&
      (init.body as { confirmations?: unknown }).confirmations !== undefined
        ? 'scene-alignment-confirmations'
        : 'teaching-skills';
    return new NextRequest(`http://localhost/api/stages/${stageId}/${path}`, requestInit as never);
  }

  const loadRoute = async (path: 'teaching-skills' | 'scene-alignment-confirmations') =>
    (await import(
      path === 'teaching-skills'
        ? '@/app/api/stages/[stageId]/teaching-skills/route'
        : '@/app/api/stages/[stageId]/scene-alignment-confirmations/route'
    )) as {
      GET?: typeof import('@/app/api/stages/[stageId]/teaching-skills/route').GET;
      PUT: (req: NextRequest, ctx: { params: Promise<{ stageId: string }> }) => Promise<Response>;
    };

  it('GET answers 404 without a grant (non-enumerating)', async () => {
    const { stageId } = await seedVersion({});
    const route = await loadRoute('teaching-skills');
    const response = await route.GET!(request(stageId), {
      params: Promise.resolve({ stageId }),
    });
    expect(response.status).toBe(404);
  });

  it('GET returns all eight fields for slide, interactive AND PBL scenes (no silent exclusion)', async () => {
    const { versionId, stageId } = await seedVersion({});
    const route = await loadRoute('teaching-skills');
    const response = await route.GET!(grantedRequest(stageId, versionId), {
      params: Promise.resolve({ stageId }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      governed: boolean;
      editable: boolean;
      capability: string;
      versionStatus: string;
      teachingModel: { key: string; version: string };
      scenes: Array<Record<string, unknown>>;
    };
    expect(payload.governed).toBe(true);
    expect(payload.editable).toBe(true);
    expect(payload.capability).toBe('read');
    expect(payload.versionStatus).toBe('draft');
    expect(payload.teachingModel).toEqual({ key: 'g5', version: 'g5.v1' });

    // All four... three seeded types — the interactive and PBL rows are the
    // ones a surfaces/-level panel would have dropped.
    const byType = new Map(payload.scenes.map((scene) => [scene.sceneType, scene]));
    expect([...byType.keys()].sort()).toEqual(['interactive', 'pbl', 'slide']);
    for (const scene of payload.scenes) {
      // The eight fields.
      expect(scene).toHaveProperty('classification');
      expect(scene).toHaveProperty('primary');
      expect(scene).toHaveProperty('supporting');
      expect(scene.policy).toMatchObject({ relationship: expect.any(String) });
      expect(scene).toHaveProperty('flowPosition');
      expect(scene.alignment).toMatchObject({
        state: expect.any(String),
        aligned: expect.any(Boolean),
      });
      expect(scene).toHaveProperty('failures');
    }
    expect(byType.get('slide')!.flowPosition).toEqual({
      key: 'lesson_introduction',
      flowIndex: 0,
    });
    expect(byType.get('interactive')!.policy).toMatchObject({ relationship: 'within-policy' });
    expect(byType.get('pbl')!.classification).toBe('non-instructional');
    expect(byType.get('pbl')!.policy).toMatchObject({ relationship: 'within-policy' });
  });

  it('GET reports a legacy stage as not governed', async () => {
    const { versionId, stageId } = await seedVersion({ contract: null });
    const route = await loadRoute('teaching-skills');
    const response = await route.GET!(grantedRequest(stageId, versionId), {
      params: Promise.resolve({ stageId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ governed: false });
  });

  it('PUT with a write grant switches within policy; a read grant is refused 403', async () => {
    const { versionId, stageId } = await seedVersion({});
    const route = await loadRoute('teaching-skills');
    const readRefusal = await route.PUT(
      grantedRequest(stageId, versionId, {
        method: 'PUT',
        capability: 'read',
        body: {
          assignments: [
            {
              sceneId: 's-slide',
              teachingSkills: { primary: LECTURE, classification: 'instructional' },
            },
          ],
        },
      }),
      { params: Promise.resolve({ stageId }) },
    );
    expect(readRefusal.status).toBe(403);

    const accepted = await route.PUT(
      grantedRequest(stageId, versionId, {
        method: 'PUT',
        capability: 'write',
        body: {
          assignments: [
            {
              sceneId: 's-slide',
              teachingSkills: { primary: LECTURE, classification: 'instructional' },
            },
          ],
        },
      }),
      { params: Promise.resolve({ stageId }) },
    );
    expect(accepted.status).toBe(200);
    const document = await makeStore().loadDocument(stageId);
    expect(document!.scenes.find((scene) => scene.id === 's-slide')!.teachingSkills).toEqual({
      primary: LECTURE,
      classification: 'instructional',
    });
  });

  it('PUT refuses out-of-policy choices and non-editable states', async () => {
    const draft = await seedVersion({});
    const route = await loadRoute('teaching-skills');
    const outOfPolicy = await route.PUT(
      grantedRequest(draft.stageId, draft.versionId, {
        method: 'PUT',
        capability: 'write',
        body: {
          assignments: [
            {
              sceneId: 's-slide',
              teachingSkills: {
                primary: { skillId: 'deep-research', version: 'v1' },
                classification: 'instructional',
              },
            },
          ],
        },
      }),
      { params: Promise.resolve({ stageId: draft.stageId }) },
    );
    expect(outOfPolicy.status).toBe(422);
    expect(((await outOfPolicy.json()) as { error: { code: string } }).error.code).toBe(
      'SKILL_ASSIGNMENT_INVALID',
    );

    const inReview = await seedVersion({ status: 'in_review' });
    const refused = await route.PUT(
      grantedRequest(inReview.stageId, inReview.versionId, {
        method: 'PUT',
        capability: 'write',
        body: {
          assignments: [
            {
              sceneId: 's-slide',
              teachingSkills: { primary: LECTURE, classification: 'instructional' },
            },
          ],
        },
      }),
      { params: Promise.resolve({ stageId: inReview.stageId }) },
    );
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('PUT confirmations records a W15 baseline with a server-derived actor', async () => {
    const { versionId, stageId } = await seedVersion({});
    const route = await loadRoute('scene-alignment-confirmations');
    const response = await route.PUT(
      grantedRequest(stageId, versionId, {
        method: 'PUT',
        capability: 'write',
        body: { confirmations: [{ sceneId: 's-slide' }] },
      }),
      { params: Promise.resolve({ stageId }) },
    );
    expect(response.status).toBe(200);
    const document = await makeStore().loadDocument(stageId);
    const scene = document!.scenes.find((entry) => entry.id === 's-slide')!;
    expect(scene.alignmentBaseline).toMatchObject({
      origin: 'reviewer-confirmation',
      actorRef: `teaching-package-editor:${stageId}`,
      primary: FEYNMAN,
    });

    const approved = await seedVersion({ status: 'approved' });
    const refused = await route.PUT(
      grantedRequest(approved.stageId, approved.versionId, {
        method: 'PUT',
        capability: 'write',
        body: { confirmations: [{ sceneId: 's-slide' }] },
      }),
      { params: Promise.resolve({ stageId: approved.stageId }) },
    );
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_TRANSITION',
    );
  });
  describe('W5 — the inspection GET carries Actions alongside governance context', () => {
    /**
     * Scenes carrying persisted Actions — the W3-validator view a reviewer
     * needs next to Skills/flow/alignment. The slide's dangling `elementId` is
     * DSL-VALID (a string), so it saves through the strict barrier and only the
     * canonical reference check flags it; the interactive scene's unknown type
     * rides the lenient app-layer path (the F-2 split) exactly as the historical
     * corpus does.
     */
    function scenesWithActions(stageId: string): AppScene[] {
      const slide = {
        ...makeSlideScene('s-slide-actions', stageId, 1),
        teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
        teachingSkills: { primary: FEYNMAN, classification: 'instructional' as const },
        actions: [
          { id: 'a-ok', type: 'speech', text: 'Narration.' },
          { id: 'a-flagged', type: 'spotlight', elementId: 'el-missing' },
        ],
      } as unknown as AppScene;
      const interactive = {
        id: 's-interactive-actions',
        stageId,
        title: 'Interactive',
        order: 2,
        type: 'interactive',
        content: { type: 'interactive', url: 'https://example.test/widget' },
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        teachingStage: { key: 'lesson_introduction', flowIndex: 0 },
        teachingSkills: { primary: LECTURE, classification: 'instructional' as const },
        actions: [{ id: 'a-legacy', type: 'legacy_confetti_burst' }],
      } as unknown as AppScene;
      return [slide, interactive];
    }

    it('a read grant gets Skills, flow position, alignment, actionCount AND actionFindings together', async () => {
      const { versionId, stageId } = await seedVersion({ scenes: scenesWithActions });
      const route = await loadRoute('teaching-skills');
      const response = await route.GET!(
        grantedRequest(stageId, versionId, { capability: 'read' }),
        { params: Promise.resolve({ stageId }) },
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        governed: boolean;
        capability: string;
        scenes: Array<Record<string, unknown>>;
      };
      expect(payload.governed).toBe(true);
      expect(payload.capability).toBe('read');

      const slide = payload.scenes.find((scene) => scene.sceneId === 's-slide-actions')!;
      expect(slide.primary).toEqual(FEYNMAN);
      expect(slide.flowPosition).toEqual({ key: 'lesson_introduction', flowIndex: 0 });
      expect(slide.alignment).toMatchObject({
        state: expect.any(String),
        aligned: expect.any(Boolean),
      });
      expect(slide.actionCount).toBe(2);
      expect(slide.actionFindings).toEqual([
        expect.objectContaining({
          actionId: 'a-flagged',
          actionType: 'spotlight',
          code: 'ACTION_REFERENCE_INVALID',
        }),
      ]);
      // The folded per-Scene failures channel carries the code too.
      expect(slide.failures).toEqual([
        expect.objectContaining({ code: 'ACTION_REFERENCE_INVALID' }),
      ]);

      const interactive = payload.scenes.find(
        (scene) => scene.sceneId === 's-interactive-actions',
      )!;
      expect(interactive.actionCount).toBe(1);
      expect(interactive.actionFindings).toEqual([
        expect.objectContaining({
          actionId: 'a-legacy',
          actionType: 'legacy_confetti_burst',
          code: 'ACTION_TYPE_UNKNOWN',
        }),
      ]);

      // Identity only (TAE-RQ-027): the persisted narration never rides the GET
      // (actionType/element ids are identity and DO appear, by design).
      expect(JSON.stringify(payload)).not.toContain('Narration.');
    });

    it('a write operation still refuses on a read grant; a non-governed Stage still answers governed:false', async () => {
      const { versionId, stageId } = await seedVersion({ scenes: scenesWithActions });
      const route = await loadRoute('teaching-skills');
      const refused = await route.PUT(
        grantedRequest(stageId, versionId, {
          method: 'PUT',
          capability: 'read',
          body: {
            assignments: [{ sceneId: 's-slide-actions', teachingSkills: { primary: LECTURE } }],
          },
        }),
        { params: Promise.resolve({ stageId }) },
      );
      expect(refused.status).toBe(403);

      const legacy = await seedVersion({ contract: null, scenes: scenesWithActions });
      const legacyResponse = await route.GET!(
        grantedRequest(legacy.stageId, legacy.versionId, { capability: 'read' }),
        { params: Promise.resolve({ stageId: legacy.stageId }) },
      );
      expect(legacyResponse.status).toBe(200);
      expect(await legacyResponse.json()).toEqual({ governed: false });
    });
  });
});
