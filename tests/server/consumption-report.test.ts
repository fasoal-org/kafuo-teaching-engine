/** Real PostgreSQL (PGlite) contracts; no credentials, providers or live data. */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTeachingModelAttemptsSchema } from '@/lib/persistence/teaching-model-attempts';
import { observeMediaCall, ensureGenerationUsageSchema } from '@/lib/persistence/generation-usage';
import { queryConsumptionReport, type ReportFilter } from '@/lib/server/consumption/report';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';

const db = new PGlite();
const filter: ReportFilter = { tenant_id: '1', since: 100, until: 1000 };
async function attempt(id: string, tenant: string, patch: Record<string, unknown> = {}) {
  const row = {
    id,
    tenant_id: tenant,
    capability: 'free_chat',
    subject_code: 'MATH',
    policy_version: 'historical',
    stage: 'free-chat-reply',
    provider_id: 'openai',
    model_id: 'gpt-5.6-luna',
    model_string: 'openai:gpt-5.6-luna',
    role: 'primary',
    attempt_index: 1,
    accounting_status: 'complete',
    outcome: 'succeeded',
    input_tokens_total: 100,
    cache_read_tokens: 25,
    output_tokens_total: 40,
    reasoning_tokens: 10,
    cost_usd: '0.0001',
    cost_basis: 'full',
    rate_card_version: 'original-card',
    usage_available: true,
    started_at: 500,
    origin: 'openmaic_runtime',
    turn_id: `turn-${id}`,
    worker_id: 'test',
    created_at: 500,
    ...patch,
  };
  await db.query(
    `INSERT INTO teaching_model_attempts (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(',')})`,
    Object.values(row),
  );
}

beforeAll(async () => {
  await ensureTeachingModelAttemptsSchema(db);
  await db.exec(`CREATE TABLE teaching_package_generation_attempts (id text PRIMARY KEY,tenant_id text,version_id text);
    CREATE TABLE tutor_help_sessions (id text PRIMARY KEY,tenant_id text,version_id text);
    CREATE TABLE teaching_package_versions (id text PRIMARY KEY,tenant_id text,learning_item_id text);`);
  await ensureGenerationUsageSchema(db);
  await attempt('original', '1');
  await attempt('retry', '1', {
    role: 'fallback',
    attempt_index: 2,
    outcome: 'provider_error',
    cost_usd: '0.0002',
    model_id: 'qwen-fallback',
    provider_id: 'qwen',
    turn_id: 'turn-original',
    origin: 'kafuo_backend',
  });
  await attempt('missing', '1', {
    cost_usd: null,
    cost_basis: null,
    input_tokens_total: null,
    cache_read_tokens: null,
    reasoning_tokens: null,
    output_tokens_total: null,
    usage_available: false,
    accounting_status: 'incomplete',
    outcome: null,
  });
  await attempt('other-tenant', '2');
  await attempt('upper', '1', {
    cost_usd: '0.0003',
    cost_basis: 'no_cache_detail',
    cache_read_tokens: null,
  });
  await db.query(
    `INSERT INTO generation_usage_events (id,tenant_id,created_at,category,feature,provider,model,request_id,status,accounting_status,characters) VALUES ('narration','1',600,'production','lesson_narration','cartesia','sonic-historical','tts-1','succeeded','complete',123),('unscoped',NULL,600,'production','lesson_narration','cartesia','sonic','tts-2','succeeded','complete',999)`,
  );
});
afterAll(async () => {
  await db.close();
});

describe('consumption read projection', () => {
  it('counts each ledger attempt once including backend-origin fallback, excludes other tenant/unscoped events', async () => {
    const result = await queryConsumptionReport(db, filter);
    const t = result.totals as Record<string, unknown>;
    expect(t.attempts).toBe(5);
    expect(Number(t.recorded_cost_usd)).toBeCloseTo(0.0003);
    expect(Number(t.estimated_cost_usd)).toBeCloseTo(0.0003);
    expect(t.recorded_priced).toBe(2);
    expect(t.retries).toBe(1);
    expect(t.fallbacks).toBe(1);
    expect(t.incomplete).toBe(1);
    expect(t.unpriced).toBe(2);
    expect(Number(t.characters)).toBe(123);
    expect(t.credits).toBeNull();
  });
  it('does not add cache or reasoning subsets to inclusive totals', async () => {
    const result = await queryConsumptionReport(db, filter);
    const t = result.totals as Record<string, unknown>;
    expect(Number(t.input_tokens)).toBe(300);
    expect(Number(t.output_tokens)).toBe(120);
    expect(Number(t.cached_tokens)).toBe(50);
    expect(Number(t.reasoning_tokens)).toBe(30);
  });
  it('keeps historical model and rate card and never exposes content/error columns', async () => {
    const result = await queryConsumptionReport(db, { ...filter, mode: 'records' });
    const rows = result.records as Record<string, unknown>[];
    const row = rows.find((r) => r.id === 'engine:attempt:original')!;
    expect(row.model).toBe('gpt-5.6-luna');
    expect(row.rate_card_version).toBe('original-card');
    for (const field of [
      'error_message',
      'text',
      'context_summary',
      'title',
      'prompt',
      'input_snapshot',
    ])
      expect(row).not.toHaveProperty(field);
    expect(row.lesson_id).toBeNull(); // Learning Item id is not a Lesson id.
  });
  it('supports exact provider/model/feature/status filters without SQL interpolation', async () => {
    const result = await queryConsumptionReport(db, {
      ...filter,
      provider: 'qwen',
      model: 'qwen-fallback',
      status: 'provider_error',
    });
    expect((result.totals as Record<string, unknown>).attempts).toBe(1);
    const hostile = await queryConsumptionReport(db, {
      ...filter,
      provider: "qwen'; DROP TABLE teaching_model_attempts;--",
    });
    expect((hostile.totals as Record<string, unknown>).attempts).toBe(0);
  });
  it('pages deterministically through equal timestamps and does not duplicate records', async () => {
    const first = await queryConsumptionReport(db, { ...filter, mode: 'records', limit: 2 });
    const rows = first.records as { id: string; occurred_at: number }[];
    expect(rows).toHaveLength(3);
    const last = rows[1]!;
    const next = await queryConsumptionReport(db, {
      ...filter,
      mode: 'records',
      limit: 2,
      cursor_time: last.occurred_at,
      cursor_id: last.id,
    });
    expect(
      (next.records as { id: string }[]).some((r) => rows.slice(0, 2).some((a) => a.id === r.id)),
    ).toBe(false);
  });
  it('keeps incompatible units separate and group query is bounded', async () => {
    const result = await queryConsumptionReport(db, {
      ...filter,
      mode: 'groups',
      group_by: 'provider',
      limit: 1,
    });
    expect(result.groups).toHaveLength(2);
    const tts = await queryConsumptionReport(db, { ...filter, provider: 'cartesia' });
    expect(Number((tts.totals as Record<string, unknown>).characters)).toBe(123);
    expect((tts.totals as Record<string, unknown>).input_tokens).toBeNull();
  });
  it('requires service credential independently of browser access', () => {
    expect(() => authenticateServiceRequest({ headers: new Headers() })).toThrow();
  });
});

it('observational media wrapping preserves the provider result and failure', async () => {
  const input = {
    category: 'production' as const,
    feature: 'package_image',
    provider: 'test',
    model: 'test',
    requestId: 'test',
    retry: false,
    images: 1,
  };
  expect(await observeMediaCall(input, async () => 'image')).toBe('image');
  const error = new Error('provider unavailable');
  await expect(
    observeMediaCall(input, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
});
