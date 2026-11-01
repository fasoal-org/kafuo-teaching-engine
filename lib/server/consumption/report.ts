/** Tenant-scoped reporting projection. No prompts, message text, errors or raw usage leave it. */
import type { Queryable } from '@openmaic/storage/document/pg';

export const GROUPS = [
  'system',
  'category',
  'feature',
  'provider',
  'model',
  'lesson_id',
  'learning_item_id',
  'student_ref',
  'version_id',
  'tier',
  'conversation_id',
  'session_id',
  'day',
  'month',
] as const;
export type Group = (typeof GROUPS)[number];
export interface ReportFilter {
  tenant_id: string;
  since: number;
  until: number;
  mode?: 'summary' | 'records' | 'groups';
  group_by?: Group;
  provider?: string;
  model?: string;
  feature?: string;
  category?: string;
  student_ref?: string;
  lesson_id?: string;
  learning_item_id?: string;
  status?: string;
  version_id?: string;
  cursor_time?: number;
  cursor_id?: string;
  limit?: number;
}

// The existing ledger is the authority even for origin=kafuo_backend. Origin describes
// the caller, not the owner of the provider execution. Never join attendance to costs.
export const ATTEMPT_PROJECTION = `SELECT
  'engine:attempt:' || a.id AS id, a.started_at AS occurred_at,
  'teaching_engine'::text AS system,
  CASE WHEN a.capability IN ('free_chat','help') THEN 'runtime' ELSE 'production' END AS category,
  a.stage AS feature, a.provider_id AS provider, a.model_id AS model,
  COALESCE(a.outcome, a.accounting_status) AS status, a.student_ref,
  NULL::text AS lesson_id,
  COALESCE(a.learning_item_id, v.learning_item_id) AS learning_item_id, COALESCE(a.version_id, g.version_id, h.version_id) AS version_id,
  COALESCE(a.turn_id, a.generation_attempt_id, a.id) || ':' || a.stage AS request_id,
  a.conversation_id, a.help_session_id AS session_id,
  NULL::text AS tier,
  a.input_tokens_total AS input_tokens, a.output_tokens_total AS output_tokens,
  a.cache_read_tokens AS cached_tokens, a.reasoning_tokens,
  NULL::bigint AS characters, NULL::numeric AS credits, NULL::bigint AS pages,
  NULL::bigint AS images, NULL::numeric AS seconds,
  a.cost_usd, CASE WHEN a.cost_usd IS NULL THEN 'unavailable'
    WHEN a.cost_basis = 'no_cache_detail' THEN 'upper_bound' ELSE 'calculated' END AS cost_kind,
  a.rate_card_version, 'provider_reported'::text AS usage_basis,
  a.attempt_index > 1 AS retry, a.role = 'fallback' AS fallback,
  a.accounting_status, COALESCE(a.usage_available, false) AS usage_available
FROM teaching_model_attempts a
LEFT JOIN teaching_package_generation_attempts g ON g.id=a.generation_attempt_id AND g.tenant_id=a.tenant_id
LEFT JOIN tutor_help_sessions h ON h.id=a.help_session_id AND h.tenant_id=a.tenant_id
LEFT JOIN teaching_package_versions v ON v.id=COALESCE(a.version_id,g.version_id,h.version_id) AND v.tenant_id=a.tenant_id
WHERE a.tenant_id = $1 AND a.started_at >= $2 AND a.started_at < $3
UNION ALL
SELECT 'engine:usage:' || u.id,u.created_at,'teaching_engine',u.category,u.feature,u.provider,u.model,
 u.status,u.student_ref,NULL::text,u.learning_item_id,COALESCE(u.version_id,mg.version_id),u.request_id,NULL::text,NULL::text,NULL::text,
 u.input_tokens,u.output_tokens,NULL::bigint,NULL::bigint,u.characters,u.credits,u.pages,u.images,u.seconds,
 NULL::numeric,'unavailable',NULL::text,
 CASE WHEN u.characters IS NOT NULL OR u.images IS NOT NULL THEN 'submitted_quantity' ELSE 'provider_reported' END,
 u.retry,false,u.accounting_status,(u.characters IS NOT NULL OR u.images IS NOT NULL OR u.input_tokens IS NOT NULL)
FROM generation_usage_events u LEFT JOIN teaching_package_generation_attempts mg ON mg.id=u.generation_attempt_id AND mg.tenant_id=u.tenant_id WHERE u.tenant_id=$1 AND u.created_at >= $2 AND u.created_at < $3`;

export const SUMS = `count(*)::int AS attempts,
 count(DISTINCT request_id)::int AS requests,
 count(DISTINCT conversation_id)::int AS conversations,
 count(DISTINCT session_id)::int AS sessions,
 count(DISTINCT version_id)::int AS versions,
 count(DISTINCT request_id) FILTER (WHERE status IN ('succeeded','completed','ok') AND category='runtime' AND feature IN ('free-chat-turn','help-turn','legacy_chat','help_cards'))::int AS responses,
 count(*) FILTER (WHERE status IN ('succeeded','completed','ok'))::int AS succeeded,
 count(*) FILTER (WHERE status NOT IN ('succeeded','completed','ok','started','running','pending'))::int AS failed,
 count(*) FILTER (WHERE retry)::int AS retries, count(*) FILTER (WHERE fallback)::int AS fallbacks,
 sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
 sum(cached_tokens) AS cached_tokens, sum(reasoning_tokens) AS reasoning_tokens,
 sum(characters) AS characters, sum(credits) AS credits, sum(pages) AS pages,
 sum(images) AS images, sum(seconds) AS seconds,
 sum(cost_usd) FILTER (WHERE cost_kind IN ('calculated','provider_reported')) AS recorded_cost_usd,
 sum(cost_usd) FILTER (WHERE cost_kind IN ('estimate','upper_bound')) AS estimated_cost_usd,
 sum(cost_usd) FILTER (WHERE retry AND cost_kind IN ('calculated','provider_reported')) AS retry_cost_usd,
 sum(cost_usd) FILTER (WHERE fallback AND cost_kind IN ('calculated','provider_reported')) AS fallback_cost_usd,
 count(*) FILTER (WHERE cost_usd IS NOT NULL AND cost_kind IN ('calculated','provider_reported'))::int AS recorded_priced,
 count(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced,
 count(*) FILTER (WHERE NOT usage_available)::int AS usage_missing,
 count(*) FILTER (WHERE accounting_status <> 'complete')::int AS incomplete,
 count(*) FILTER (WHERE input_tokens IS NOT NULL AND cached_tokens IS NULL)::int AS cache_detail_missing,
 count(*) FILTER (WHERE output_tokens IS NOT NULL AND reasoning_tokens IS NULL)::int AS reasoning_detail_missing`;

export async function queryConsumptionReport(db: Queryable, f: ReportFilter) {
  const values: unknown[] = [f.tenant_id, f.since, f.until];
  const where: string[] = [];
  for (const field of [
    'provider',
    'model',
    'feature',
    'category',
    'student_ref',
    'lesson_id',
    'learning_item_id',
    'status',
    'version_id',
  ] as const) {
    if (f[field]) {
      values.push(field === 'learning_item_id' ? f[field]!.split(',') : f[field]);
      where.push(
        field === 'learning_item_id'
          ? `${field} = ANY($${values.length}::text[])`
          : `${field} = $${values.length}`,
      );
    }
  }
  let cte = `WITH usage AS (${ATTEMPT_PROJECTION}), filtered AS (SELECT * FROM usage${where.length ? ` WHERE ${where.join(' AND ')}` : ''})`;
  const limit = Math.min(f.mode === 'groups' ? 366 : 200, Math.max(1, f.limit ?? 50));
  if (f.mode === 'records') {
    const cursor =
      f.cursor_time !== undefined && f.cursor_id
        ? (values.push(f.cursor_time, f.cursor_id),
          `WHERE (occurred_at, id) < ($${values.length - 1}, $${values.length})`)
        : '';
    values.push(limit + 1);
    const result = await db.query(
      `${cte} SELECT * FROM filtered ${cursor} ORDER BY occurred_at DESC, id DESC LIMIT $${values.length}`,
      values,
    );
    return { records: result.rows, limit };
  }
  if (f.mode === 'groups') {
    const group = f.group_by ?? 'provider';
    if (!GROUPS.includes(group)) throw new Error('invalid group');
    const expression =
      group === 'day' || group === 'month'
        ? `to_char(to_timestamp(occurred_at) AT TIME ZONE 'Asia/Riyadh', '${group === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM'}')`
        : group;
    values.push(limit + 1);
    const result = await db.query(
      `${cte} SELECT ${expression} AS key, ${SUMS} FROM filtered GROUP BY 1 ORDER BY recorded_cost_usd DESC NULLS LAST, attempts DESC, key LIMIT $${values.length}`,
      values,
    );
    return { groups: result.rows, limit };
  }
  // Today/month are inside the selected date range, explicitly labelled by the UI.
  cte += ` SELECT ${SUMS},
    sum(cost_usd) FILTER (WHERE cost_kind IN ('calculated','provider_reported') AND to_timestamp(occurred_at) >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh') AS today_cost_usd,
    sum(cost_usd) FILTER (WHERE cost_kind IN ('calculated','provider_reported') AND to_timestamp(occurred_at) >= date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh') AS month_cost_usd
    FROM filtered`;
  return { totals: (await db.query(cte, values)).rows[0] };
}
