/**
 * The agent book review routes (Kafuo Agent API D2a): service key (401), tenant
 * (another tenant's version → 404), 202 with the review id (idempotent by
 * requestId), and the GET read model. PGlite; the sweep is mocked (no model).
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ensureTeachingPackageSchema, insertVersion } from '@/lib/persistence/teaching-package';
import { TEACHING_PACKAGE_STAGE_OWNER } from '@/lib/server/teaching-package/owner';
import { teachingPackageStageGuardFence } from '@/lib/server/teaching-package/stage-guard';
import type { AppScene } from '@/lib/types/stage';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';
import { makeDocument, makeSlideScene } from '../agent-runtime/_stage-fixtures';

const sweep = vi.hoisted(() => vi.fn(async () => []));
vi.mock('@/lib/server/teaching-package/agent-book-review', () => ({
  sweepAgentBookReviews: sweep,
}));

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return { query: (t: string, p?: unknown[]) => this.db.query(t, p), release() {} };
  }
  async end() {
    await this.db.close();
  }
}

const KEY = 'agent-review-route-key';
const VERSION = 'tpv-arr';
const STAGE = 'stage-arr';

describe('agent book review routes', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://arr-${randomUUID()}`);
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', KEY);
    sweep.mockClear();
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    await createOwnerBoundDocumentStore<AppScene, AppStage>({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    }).saveDocument(makeDocument(STAGE, 'arr', [makeSlideScene('s1', STAGE, 1)]));
    await insertVersion(pool as never, {
      id: VERSION,
      aggregate: { tenantId: 'tenant-a', learningItem: { type: 'lesson', id: '218' } },
      version: 1,
      status: 'draft',
      currentStageId: STAGE,
      currentAttemptId: 'tpa-arr',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  const body = (tenantId = 'tenant-a', requestId = 'eval-1') => ({
    tenantContext: { tenantId },
    requestId,
    evaluationId: 'ev-9',
    runId: '35',
    subjectCode: 'CHEM',
    pages: [
      {
        pdfPage: 4,
        bookPage: 53,
        text: 'نص الصفحة',
        image: { mediaType: 'image/jpeg', data: 'QUJD' },
      },
    ],
    blocks: [{ id: 'b1', pdfPage: 4, kind: 'text', text: 'نص' }],
    units: [{ contentUnitId: 'u1', order: 0, blockIds: ['b1'] }],
  });

  const post = async (payload: unknown, authorization?: string) => {
    const { POST } = await import('@/app/api/teaching-packages/[id]/agent-book-reviews/route');
    return POST(
      new NextRequest(`http://localhost/api/teaching-packages/${VERSION}/agent-book-reviews`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: authorization ? { authorization } : {},
      }),
      { params: Promise.resolve({ id: VERSION }) },
    );
  };
  const get = async (reviewId: string, tenantId: string, authorization = `Bearer ${KEY}`) => {
    const { GET } =
      await import('@/app/api/teaching-packages/[id]/agent-book-reviews/[reviewId]/route');
    return GET(
      new NextRequest(
        `http://localhost/api/teaching-packages/${VERSION}/agent-book-reviews/${reviewId}?tenantId=${tenantId}`,
        { headers: { authorization } },
      ),
      { params: Promise.resolve({ id: VERSION, reviewId }) },
    );
  };

  it('refuses a missing or wrong service key with 401', async () => {
    expect((await post(body())).status).toBe(401);
    expect((await post(body(), 'Bearer wrong')).status).toBe(401);
    expect((await get('tpar-x', 'tenant-a', 'Bearer wrong')).status).toBe(401);
  });

  it('answers 404 for another tenant (POST and GET)', async () => {
    const response = await post(body('tenant-b'), `Bearer ${KEY}`);
    expect(response.status).toBe(404);
    const created = (await (await post(body(), `Bearer ${KEY}`)).json()) as { review_id: string };
    expect((await get(created.review_id, 'tenant-b')).status).toBe(404);
  });

  it('queues 202 {review_id}, starts the sweep, and replays by requestId', async () => {
    const first = await post(body(), `Bearer ${KEY}`);
    expect(first.status).toBe(202);
    const created = (await first.json()) as Record<string, unknown>;
    expect(created).toMatchObject({ status: 'queued', replayed: false });
    expect(String(created.review_id)).toMatch(/^tpar-/);
    await vi.waitFor(() => expect(sweep).toHaveBeenCalled());
    const again = (await (await post(body(), `Bearer ${KEY}`)).json()) as Record<string, unknown>;
    expect(again).toEqual({ review_id: created.review_id, status: 'queued', replayed: true });

    const read = await get(String(created.review_id), 'tenant-a');
    expect(read.status).toBe(200);
    const wire = (await read.json()) as Record<string, unknown>;
    expect(wire).toMatchObject({
      review_id: created.review_id,
      version_id: VERSION,
      evaluation_id: 'ev-9',
      run_id: '35',
      status: 'queued',
      findings: [],
      usage: { input_tokens: null, output_tokens: null, cost_usd: null },
    });
    // The images are never stored.
    const stored = await pool.query(
      'SELECT evidence::text AS e FROM teaching_package_agent_reviews',
    );
    expect((stored.rows[0] as { e: string }).e).not.toContain('QUJD');
  });

  it('a failed insert frees the held images at once (review fix 2)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await pool.query('ALTER TABLE teaching_package_agent_reviews RENAME TO tpar_moved_for_test');
    const response = await post(body(), `Bearer ${KEY}`);
    expect(response.status).toBe(500);
    const { heldAgentReviewImageBytes } =
      await import('@/lib/server/teaching-package/agent-book-review-store');
    expect(heldAgentReviewImageBytes()).toBe(0);
    await pool.query('ALTER TABLE tpar_moved_for_test RENAME TO teaching_package_agent_reviews');
    // And the next request is not refused as busy.
    expect((await post(body(), `Bearer ${KEY}`)).status).toBe(202);
    errors.mockRestore();
  });

  it('refuses a body over the cap with 413 in the error envelope (LOW d)', async () => {
    const big = { ...body(), pages: [{ pdfPage: 1, text: 'x'.repeat(33 * 1024 * 1024) }] };
    const response = await post(big, `Bearer ${KEY}`);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AGENT_REVIEW_BODY_TOO_LARGE' },
    });
  });

  it('refuses a malformed body with 400', async () => {
    const response = await post({ ...body(), pages: [] }, `Bearer ${KEY}`);
    expect(response.status).toBe(400);
  });
});
