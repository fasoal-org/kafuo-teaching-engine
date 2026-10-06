import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pg-backed Kafuo grounding reader (discovery-first P6, §5.5) over a
 * mocked pg pool: row mapping for every `resolve_items` outcome, the
 * contract checks, admission (semaphore → `retrieval_busy` fast, connect
 * timeout by pool state), statement / client timeouts → `retrieval_unavailable`,
 * connection release rules, health counters, and that nothing it logs carries
 * the student's text, a driver message or a vector.
 */

const logs = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const push = (...args: unknown[]) => logs.lines.push(args.map(String).join(' '));
    return { info: push, warn: push, error: push, debug: push };
  },
}));

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';

import { checkKafuoGroundingConnection } from '@/lib/server/tutor/grounding/grounding-config';
import {
  GROUNDING_APPLICATION_NAME,
  ITEM_EMBEDDING_PROFILE_SQL,
  PgGroundingReader,
  RESOLVE_ITEMS_SQL,
  SEARCH_UNITS_SQL,
  VALIDATE_UNITS_SQL,
  closeKafuoGroundingReader,
  createKafuoGroundingPool,
  getKafuoGroundingReader,
  kafuoGroundingHealth,
  kafuoGroundingPoolConfig,
  mapResolveRows,
  type GroundingPgClient,
  type GroundingPgPool,
} from '@/lib/server/tutor/grounding/pg-grounding-reader';

const SCOPE = { tenantId: '7', studentRef: 'ref-abc', subjectOfferingId: '11' };
const SECRET_TEXT = 'اشرحلي المثال المضاد 1234567';

type Row = Record<string, unknown>;

const header = (outcome: string, extra: Row = {}): Row => ({
  row_kind: 'header',
  outcome,
  reason_code: null,
  index_coverage: 'complete',
  candidate_rank: null,
  learning_item_id: null,
  item_type: null,
  title: null,
  score: null,
  matched_term_types: null,
  routable: null,
  readiness: null,
  match_source: null,
  build_id: null,
  ...extra,
});

const cand = (outcome: string, rank: number, id: string, extra: Row = {}): Row => ({
  row_kind: 'candidate',
  outcome,
  reason_code: null,
  index_coverage: 'complete',
  candidate_rank: rank,
  learning_item_id: id,
  item_type: 'LESSON',
  title: `عنوان ${id}`,
  score: 2.5,
  matched_term_types: ['glossary'],
  routable: true,
  readiness: 'ready',
  match_source: 'term',
  build_id: `9${id}`,
  ...extra,
});

interface FakePool {
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  clients: Array<{ query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

function fakePool(
  respond: (text: string, values: unknown[]) => Promise<{ rows: Row[] }>,
): FakePool {
  const pool: FakePool = {
    clients: [],
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    end: vi.fn(async () => undefined),
    connect: vi.fn(async (): Promise<GroundingPgClient & FakePool['clients'][number]> => {
      const client = {
        query: vi.fn(async (config: { text: string; values: unknown[] }) =>
          respond(config.text, config.values),
        ),
        release: vi.fn(),
      };
      pool.clients.push(client);
      return client;
    }),
  };
  return pool;
}

const rowsOf =
  (...rows: Row[]) =>
  async () => ({ rows });
const asPool = (pool: FakePool) => pool as unknown as GroundingPgPool;

describe('mapResolveRows (plan §5.3, backend parse_resolve_rows)', () => {
  it('single / ambiguous / weak / index_not_ready map candidates in rank order with build ids as strings', () => {
    expect(
      mapResolveRows([header('single', { reason_code: 'strong_match' }), cand('single', 1, '155')]),
    ).toEqual({
      outcome: 'single',
      reasonCode: 'strong_match',
      indexCoverage: 'complete',
      candidates: [
        {
          learningItemId: '155',
          itemType: 'LESSON',
          title: 'عنوان 155',
          score: 2.5,
          matchedTermTypes: ['glossary'],
          routable: true,
          buildId: '9155',
          readiness: 'ready',
          matchSource: 'term',
        },
      ],
    });

    const ambiguous = mapResolveRows([
      header('ambiguous', { reason_code: 'close_scores', index_coverage: 'partial' }),
      cand('ambiguous', 2, '612', { item_type: 'SECTION', score: 2.1 }),
      cand('ambiguous', 1, '155'),
    ]);
    expect(ambiguous).toMatchObject({
      outcome: 'ambiguous',
      reasonCode: 'close_scores',
      indexCoverage: 'partial',
    });
    expect(
      (
        ambiguous as { candidates: Array<{ learningItemId: string; itemType: string }> }
      ).candidates.map((c) => [c.learningItemId, c.itemType]),
    ).toEqual([
      ['155', 'LESSON'],
      ['612', 'SECTION'],
    ]);

    const weak = mapResolveRows([
      header('weak', { reason_code: 'lexical_fallback' }),
      cand('weak', 1, '155', { match_source: 'fallback', matched_term_types: [], score: 0.0607 }),
    ]);
    expect(weak).toMatchObject({
      outcome: 'weak',
      candidates: [{ matchedTermTypes: [], score: 0.0607, matchSource: 'fallback' }],
    });

    // Title-probe candidate: not routable, NULL build_id (a never-built item).
    const notReady = mapResolveRows([
      header('index_not_ready', { reason_code: 'title_probe', index_coverage: 'partial' }),
      cand('index_not_ready', 1, '800', {
        routable: false,
        readiness: 'not_built',
        match_source: 'title',
        build_id: null,
        matched_term_types: [],
      }),
    ]);
    expect(notReady).toMatchObject({
      outcome: 'index_not_ready',
      reasonCode: 'title_probe',
      candidates: [{ learningItemId: '800', routable: false, buildId: null, matchSource: 'title' }],
    });
  });

  it('no_match carries its coverage and no candidates; the two scope refusals carry NOTHING else', () => {
    expect(
      mapResolveRows([
        header('no_match', { reason_code: 'no_term_match', index_coverage: 'partial' }),
      ]),
    ).toEqual({
      outcome: 'no_match',
      reasonCode: 'no_term_match',
      indexCoverage: 'partial',
    });
    expect(
      mapResolveRows([
        header('student_ref_unknown', { reason_code: 'student_ref_unknown', index_coverage: null }),
      ]),
    ).toEqual({
      outcome: 'student_ref_unknown',
    });
    expect(
      mapResolveRows([
        header('offering_not_permitted', {
          reason_code: 'placement_missing',
          index_coverage: null,
        }),
      ]),
    ).toEqual({
      outcome: 'offering_not_permitted',
    });
  });

  it.each([
    ['no header', [cand('single', 1, '1')]],
    ['two headers', [header('no_match'), header('no_match')]],
    ['unknown outcome', [header('maybe')]],
    [
      'candidate on a refusal',
      [
        header('student_ref_unknown', { index_coverage: null }),
        cand('student_ref_unknown', 1, '1'),
      ],
    ],
    ['candidate on no_match', [header('no_match'), cand('no_match', 1, '1')]],
    ['single without a candidate', [header('single')]],
    ['single with two', [header('single'), cand('single', 1, '1'), cand('single', 2, '2')]],
    [
      'four candidates',
      [
        header('ambiguous'),
        cand('ambiguous', 1, '1'),
        cand('ambiguous', 2, '2'),
        cand('ambiguous', 3, '3'),
        cand('ambiguous', 4, '4'),
      ],
    ],
    ['unroutable single', [header('single'), cand('single', 1, '1', { routable: false })]],
    ['weak from terms', [header('weak'), cand('weak', 1, '1')]],
    [
      'routable candidate without a build',
      [header('single'), cand('single', 1, '1', { build_id: null })],
    ],
    ['candidate outcome differs', [header('single'), cand('ambiguous', 1, '1')]],
    ['bad item type', [header('single'), cand('single', 1, '1', { item_type: 'UNIT' })]],
    ['bad id', [header('single'), cand('single', 1, 'x1')]],
    ['no_match without coverage', [header('no_match', { index_coverage: null })]],
  ])('a contract violation throws: %s', (_label, rows) => {
    expect(() => mapResolveRows(rows as Row[])).toThrow('contract_violation');
  });
});

describe('PgGroundingReader', () => {
  beforeEach(() => {
    logs.lines.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends exactly one resolve_items statement (typed params, ≤ 3 candidates) and releases the client', async () => {
    const pool = fakePool(
      rowsOf(header('single', { reason_code: 'strong_match' }), cand('single', 1, '155')),
    );
    let tick = 0;
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 2, clock: () => (tick += 5) });
    const result = await reader.resolveItems(SCOPE, { text: SECRET_TEXT, maxCandidates: 9 });
    expect(result).toMatchObject({ outcome: 'single', poolWaitMs: 5 });
    expect(pool.clients).toHaveLength(1);
    const client = pool.clients[0]!;
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0]![0]).toEqual({
      text: RESOLVE_ITEMS_SQL,
      values: ['7', 'ref-abc', '11', SECRET_TEXT, 3],
    });
    expect(RESOLVE_ITEMS_SQL).toMatch(
      /^SELECT .* FROM grounding_read_v1\.resolve_items\(\$1::bigint, \$2::text, \$3::bigint, \$4::text, \$5::integer\) ORDER BY candidate_rank NULLS FIRST$/,
    );
    expect(client.release).toHaveBeenCalledWith();
    expect(reader.stats()).toMatchObject({ inFlight: 0, lastErrorCode: null });
  });

  it('the D-10 probe is the same statement with 3 candidates', async () => {
    const pool = fakePool(rowsOf(header('no_match', { reason_code: 'no_term_match' })));
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    expect(await reader.probeItems(SCOPE, { text: 'x' })).toMatchObject({
      outcome: 'no_match',
      indexCoverage: 'complete',
    });
    expect(pool.clients[0]!.query.mock.calls[0]![0].values).toEqual(['7', 'ref-abc', '11', 'x', 3]);
  });

  it('scope refusals pass through as typed outcomes (the caller refuses the turn)', async () => {
    const pool = fakePool(
      rowsOf(
        header('offering_not_permitted', {
          reason_code: 'offering_out_of_scope',
          index_coverage: null,
        }),
      ),
    );
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    const result = await reader.resolveItems(SCOPE, { text: 'x' });
    expect(result).toEqual({ outcome: 'offering_not_permitted', poolWaitMs: expect.any(Number) });
  });

  it('pool saturation: a call beyond the semaphore is retrieval_busy at once, without touching the pool', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pool = fakePool(async () => {
      await gate;
      return { rows: [header('no_match')] };
    });
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 2 });
    const first = reader.resolveItems(SCOPE, { text: 'a' });
    const second = reader.resolveItems(SCOPE, { text: 'b' });
    await vi.waitFor(() => expect(pool.connect).toHaveBeenCalledTimes(2));
    expect(reader.stats().inFlight).toBe(2);

    const startedAt = performance.now();
    const third = await reader.resolveItems(SCOPE, { text: 'c' });
    expect(performance.now() - startedAt).toBeLessThan(50);
    expect(third).toEqual({ outcome: 'retrieval_busy', poolWaitMs: 0 });
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(reader.stats()).toMatchObject({ lastErrorCode: 'retrieval_busy' });

    release();
    expect(await first).toMatchObject({ outcome: 'no_match' });
    expect(await second).toMatchObject({ outcome: 'no_match' });
    expect(reader.stats().inFlight).toBe(0);
    // A slot is free again.
    expect(await reader.resolveItems(SCOPE, { text: 'd' })).toMatchObject({ outcome: 'no_match' });
  });

  it('a connect timeout is retrieval_busy when the pool is full, retrieval_unavailable otherwise', async () => {
    const timeout = new Error('timeout exceeded when trying to connect');
    const pool = fakePool(rowsOf(header('no_match')));
    pool.connect.mockRejectedValueOnce(timeout);
    pool.totalCount = 4;
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 4 });
    expect(await reader.resolveItems(SCOPE, { text: 'x' })).toMatchObject({
      outcome: 'retrieval_busy',
    });

    pool.totalCount = 1;
    pool.connect.mockRejectedValueOnce(timeout);
    expect(await reader.resolveItems(SCOPE, { text: 'x' })).toMatchObject({
      outcome: 'retrieval_unavailable',
    });
    expect(reader.stats().lastErrorCode).toBe('connect_timeout');

    pool.connect.mockRejectedValueOnce(
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    );
    expect(await reader.resolveItems(SCOPE, { text: 'x' })).toMatchObject({
      outcome: 'retrieval_unavailable',
    });
    expect(reader.stats().lastErrorCode).toBe('econnrefused');
    expect(reader.stats().inFlight).toBe(0);
  });

  it('a server statement_timeout (57014) is retrieval_unavailable and keeps the connection', async () => {
    const pool = fakePool(async () => {
      throw Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      });
    });
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    expect(await reader.resolveItems(SCOPE, { text: SECRET_TEXT })).toMatchObject({
      outcome: 'retrieval_unavailable',
    });
    expect(pool.clients[0]!.release).toHaveBeenCalledWith(undefined);
    expect(reader.stats().lastErrorCode).toBe('statement_timeout');
  });

  it('the client-side query_timeout backstop is retrieval_unavailable and DESTROYS the connection', async () => {
    const pool = fakePool(async () => {
      throw new Error('Query read timeout');
    });
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    expect(await reader.resolveItems(SCOPE, { text: 'x' })).toMatchObject({
      outcome: 'retrieval_unavailable',
    });
    expect(pool.clients[0]!.release).toHaveBeenCalledWith(true);
    expect(reader.stats().lastErrorCode).toBe('query_timeout');
  });

  it('any other SQL error, or rows breaking the contract, is retrieval_unavailable', async () => {
    const pool = fakePool(async () => {
      throw Object.assign(new Error(`invalid input syntax for type bigint: "${SECRET_TEXT}"`), {
        code: '22P02',
      });
    });
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    expect(await reader.resolveItems(SCOPE, { text: 'x' })).toMatchObject({
      outcome: 'retrieval_unavailable',
    });
    expect(reader.stats().lastErrorCode).toBe('sqlstate_22P02');

    const broken = new PgGroundingReader({
      pool: asPool(fakePool(rowsOf(header('single')))),
      max: 1,
    });
    expect(await broken.resolveItems(SCOPE, { text: 'x' })).toMatchObject({
      outcome: 'retrieval_unavailable',
    });
    expect(broken.stats().lastErrorCode).toBe('contract_violation');
  });

  it('a non-numeric tenant or offering id never reaches the database', async () => {
    const pool = fakePool(rowsOf(header('no_match')));
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    expect(await reader.resolveItems({ ...SCOPE, tenantId: '7; DROP' }, { text: 'x' })).toEqual({
      outcome: 'retrieval_unavailable',
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('item_embedding_profile: bigint[] of ids; ok / no_active_embeddings / mismatch per item, in rank order', async () => {
    const pool = fakePool(
      rowsOf(
        {
          row_kind: 'header',
          outcome: 'ok',
          item_rank: null,
          learning_item_id: null,
          build_id: null,
          embedding_run_id: null,
          provider: null,
          model: null,
          dims: null,
        },
        {
          row_kind: 'item',
          outcome: 'embedding_profile_mismatch',
          item_rank: 2,
          learning_item_id: '612',
          build_id: '70',
          embedding_run_id: null,
          provider: null,
          model: null,
          dims: null,
        },
        {
          row_kind: 'item',
          outcome: 'ok',
          item_rank: 1,
          learning_item_id: '155',
          build_id: '71',
          embedding_run_id: '501',
          provider: 'openai',
          model: 'text-embedding-3-small',
          dims: 1536,
        },
        {
          row_kind: 'item',
          outcome: 'no_active_embeddings',
          item_rank: 3,
          learning_item_id: '800',
          build_id: null,
          embedding_run_id: null,
          provider: null,
          model: null,
          dims: null,
        },
      ),
    );
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    const result = await reader.itemEmbeddingProfile(SCOPE, { itemIds: ['155', '612', '800'] });
    expect(result).toEqual({
      outcome: 'ok',
      poolWaitMs: expect.any(Number),
      items: [
        {
          outcome: 'ok',
          learningItemId: '155',
          buildId: '71',
          embeddingRunId: '501',
          provider: 'openai',
          model: 'text-embedding-3-small',
          dims: 1536,
        },
        { outcome: 'embedding_profile_mismatch', learningItemId: '612' },
        { outcome: 'no_active_embeddings', learningItemId: '800' },
      ],
    });
    expect(pool.clients[0]!.query.mock.calls[0]![0]).toEqual({
      text: ITEM_EMBEDDING_PROFILE_SQL,
      values: ['7', 'ref-abc', '11', ['155', '612', '800']],
    });
    expect(ITEM_EMBEDDING_PROFILE_SQL).toContain(
      'grounding_read_v1.item_embedding_profile($1::bigint, $2::text, $3::bigint, $4::bigint[])',
    );
  });

  it('search_units: targets as jsonb, the query as real[], ≤ 5 units mapped; run_superseded / mismatch / refusals carry no rows', async () => {
    const unit = (rank: number, id: string, extra: Row = {}): Row => ({
      row_kind: 'unit',
      outcome: 'ok',
      reason_code: null,
      unit_rank: rank,
      content_unit_id: id,
      learning_item_id: '612',
      item_type: 'SECTION',
      unit_title: 'المفردات',
      text: 'نص',
      char_length: 3,
      similarity: 0.83,
      content_revision_id: '40',
      unit_updated_at: '2026-10-01T08:00:00.123456Z',
      build_id: '70',
      embedding_run_id: '501',
      ...extra,
    });
    const hdr = (outcome: string): Row => ({
      row_kind: 'header',
      outcome,
      reason_code: null,
      unit_rank: null,
      content_unit_id: null,
      learning_item_id: null,
      item_type: null,
      unit_title: null,
      text: null,
      char_length: null,
      similarity: null,
      content_revision_id: null,
      unit_updated_at: null,
      build_id: null,
      embedding_run_id: null,
    });
    const pool = fakePool(
      rowsOf(hdr('ok'), unit(2, '3278', { similarity: 0.71, unit_title: null }), unit(1, '3279'), {
        ...hdr('ok'),
        row_kind: 'dropped',
        reason_code: 'dropped_incompatible',
        learning_item_id: '155',
        embedding_run_id: '502',
      }),
    );
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    const query = [0.1, -0.2, 0.3];
    const result = await reader.searchUnits(SCOPE, {
      targets: [
        { learningItemId: '612', embeddingRunId: '501' },
        { learningItemId: '155', embeddingRunId: '502' },
      ],
      query,
      provider: 'openai',
      model: 'text-embedding-3-small',
      limit: 9,
    });
    expect(result).toEqual({
      outcome: 'ok',
      poolWaitMs: expect.any(Number),
      dropped: [{ learningItemId: '155', embeddingRunId: '502' }],
      units: [
        {
          contentUnitId: '3279',
          learningItemId: '612',
          itemType: 'SECTION',
          unitTitle: 'المفردات',
          text: 'نص',
          charLength: 3,
          similarity: 0.83,
          contentRevisionId: '40',
          unitUpdatedAt: '2026-10-01T08:00:00.123456Z',
          buildId: '70',
        },
        {
          contentUnitId: '3278',
          learningItemId: '612',
          itemType: 'SECTION',
          unitTitle: null,
          text: 'نص',
          charLength: 3,
          similarity: 0.71,
          contentRevisionId: '40',
          unitUpdatedAt: '2026-10-01T08:00:00.123456Z',
          buildId: '70',
        },
      ],
    });
    expect(pool.clients[0]!.query.mock.calls[0]![0]).toEqual({
      text: SEARCH_UNITS_SQL,
      values: [
        '7',
        'ref-abc',
        '11',
        '[{"item_id":"612","embedding_run_id":"501"},{"item_id":"155","embedding_run_id":"502"}]',
        query,
        'openai',
        'text-embedding-3-small',
        5,
      ],
    });

    for (const outcome of [
      'run_superseded',
      'embedding_profile_mismatch',
      'student_ref_unknown',
      'offering_not_permitted',
    ]) {
      const refused = new PgGroundingReader({
        pool: asPool(fakePool(rowsOf(hdr(outcome)))),
        max: 1,
      });
      expect(
        await refused.searchUnits(SCOPE, {
          targets: [{ learningItemId: '1', embeddingRunId: '2' }],
          query,
          provider: 'openai',
          model: 'm',
        }),
      ).toEqual({ outcome, poolWaitMs: expect.any(Number) });
    }
    // Contract: ranks 1..n, ≤ 5, distinct units; no rows on a non-ok outcome.
    for (const rows of [
      [hdr('ok'), unit(2, '1')],
      [hdr('ok'), unit(1, '1'), unit(2, '1')],
      [hdr('ok'), ...[1, 2, 3, 4, 5, 6].map((rank) => unit(rank, String(rank)))],
      [hdr('run_superseded'), unit(1, '1')],
      [hdr('ok'), unit(1, '1', { unit_updated_at: null })],
    ]) {
      const broken = new PgGroundingReader({ pool: asPool(fakePool(rowsOf(...rows))), max: 1 });
      expect(
        await broken.searchUnits(SCOPE, {
          targets: [{ learningItemId: '1', embeddingRunId: '2' }],
          query,
          provider: 'openai',
          model: 'm',
        }),
      ).toMatchObject({ outcome: 'retrieval_unavailable' });
      expect(broken.stats().lastErrorCode).toBe('contract_violation');
    }
  });

  it('validate_units: refs as jsonb (ids as strings); the valid subset; an empty ref list never reaches the database', async () => {
    const pool = fakePool(
      rowsOf(
        { row_kind: 'header', outcome: 'ok', content_unit_id: null, learning_item_id: null },
        { row_kind: 'valid', outcome: 'ok', content_unit_id: '3279', learning_item_id: '612' },
      ),
    );
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    const ref = {
      contentUnitId: '3279',
      learningItemId: '612',
      buildId: '70',
      contentRevisionId: '40',
      unitUpdatedAt: '2026-10-01T08:00:00.123456Z',
    };
    expect(
      await reader.validateUnits(SCOPE, { unitRefs: [ref, { ...ref, contentUnitId: '3278' }] }),
    ).toEqual({ outcome: 'ok', validUnitIds: ['3279'], poolWaitMs: expect.any(Number) });
    expect(JSON.parse(pool.clients[0]!.query.mock.calls[0]![0].values[3] as string)).toEqual([
      {
        content_unit_id: '3279',
        learning_item_id: '612',
        build_id: '70',
        content_revision_id: '40',
        unit_updated_at: '2026-10-01T08:00:00.123456Z',
      },
      {
        content_unit_id: '3278',
        learning_item_id: '612',
        build_id: '70',
        content_revision_id: '40',
        unit_updated_at: '2026-10-01T08:00:00.123456Z',
      },
    ]);
    expect(pool.clients[0]!.query.mock.calls[0]![0].text).toBe(VALIDATE_UNITS_SQL);
    expect(await reader.validateUnits(SCOPE, { unitRefs: [] })).toEqual({
      outcome: 'ok',
      validUnitIds: [],
      poolWaitMs: 0,
    });
    expect(pool.connect).toHaveBeenCalledTimes(1);

    const refused = new PgGroundingReader({
      pool: asPool(
        fakePool(
          rowsOf({
            row_kind: 'header',
            outcome: 'student_ref_unknown',
            content_unit_id: null,
            learning_item_id: null,
          }),
        ),
      ),
      max: 1,
    });
    expect(await refused.validateUnits(SCOPE, { unitRefs: [ref] })).toEqual({
      outcome: 'student_ref_unknown',
      poolWaitMs: expect.any(Number),
    });
  });

  it('requests the functions would refuse (22023) never reach the database', async () => {
    const pool = fakePool(rowsOf());
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    const target = { learningItemId: '1', embeddingRunId: '2' };
    const search = (input: Partial<Parameters<PgGroundingReader['searchUnits']>[1]>) =>
      reader.searchUnits(SCOPE, {
        targets: [target],
        query: [0.1],
        provider: 'openai',
        model: 'm',
        ...input,
      });
    expect(await reader.itemEmbeddingProfile(SCOPE, { itemIds: ['1', '2', '3', '4'] })).toEqual({
      outcome: 'retrieval_unavailable',
    });
    expect(await reader.itemEmbeddingProfile(SCOPE, { itemIds: [] })).toEqual({
      outcome: 'retrieval_unavailable',
    });
    expect(await reader.itemEmbeddingProfile(SCOPE, { itemIds: ['x'] })).toEqual({
      outcome: 'retrieval_unavailable',
    });
    expect(await search({ targets: [] })).toEqual({ outcome: 'retrieval_unavailable' });
    expect(await search({ targets: [target, target] })).toEqual({
      outcome: 'retrieval_unavailable',
    });
    expect(
      await search({
        targets: [
          target,
          { ...target, learningItemId: '5' },
          { ...target, learningItemId: '6' },
          { ...target, learningItemId: '7' },
        ],
      }),
    ).toEqual({ outcome: 'retrieval_unavailable' });
    expect(await search({ query: [] })).toEqual({ outcome: 'retrieval_unavailable' });
    expect(await search({ query: [Number.NaN] })).toEqual({ outcome: 'retrieval_unavailable' });
    const ref = {
      contentUnitId: '1',
      learningItemId: '2',
      buildId: '3',
      contentRevisionId: '4',
      unitUpdatedAt: 'x',
    };
    expect(
      await reader.validateUnits(SCOPE, { unitRefs: Array.from({ length: 26 }, () => ref) }),
    ).toEqual({ outcome: 'retrieval_unavailable' });
    expect(await reader.validateUnits(SCOPE, { unitRefs: [{ ...ref, buildId: 'b-1' }] })).toEqual({
      outcome: 'retrieval_unavailable',
    });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(reader.stats().lastErrorCode).toBe('invalid_request');
  });

  it('a search query vector never appears in a log line', async () => {
    const pool = fakePool(async () => {
      throw Object.assign(new Error('different vector dimensions 3 and 1536: [0.987654,0.123]'), {
        code: '22000',
      });
    });
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    await reader.searchUnits(SCOPE, {
      targets: [{ learningItemId: '1', embeddingRunId: '2' }],
      query: [0.987654, 0.123, 0.5],
      provider: 'openai',
      model: 'm',
    });
    expect(logs.lines.join('\n')).not.toContain('0.987654');
    expect(JSON.parse(logs.lines.at(-1)!)).toEqual({
      event: 'tutor.grounding_reader_error',
      fn: 'search_units',
      code: 'sqlstate_22000',
    });
  });

  it('logs only the function and an error code: never the text, a driver message or a vector', async () => {
    const pool = fakePool(async () => {
      throw Object.assign(new Error(`invalid input: "${SECRET_TEXT}" [0.123456,0.654321]`), {
        code: '22P02',
      });
    });
    const reader = new PgGroundingReader({ pool: asPool(pool), max: 1 });
    await reader.resolveItems(SCOPE, { text: SECRET_TEXT });
    expect(logs.lines.length).toBeGreaterThan(0);
    const all = logs.lines.join('\n');
    expect(all).not.toContain(SECRET_TEXT);
    expect(all).not.toContain('0.123456');
    expect(all).not.toContain('invalid input');
    expect(all).not.toContain('ref-abc');
    expect(JSON.parse(logs.lines[0]!)).toEqual({
      event: 'tutor.grounding_reader_error',
      fn: 'resolve_items',
      code: 'sqlstate_22P02',
    });
  });
});

describe('kafuoGroundingHealth', () => {
  it('reports configuration without the DSN, and null counts until the lazy pool exists', () => {
    const health = kafuoGroundingHealth({
      TUTOR_GROUNDING_SOURCE: 'shadow',
      KAFUO_GROUNDING_DATABASE_URL: 'postgres://kafuo_grounding_reader:s3cret@db/kafuo',
      KAFUO_GROUNDING_POOL_MAX: '6',
    });
    expect(health).toEqual({
      configured: true,
      source: 'shadow',
      poolMax: 6,
      total: null,
      idle: null,
      waiting: null,
      inFlight: null,
      lastErrorCode: null,
      lastErrorAt: null,
    });
    expect(JSON.stringify(health)).not.toContain('s3cret');
    expect(kafuoGroundingHealth({})).toMatchObject({
      configured: false,
      source: 'kafuo_http',
      poolMax: null,
    });
  });

  it('the pool is tagged with the te-grounding application name', () => {
    expect(GROUNDING_APPLICATION_NAME).toBe('te-grounding');
  });
});

describe('M-1: the pool is built from the checked DSN and the environment cannot weaken it', () => {
  const SETTINGS = { max: 2, admissionTimeoutMs: 300, idleTimeoutMs: 1_000, queryTimeoutMs: 2_500 };
  const REMOTE = 'postgres://kafuo_grounding_reader:s3cret@kafuo-db.example.com:25060/kafuo';
  const VERIFY_FULL = `${REMOTE}?sslmode=verify-full`;
  const LOOPBACK = 'postgres://kafuo_grounding_reader:s3cret@127.0.0.1/fasol_ai_tutor';

  interface EffectiveParameters {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl: unknown;
    options: string | undefined;
    application_name: string | undefined;
  }

  /** What node-postgres would connect with: a Client is built, nothing is opened. */
  function effective(url: string): EffectiveParameters {
    const check = checkKafuoGroundingConnection(url, {});
    if (!check.ok) throw new Error(check.reason);
    const client = new Client(kafuoGroundingPoolConfig(check.connection, SETTINGS));
    return (client as unknown as { connectionParameters: EffectiveParameters })
      .connectionParameters;
  }

  beforeEach(() => {
    logs.lines.length = 0;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeKafuoGroundingReader();
  });

  it('verify-full: an explicit ssl with certificate checks, whatever PGSSLMODE or NODE_TLS_REJECT_UNAUTHORIZED say', () => {
    vi.stubEnv('PGSSLMODE', 'disable');
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    expect(effective(VERIFY_FULL).ssl).toEqual({ rejectUnauthorized: true });
    vi.stubEnv('PGSSLMODE', 'no-verify');
    expect(effective(VERIFY_FULL).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('loopback without TLS: ssl is false, whatever PGSSLMODE says', () => {
    vi.stubEnv('PGSSLMODE', 'verify-full');
    expect(effective(LOOPBACK).ssl).toBe(false);
    vi.stubEnv('PGSSLMODE', 'no-verify');
    expect(effective(LOOPBACK).ssl).toBe(false);
  });

  it('host, port, user and database come from the DSN, never PG* env; an encoded password does not move the host', () => {
    vi.stubEnv('PGHOST', 'evil.example.com');
    vi.stubEnv('PGPORT', '6543');
    vi.stubEnv('PGUSER', 'postgres');
    vi.stubEnv('PGDATABASE', 'postgres');
    vi.stubEnv('PGAPPNAME', 'renamed');
    const params = effective(
      'postgresql://kafuo_grounding_reader:p%40ss%3Aw%2Fd%23x%3Fy@kafuo-db.example.com:25060/kafuo?sslmode=verify-full',
    );
    expect({
      host: params.host,
      port: params.port,
      user: params.user,
      password: params.password,
      database: params.database,
      application_name: params.application_name,
    }).toEqual({
      host: 'kafuo-db.example.com',
      port: 25060,
      user: 'kafuo_grounding_reader',
      password: 'p@ss:w/d#x?y',
      database: 'kafuo',
      application_name: 'te-grounding',
    });
    expect(effective(LOOPBACK).port).toBe(5432);
    expect(effective('postgres://r:pw@[::1]:5433/db').host).toBe('::1');
  });

  it('sslrootcert: the CA file is read into an explicit ssl.ca', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kafuo-grounding-ca-'));
    try {
      const caFile = join(dir, 'ca.crt');
      writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
      expect(effective(`${VERIFY_FULL}&sslrootcert=${encodeURIComponent(caFile)}`).ssl).toEqual({
        rejectUnauthorized: true,
        ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PGOPTIONS cannot be suppressed through the config, so pool creation refuses it', () => {
    vi.stubEnv('PGOPTIONS', '-c statement_timeout=0');
    // The reason the refusal exists: node-postgres falls back to PGOPTIONS.
    expect(effective(LOOPBACK).options).toBe('-c statement_timeout=0');
    expect(() =>
      createKafuoGroundingPool(LOOPBACK, SETTINGS, () => undefined, {
        PGOPTIONS: '-c statement_timeout=0',
      }),
    ).toThrow(/KAFUO_GROUNDING_DATABASE_URL is refused: PGOPTIONS is set/);
    vi.unstubAllEnvs();
    expect(effective(LOOPBACK).options).toBeUndefined();
  });

  it('pool creation refuses a remote DSN without TLS, and never echoes the DSN', () => {
    let message = '';
    try {
      createKafuoGroundingPool(REMOTE, SETTINGS, () => undefined, {});
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/a non-loopback host needs sslmode=verify-full/);
    expect(message).not.toContain('s3cret');
    expect(message).not.toContain('kafuo-db.example.com');
  });

  it('getKafuoGroundingReader is undefined while refused (fail closed), logged once, re-checked before the cached reader', () => {
    const ok = { KAFUO_GROUNDING_DATABASE_URL: LOOPBACK };
    const withOptions = { ...ok, PGOPTIONS: '-c statement_timeout=0' };
    expect(getKafuoGroundingReader(withOptions)).toBeUndefined();
    expect(getKafuoGroundingReader(withOptions)).toBeUndefined();
    expect(getKafuoGroundingReader({ KAFUO_GROUNDING_DATABASE_URL: REMOTE })).toBeUndefined();
    const refusals = logs.lines.filter((line) => line.includes('tutor.grounding_reader_refused'));
    expect(refusals).toHaveLength(2);
    expect(logs.lines.join('\n')).not.toContain('s3cret');

    // Lazy: no connection is opened by creating the reader.
    const reader = getKafuoGroundingReader(ok);
    expect(reader).toBeInstanceOf(PgGroundingReader);
    expect(getKafuoGroundingReader(ok)).toBe(reader);
    expect(getKafuoGroundingReader(withOptions)).toBeUndefined();
  });
});
