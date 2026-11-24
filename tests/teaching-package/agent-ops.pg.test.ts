/**
 * Kafuo Agent API wave E3 over PGlite, through the real `agent-ops` routes, services,
 * stores, fences and schema. Only the model is stubbed (`regenerateOneScene` and the model
 * route, which is where the meter starts).
 *
 * - §8 "dry run changes nothing": dry runs of regenerate, generate, delete and skills
 *   leave every row count unchanged and create no regeneration or insertion row.
 * - The real 202 seam: the answer comes once the regeneration row exists, the run goes
 *   on under `after()`, and the op status reads it done.
 * - The delete: its keyed record is written in its own transaction, so a retry after an
 *   unknown outcome answers "done" with the backup before the revision check; the
 *   revision fence and the running-row re-check refuse inside the write.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { insertVersion } from '@/lib/persistence/teaching-package';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import type { RegenerateOneSceneInput } from '@/lib/server/teaching-package/regenerate-one-scene';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const mocks = vi.hoisted(() => ({
  regenerate: vi.fn(),
  createRoute: vi.fn(),
  /** Phase 2 F3.3: the eligible visuals (null → the real reader). */
  visuals: null as null | ((...args: unknown[]) => Promise<unknown>),
  release: null as null | (() => void),
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (callback: () => unknown) => {
    mocks.afterCallbacks.push(callback);
  },
}));
vi.mock('@/lib/server/teaching-package/regenerate-one-scene', () => ({
  regenerateOneScene: mocks.regenerate,
}));
vi.mock('@/lib/server/teaching-package/routed-regeneration-call', () => ({
  createRegenerationRoute: mocks.createRoute,
}));
vi.mock('@/lib/server/teaching-package/scene-insertion', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/lib/server/teaching-package/scene-insertion')>();
  return {
    ...original,
    eligibleVisualsForUnits: (...args: Parameters<typeof original.eligibleVisualsForUnits>) =>
      mocks.visuals
        ? (mocks.visuals(...args) as ReturnType<typeof original.eligibleVisualsForUnits>)
        : original.eligibleVisualsForUnits(...args),
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

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

const STAGE = 'stage-agent-ops';
const VERSION = `tpv-${STAGE}`;
const TENANT = 'tenant-test';
const SERVICE_KEY = 'agent-ops-pg-key';
const AGENT = 'agent:5';

function slide(id: string, order: number, units: string[]): AppScene {
  return { ...makeSlideScene(id, STAGE, order), sourceContentUnitIds: units } as AppScene;
}

function generatedFrom(pre: AppScene): AppScene {
  return { ...pre, title: `${pre.title} (regenerated)`, updatedAt: (pre.updatedAt ?? 0) + 1 };
}

describe('agent-ops over PGlite', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://agent-ops-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    mocks.afterCallbacks.length = 0;
    mocks.release = null;
    mocks.visuals = null;
    mocks.regenerate.mockReset();
    mocks.createRoute.mockReset();
    mocks.createRoute.mockResolvedValue({
      aiCallFor: () => async () => '',
      assertAvailable: () => {},
      description: { mode: 'test' },
    });
    mocks.regenerate.mockImplementation(async (input: RegenerateOneSceneInput) => {
      await new Promise<void>((resolve) => {
        mocks.release = resolve;
      });
      return { ok: true, scene: generatedFrom(input.scene) };
    });

    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const store = createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    await store.saveDocument(
      makeDocument(STAGE, 'Draft package', [
        slide('scene-1', 1, ['u1']),
        slide('scene-2', 2, ['u1']),
        slide('scene-3', 3, ['u2']),
      ]),
    );
    await insertVersion(pool as never, {
      id: VERSION,
      aggregate: { tenantId: TENANT, learningItem: { type: 'lesson', id: `li-${STAGE}` } },
      version: 1,
      status: 'draft',
      currentStageId: STAGE,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function stageRevision(): Promise<number> {
    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const store = await getOwnerScopedDocumentStore(TEACHING_PACKAGE_STAGE_OWNER);
    return Number((await store.readFreshnessManifest(STAGE))!.rev);
  }

  async function post(op: string, body: Record<string, unknown>): Promise<Response> {
    const { POST } = await import('@/app/api/teaching-packages/[id]/agent-ops/[op]/route');
    return POST(
      new NextRequest(`http://localhost/api/teaching-packages/${VERSION}/agent-ops/${op}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantContext: { tenantId: TENANT },
          actorRef: AGENT,
          ...body,
        }),
      }),
      { params: Promise.resolve({ id: VERSION, op }) },
    );
  }

  async function opStatus(opId: string): Promise<Response> {
    const { GET } = await import('@/app/api/teaching-packages/[id]/agent-ops/ops/[opId]/route');
    return GET(
      new NextRequest(
        `http://localhost/api/teaching-packages/${VERSION}/agent-ops/ops/${opId}?tenantId=${TENANT}`,
        { headers: { authorization: `Bearer ${SERVICE_KEY}` } },
      ),
      { params: Promise.resolve({ id: VERSION, opId }) },
    );
  }

  async function counts() {
    const one = async (sql: string) =>
      Number(((await pool.query(sql)).rows[0] as { n: number | string }).n);
    return {
      scenes: await one(`SELECT count(*) AS n FROM document_scenes WHERE stage_id = '${STAGE}'`),
      revisions: await one(
        `SELECT coalesce(sum(rev), 0) AS n FROM document_scene_revision WHERE stage_id = '${STAGE}'`,
      ),
      regenerations: await one('SELECT count(*) AS n FROM teaching_package_scene_regenerations'),
      insertions: await one('SELECT count(*) AS n FROM teaching_package_scene_insertions'),
      events: await one('SELECT count(*) AS n FROM teaching_package_review_events'),
      webhooks: await one('SELECT count(*) AS n FROM teaching_package_webhook_deliveries'),
      agentOps: await one('SELECT count(*) AS n FROM teaching_package_agent_ops'),
    };
  }

  const KEY = 'agt_3_0123456789abcdef0123456789abcdef01234567';

  it('dry runs of regenerate, generate, delete and skills change no row and call no model', async () => {
    const revision = String(await stageRevision());
    const before = await counts();
    const answers = [
      await post('regenerate', {
        expectedRevision: revision,
        dryRun: true,
        sceneId: 'scene-1',
        instruction: 'اكتب الشريحة بلغة أبسط مع مثال',
        reason: 'the slide is too dense',
      }),
      await post('generate', {
        expectedRevision: revision,
        dryRun: true,
        unitIds: ['u2'],
        afterSceneId: 'scene-1',
        teachingStage: { key: 'explain', flowIndex: 0 },
        reason: 'a part with no slide',
      }),
      await post('delete', {
        expectedRevision: revision,
        dryRun: true,
        sceneId: 'scene-2',
        keepSceneId: 'scene-1',
        reason: 'the same slide twice',
      }),
      await post('skills', {
        expectedRevision: revision,
        dryRun: true,
        sceneId: 'scene-1',
        primary: { skillId: 'chem', version: 'v1' },
      }),
    ];
    // regenerate and delete answer their verdicts; generate and skills refuse on this
    // legacy package (no flow, no governance) — a dry run refusal writes no audit row.
    expect(answers[0]!.status).toBe(200);
    expect(await answers[0]!.json()).toMatchObject({ dryRun: true, wouldRun: true });
    expect(answers[1]!.status).toBeGreaterThanOrEqual(400);
    expect(answers[2]!.status).toBe(200);
    expect(await answers[2]!.json()).toMatchObject({ dryRun: true, status: 'would_delete' });
    expect(answers[3]!.status).toBeGreaterThanOrEqual(400);
    expect(await counts()).toEqual(before);
    expect(String(await stageRevision())).toBe(revision);
    expect(mocks.createRoute).not.toHaveBeenCalled();
    expect(mocks.regenerate).not.toHaveBeenCalled();
  });

  it('a real regenerate answers 202 once its row exists, then the op reads done, as agent:<id>', async () => {
    const revision = String(await stageRevision());
    const response = await post('regenerate', {
      expectedRevision: revision,
      sceneId: 'scene-1',
      instruction: 'اكتب الشريحة بلغة أبسط مع مثال',
      reason: 'the slide is too dense',
      idempotencyKey: KEY,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ opId: `rg_${KEY}`, status: 'running' });
    const running = (
      await pool.query('SELECT status, actor_ref FROM teaching_package_scene_regenerations')
    ).rows as Array<{ status: string; actor_ref: string }>;
    expect(running).toEqual([{ status: 'running', actor_ref: AGENT }]);
    expect((await opStatus(`rg_${KEY}`)).status).toBe(202);

    // While it runs, a delete's write re-checks the running rows under the stage lock.
    const { deleteSceneAtRevs } =
      await import('@/lib/server/teaching-package/delete-duplicate-scene');
    await expect(
      deleteSceneAtRevs(
        pool as never,
        {
          stageId: STAGE,
          sceneId: 'scene-2',
          keepSceneId: 'scene-3',
          revs: { 'scene-2': 1, 'scene-3': 1 },
        },
        AGENT,
      ),
    ).rejects.toMatchObject({ code: 'STAGE_GENERATION_IN_PROGRESS' });

    await vi.waitFor(() => expect(mocks.release).not.toBeNull());
    mocks.release!();
    await Promise.all(mocks.afterCallbacks.map((callback) => callback()));
    const done = await opStatus(`rg_${KEY}`);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: 'done', sceneId: 'scene-1' });
    expect(mocks.regenerate).toHaveBeenCalledTimes(1);
  });

  it('a delete records itself in its own transaction; a retry answers done with the backup', async () => {
    const revision = String(await stageRevision());
    const body = {
      expectedRevision: revision,
      sceneId: 'scene-2',
      keepSceneId: 'scene-1',
      reason: 'the same slide twice',
      idempotencyKey: KEY,
    };
    const first = await post('delete', body);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { backup: { scene_id: string } };
    expect(firstBody.backup.scene_id).toBe('scene-2');
    const after = await counts();
    expect(after.scenes).toBe(2);
    expect(after.agentOps).toBe(1);
    const webhooks = (
      await pool.query(
        `SELECT payload FROM teaching_package_webhook_deliveries
          WHERE event_type = 'teaching_package.scene_changed'`,
      )
    ).rows as Array<{ payload: unknown }>;
    expect(JSON.stringify(webhooks)).toContain(AGENT);

    // The same key after an unknown outcome: the stage moved, the slide is gone.
    const retry = await post('delete', body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      status: 'done',
      replayed: true,
      deleted: true,
      backup: { scene_id: 'scene-2' },
    });
    // The same key with another body is refused.
    const other = await post('delete', { ...body, reason: 'another reason entirely' });
    expect(other.status).toBe(409);
    expect(await counts()).toEqual(after);
  });

  describe('add-image (phase 2 F3.3)', () => {
    const IMAGE_KEY = 'agt_3_add_image_0123456789abcdef0123456789abcdef';
    const PATH = '/media/stage-agent-ops/src-7.png';
    const entry = {
      id: 'src-7',
      contentResourceId: '1',
      pageNumber: 4,
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      servingPath: PATH,
      sourceContentUnitIds: ['u1'],
    };
    const image = { id: 'src-7', src: PATH, pageNumber: 4, sourceContentUnitIds: ['u1'] };
    const plan = JSON.stringify({
      suggestedImageIds: ['src-7'],
      imagePlans: [{ imageId: 'src-7', shows: 'دائرة كهربائية', teachingPoint: 'مسار التيار' }],
      visualPlan: { mode: 'image' },
      keyPoints: ['نقطة أولى', 'نقطة ثانية', 'نقطة ثالثة'],
    });
    const prompts: string[] = [];

    beforeEach(() => {
      prompts.length = 0;
      // Only the parts `u1` cites have this one approved, readable visual.
      mocks.visuals = async (...args: unknown[]) =>
        (args[2] as string[]).includes('u1')
          ? {
              visuals: [{ entry, image }],
              visionImages: [{ id: 'src-7', src: 'data:image/png;base64,AAAA' }],
            }
          : { visuals: [], visionImages: [] };
      mocks.createRoute.mockResolvedValue({
        aiCallFor: () => async (_system: string, user: string) => {
          prompts.push(user);
          return plan;
        },
        assertAvailable: () => {},
        description: { mode: 'test' },
      });
      mocks.regenerate.mockImplementation(async (input: RegenerateOneSceneInput) => {
        await new Promise<void>((resolve) => {
          mocks.release = resolve;
        });
        const pre = input.scene as AppScene & { content: { canvas: { elements: unknown[] } } };
        return {
          ok: true,
          scene: {
            ...generatedFrom(input.scene),
            content: {
              ...pre.content,
              canvas: {
                ...pre.content.canvas,
                elements: [
                  ...pre.content.canvas.elements,
                  {
                    id: 'img-1',
                    type: 'image',
                    src: PATH,
                    left: 0,
                    top: 0,
                    width: 100,
                    height: 80,
                  },
                ],
              },
            },
          },
        };
      });
    });

    const body = (revision: string, extra: Record<string, unknown> = {}) => ({
      expectedRevision: revision,
      sceneId: 'scene-1',
      sourceVisualId: 'src-7',
      note: 'اربط الصورة بمسار التيار',
      idempotencyKey: IMAGE_KEY,
      ...extra,
    });

    it('a dry run and every refusal write no row and call no model', async () => {
      const revision = String(await stageRevision());
      const before = await counts();
      const dry = await post('add-image', body(revision, { dryRun: true }));
      expect(dry.status).toBe(200);
      expect(await dry.json()).toMatchObject({
        dryRun: true,
        wouldRun: true,
        sceneId: 'scene-1',
        sourceVisualId: 'src-7',
      });
      // scene-3 cites u2: src-7 is not one of its parts' visuals.
      const foreign = await post('add-image', body(revision, { sceneId: 'scene-3' }));
      expect(foreign.status).toBe(422);
      expect(await foreign.json()).toMatchObject({
        error: { code: 'VISUAL_NOT_ELIGIBLE', details: { eligibleVisualIds: [] } },
      });
      const unknown = await post('add-image', body(revision, { sourceVisualId: 'src-99' }));
      expect(unknown.status).toBe(422);
      expect(await unknown.json()).toMatchObject({
        error: { code: 'VISUAL_NOT_ELIGIBLE', details: { eligibleVisualIds: ['src-7'] } },
      });
      expect(await counts()).toEqual(before);
      expect(mocks.regenerate).not.toHaveBeenCalled();
      expect(prompts).toEqual([]);
    });

    it('answers 202, re-plans with the image, lands as the agent’s regeneration, replays by key', async () => {
      const revision = String(await stageRevision());
      const response = await post('add-image', body(revision));
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        opId: `rg_${IMAGE_KEY}`,
        status: 'running',
        sceneId: 'scene-1',
        sourceVisualId: 'src-7',
      });
      await vi.waitFor(() => expect(mocks.release).not.toBeNull());
      // The visual re-plan ran on the metered route, with the image required.
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('keep exactly src-7');
      expect(prompts[0]).toContain('<<<NOTE');
      const input = mocks.regenerate.mock.calls[0]![0] as RegenerateOneSceneInput;
      expect(input.replannedOutline?.suggestedImageIds).toEqual(['src-7']);
      expect(input.sourceContentUnitIds).toEqual(['u1']);
      mocks.release!();
      await Promise.all(mocks.afterCallbacks.map((callback) => callback()));

      const done = await opStatus(`rg_${IMAGE_KEY}`);
      expect(done.status).toBe(200);
      expect(await done.json()).toMatchObject({ status: 'done', kind: 'regeneration' });
      // A8: the agent's own regeneration event on the slide.
      const { loadSceneWriteEvents } =
        await import('@/lib/server/teaching-package/agent-alignment-proof');
      const events = await loadSceneWriteEvents(pool as never, VERSION, STAGE, ['scene-1']);
      expect(events.get('scene-1')).toEqual([
        expect.objectContaining({ kind: 'regeneration', actorRef: AGENT }),
      ]);
      expect((await counts()).agentOps).toBe(0);

      // The same key after the image landed: that run, never a 409.
      const replay = await post('add-image', body(revision));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ opId: `rg_${IMAGE_KEY}`, status: 'done' });
      const reused = await post('add-image', body(revision, { note: 'ملاحظة أخرى مختلفة' }));
      expect(reused.status).toBe(409);
      expect(await reused.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
      // A new key: the image is on the slide now.
      const again = await post(
        'add-image',
        body(String(await stageRevision()), { idempotencyKey: `${IMAGE_KEY}_2` }),
      );
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: { code: 'VISUAL_ALREADY_ON_SLIDE' } });
      expect(mocks.regenerate).toHaveBeenCalledTimes(1);
    });

    it('a regeneration that drops the added image fails and writes nothing to the slide', async () => {
      mocks.regenerate.mockImplementation(async (input: RegenerateOneSceneInput) => ({
        ok: true,
        scene: generatedFrom(input.scene),
      }));
      const revision = String(await stageRevision());
      const response = await post('add-image', body(revision));
      // Started after its row exists (202); the run then fails on the missing image.
      expect(response.status).toBe(202);
      await Promise.all(mocks.afterCallbacks.map((callback) => callback()));
      expect(String(await stageRevision())).toBe(revision);
      const status = await opStatus(`rg_${IMAGE_KEY}`);
      expect(await status.json()).toMatchObject({
        status: 'failed',
        errorCode: 'SCENE_CONTENT_GENERATION_FAILED',
      });
    });
  });

  it('the delete fence refuses a slide changed since its revision was read', async () => {
    const { deleteSceneAtRevs } =
      await import('@/lib/server/teaching-package/delete-duplicate-scene');
    const before = await counts();
    await expect(
      deleteSceneAtRevs(
        pool as never,
        {
          stageId: STAGE,
          sceneId: 'scene-2',
          keepSceneId: 'scene-1',
          revs: { 'scene-2': 99, 'scene-1': 1 },
        },
        AGENT,
      ),
    ).rejects.toMatchObject({ code: 'SCENE_REVISION_CONFLICT' });
    expect(await counts()).toEqual(before);
  });
});
