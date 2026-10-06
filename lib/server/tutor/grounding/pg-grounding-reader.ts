/**
 * The pg-backed Kafuo grounding reader (discovery-first plan P6, §5.5).
 * It implements the P7 seam (`kafuo-grounding-reader.ts`) over a DEDICATED,
 * bounded `pg.Pool` that logs in as `kafuo_grounding_reader`
 * (`KAFUO_GROUNDING_DATABASE_URL`).
 *
 * Rules (RET-06, RET-07, §5.5):
 *  - Every call is ONE autocommit statement against a `grounding_read_v1`
 *    function. No other SQL is ever sent, no transaction is opened, and the
 *    connection is released before the caller embeds or calls a model.
 *  - A per-process semaphore caps in-flight calls at `KAFUO_GROUNDING_POOL_MAX`;
 *    a call beyond it returns `retrieval_busy` at once, without touching the pool.
 *  - `connectionTimeoutMillis` is the admission wait. A connect timeout while the
 *    pool is full is `retrieval_busy`; any other connect failure, a statement
 *    error, a server `statement_timeout` (57014) or the client-side
 *    `query_timeout` backstop is `retrieval_unavailable`.
 *  - Outcomes are returned, never thrown. Rows that break the function's
 *    contract are `retrieval_unavailable` (`contract_violation` in health).
 *  - Nothing here logs text, vectors, rows or driver messages (a pg message can
 *    echo an input value): only the function name and the SQLSTATE / error kind.
 *  - The reader never sends `statement_timeout` or `options`: a startup
 *    parameter would override the role's own settings (migration 294). It does
 *    send `application_name = te-grounding`, the same value the role sets, so a
 *    stray `PGAPPNAME` cannot rename the sessions ops look for.
 *  - M-1 (security pre-review): the pool config is built from the CHECKED DSN
 *    parts (`checkKafuoGroundingConnection`), never from the raw DSN, whose query
 *    parameters node-postgres would merge over it. `ssl` is always explicit
 *    (`verify-full` → `{ rejectUnauthorized: true, ca? }`; loopback → `false`), so
 *    `PGSSLMODE` and `NODE_TLS_REJECT_UNAUTHORIZED` cannot change it. `PGOPTIONS`
 *    cannot be suppressed through the config, so a set `PGOPTIONS` refuses the
 *    pool (at boot, at pool creation, and on every `getKafuoGroundingReader`).
 *
 * `poolWaitMs` (admission + connect) is returned on every result, for the
 * turn's timings and `tutor_turn_groundings.pool_wait_ms`.
 */
import { readFileSync } from 'node:fs';

import { Pool, type PoolConfig } from 'pg';

import { createLogger } from '@/lib/logger';

import {
  checkKafuoGroundingConnection,
  groundingSourceSetting,
  kafuoGroundingDatabaseUrl,
  kafuoGroundingPoolSettings,
  type GroundingSource,
  type KafuoGroundingConnection,
  type KafuoGroundingPoolSettings,
} from './grounding-config';
import type {
  GroundingItemType,
  GroundingReaderScope,
  IndexCoverage,
  ItemCandidate,
  ItemEmbeddingProfileResult,
  ItemProfileEntry,
  KafuoGroundingReader,
  ResolveItemsInput,
  ResolveItemsResult,
  SearchUnitRow,
  SearchUnitsInput,
  SearchUnitsResult,
  UnitRef,
  ValidateUnitsResult,
} from './kafuo-grounding-reader';

const log = createLogger('KafuoGroundingReader');

export const GROUNDING_APPLICATION_NAME = 'te-grounding';

/** The only statements this reader sends (one per function). */
export const RESOLVE_ITEMS_SQL =
  'SELECT row_kind, outcome, reason_code, index_coverage, candidate_rank, learning_item_id, ' +
  'item_type, title, score, matched_term_types, routable, readiness, match_source, build_id ' +
  'FROM grounding_read_v1.resolve_items($1::bigint, $2::text, $3::bigint, $4::text, $5::integer) ' +
  'ORDER BY candidate_rank NULLS FIRST';

export const ITEM_EMBEDDING_PROFILE_SQL =
  'SELECT row_kind, outcome, item_rank, learning_item_id, build_id, embedding_run_id, provider, ' +
  'model, dims FROM grounding_read_v1.item_embedding_profile($1::bigint, $2::text, $3::bigint, ' +
  '$4::bigint[]) ORDER BY item_rank NULLS FIRST';

export const SEARCH_UNITS_SQL =
  'SELECT row_kind, outcome, reason_code, unit_rank, content_unit_id, learning_item_id, ' +
  'item_type, unit_title, text, char_length, similarity, content_revision_id, unit_updated_at, ' +
  'build_id, embedding_run_id FROM grounding_read_v1.search_units($1::bigint, $2::text, ' +
  "$3::bigint, $4::jsonb, $5::real[], $6::text, $7::text, $8::integer) ORDER BY row_kind = 'header' " +
  'DESC, unit_rank NULLS LAST, learning_item_id';

export const VALIDATE_UNITS_SQL =
  'SELECT row_kind, outcome, content_unit_id, learning_item_id FROM ' +
  'grounding_read_v1.validate_units($1::bigint, $2::text, $3::bigint, $4::jsonb) ' +
  'ORDER BY content_unit_id NULLS FIRST';

const MAX_RESOLVE_CANDIDATES = 3;
/** Kafuo limits (backend `search_units_contract.py`); beyond them the function raises 22023. */
const MAX_PROFILE_ITEMS = 3;
const MAX_SEARCH_TARGETS = 3;
const MAX_SEARCH_UNITS = 5;
const MAX_UNIT_REFS = 25;

// ---------------------------------------------------------------------------
// The narrow pg surface (a real `pg.Pool`, or a test double)
// ---------------------------------------------------------------------------

export interface GroundingPgClient {
  query(config: { text: string; values: unknown[] }): Promise<{ rows: Record<string, unknown>[] }>;
  /** `true` (or an Error) destroys the connection instead of returning it to the pool. */
  release(destroy?: boolean | Error): void;
}

export interface GroundingPgPool {
  connect(): Promise<GroundingPgClient>;
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  end(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

type Unavailable = { outcome: 'retrieval_unavailable' };
type Busy = { outcome: 'retrieval_busy' };

class ContractViolation extends Error {
  constructor(readonly detail: string) {
    super('contract_violation');
    this.name = 'ContractViolation';
  }
}

/** pg-pool's admission timeout ("timeout exceeded when trying to connect"). */
function isConnectTimeout(error: unknown): boolean {
  return error instanceof Error && /timeout exceeded when trying to connect/i.test(error.message);
}

/** pg's client-side `query_timeout` ("Query read timeout"). */
function isQueryTimeout(error: unknown): boolean {
  return error instanceof Error && /query read timeout/i.test(error.message);
}

/** A 5-character SQLSTATE from the server, or null for a client/network error. */
function sqlState(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/** A short, value-free error kind for logs and health. */
function errorKind(error: unknown): string {
  if (isConnectTimeout(error)) return 'connect_timeout';
  if (isQueryTimeout(error)) return 'query_timeout';
  const state = sqlState(error);
  if (state) return state === '57014' ? 'statement_timeout' : `sqlstate_${state}`;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z_]{2,32}$/.test(code)) return code.toLowerCase();
  return 'error';
}

const BIGINT_ID = /^[0-9]{1,19}$/;

// ---------------------------------------------------------------------------
// Row mapping (resolve_items, plan §5.3 / backend `resolve_items_contract.py`)
// ---------------------------------------------------------------------------

const RESOLVE_OUTCOMES = new Set([
  'single',
  'ambiguous',
  'weak',
  'index_not_ready',
  'no_match',
  'student_ref_unknown',
  'offering_not_permitted',
]);
const MATCH_SOURCES = new Set(['term', 'title', 'fallback']);

function idText(value: unknown, column: string): string {
  if (typeof value === 'string' && BIGINT_ID.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'bigint' && value >= BigInt(0)) return value.toString();
  throw new ContractViolation(`${column} is not a bigint id`);
}

function itemType(value: unknown): GroundingItemType {
  if (value === 'LESSON' || value === 'SECTION') return value;
  throw new ContractViolation('item_type');
}

function coverage(value: unknown): IndexCoverage {
  if (value === 'complete' || value === 'partial') return value;
  throw new ContractViolation('index_coverage');
}

function mapCandidate(row: Record<string, unknown>): ItemCandidate & { rank: number } {
  const rank = Number(row.candidate_rank);
  if (!Number.isInteger(rank) || rank < 1) throw new ContractViolation('candidate_rank');
  const score = Number(row.score);
  if (!Number.isFinite(score)) throw new ContractViolation('score');
  const terms = row.matched_term_types;
  if (terms !== null && terms !== undefined && !Array.isArray(terms)) {
    throw new ContractViolation('matched_term_types');
  }
  const matchSource = row.match_source;
  if (typeof matchSource !== 'string' || !MATCH_SOURCES.has(matchSource)) {
    throw new ContractViolation('match_source');
  }
  if (typeof row.routable !== 'boolean') throw new ContractViolation('routable');
  return {
    rank,
    learningItemId: idText(row.learning_item_id, 'learning_item_id'),
    itemType: itemType(row.item_type),
    title: typeof row.title === 'string' ? row.title : '',
    score,
    matchedTermTypes: (terms ?? []).map((term) => String(term)),
    routable: row.routable,
    buildId:
      row.build_id === null || row.build_id === undefined ? null : idText(row.build_id, 'build_id'),
    readiness: typeof row.readiness === 'string' ? row.readiness : undefined,
    matchSource: matchSource as ItemCandidate['matchSource'],
  };
}

/** Header + ≤ 3 candidate rows → the seam's result (the `parse_resolve_rows` rules). */
export function mapResolveRows(rows: readonly Record<string, unknown>[]): ResolveItemsResult {
  const headers = rows.filter((row) => row.row_kind === 'header');
  if (headers.length !== 1) throw new ContractViolation('expected exactly one header row');
  const header = headers[0]!;
  const outcome = header.outcome;
  if (typeof outcome !== 'string' || !RESOLVE_OUTCOMES.has(outcome)) {
    throw new ContractViolation('outcome');
  }
  const candidates: Array<ItemCandidate & { rank: number }> = [];
  for (const row of rows) {
    if (row.row_kind === 'header') continue;
    if (row.row_kind !== 'candidate') throw new ContractViolation('row_kind');
    if (row.outcome !== outcome) throw new ContractViolation('candidate outcome differs');
    candidates.push(mapCandidate(row));
  }
  candidates.sort((a, b) => a.rank - b.rank);
  const reasonCode = typeof header.reason_code === 'string' ? header.reason_code : null;

  if (outcome === 'student_ref_unknown' || outcome === 'offering_not_permitted') {
    if (candidates.length > 0) throw new ContractViolation(`${outcome} carries candidates`);
    // Scope refusal (CHAT-04): no item data crosses the seam.
    return { outcome };
  }
  if (outcome === 'no_match') {
    if (candidates.length > 0) throw new ContractViolation('no_match carries candidates');
    return { outcome, reasonCode, indexCoverage: coverage(header.index_coverage) };
  }
  if (candidates.length === 0) throw new ContractViolation(`${outcome} has no candidate`);
  if (candidates.length > MAX_RESOLVE_CANDIDATES)
    throw new ContractViolation('too many candidates');
  if (outcome === 'single' && candidates.length !== 1) {
    throw new ContractViolation('single must carry exactly one candidate');
  }
  if (outcome !== 'index_not_ready' && !candidates.every((c) => c.routable)) {
    throw new ContractViolation(`${outcome} candidates must be routable`);
  }
  if (outcome === 'weak' && candidates.some((c) => c.matchSource !== 'fallback')) {
    throw new ContractViolation('weak candidates come from the fallback only');
  }
  if (outcome !== 'index_not_ready' && candidates.some((c) => c.buildId === null)) {
    throw new ContractViolation(`${outcome} candidate without a build`);
  }
  const mapped: ItemCandidate[] = candidates.map(({ rank: _rank, ...candidate }) => candidate);
  return {
    outcome: outcome as 'single' | 'ambiguous' | 'weak' | 'index_not_ready',
    reasonCode,
    candidates: mapped,
    indexCoverage: coverage(header.index_coverage),
  };
}

// ---------------------------------------------------------------------------
// Row mapping (P5: item_embedding_profile, search_units, validate_units —
// backend `search_units_contract.py`)
// ---------------------------------------------------------------------------

function singleHeader(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  const headers = rows.filter((row) => row.row_kind === 'header');
  if (headers.length !== 1) throw new ContractViolation('expected exactly one header row');
  return headers[0]!;
}

function isScopeRefusal(
  outcome: unknown,
): outcome is 'student_ref_unknown' | 'offering_not_permitted' {
  return outcome === 'student_ref_unknown' || outcome === 'offering_not_permitted';
}

export function mapProfileRows(
  rows: readonly Record<string, unknown>[],
): ItemEmbeddingProfileResult {
  const outcome = singleHeader(rows).outcome;
  const body = rows.filter((row) => row.row_kind !== 'header');
  if (isScopeRefusal(outcome)) {
    if (body.length > 0) throw new ContractViolation(`${outcome} carries rows`);
    return { outcome };
  }
  if (outcome !== 'ok') throw new ContractViolation('profile outcome');
  const items: Array<{ rank: number; entry: ItemProfileEntry }> = [];
  for (const row of body) {
    if (row.row_kind !== 'item') throw new ContractViolation('row_kind');
    const rank = Number(row.item_rank);
    if (!Number.isInteger(rank) || rank < 1) throw new ContractViolation('item_rank');
    const learningItemId = idText(row.learning_item_id, 'learning_item_id');
    if (row.outcome === 'ok') {
      const dims = Number(row.dims);
      if (
        typeof row.provider !== 'string' ||
        typeof row.model !== 'string' ||
        !Number.isInteger(dims) ||
        dims < 1
      ) {
        throw new ContractViolation('an ok profile row lacks a field');
      }
      items.push({
        rank,
        entry: {
          outcome: 'ok',
          learningItemId,
          buildId: idText(row.build_id, 'build_id'),
          embeddingRunId: idText(row.embedding_run_id, 'embedding_run_id'),
          provider: row.provider,
          model: row.model,
          dims,
        },
      });
    } else if (
      row.outcome === 'no_active_embeddings' ||
      row.outcome === 'embedding_profile_mismatch'
    ) {
      items.push({ rank, entry: { outcome: row.outcome, learningItemId } });
    } else {
      throw new ContractViolation('item outcome');
    }
  }
  items.sort((a, b) => a.rank - b.rank);
  return { outcome: 'ok', items: items.map((item) => item.entry) };
}

export function mapSearchRows(rows: readonly Record<string, unknown>[]): SearchUnitsResult {
  const outcome = singleHeader(rows).outcome;
  const body = rows.filter((row) => row.row_kind !== 'header');
  if (
    isScopeRefusal(outcome) ||
    outcome === 'run_superseded' ||
    outcome === 'embedding_profile_mismatch'
  ) {
    if (body.length > 0) throw new ContractViolation(`${String(outcome)} carries rows`);
    return { outcome };
  }
  if (outcome !== 'ok') throw new ContractViolation('search outcome');
  const units: Array<SearchUnitRow & { rank: number }> = [];
  const dropped: Array<{ learningItemId: string; embeddingRunId: string }> = [];
  for (const row of body) {
    if (row.row_kind === 'dropped') {
      if (row.reason_code !== 'dropped_incompatible') throw new ContractViolation('drop reason');
      dropped.push({
        learningItemId: idText(row.learning_item_id, 'learning_item_id'),
        embeddingRunId: idText(row.embedding_run_id, 'embedding_run_id'),
      });
      continue;
    }
    if (row.row_kind !== 'unit') throw new ContractViolation('row_kind');
    const rank = Number(row.unit_rank);
    const similarity = Number(row.similarity);
    const charLength = Number(row.char_length);
    if (!Number.isInteger(rank) || rank < 1) throw new ContractViolation('unit_rank');
    if (!Number.isFinite(similarity)) throw new ContractViolation('similarity');
    if (!Number.isInteger(charLength) || charLength < 0) throw new ContractViolation('char_length');
    if (typeof row.text !== 'string') throw new ContractViolation('text');
    if (typeof row.unit_updated_at !== 'string' || row.unit_updated_at.length === 0) {
      throw new ContractViolation('unit_updated_at');
    }
    units.push({
      rank,
      contentUnitId: idText(row.content_unit_id, 'content_unit_id'),
      learningItemId: idText(row.learning_item_id, 'learning_item_id'),
      itemType: itemType(row.item_type),
      unitTitle: typeof row.unit_title === 'string' ? row.unit_title : null,
      text: row.text,
      charLength,
      similarity,
      contentRevisionId: idText(row.content_revision_id, 'content_revision_id'),
      unitUpdatedAt: row.unit_updated_at,
      buildId: idText(row.build_id, 'build_id'),
    });
  }
  units.sort((a, b) => a.rank - b.rank);
  if (units.some((unit, index) => unit.rank !== index + 1))
    throw new ContractViolation('unit ranks');
  if (units.length > MAX_SEARCH_UNITS) throw new ContractViolation('too many units');
  if (new Set(units.map((unit) => unit.contentUnitId)).size !== units.length) {
    throw new ContractViolation('a unit appears twice');
  }
  return {
    outcome: 'ok',
    units: units.map(({ rank: _rank, ...unit }) => unit),
    ...(dropped.length > 0 ? { dropped } : {}),
  };
}

export function mapValidateRows(rows: readonly Record<string, unknown>[]): ValidateUnitsResult {
  const outcome = singleHeader(rows).outcome;
  const body = rows.filter((row) => row.row_kind !== 'header');
  if (isScopeRefusal(outcome)) {
    if (body.length > 0) throw new ContractViolation(`${outcome} carries rows`);
    return { outcome };
  }
  if (outcome !== 'ok') throw new ContractViolation('validate outcome');
  const valid: string[] = [];
  for (const row of body) {
    if (row.row_kind !== 'valid') throw new ContractViolation('row_kind');
    valid.push(idText(row.content_unit_id, 'content_unit_id'));
  }
  return { outcome: 'ok', validUnitIds: valid };
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export interface KafuoGroundingPoolStats {
  poolMax: number;
  total: number;
  idle: number;
  waiting: number;
  inFlight: number;
  lastErrorCode: string | null;
  /** Epoch ms of the last error (busy, unavailable or contract violation). */
  lastErrorAt: number | null;
}

export interface PgGroundingReaderOptions {
  pool: GroundingPgPool;
  /** The semaphore size: the pool's `max`. */
  max: number;
  /** Monotonic ms clock for `poolWaitMs` (default `performance.now`). */
  clock?: () => number;
  /** Epoch ms clock for `lastErrorAt` (default `Date.now`). */
  wallClock?: () => number;
}

export class PgGroundingReader implements KafuoGroundingReader {
  private inFlight = 0;
  private lastErrorCode: string | null = null;
  private lastErrorAt: number | null = null;
  private readonly clock: () => number;
  private readonly wallClock: () => number;

  constructor(private readonly options: PgGroundingReaderOptions) {
    this.clock = options.clock ?? (() => performance.now());
    this.wallClock = options.wallClock ?? Date.now;
  }

  /** Recorded by the pool's `error` listener too (an idle client died). */
  recordError(code: string, fn = 'pool'): void {
    this.lastErrorCode = code;
    this.lastErrorAt = this.wallClock();
    log.warn(JSON.stringify({ event: 'tutor.grounding_reader_error', fn, code }));
  }

  stats(): KafuoGroundingPoolStats {
    const { pool, max } = this.options;
    return {
      poolMax: max,
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      inFlight: this.inFlight,
      lastErrorCode: this.lastErrorCode,
      lastErrorAt: this.lastErrorAt,
    };
  }

  async end(): Promise<void> {
    await this.options.pool.end();
  }

  /**
   * Admission → one statement → release. `map` turns the rows into the seam's
   * result; it may throw `ContractViolation`.
   */
  private async call<T extends { outcome: string }>(
    fn: string,
    text: string,
    values: unknown[],
    map: (rows: Record<string, unknown>[]) => T,
  ): Promise<(T | Busy | Unavailable) & { poolWaitMs?: number }> {
    const { pool, max } = this.options;
    if (this.inFlight >= max) {
      this.recordError('retrieval_busy', fn);
      return { outcome: 'retrieval_busy', poolWaitMs: 0 };
    }
    this.inFlight += 1;
    const startedAt = this.clock();
    const waited = () => Math.round((this.clock() - startedAt) * 1000) / 1000;
    try {
      let client: GroundingPgClient;
      try {
        client = await pool.connect();
      } catch (error) {
        const kind = errorKind(error);
        // A connect timeout while every connection is checked out is admission
        // saturation (RET-06); otherwise the database is not reachable.
        const saturated = kind === 'connect_timeout' && pool.totalCount >= max;
        this.recordError(saturated ? 'retrieval_busy' : kind, fn);
        return {
          outcome: saturated ? 'retrieval_busy' : 'retrieval_unavailable',
          poolWaitMs: waited(),
        };
      }
      const poolWaitMs = waited();
      let rows: Record<string, unknown>[];
      try {
        rows = (await client.query({ text, values })).rows;
        client.release();
      } catch (error) {
        // A server-side error leaves the session usable; a client-side timeout or
        // a broken socket does not, so that connection is destroyed.
        client.release(sqlState(error) === null ? true : undefined);
        this.recordError(errorKind(error), fn);
        return { outcome: 'retrieval_unavailable', poolWaitMs };
      }
      try {
        return { ...map(rows), poolWaitMs };
      } catch (error) {
        this.recordError(
          error instanceof ContractViolation ? 'contract_violation' : 'mapping_error',
          fn,
        );
        return { outcome: 'retrieval_unavailable', poolWaitMs };
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  private scopeValues(scope: GroundingReaderScope): [string, string, string] | null {
    if (!BIGINT_ID.test(scope.tenantId) || !BIGINT_ID.test(scope.subjectOfferingId)) return null;
    return [scope.tenantId, scope.studentRef, scope.subjectOfferingId];
  }

  async resolveItems(
    scope: GroundingReaderScope,
    input: ResolveItemsInput,
  ): Promise<ResolveItemsResult> {
    return this.resolve('resolve_items', scope, input.text, input.maxCandidates);
  }

  /** D-10: the same single statement; the caller acts on `single` only. */
  async probeItems(
    scope: GroundingReaderScope,
    input: { text: string },
  ): Promise<ResolveItemsResult> {
    return this.resolve('resolve_items:probe', scope, input.text, MAX_RESOLVE_CANDIDATES);
  }

  private async resolve(
    fn: string,
    scope: GroundingReaderScope,
    text: string,
    maxCandidates: number | undefined,
  ): Promise<ResolveItemsResult> {
    const values = this.scopeValues(scope);
    if (!values) {
      this.recordError('invalid_scope_id', fn);
      return { outcome: 'retrieval_unavailable' };
    }
    const [tenantId, studentRef, offeringId] = values;
    const max = Math.min(
      MAX_RESOLVE_CANDIDATES,
      Math.max(1, Math.trunc(maxCandidates ?? MAX_RESOLVE_CANDIDATES)),
    );
    return this.call(
      fn,
      RESOLVE_ITEMS_SQL,
      [tenantId, studentRef, offeringId, text, max],
      mapResolveRows,
    );
  }

  /** A request the function would refuse with 22023 / 22P02 never reaches the database. */
  private invalid(fn: string): { outcome: 'retrieval_unavailable' } {
    this.recordError('invalid_request', fn);
    return { outcome: 'retrieval_unavailable' };
  }

  async itemEmbeddingProfile(
    scope: GroundingReaderScope,
    input: { itemIds: string[] },
  ): Promise<ItemEmbeddingProfileResult> {
    const fn = 'item_embedding_profile';
    const values = this.scopeValues(scope);
    const itemIds = [...new Set(input.itemIds)];
    if (!values) return this.invalid(fn);
    if (
      itemIds.length === 0 ||
      itemIds.length > MAX_PROFILE_ITEMS ||
      !itemIds.every((id) => BIGINT_ID.test(id))
    ) {
      return this.invalid(fn);
    }
    return this.call(fn, ITEM_EMBEDDING_PROFILE_SQL, [...values, itemIds], mapProfileRows);
  }

  async searchUnits(
    scope: GroundingReaderScope,
    input: SearchUnitsInput,
  ): Promise<SearchUnitsResult> {
    const fn = 'search_units';
    const values = this.scopeValues(scope);
    if (!values) return this.invalid(fn);
    const { targets, query } = input;
    if (
      targets.length === 0 ||
      targets.length > MAX_SEARCH_TARGETS ||
      new Set(targets.map((target) => target.learningItemId)).size !== targets.length ||
      !targets.every((t) => BIGINT_ID.test(t.learningItemId) && BIGINT_ID.test(t.embeddingRunId)) ||
      query.length === 0 ||
      !query.every((value) => Number.isFinite(value))
    ) {
      return this.invalid(fn);
    }
    const targetsJson = JSON.stringify(
      targets.map((target) => ({
        item_id: target.learningItemId,
        embedding_run_id: target.embeddingRunId,
      })),
    );
    const limit = Math.min(
      MAX_SEARCH_UNITS,
      Math.max(1, Math.trunc(input.limit ?? MAX_SEARCH_UNITS)),
    );
    return this.call(
      fn,
      SEARCH_UNITS_SQL,
      [...values, targetsJson, query, input.provider, input.model, limit],
      mapSearchRows,
    );
  }

  async validateUnits(
    scope: GroundingReaderScope,
    input: { unitRefs: UnitRef[] },
  ): Promise<ValidateUnitsResult> {
    const fn = 'validate_units';
    const values = this.scopeValues(scope);
    if (!values) return this.invalid(fn);
    const refs = input.unitRefs;
    if (refs.length === 0) return { outcome: 'ok', validUnitIds: [], poolWaitMs: 0 };
    if (
      refs.length > MAX_UNIT_REFS ||
      !refs.every(
        (ref) =>
          BIGINT_ID.test(ref.contentUnitId) &&
          BIGINT_ID.test(ref.learningItemId) &&
          BIGINT_ID.test(ref.buildId) &&
          BIGINT_ID.test(ref.contentRevisionId),
      )
    ) {
      return this.invalid(fn);
    }
    const refsJson = JSON.stringify(
      refs.map((ref) => ({
        content_unit_id: ref.contentUnitId,
        learning_item_id: ref.learningItemId,
        build_id: ref.buildId,
        content_revision_id: ref.contentRevisionId,
        unit_updated_at: ref.unitUpdatedAt,
      })),
    );
    return this.call(fn, VALIDATE_UNITS_SQL, [...values, refsJson], mapValidateRows);
  }
}

// ---------------------------------------------------------------------------
// Process singleton (lazy; health never instantiates it)
// ---------------------------------------------------------------------------

/**
 * The pool config for a checked connection (M-1). Every connection field is
 * explicit, so `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGSSLMODE` and
 * `NODE_TLS_REJECT_UNAUTHORIZED` cannot change where or how it connects. The
 * `sslrootcert` file is read here (an unreadable file throws).
 */
export function kafuoGroundingPoolConfig(
  connection: KafuoGroundingConnection,
  settings: KafuoGroundingPoolSettings,
): PoolConfig {
  return {
    host: connection.host,
    port: connection.port,
    user: connection.user,
    ...(connection.password !== undefined ? { password: connection.password } : {}),
    database: connection.database,
    ssl:
      connection.tls === 'verify-full'
        ? {
            rejectUnauthorized: true,
            ...(connection.caFile !== null ? { ca: readFileSync(connection.caFile, 'utf8') } : {}),
          }
        : false,
    max: settings.max,
    connectionTimeoutMillis: settings.admissionTimeoutMs,
    idleTimeoutMillis: settings.idleTimeoutMs,
    query_timeout: settings.queryTimeoutMs,
    application_name: GROUNDING_APPLICATION_NAME,
    allowExitOnIdle: true,
  };
}

/** Throws (without echoing the DSN) when the DSN or the environment breaks the M-1 rules. */
export function createKafuoGroundingPool(
  url: string,
  settings: KafuoGroundingPoolSettings,
  onError: (code: string) => void,
  env: Record<string, string | undefined> = process.env,
): Pool {
  const check = checkKafuoGroundingConnection(url, env);
  if (!check.ok) throw new Error(`KAFUO_GROUNDING_DATABASE_URL is refused: ${check.reason}`);
  const pool = new Pool(kafuoGroundingPoolConfig(check.connection, settings));
  // Mandatory: an idle client that dies emits `error` on the pool, which would
  // otherwise crash the process.
  pool.on('error', (error) => onError(errorKind(error)));
  return pool;
}

const READER_KEY = Symbol.for('openmaic.tutor.kafuo-grounding-reader');

interface ReaderRegistry {
  reader?: PgGroundingReader;
  url?: string;
  /** The last refusal logged, so a refused configuration logs once, not per turn. */
  refusal?: string;
}

function noteRefusal(state: ReaderRegistry, reason: string): undefined {
  if (state.refusal !== reason) {
    state.refusal = reason;
    log.warn(JSON.stringify({ event: 'tutor.grounding_reader_refused', reason }));
  }
  return undefined;
}

function registry(): ReaderRegistry {
  const store = globalThis as Record<symbol, ReaderRegistry | undefined>;
  return (store[READER_KEY] ??= {});
}

/**
 * The process reader, created on first use when `KAFUO_GROUNDING_DATABASE_URL`
 * is set (no connection is opened until a call); `undefined` otherwise.
 *
 * Also `undefined` (fail closed: `direct` falls back to `kafuo_http`, shadow
 * records "not available") while the DSN or the environment breaks the M-1
 * rules. That check is cheap and runs on every call, before the cached reader
 * is returned; a refusal is logged once per distinct reason.
 */
export function getKafuoGroundingReader(
  env: Record<string, string | undefined> = process.env,
): PgGroundingReader | undefined {
  const url = kafuoGroundingDatabaseUrl(env);
  if (!url) return undefined;
  const state = registry();
  const check = checkKafuoGroundingConnection(url, env);
  if (!check.ok) return noteRefusal(state, check.reason);
  state.refusal = undefined;
  if (state.reader && state.url === url) return state.reader;
  const settings = kafuoGroundingPoolSettings(env);
  let config: PoolConfig;
  try {
    config = kafuoGroundingPoolConfig(check.connection, settings);
  } catch (error) {
    // The `sslrootcert` file is unreadable; the code only, never the path.
    return noteRefusal(state, `sslrootcert_unreadable:${errorKind(error)}`);
  }
  const pool = new Pool(config);
  const reader = new PgGroundingReader({ pool, max: settings.max });
  // Mandatory: an idle client that dies emits `error` on the pool, which would
  // otherwise crash the process.
  pool.on('error', (error) => reader.recordError(errorKind(error)));
  const previous = state.reader;
  state.reader = reader;
  state.url = url;
  if (previous) void previous.end().catch(() => undefined);
  return reader;
}

/** Shutdown: close the reader pool if one was created. */
export async function closeKafuoGroundingReader(): Promise<void> {
  const state = registry();
  const reader = state.reader;
  state.reader = undefined;
  state.url = undefined;
  if (reader) await reader.end().catch(() => undefined);
}

export interface KafuoGroundingHealth {
  /** Whether `KAFUO_GROUNDING_DATABASE_URL` is set (never the URL itself). */
  configured: boolean;
  source: GroundingSource;
  poolMax: number | null;
  total: number | null;
  idle: number | null;
  waiting: number | null;
  inFlight: number | null;
  lastErrorCode: string | null;
  lastErrorAt: number | null;
}

/** The health block; reads the live pool only if one already exists. */
export function kafuoGroundingHealth(
  env: Record<string, string | undefined> = process.env,
): KafuoGroundingHealth {
  const reader = registry().reader;
  const stats = reader?.stats();
  return {
    configured: kafuoGroundingDatabaseUrl(env) !== null,
    source: groundingSourceSetting(env),
    poolMax:
      stats?.poolMax ??
      (kafuoGroundingDatabaseUrl(env) ? kafuoGroundingPoolSettings(env).max : null),
    total: stats?.total ?? null,
    idle: stats?.idle ?? null,
    waiting: stats?.waiting ?? null,
    inFlight: stats?.inFlight ?? null,
    lastErrorCode: stats?.lastErrorCode ?? null,
    lastErrorAt: stats?.lastErrorAt ?? null,
  };
}
