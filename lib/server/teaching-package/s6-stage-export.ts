/**
 * S6 stage export (source-fidelity s6-s7-readiness §1.4 G0, §1.8 steps 1, 4, 6).
 *
 * A full regeneration tombstones the version's stage and deletes its media, and the
 * second S6 attempt destroys the first the same way. Before each run, and between the
 * two attempts, this export keeps what S7 compares:
 *
 * - the review-bot projection `GET /api/teaching-packages/{id}/agent-read/scenes` and
 *   the approved-only `GET .../outline` (a draft answers 409; the status is recorded);
 * - the raw rows of the version's current stage: `document_stages`, `document_scenes`,
 *   `document_outlines` and its `stage_meta` (tombstone state);
 * - the version row, its producing attempt row, the Content Units that attempt kept,
 *   its ledger rows (`teaching_model_attempts` by `generation_attempt_id`), its narration
 *   usage, and the version's review events, slide regenerations and insertions.
 *
 * READ-ONLY. The caller's connection must run with `default_transaction_read_only=on`
 * (checked first; anything else is refused before any read). Nothing here imports the
 * persistence provider, so no ensure-schema DDL can run against the target database.
 * Student identifiers that a ledger or usage row could carry are dropped. The service
 * key is sent as a bearer header only and never written or printed.
 *
 * Output: `<outRoot>/<learningItemId>/<attemptId>[__<label>]/`, one JSON file per part
 * plus `manifest.json` with each file's sha256. An existing folder is never overwritten.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** The one query shape the export needs (a `pg` Pool, a PGlite pool in tests). */
export interface ReadOnlyQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export interface S6StageExportInput {
  queryable: ReadOnlyQueryable;
  tenantId: string;
  versionId: string;
  /** The Teaching Engine base URL for the two HTTP reads; null skips them (recorded). */
  teUrl: string | null;
  /** `TEACHING_ENGINE_SERVICE_KEY`; required when `teUrl` is set. */
  serviceKey: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface S6HttpCapture {
  url: string;
  status: number | null;
  body: unknown;
  error?: string;
}

export interface S6StageExport {
  learningItemId: string;
  learningItemType: string;
  attemptId: string;
  stageId: string;
  /** File name → JSON value, in write order. */
  files: Record<string, unknown>;
  manifest: Record<string, unknown>;
}

/** Keys a ledger or usage row may carry for a learner turn; never exported. */
const STUDENT_KEYS = ['student_ref', 'conversation_id', 'turn_id', 'help_session_id'] as const;

function withoutStudentKeys<Row extends Record<string, unknown>>(rows: Row[]): Row[] {
  return rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const key of STUDENT_KEYS) delete copy[key];
    return copy as Row;
  });
}

export class S6ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S6ExportError';
  }
}

async function assertReadOnly(queryable: ReadOnlyQueryable): Promise<void> {
  const result = await queryable.query<{ default_transaction_read_only: string }>(
    'SHOW default_transaction_read_only',
  );
  const value = result.rows[0]?.default_transaction_read_only;
  if (value !== 'on') {
    throw new S6ExportError(
      `refused: the connection is not read-only (default_transaction_read_only=${String(value)}); ` +
        "connect with options '-c default_transaction_read_only=on'",
    );
  }
}

/** The version's producing attempt: its own, else the nearest predecessor's (a clone). */
async function producingAttemptId(
  queryable: ReadOnlyQueryable,
  versionId: string,
  tenantId: string,
): Promise<string | null> {
  const visited = new Set<string>();
  let current: string | null = versionId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const result: {
      rows: Array<{ current_attempt_id: string | null; predecessor_version_id: string | null }>;
    } = await queryable.query(
      `SELECT current_attempt_id, predecessor_version_id
           FROM teaching_package_versions WHERE id = $1 AND tenant_id = $2`,
      [current, tenantId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.current_attempt_id) return row.current_attempt_id;
    current = row.predecessor_version_id;
  }
  return null;
}

async function capture(
  fetchImpl: typeof fetch,
  url: string,
  serviceKey: string,
): Promise<S6HttpCapture> {
  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${serviceKey}`, accept: 'application/json' },
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* kept as text */
    }
    return { url, status: response.status, body };
  } catch (error) {
    return {
      url,
      status: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The service key travels in the HTTP reads' bearer header, so the Teaching Engine URL
 * must be https; plain http is accepted for a loopback host only (a local dev server).
 */
export function assertSafeTeUrl(teUrl: string): void {
  let url: URL;
  try {
    url = new URL(teUrl);
  } catch {
    throw new S6ExportError(`--te-url ${JSON.stringify(teUrl)} is not a URL`);
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new S6ExportError(
    `refused: --te-url must be https (plain http only for localhost, 127.0.0.1 or [::1]); it carries the service key`,
  );
}

/** Collect every part in memory (no file is written). */
export async function collectS6StageExport(input: S6StageExportInput): Promise<S6StageExport> {
  const { queryable, tenantId, versionId } = input;
  if (input.teUrl) assertSafeTeUrl(input.teUrl);
  if (input.teUrl && !input.serviceKey) {
    throw new S6ExportError('TEACHING_ENGINE_SERVICE_KEY is required for the HTTP reads');
  }
  await assertReadOnly(queryable);

  const versions = await queryable.query(
    `SELECT * FROM teaching_package_versions WHERE id = $1 AND tenant_id = $2`,
    [versionId, tenantId],
  );
  const version = versions.rows[0];
  if (!version) throw new S6ExportError(`teaching package ${versionId} not found for this tenant`);
  const learningItemId = String(version.learning_item_id);
  const learningItemType = String(version.learning_item_type);
  const stageId = String(version.current_stage_id);
  const attemptId = await producingAttemptId(queryable, versionId, tenantId);
  if (!attemptId) throw new S6ExportError(`teaching package ${versionId} has no producing attempt`);

  const one = async (sql: string, params: unknown[]) => (await queryable.query(sql, params)).rows;
  const attempt = await one(
    `SELECT * FROM teaching_package_generation_attempts WHERE id = $1 AND tenant_id = $2`,
    [attemptId, tenantId],
  );
  const files: Record<string, unknown> = {
    'version.json': version,
    'attempt.json': attempt[0] ?? null,
    'content-units.json': await one(
      `SELECT * FROM teaching_package_content_units
        WHERE attempt_id = $1 AND tenant_id = $2 ORDER BY order_index, unit_id`,
      [attemptId, tenantId],
    ),
    'ledger.json': withoutStudentKeys(
      await one(
        `SELECT * FROM teaching_model_attempts
          WHERE generation_attempt_id = $1 AND tenant_id = $2
          ORDER BY started_at, attempt_index, id`,
        [attemptId, tenantId],
      ),
    ),
    'usage-events.json': withoutStudentKeys(
      await one(
        `SELECT * FROM generation_usage_events
          WHERE generation_attempt_id = $1 AND tenant_id = $2 ORDER BY created_at, id`,
        [attemptId, tenantId],
      ),
    ),
    'stage.json': (await one(`SELECT * FROM document_stages WHERE id = $1`, [stageId]))[0] ?? null,
    'stage-meta.json':
      (await one(`SELECT * FROM stage_meta WHERE stage_id = $1`, [stageId]))[0] ?? null,
    'scenes.json': await one(
      `SELECT * FROM document_scenes WHERE stage_id = $1 ORDER BY scene_order, id`,
      [stageId],
    ),
    'outline.json':
      (await one(`SELECT * FROM document_outlines WHERE stage_id = $1`, [stageId]))[0] ?? null,
    'review-events.json': await one(
      `SELECT * FROM teaching_package_review_events WHERE version_id = $1 ORDER BY created_at, id`,
      [versionId],
    ),
    'scene-regenerations.json': await one(
      `SELECT * FROM teaching_package_scene_regenerations
        WHERE version_id = $1 AND tenant_id = $2 ORDER BY id`,
      [versionId, tenantId],
    ),
    'scene-insertions.json': await one(
      `SELECT * FROM teaching_package_scene_insertions
        WHERE version_id = $1 AND tenant_id = $2 ORDER BY id`,
      [versionId, tenantId],
    ),
  };

  const http: Record<string, S6HttpCapture | { skipped: true }> = {};
  if (input.teUrl) {
    const base = input.teUrl.replace(/\/+$/, '');
    const fetchImpl = input.fetchImpl ?? fetch;
    const id = encodeURIComponent(versionId);
    const tenant = encodeURIComponent(tenantId);
    http['agent-read-scenes.json'] = await capture(
      fetchImpl,
      `${base}/api/teaching-packages/${id}/agent-read/scenes?tenantId=${tenant}`,
      input.serviceKey!,
    );
    http['outline-http.json'] = await capture(
      fetchImpl,
      `${base}/api/teaching-packages/${id}/outline?tenantId=${tenant}` +
        `&learningItemType=${encodeURIComponent(learningItemType)}` +
        `&learningItemId=${encodeURIComponent(learningItemId)}`,
      input.serviceKey!,
    );
  } else {
    http['agent-read-scenes.json'] = { skipped: true };
    http['outline-http.json'] = { skipped: true };
  }
  for (const [name, value] of Object.entries(http)) files[name] = value;

  const scenes = files['scenes.json'] as unknown[];
  const ledger = files['ledger.json'] as unknown[];
  const manifest: Record<string, unknown> = {
    kind: 'kafuo.s6-stage-export.v1',
    exportedAt: (input.now ?? (() => new Date()))().toISOString(),
    readOnly: true,
    tenantId,
    versionId,
    learningItemType,
    learningItemId,
    attemptId,
    stageId,
    versionStatus: version.status,
    sceneCount: scenes.length,
    ledgerRowCount: ledger.length,
    http: Object.fromEntries(
      Object.entries(http).map(([name, value]) => [
        name,
        'skipped' in value ? 'skipped' : (value.status ?? `error: ${value.error ?? 'unknown'}`),
      ]),
    ),
  };
  return { learningItemId, learningItemType, attemptId, stageId, files, manifest };
}

/** A BIGINT column read as a JS bigint is written as its decimal string. */
function bigintAsString(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function safeSegment(value: string, what: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new S6ExportError(`${what} ${JSON.stringify(value)} is not a safe folder name`);
  }
  return value;
}

/** Write the export under `<outRoot>/<item>/<attempt>[__<label>]/`; refuses an existing folder. */
export async function writeS6StageExport(
  outRoot: string,
  exported: S6StageExport,
  options: { label?: string } = {},
): Promise<{ dir: string; files: Array<{ name: string; sha256: string; bytes: number }> }> {
  const folder =
    safeSegment(exported.attemptId, 'attempt id') +
    (options.label ? `__${safeSegment(options.label, 'label')}` : '');
  const dir = path.join(outRoot, safeSegment(exported.learningItemId, 'learning item id'), folder);
  try {
    await fs.access(dir);
    throw new S6ExportError(`refused: ${dir} already exists; pass another --label`);
  } catch (error) {
    if (error instanceof S6ExportError) throw error;
  }
  await fs.mkdir(dir, { recursive: true });
  const written: Array<{ name: string; sha256: string; bytes: number }> = [];
  for (const [name, value] of Object.entries(exported.files)) {
    const bytes = Buffer.from(`${JSON.stringify(value, bigintAsString, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(dir, name), bytes, { flag: 'wx' });
    written.push({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  }
  const manifest = { ...exported.manifest, files: written };
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify(manifest, bigintAsString, 2)}\n`,
    { flag: 'wx' },
  );
  return { dir, files: written };
}
