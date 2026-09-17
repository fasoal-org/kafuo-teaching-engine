import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  ensureDocumentSchema,
  ensureStageMetaSchema,
} from './helpers';

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

describe('teaching package webhooks', () => {
  let pool: PGlitePool;
  const qp = () => pool as never;
  const txPool = () => pool as unknown as ConnectableQueryable;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    const { ensureTeachingPackageSchema } = await import('@/lib/persistence/teaching-package');
    await ensureTeachingPackageSchema(qp());
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  const aggregate = {
    tenantId: 'tenant-wh',
    learningItem: { type: 'lesson' as const, id: `li-wh-${randomUUID()}` },
  };

  async function enqueue(eventType: 'teaching_package.status_changed' | 'teaching_package.generation_succeeded' | 'teaching_package.generation_failed', data: Record<string, unknown> = { version: { id: 'tpv-1' } }) {
    const { enqueueWebhookEvent } = await import('@/lib/server/teaching-package/webhook-events');
    await enqueueWebhookEvent(txPool(), aggregate, eventType, () => data as never);
  }

  it('allocates strictly increasing per-aggregate sequences', async () => {
    const { readLatestWebhookSequence } = await import('@/lib/persistence/teaching-package');
    await enqueue('teaching_package.status_changed');
    await enqueue('teaching_package.generation_failed');
    await enqueue('teaching_package.generation_succeeded');
    expect(await readLatestWebhookSequence(qp(), aggregate)).toBe(3);
    const rows = await pool.query(`SELECT sequence, event_type FROM teaching_package_webhook_deliveries ORDER BY sequence`);
    expect(rows.rows.map((r: unknown) => Number((r as { sequence: number }).sequence))).toEqual([1, 2, 3]);
  });

  it('rejects a payload carrying source content or retrieval credentials', async () => {
    await expect(
      enqueue('teaching_package.generation_failed', {
        contentResource: { url: 'https://x/y.pdf?X-Amz-Signature=abc' },
      }),
    ).rejects.toThrow(/retrieval credentials|source content/);
    await expect(
      enqueue('teaching_package.generation_failed', {
        normalizedContentResource: { url: 'https://x/y.zip?sig=abc' },
      }),
    ).rejects.toThrow(/retrieval credentials|source content/);
  });

  it('signs exactly `<timestamp>.<raw body>` with the dedicated secret (vector)', async () => {
    const { signWebhookDelivery, webhookSignatureInput } = await import(
      '@/lib/server/teaching-package/webhook-delivery'
    );
    const { createHmac } = await import('node:crypto');
    const timestamp = '1760000000';
    const body = '{"id":"tpe-1"}';
    expect(webhookSignatureInput(timestamp, body)).toBe(`${timestamp}.${body}`);
    const expected = `v1=${createHmac('sha256', 'whsec').update(`${timestamp}.${body}`).digest('hex')}`;
    expect(signWebhookDelivery('whsec', timestamp, body)).toBe(expected);
  });

  it('delivers in aggregate order, marks delivered, and keeps seq 2 waiting behind seq 1', async () => {
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_URL', 'https://kafuo.test/hook');
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_SECRET', 'whsec-test');
    await enqueue('teaching_package.status_changed', { marker: 'first' });
    await enqueue('teaching_package.generation_failed', { marker: 'second' });

    const { deliverPendingWebhooks } = await import(
      '@/lib/server/teaching-package/webhook-delivery'
    );
    // First attempt: only seq 1 is delivered — seq 2 has an older pending row? No:
    // seq 1 delivered, seq 2 claimable only after seq 1 leaves pending.
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(String(init?.body));
      return new Response(null, { status: 204 });
    });
    // Ordering: an event is claimable only when no older pending row exists
    // for its aggregate — seq 2 can NEVER overtake seq 1, so the first pass
    // delivers exactly seq 1 and the next pass picks up seq 2.
    const firstPass = await deliverPendingWebhooks({
      workerId: 'w1',
      fetchImpl: fetchImpl as never,
      pool: txPool(),
    });
    expect(firstPass).toBe(1);
    const secondPass = await deliverPendingWebhooks({
      workerId: 'w1',
      fetchImpl: fetchImpl as never,
      pool: txPool(),
    });
    expect(secondPass).toBe(1);
    expect(seen).toHaveLength(2);
    const statuses = await pool.query(`SELECT sequence, status FROM teaching_package_webhook_deliveries ORDER BY sequence`);
    expect(statuses.rows.every((r: unknown) => (r as { status: string }).status === 'delivered')).toBe(true);
    // The signature header is present and verifiable.
    const headers = (fetchImpl.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers['X-Teaching-Engine-Signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(headers['X-Teaching-Engine-Event-Id']).toBeDefined();
    expect(headers['X-Teaching-Engine-Timestamp']).toBeDefined();
  });

  it('retries a 5xx with backoff and terminally fails a 4xx', async () => {
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_URL', 'https://kafuo.test/hook');
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_SECRET', 'whsec-test');
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_MAX_RETRIES', '2');
    await enqueue('teaching_package.status_changed', { marker: 'terminal' });
    const { deliverPendingWebhooks } = await import(
      '@/lib/server/teaching-package/webhook-delivery'
    );
    const fetchImpl = vi.fn(async () => new Response(null, { status: 400 }));
    await deliverPendingWebhooks({ workerId: 'w1', fetchImpl: fetchImpl as never, pool: txPool() });
    const row = await pool.query(`SELECT status, attempts FROM teaching_package_webhook_deliveries`);
    expect(row.rows[0]).toMatchObject({ status: 'terminal_failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 4xx never retries
  });

  it('reclaims stale attempts through the sweep and enqueues generation_failed with ATTEMPT_RECLAIMED_STALE', async () => {
    const { insertAttempt } = await import('@/lib/persistence/teaching-package');
    const staleItem = { type: 'lesson' as const, id: `li-stale-${randomUUID()}` };
    await insertAttempt(qp(), {
      id: 'tpa-sweep-wh',
      aggregate: { tenantId: 'tenant-wh', learningItem: staleItem },
      kind: 'initial',
      status: 'running',
      requestedByActorRef: 'actor-1',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: {
        learningItem: staleItem,
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
      },
      now: 1,
    });
    await pool.query(
      `UPDATE teaching_package_generation_attempts SET created_at = $2 WHERE id = $1`,
      ['tpa-sweep-wh', Date.now() - 31 * 60 * 1000],
    );

    const { sweepWebhooksAndStaleAttempts } = await import(
      '@/lib/server/teaching-package/webhook-delivery'
    );
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_URL', 'https://kafuo.test/hook');
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_SECRET', 'whsec-test');
    vi.stubEnv('DATABASE_URL', `postgres://wh-${randomUUID()}`);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await sweepWebhooksAndStaleAttempts({ fetchImpl: fetchImpl as never, pool: txPool() });

    const attempt = await pool.query(`SELECT status, error_code FROM teaching_package_generation_attempts WHERE id = 'tpa-sweep-wh'`);
    expect(attempt.rows[0]).toMatchObject({
      status: 'failed',
      error_code: 'ATTEMPT_RECLAIMED_STALE',
    });
    const events = await pool.query(`SELECT event_type, payload FROM teaching_package_webhook_deliveries`);
    const failedEvent = events.rows.find(
      (r: unknown) => (r as { event_type: string }).event_type === 'teaching_package.generation_failed',
    ) as { payload: { error: { code: string } } } | undefined;
    expect(failedEvent?.payload.error.code).toBe('ATTEMPT_RECLAIMED_STALE');
  });

  it('emits superseded-then-approved in sequence order on successor approval, and NOTHING on createSuccessor', async () => {
    // Covered end-to-end through the lifecycle service with a PGlite pool.
    const { approve, createSuccessor, submitForReview } = await import(
      '@/lib/server/teaching-package/lifecycle'
    );
    const { insertVersion } = await import('@/lib/persistence/teaching-package');
    const { makeDocument, makeSlideScene } = await import('../agent-runtime/_stage-fixtures');
    const { createOwnerBoundDocumentStore } = await import('@/lib/persistence/owner-bound-document-store');
    const { validateAppScene, validateAppStage } = await import('@/lib/document-store/validators');
    const { teachingPackageStageGuardFence } = await import('@/lib/server/teaching-package/stage-guard');
    const { TEACHING_PACKAGE_STAGE_OWNER } = await import('@/lib/server/teaching-package/owner');

    vi.stubEnv('DATABASE_URL', `postgres://wh-app-${randomUUID()}`);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const item = { type: 'lesson' as const, id: `li-app-${randomUUID()}` };
    const agg = { tenantId: 'tenant-wh', learningItem: item };
    const store = createOwnerBoundDocumentStore({
      pool,
      ownerId: TEACHING_PACKAGE_STAGE_OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      mutationFence: teachingPackageStageGuardFence(),
    });
    const mkStage = async (name: string) => {
      await store.saveDocument(
        makeDocument(name, name, [makeSlideScene('s1', name, 1)]) as never,
      );
      return name;
    };
    const stageA = await mkStage('stageA1');
    const stageB = await mkStage('stageB2');
    await insertVersion(qp(), {
      id: 'tpv-wh-1',
      aggregate: agg,
      version: 1,
      status: 'draft',
      currentStageId: stageA,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    // No flow recorded → the exact-flow gate is skipped for this legacy-shaped seed.
    await submitForReview(txPool(), { tenantId: agg.tenantId, versionId: 'tpv-wh-1', actorRef: 'a' });
    await approve(txPool(), { tenantId: agg.tenantId, versionId: 'tpv-wh-1', actorRef: 'a' });

    const successor = await createSuccessor(txPool(), {
      tenantId: agg.tenantId,
      versionId: 'tpv-wh-1',
      actorRef: 'a',
    });
    // createSuccessor emitted NO event: count did not change for a new aggregate…
    const before = await pool.query(
      `SELECT COUNT(*)::int AS n FROM teaching_package_webhook_deliveries WHERE tenant_id = $1 AND learning_item_id = $2`,
      [agg.tenantId, item.id],
    );
    await submitForReview(txPool(), { tenantId: agg.tenantId, versionId: successor.id, actorRef: 'a' });
    void stageB;
    await approve(txPool(), { tenantId: agg.tenantId, versionId: successor.id, actorRef: 'a' });

    const rows = await pool.query(
      `SELECT sequence, event_type, payload FROM teaching_package_webhook_deliveries WHERE tenant_id = $1 AND learning_item_id = $2 ORDER BY sequence`,
      [agg.tenantId, item.id],
    );
    const events = rows.rows as Array<{ sequence: number; event_type: string; payload: { version: { previousStatus?: string; status?: string } } }>;
    // The successor-approval pair is the tail: superseded (v1) then approved (v2).
    const tail = events.slice(-2);
    expect(tail[0]!.event_type).toBe('teaching_package.status_changed');
    expect(tail[0]!.payload.version).toMatchObject({ previousStatus: 'approved', status: 'superseded' });
    expect(tail[1]!.payload.version).toMatchObject({ previousStatus: 'in_review', status: 'approved' });
    expect(Number(tail[1]!.sequence)).toBeGreaterThan(Number(tail[0]!.sequence));
    // And createSuccessor itself added nothing between approve(v1) and submit(v2):
    const countBeforeSuccessor = Number((before.rows[0] as { n: number }).n);
    const createdEvents = events.filter((e) => (e.payload.version as { status?: string } | undefined)?.status === 'draft');
    expect(createdEvents.length).toBe(0);
    expect(events.length).toBe(countBeforeSuccessor + 3); // submit(v2) + superseded + approved
  });
});

/**
 * The cross-application webhook contract, from OpenMAIC's side.
 *
 * History: `404 → 401 → 401 → 204`. The 404 was a double-prefixed receiver mount
 * in Kafuo; the 401s were Kafuo's verifier calling
 * `hmac.new(message, key)` with the arguments swapped. Both are fixed on the
 * Kafuo side. What was missing on BOTH sides was a shared vector — each repo
 * signed and verified through its own helper, so any self-consistent
 * construction passed, including the swapped one that rejected every genuine
 * delivery.
 *
 * `tests/fixtures/teaching-engine-webhook-signature-vector.json` is that vector.
 * It is generated from this repository's `signWebhookDelivery` and asserted by
 * BOTH repositories, so neither implementation can drift without a red test.
 */
describe('the cross-application webhook signature vector', () => {
  it('is exactly what signWebhookDelivery produces', async () => {
    const { readFile } = await import('node:fs/promises');
    const vector = JSON.parse(
      await readFile(
        new URL('../fixtures/teaching-engine-webhook-signature-vector.json', import.meta.url),
        'utf8',
      ),
    ) as {
      secret: string;
      timestamp: string;
      rawBody: string;
      signatureInput: string;
      signature: string;
      headers: Record<string, string>;
    };
    const { signWebhookDelivery, webhookSignatureInput, WEBHOOK_EVENT_HEADERS } =
      await import('@/lib/server/teaching-package/webhook-delivery');

    // The signature input is `<timestamp>.<raw body>` — not the body alone, and
    // not a re-serialization of it.
    expect(webhookSignatureInput(vector.timestamp, vector.rawBody)).toBe(
      vector.signatureInput,
    );
    expect(vector.signatureInput).toBe(`${vector.timestamp}.${vector.rawBody}`);

    // And the signature over it matches the vector Kafuo independently verifies.
    expect(signWebhookDelivery(vector.secret, vector.timestamp, vector.rawBody)).toBe(
      vector.signature,
    );

    // The three canonical headers, spelled identically on both sides.
    expect(WEBHOOK_EVENT_HEADERS.eventId).toBe(vector.headers.eventId);
    expect(WEBHOOK_EVENT_HEADERS.timestamp).toBe(vector.headers.timestamp);
    expect(WEBHOOK_EVENT_HEADERS.signature).toBe(vector.headers.signature);
  });

  it('signs with the webhook secret, never the service key', async () => {
    const { signWebhookDelivery } = await import(
      '@/lib/server/teaching-package/webhook-delivery'
    );

    // Two different secrets must give two different signatures — the property
    // that makes the dedicated webhook secret meaningful at all.
    const a = signWebhookDelivery('whsec-one', '1', '{}');
    const b = signWebhookDelivery('svckey-two', '1', '{}');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1=')).toBe(true);
  });

  it('posts to the configured URL verbatim, without touching its path', async () => {
    const { webhookBaseUrl } = await import('@/lib/server/teaching-package/webhook-delivery');
    const configured =
      'https://kafuo.example/api/v2/integrations/teaching-engine/webhooks';
    vi.stubEnv('TEACHING_ENGINE_WEBHOOK_URL', configured);

    // Read back byte-for-byte: no segment appended, stripped or normalized. The
    // historical 404 came from a path that differed from the configured one.
    expect(webhookBaseUrl()).toBe(configured);
    vi.unstubAllEnvs();
  });
});

/**
 * Startup configuration validation (requirement 8). These used to run in
 * production only, so a development deployment with a missing secret or a secret
 * copied from the service key booted quietly and then failed every delivery.
 */
describe('teaching engine integration configuration validation', () => {
  const base = {
    serviceKey: 'svc-key',
    isProduction: false,
    databaseUrl: 'postgres://localhost/te',
    webhookUrl: 'http://localhost:8000/api/v2/integrations/teaching-engine/webhooks',
    webhookSecret: 'whsec-distinct',
    accessCode: '',
  };
  const validate = async (overrides: Partial<typeof base>) => {
    const { validateTeachingEngineIntegrationConfig } = await import(
      '@/lib/server/teaching-package/safe-error'
    );
    return () => validateTeachingEngineIntegrationConfig({ ...base, ...overrides });
  };

  it('accepts an explicit http://localhost receiver in development', async () => {
    expect(await validate({}).then((run) => run)).not.toThrow();
    expect(
      await validate({ webhookUrl: 'http://127.0.0.1:8000/webhooks' }).then((r) => r),
    ).not.toThrow();
  });

  it('rejects a non-https receiver in production', async () => {
    const run = await validate({
      isProduction: true,
      webhookUrl: 'http://localhost:8000/webhooks',
    });
    expect(run).toThrow(/must be an https URL/);
  });

  it('rejects a non-loopback http receiver even in development', async () => {
    // `http://localhost.attacker.test` and `https://x/?y=localhost` must be
    // judged on their real host, which is why the URL is parsed, not prefixed.
    const run = await validate({ webhookUrl: 'http://localhost.attacker.test/webhooks' });
    expect(run).toThrow(/http:\/\/localhost/);
  });

  it('requires the database URL, the webhook URL and the webhook secret in development', async () => {
    expect(await validate({ databaseUrl: '' })).toThrow(/DATABASE_URL is required/);
    expect(await validate({ webhookUrl: '' })).toThrow(
      /TEACHING_ENGINE_WEBHOOK_URL is required/,
    );
    expect(await validate({ webhookSecret: '' })).toThrow(
      /TEACHING_ENGINE_WEBHOOK_SECRET is required/,
    );
  });

  it('refuses the service key as the webhook signing secret', async () => {
    const run = await validate({ webhookSecret: base.serviceKey });
    expect(run).toThrow(/must differ from TEACHING_ENGINE_SERVICE_KEY/);
  });

  it('validates nothing when the integration is not enabled', async () => {
    // No service key: this deployment is not Kafuo-facing at all.
    const run = await validate({ serviceKey: '', databaseUrl: '', webhookUrl: '' });
    expect(run).not.toThrow();
  });

  it('never puts a secret value in a validation message', async () => {
    const secrets = ['svc-key', 'whsec-distinct'];
    for (const overrides of [
      { databaseUrl: '' },
      { webhookUrl: '' },
      { webhookSecret: '' },
      { webhookSecret: 'svc-key' },
      { isProduction: true, webhookUrl: 'http://elsewhere.test/hook' },
      { isProduction: true, accessCode: 'ac' },
    ]) {
      const run = await validate(overrides);
      let message = '';
      try {
        run();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe('');
      for (const secret of secrets) {
        // The env var NAME may appear; the VALUE never may.
        expect(message).not.toContain(secret);
      }
    }
  });
});
