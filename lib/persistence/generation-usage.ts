/** Durable extension of modality/embedding usage. Token teaching calls keep their ledger. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Queryable } from '@openmaic/storage/document/pg';

export const GENERATION_USAGE_SCHEMA = `CREATE TABLE IF NOT EXISTS generation_usage_events (
 id text PRIMARY KEY, tenant_id text, created_at double precision NOT NULL,
 category text NOT NULL, feature text NOT NULL, provider text NOT NULL, model text,
 student_ref text, learning_item_id text, version_id text, generation_attempt_id text, request_id text NOT NULL,
 status text NOT NULL DEFAULT 'started', accounting_status text NOT NULL DEFAULT 'started',
 retry boolean NOT NULL DEFAULT false, input_tokens bigint, output_tokens bigint,
 characters bigint, credits numeric, pages bigint, images bigint, seconds numeric,
 CHECK (category IN ('production','runtime','other')),
 CHECK (accounting_status IN ('started','complete'))
)`;
export async function ensureGenerationUsageSchema(db: Queryable) {
  await db.query(GENERATION_USAGE_SCHEMA);
  await db.query(
    'CREATE INDEX IF NOT EXISTS generation_usage_tenant_time_idx ON generation_usage_events (tenant_id, created_at, id)',
  );
}
let observationPool: Pool | undefined;
function usagePool() {
  if (!observationPool) {
    observationPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 150,
      query_timeout: 200,
      statement_timeout: 150,
      idleTimeoutMillis: 5000,
      allowExitOnIdle: true,
    });
    observationPool.on('error', () => console.warn('generation_usage_connection_unavailable'));
  }
  return observationPool;
}
export interface UsageScope {
  tenantId: string;
  studentRef?: string;
  learningItemId?: string;
  versionId?: string;
  generationAttemptId?: string;
}
export interface StartUsage {
  scope?: UsageScope;
  stageId?: string | null;
  category: 'production' | 'runtime' | 'other';
  feature: string;
  provider: string;
  model: string | null;
  requestId: string;
  retry: boolean;
  characters?: number;
  images?: number;
}

/** Called only at provider execution boundaries, never during re-use/playback. */
export async function startGenerationUsage(input: StartUsage) {
  if (!process.env.DATABASE_URL || process.env.VITEST || process.env.NODE_ENV === 'test')
    return null;
  try {
    const pool = usagePool();
    let scope = input.scope;
    if (!scope && input.stageId) {
      // One row, no output/prompt: a Stage may be a retained attempt's Stage.
      const found = await pool.query(
        `SELECT id, tenant_id, learning_item_id, version_id
        FROM teaching_package_generation_attempts WHERE produced_stage_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [input.stageId],
      );
      const row = found.rows[0];
      if (row)
        scope = {
          tenantId: row.tenant_id,
          learningItemId: row.learning_item_id,
          versionId: row.version_id,
          generationAttemptId: row.id,
        };
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO generation_usage_events
      (id,tenant_id,created_at,category,feature,provider,model,student_ref,learning_item_id,version_id,request_id,retry,characters,images,generation_attempt_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        scope?.tenantId ?? null,
        Date.now() / 1000,
        input.category,
        input.feature,
        input.provider,
        input.model,
        scope?.studentRef ?? null,
        scope?.learningItemId ?? null,
        scope?.versionId ?? null,
        input.requestId,
        input.retry,
        input.characters ?? null,
        input.images ?? null,
        scope?.generationAttemptId ?? null,
      ],
    );
    return { id, pool };
  } catch {
    console.warn('generation_usage_start_unavailable');
    return null;
  }
}
export async function finishGenerationUsage(
  event: Awaited<ReturnType<typeof startGenerationUsage>>,
  status: string,
  usage?: { inputTokens: number; outputTokens: number },
  model?: string | null,
) {
  if (!event) return;
  try {
    await event.pool.query(
      `UPDATE generation_usage_events SET status=$2,accounting_status='complete',input_tokens=$3,output_tokens=$4,model=COALESCE($5,model) WHERE id=$1`,
      [event.id, status, usage?.inputTokens ?? null, usage?.outputTokens ?? null, model ?? null],
    );
  } catch {
    console.warn('generation_usage_completion_unavailable');
  }
}

export async function observeMediaCall<T>(input: StartUsage, action: () => Promise<T>): Promise<T> {
  const event = await startGenerationUsage(input);
  try {
    const result = await action();
    await finishGenerationUsage(event, 'succeeded');
    return result;
  } catch (error) {
    await finishGenerationUsage(event, 'provider_error');
    throw error;
  }
}
