import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { ensureDocumentSchema, ensureStageMetaSchema } from './helpers';

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

describe('aggregate reconciliation read (plan §4.4.4)', () => {
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

  it('returns approved + working versions, latest attempt, and the sequence watermark', async () => {
    const { insertVersion, insertAttempt, insertWebhookDelivery } = await import(
      '@/lib/persistence/teaching-package'
    );
    const agg = { tenantId: 'tenant-agg', learningItem: { type: 'lesson' as const, id: 'li-agg' } };
    for (const stageId of ['stage-none-1', 'stage-none-2']) {
      await pool.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, data)
         VALUES ($1, 'seed', 1, 1, '{}'::jsonb)`,
        [stageId],
      );
    }
    await insertVersion(qp(), {
      id: 'tpv-agg-1',
      aggregate: agg,
      version: 1,
      status: 'approved',
      currentStageId: 'stage-none-1',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    await insertVersion(qp(), {
      id: 'tpv-agg-2',
      aggregate: agg,
      version: 2,
      status: 'draft',
      currentStageId: 'stage-none-2',
      predecessorVersionId: 'tpv-agg-1',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 2,
    });
    await insertAttempt(qp(), {
      id: 'tpa-agg-1',
      aggregate: agg,
      kind: 'initial',
      status: 'succeeded',
      requestedByActorRef: 'a',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: {
        learningItem: agg.learningItem,
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
      now: 3,
    });
    await insertWebhookDelivery(qp(), {
      id: 'tpe-1',
      aggregate: agg,
      sequence: 1,
      eventType: 'teaching_package.status_changed',
      occurredAt: 4,
      payload: {},
      now: 4,
    });
    await insertWebhookDelivery(qp(), {
      id: 'tpe-2',
      aggregate: agg,
      sequence: 2,
      eventType: 'teaching_package.generation_succeeded',
      occurredAt: 5,
      payload: {},
      now: 5,
    });

    const { nodePostgresTransaction } = await import('@openmaic/storage/server/reference');
    const withTransaction = nodePostgresTransaction(txPool());
    const {
      readApprovedVersion,
      readActiveVersion,
      readLatestWebhookSequence,
      readAttemptById,
    } = await import('@/lib/persistence/teaching-package');
    const result = await withTransaction(async (tx) => {
      const [approved, working, sequence] = await Promise.all([
        readApprovedVersion(tx, agg),
        readActiveVersion(tx, agg),
        readLatestWebhookSequence(tx, agg),
      ]);
      return {
        approvedVersion: approved,
        workingVersion: working,
        latestAttempt: await readAttemptById(tx, 'tpa-agg-1'),
        latestAggregateSequence: sequence,
      };
    });
    expect(result.approvedVersion?.id).toBe('tpv-agg-1');
    expect(result.workingVersion?.id).toBe('tpv-agg-2');
    expect(result.latestAttempt?.id).toBe('tpa-agg-1');
    expect(result.latestAggregateSequence).toBe(2);
    // No Stage/Scene/history document rides along.
    expect(JSON.stringify(result)).not.toContain('scenes');
  });
});

describe('safe error descriptors (plan §4.4.6)', () => {
  it('extracts name/code/status and drops messages', async () => {
    const { describeErrorSafely } = await import('@/lib/server/teaching-package/safe-error');
    const error = new Error('https://r2.example.test/lesson.pdf?X-Amz-Signature=SECRET leaked');
    (error as Error & { code?: string }).code = 'CONTENT_RESOURCE_DOWNLOAD_FAILED';
    const descriptor = describeErrorSafely(error);
    expect(descriptor).toEqual({
      name: 'Error',
      code: 'CONTENT_RESOURCE_DOWNLOAD_FAILED',
    });
    expect(JSON.stringify(descriptor)).not.toContain('X-Amz-Signature');
    expect(describeErrorSafely('a string')).toEqual({ name: 'Error' });
    expect(describeErrorSafely({ name: 'FetchError', status: 502 })).toEqual({
      name: 'FetchError',
      status: 502,
    });
  });
});

import {
  validateTeachingEngineIntegrationConfig,
} from '@/lib/server/teaching-package/safe-error';

describe('teaching engine integration fail-fast config (plan §4.4.6)', () => {
  const base = {
    serviceKey: 'svc-key',
    isProduction: true,
    databaseUrl: 'postgres://configured',
    webhookUrl: 'https://kafuo.test/hook',
    webhookSecret: 'whsec-distinct',
    accessCode: '',
  };

  it('accepts a fully configured production deployment', () => {
    expect(() => validateTeachingEngineIntegrationConfig({ ...base })).not.toThrow();
  });

  it('refuses the missing webhook URL, missing secret, shared secret, and ACCESS_CODE combinations', () => {
    expect(() =>
      validateTeachingEngineIntegrationConfig({ ...base, webhookUrl: '' }),
    ).toThrow(/TEACHING_ENGINE_WEBHOOK_URL/);
    expect(() =>
      validateTeachingEngineIntegrationConfig({ ...base, webhookSecret: '' }),
    ).toThrow(/TEACHING_ENGINE_WEBHOOK_SECRET/);
    expect(() =>
      validateTeachingEngineIntegrationConfig({ ...base, webhookSecret: base.serviceKey }),
    ).toThrow(/must differ/);
    expect(() =>
      validateTeachingEngineIntegrationConfig({ ...base, accessCode: 'shared-gate' }),
    ).toThrow(/ACCESS_CODE/);
    expect(() =>
      validateTeachingEngineIntegrationConfig({ ...base, databaseUrl: '' }),
    ).toThrow(/DATABASE_URL/);
    // Outside production, and with no service key, the gate is inert.
    expect(() =>
      validateTeachingEngineIntegrationConfig({ ...base, isProduction: false, accessCode: 'x' }),
    ).not.toThrow();
    expect(() =>
      validateTeachingEngineIntegrationConfig({ ...base, serviceKey: '', accessCode: 'x' }),
    ).not.toThrow();
  });
});
