/**
 * The pg grounding reader against a REAL Kafuo database, logged in as
 * `kafuo_grounding_reader` (discovery-first P6, §5.3–§5.5).
 *
 * Gate — BOTH must be set, and both name the same SCRATCH Kafuo database at
 * migration 294 (never a shared one; `PG_CONTRACT_URL` alone points other
 * suites at an OpenMAIC database, so it never enables this one):
 *  - `PG_CONTRACT_URL`: an admin DSN that writes the fixtures (committed, then
 *    deleted by id);
 *  - `KAFUO_GROUNDING_CONTRACT_READER_URL`: the reader's DSN. The reader gets
 *    LOGIN and a password ONLY inside the scratch setup (backend `chat_grounding`
 *    README, "P6"), and loses them afterwards.
 *
 * PGlite has neither pgvector nor roles, so this cannot run on it.
 *
 * The world is one tenant, one onboarded student, one offering and one LESSON
 * item with two approved units, a ready Discovery build and a ready embedding
 * run (4-dim vectors), plus one never-built item for the title probe. Match
 * keys and the scope hash are computed by Kafuo's own SQL
 * (`chat_grounding_private.normalize_ar_v2_tokens`, the P2 hash formula), so no
 * builder logic is reimplemented here.
 */
import { randomUUID } from 'node:crypto';

import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createKafuoGroundingPool,
  PgGroundingReader,
} from '@/lib/server/tutor/grounding/pg-grounding-reader';
import type {
  GroundingReaderScope,
  SearchUnitRow,
} from '@/lib/server/tutor/grounding/kafuo-grounding-reader';

const adminUrl = process.env.PG_CONTRACT_URL;
const readerUrl = process.env.KAFUO_GROUNDING_CONTRACT_READER_URL;
const enabled = Boolean(adminUrl && readerUrl);

const TITLE = 'التبرير الاستقرائي والتخمين';
const GLOSSARY = 'المثال المضاد';
const NEVER_BUILT_TITLE = 'الدوال الأسية والنمو';
const MODEL = 'text-embedding-3-small';
const VECTOR_A = [1, 0, 0, 0];
const VECTOR_B = [0, 1, 0, 0];
const QUERY = [1, 0.2, 0, 0];

interface World {
  tag: string;
  ids: Record<string, string>;
  unitIds: string[];
  scope: GroundingReaderScope;
}

describe.skipIf(!enabled)(
  'Kafuo grounding reader on a real database (as kafuo_grounding_reader)',
  () => {
    let admin: Pool;
    let pool: ReturnType<typeof createKafuoGroundingPool>;
    let reader: PgGroundingReader;
    let world: World;
    const POOL_MAX = 2;

    async function one(sql: string, values: unknown[] = []): Promise<string> {
      const result = await admin.query<{ id: string }>(sql, values);
      return String(result.rows[0]!.id);
    }

    async function buildWorld(): Promise<World> {
      const tag = randomUUID().replace(/-/g, '').slice(0, 10);
      const ids: Record<string, string> = {};
      ids.tenant = await one('INSERT INTO tenants (name_en) VALUES ($1) RETURNING id', [
        `p6-${tag}`,
      ]);
      ids.curriculum = await one(
        'INSERT INTO curriculums (tenant_id, code, name_en) VALUES ($1, $2, $3) RETURNING id',
        [ids.tenant, `P6-${tag}`, `p6-${tag}`],
      );
      ids.version = await one(
        "INSERT INTO curriculum_versions (curriculum_id, version_label) VALUES ($1, 'v1') RETURNING id",
        [ids.curriculum],
      );
      ids.stage = await one(
        "INSERT INTO stages (code, name_en) VALUES ($1, 'stage') RETURNING id",
        [`S${tag}`],
      );
      ids.level = await one(
        "INSERT INTO levels (stage_id, code, name_en) VALUES ($1, $2, 'grade') RETURNING id",
        [ids.stage, `G${tag}`],
      );
      ids.period = await one(
        "INSERT INTO academic_periods (code, name_en) VALUES ($1, 'term') RETURNING id",
        [`T${tag}`],
      );
      ids.offering = await one(
        'INSERT INTO subject_offerings (code, name_en, academic_period_id, curriculum_version_id, level_id) ' +
          "VALUES ($1, 'math', $2, $3, $4) RETURNING id",
        [`O${tag}`, ids.period, ids.version, ids.level],
      );
      ids.otherOffering = await one(
        'INSERT INTO subject_offerings (code, name_en, academic_period_id, curriculum_version_id, level_id) ' +
          "VALUES ($1, 'math', $2, $3, $4) RETURNING id",
        [
          `X${tag}`,
          ids.period,
          ids.version,
          await one(
            "INSERT INTO levels (stage_id, code, name_en) VALUES ($1, $2, 'grade') RETURNING id",
            [ids.stage, `H${tag}`],
          ),
        ],
      );
      ids.unit = await one(
        "INSERT INTO units (code, title, academic_period_id, subject_offering_id) VALUES ($1, 'unit', $2, $3) RETURNING id",
        [`U${tag}`, ids.period, ids.offering],
      );
      ids.student = await one(
        "INSERT INTO users (full_name, role, user_type, tenant_id) VALUES ('student', 'student', 'tenant', $1) RETURNING id",
        [ids.tenant],
      );
      await admin.query(
        'INSERT INTO auth_student_profiles (user_id, tenant_id, curriculum_id, curriculum_version_id, grade_level_id, onboarding_completed) ' +
          'VALUES ($1, $2, $3, $4, $5, TRUE)',
        [ids.student, ids.tenant, ids.curriculum, ids.version, ids.level],
      );
      const studentRef = `p6ref${tag}${randomUUID().slice(0, 8)}`;
      await admin.query(
        'INSERT INTO student_runtime_refs (tenant_id, student_user_id, student_ref) VALUES ($1, $2, $3)',
        [ids.tenant, ids.student, studentRef],
      );

      // The routable LESSON item (its own status 'draft': a LESSON publishes through its Lesson).
      ids.lesson = await one(
        "INSERT INTO lessons (unit_id, code, title, status) VALUES ($1, $2, $3, 'published') RETURNING id",
        [ids.unit, `L${tag}`, TITLE],
      );
      ids.item = await one(
        "INSERT INTO learning_items (unit_id, item_type, lesson_id, title, status, is_active) VALUES ($1, 'LESSON', $2, $3, 'draft', TRUE) RETURNING id",
        [ids.unit, ids.lesson, TITLE],
      );
      ids.source = await one(
        "INSERT INTO content_sources (lesson_id, type, uri, is_active) VALUES ($1, 'pdf', $2, TRUE) RETURNING id",
        [ids.lesson, `s3://fixture/p6/${tag}.pdf`],
      );
      ids.revision = await one(
        "INSERT INTO content_revisions (content_source_id, version, extracted_text, status, is_active, is_retrieval_ready) VALUES ($1, 1, 'text', 'approved', TRUE, TRUE) RETURNING id",
        [ids.source],
      );
      const unitIds: string[] = [];
      for (const [index, text] of [
        'المثال المضاد مثال واحد يبيّن أن التخمين خاطئ.',
        'التبرير الاستقرائي يبدأ من أمثلة.',
      ].entries()) {
        unitIds.push(
          await one(
            "INSERT INTO content_units (content_source_id, content_revision_id, order_index, title, text, review_status) VALUES ($1, $2, $3, $4, $5, 'approved') RETURNING id",
            [ids.source, ids.revision, (index + 1) * 10, `وحدة ${index + 1}`, text],
          ),
        );
      }

      // Discovery: state → building build → terms (keys by Kafuo SQL) → scope units → outputs → ready.
      const keySql = (param: string) =>
        `NULLIF(array_to_string(chat_grounding_private.normalize_ar_v2_tokens(CAST(${param} AS text)), ' '), '')`;
      await admin.query(
        `INSERT INTO learning_item_discovery_state (learning_item_id, tenant_id, item_type, subject_offering_id, normalized_title, state, reason_code, request_generation)
       VALUES ($1, $2, 'LESSON', $3, ${keySql('$4')}, 'not_built', 'never_built', 0)`,
        [ids.item, ids.tenant, ids.offering, TITLE],
      );
      ids.build = await one(
        `INSERT INTO learning_item_discovery_builds (learning_item_id, tenant_id, item_type, subject_offering_id, unit_id, curriculum_version_id, grade_id,
         request_generation, source_revision_id, source_fingerprint, source_snapshot, normalization_version, extractor_version, status)
       VALUES ($1, $2, 'LESSON', $3, $4, $5, $6, 0, $7, $8, '{}'::jsonb, 'p6-fixture', 'p6-fixture', 'building') RETURNING id`,
        [
          ids.item,
          ids.tenant,
          ids.offering,
          ids.unit,
          ids.version,
          ids.level,
          ids.revision,
          `fp-${tag}`,
        ],
      );
      await admin.query(
        `INSERT INTO learning_item_discovery_terms (build_id, learning_item_id, tenant_id, subject_offering_id, term_type, value, normalized_value, token_count, source_kind, status)
       SELECT $1, $2, $3, $4, x.term_type, x.value,
              array_to_string(chat_grounding_private.normalize_ar_v2_tokens(x.value), ' '),
              cardinality(chat_grounding_private.normalize_ar_v2_tokens(x.value)), x.source_kind, 'active'
         FROM (VALUES ('title', CAST($5 AS text), 'item_title'), ('glossary', CAST($6 AS text), 'definition_label')) AS x(term_type, value, source_kind)`,
        [ids.build, ids.item, ids.tenant, ids.offering, TITLE, GLOSSARY],
      );
      await admin.query(
        `INSERT INTO learning_item_discovery_scope_units (build_id, content_unit_id, content_revision_id)
       SELECT $1, cu.id, cu.content_revision_id FROM content_units cu WHERE cu.content_revision_id = $2 AND cu.review_status = 'approved'`,
        [ids.build, ids.revision],
      );
      await admin.query(
        `UPDATE learning_item_discovery_builds b
          SET search_tsv = setweight(to_tsvector('simple', coalesce(t.title_text, '')), 'A')
                        || setweight(to_tsvector('simple', coalesce(t.body_text, '')), 'B'),
              scope_units_hash = su.scope_hash,
              status = 'ready',
              completed_at = now()
         FROM (SELECT string_agg(normalized_value, ' ' ORDER BY id) FILTER (WHERE term_type = 'title') AS title_text,
                      string_agg(normalized_value, ' ' ORDER BY id) FILTER (WHERE term_type <> 'title') AS body_text
                 FROM learning_item_discovery_terms WHERE build_id = $1 AND status = 'active') t,
              (SELECT md5(coalesce(string_agg((content_unit_id)::text, ',' ORDER BY (content_unit_id)), '')) AS scope_hash
                 FROM learning_item_discovery_scope_units WHERE build_id = $1) su
        WHERE b.id = $1`,
        [ids.build],
      );
      await admin.query(
        `UPDATE learning_item_discovery_state SET state = 'ready', reason_code = NULL, active_build_id = $2, last_success_at = now(), updated_at = now()
        WHERE learning_item_id = $1`,
        [ids.item, ids.build],
      );

      // Retrieval rows (what the P5 dual-write produces): chunk run → embedding run → chunks → vectors.
      ids.chunkRun = await one(
        "INSERT INTO chunk_runs (content_source_id, revision_id, status, config_hash, is_active) VALUES ($1, $2, 'succeeded', $3, TRUE) RETURNING id",
        [ids.source, ids.revision, `cr-${tag}`],
      );
      ids.run = await one(
        `INSERT INTO embedding_runs (chunk_run_id, config_hash, config_snapshot, status, is_active, is_ready)
       VALUES ($1, $2, CAST($3 AS jsonb), 'succeeded', TRUE, TRUE) RETURNING id`,
        [
          ids.chunkRun,
          `er-${tag}`,
          JSON.stringify({ provider: 'openai', model: MODEL, dimensions: null }),
        ],
      );
      for (const [index, unitId] of unitIds.entries()) {
        const chunk = await one(
          "INSERT INTO chunks (chunk_run_id, content_source_id, revision_id, position, chunk_type, text, content_unit_id) VALUES ($1, $2, $3, $4, 'text', 'chunk', $5) RETURNING id",
          [ids.chunkRun, ids.source, ids.revision, index + 1, unitId],
        );
        await admin.query(
          `INSERT INTO chunk_embeddings (chunk_id, embedding_run_id, tenant_id, status, embedding_vector, embedding, embedding_dims, provider, model)
         VALUES ($1, $2, $3, 'succeeded', CAST($4 AS double precision[]), CAST(CAST($4 AS double precision[]) AS public.vector),
                 cardinality(CAST($4 AS double precision[])), 'openai', $5)`,
          [chunk, ids.run, ids.tenant, index === 0 ? VECTOR_A : VECTOR_B, MODEL],
        );
      }

      // A never-built eligible item: only the title probe can find it (index_not_ready).
      ids.lesson2 = await one(
        "INSERT INTO lessons (unit_id, code, title, status) VALUES ($1, $2, $3, 'published') RETURNING id",
        [ids.unit, `M${tag}`, NEVER_BUILT_TITLE],
      );
      ids.item2 = await one(
        "INSERT INTO learning_items (unit_id, item_type, lesson_id, title, status, is_active) VALUES ($1, 'LESSON', $2, $3, 'draft', TRUE) RETURNING id",
        [ids.unit, ids.lesson2, NEVER_BUILT_TITLE],
      );
      await admin.query(
        `INSERT INTO learning_item_discovery_state (learning_item_id, tenant_id, item_type, subject_offering_id, normalized_title, state, reason_code, request_generation)
       VALUES ($1, $2, 'LESSON', $3, ${keySql('$4')}, 'not_built', 'never_built', 0)`,
        [ids.item2, ids.tenant, ids.offering, NEVER_BUILT_TITLE],
      );

      return {
        tag,
        ids,
        unitIds,
        scope: { tenantId: ids.tenant, studentRef, subjectOfferingId: ids.offering },
      };
    }

    async function dropWorld(w: World): Promise<void> {
      const { ids } = w;
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        const del = (sql: string, values: unknown[]) => client.query(sql, values);
        await del('DELETE FROM chunk_embeddings WHERE embedding_run_id = $1', [ids.run]);
        await del('DELETE FROM chunks WHERE chunk_run_id = $1', [ids.chunkRun]);
        await del('DELETE FROM embedding_runs WHERE id = $1', [ids.run]);
        await del('DELETE FROM chunk_runs WHERE id = $1', [ids.chunkRun]);
        await del('DELETE FROM learning_items WHERE id = ANY($1::bigint[])', [
          [ids.item, ids.item2],
        ]);
        await del('DELETE FROM content_units WHERE content_revision_id = $1', [ids.revision]);
        await del('DELETE FROM content_revisions WHERE id = $1', [ids.revision]);
        await del('DELETE FROM content_sources WHERE id = $1', [ids.source]);
        await del('DELETE FROM lessons WHERE id = ANY($1::bigint[])', [[ids.lesson, ids.lesson2]]);
        await del('DELETE FROM units WHERE id = $1', [ids.unit]);
        await del('DELETE FROM student_runtime_refs WHERE tenant_id = $1', [ids.tenant]);
        await del('DELETE FROM auth_student_profiles WHERE user_id = $1', [ids.student]);
        await del('DELETE FROM users WHERE id = $1', [ids.student]);
        await del('DELETE FROM subject_offerings WHERE id = ANY($1::bigint[])', [
          [ids.offering, ids.otherOffering],
        ]);
        await del('DELETE FROM academic_periods WHERE id = $1', [ids.period]);
        await del('DELETE FROM levels WHERE stage_id = $1', [ids.stage]);
        await del('DELETE FROM stages WHERE id = $1', [ids.stage]);
        await del('DELETE FROM curriculum_versions WHERE id = $1', [ids.version]);
        await del('DELETE FROM curriculums WHERE id = $1', [ids.curriculum]);
        await del('DELETE FROM tenants WHERE id = $1', [ids.tenant]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    beforeAll(async () => {
      admin = new Pool({ connectionString: adminUrl, max: 2 });
      const present = await admin.query<{ ok: boolean }>(
        "SELECT to_regprocedure('grounding_read_v1.search_units(bigint, text, bigint, jsonb, real[], text, text, integer)') IS NOT NULL AS ok",
      );
      if (!present.rows[0]!.ok) {
        throw new Error(
          'PG_CONTRACT_URL is not a Kafuo scratch database at migration 293+ (grounding_read_v1.search_units missing)',
        );
      }
      world = await buildWorld();
      pool = createKafuoGroundingPool(
        readerUrl!,
        { max: POOL_MAX, admissionTimeoutMs: 2_000, idleTimeoutMs: 10_000, queryTimeoutMs: 5_000 },
        () => undefined,
      );
      reader = new PgGroundingReader({ pool, max: POOL_MAX });
    });

    afterAll(async () => {
      await reader?.end().catch(() => undefined);
      if (world) await dropWorld(world);
      await admin?.end();
    });

    it('logs in as the reader with the 294 role settings in force (the reader never sends them)', async () => {
      const client = new Client({ connectionString: readerUrl });
      await client.connect();
      try {
        const show = async (name: string) => (await client.query(`SHOW ${name}`)).rows[0]![name];
        expect((await client.query('SELECT current_user AS u')).rows[0]!.u).toBe(
          'kafuo_grounding_reader',
        );
        expect(await show('statement_timeout')).toBe('1500ms');
        expect(await show('default_transaction_read_only')).toBe('on');
        expect(await show('transaction_read_only')).toBe('on');
        expect(await show('idle_in_transaction_session_timeout')).toBe('5s');
        expect(await show('log_parameter_max_length')).toBe('0');
        expect(await show('log_parameter_max_length_on_error')).toBe('0');
        expect(await show('application_name')).toBe('te-grounding');
        // A write is impossible even where a privilege would allow it (TEMP is granted to PUBLIC).
        await expect(client.query('CREATE TEMP TABLE p6_probe (x int)')).rejects.toMatchObject({
          code: '25006',
        });
        // And no table is readable.
        await expect(
          client.query('SELECT 1 FROM public.content_units LIMIT 1'),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.end();
      }
    });

    it('resolve_items: single with its build id; refusals carry nothing; no_match; a never-built title is index_not_ready (build id NULL)', async () => {
      const single = await reader.resolveItems(world.scope, { text: `اشرحلي ${GLOSSARY}` });
      expect(single).toMatchObject({
        outcome: 'single',
        reasonCode: 'strong_match',
        indexCoverage: 'partial',
        candidates: [
          {
            learningItemId: world.ids.item,
            itemType: 'LESSON',
            title: TITLE,
            routable: true,
            buildId: world.ids.build,
            readiness: 'ready',
            matchSource: 'term',
          },
        ],
        poolWaitMs: expect.any(Number),
      });

      expect(
        await reader.resolveItems(
          { ...world.scope, studentRef: 'no-such-student-ref' },
          { text: GLOSSARY },
        ),
      ).toEqual({
        outcome: 'student_ref_unknown',
        poolWaitMs: expect.any(Number),
      });
      expect(
        await reader.resolveItems(
          { ...world.scope, subjectOfferingId: world.ids.otherOffering },
          { text: GLOSSARY },
        ),
      ).toEqual({ outcome: 'offering_not_permitted', poolWaitMs: expect.any(Number) });

      expect(await reader.probeItems(world.scope, { text: 'ما عاصمة فرنسا' })).toMatchObject({
        outcome: 'no_match',
        indexCoverage: 'partial',
      });

      const notReady = await reader.resolveItems(world.scope, {
        text: `اشرح ${NEVER_BUILT_TITLE}`,
      });
      expect(notReady).toMatchObject({
        outcome: 'index_not_ready',
        reasonCode: 'title_probe',
        candidates: [
          { learningItemId: world.ids.item2, routable: false, buildId: null, matchSource: 'title' },
        ],
      });
    });

    it('item_embedding_profile → search_units (bound to the run) → validate_units, as typed rows', async () => {
      const profile = await reader.itemEmbeddingProfile(world.scope, { itemIds: [world.ids.item] });
      expect(profile).toMatchObject({
        outcome: 'ok',
        items: [
          {
            outcome: 'ok',
            learningItemId: world.ids.item,
            buildId: world.ids.build,
            embeddingRunId: world.ids.run,
            provider: 'openai',
            model: MODEL,
            dims: 4,
          },
        ],
      });

      const searched = await reader.searchUnits(world.scope, {
        targets: [{ learningItemId: world.ids.item, embeddingRunId: world.ids.run }],
        query: QUERY,
        provider: 'openai',
        model: MODEL,
      });
      expect(searched.outcome).toBe('ok');
      const units = (searched as { units: SearchUnitRow[] }).units;
      expect(units.map((unit) => unit.contentUnitId)).toEqual(world.unitIds);
      expect(units[0]).toMatchObject({
        learningItemId: world.ids.item,
        itemType: 'LESSON',
        unitTitle: 'وحدة 1',
        buildId: world.ids.build,
        contentRevisionId: world.ids.revision,
      });
      expect(units[0]!.similarity).toBeGreaterThan(units[1]!.similarity);
      expect(units[0]!.unitUpdatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
      expect(units[0]!.charLength).toBe(units[0]!.text.length);

      // Provider/model must equal the run's: otherwise a mismatch and no rows.
      expect(
        await reader.searchUnits(world.scope, {
          targets: [{ learningItemId: world.ids.item, embeddingRunId: world.ids.run }],
          query: QUERY,
          provider: 'openai',
          model: 'text-embedding-3-large',
        }),
      ).toMatchObject({ outcome: 'embedding_profile_mismatch' });

      const refs = units.map((unit) => ({
        contentUnitId: unit.contentUnitId,
        learningItemId: unit.learningItemId,
        buildId: unit.buildId,
        contentRevisionId: unit.contentRevisionId,
        unitUpdatedAt: unit.unitUpdatedAt,
      }));
      expect(await reader.validateUnits(world.scope, { unitRefs: refs })).toMatchObject({
        outcome: 'ok',
        validUnitIds: [...world.unitIds].sort(),
      });
      // The second unit changes: it is no longer valid (D-17).
      await admin.query(
        "UPDATE content_units SET updated_at = now() + interval '1 second' WHERE id = $1",
        [world.unitIds[1]],
      );
      expect(await reader.validateUnits(world.scope, { unitRefs: refs })).toMatchObject({
        outcome: 'ok',
        validUnitIds: [world.unitIds[0]],
      });
    });

    it('under concurrent load the reader never holds more than POOL_MAX sessions and none sits idle in transaction', async () => {
      const counts: Array<{ total: number; idleInTx: number }> = [];
      const sample = async () => {
        const result = await admin.query<{ total: string; idle_in_tx: string }>(
          `SELECT count(*) AS total, count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx
           FROM pg_stat_activity WHERE usename = 'kafuo_grounding_reader' AND application_name = 'te-grounding'`,
        );
        counts.push({
          total: Number(result.rows[0]!.total),
          idleInTx: Number(result.rows[0]!.idle_in_tx),
        });
      };
      const calls = Array.from({ length: 12 }, (_, index) =>
        reader.resolveItems(world.scope, {
          text: index % 2 ? `اشرحلي ${GLOSSARY}` : 'ما عاصمة فرنسا',
        }),
      );
      const sampler = (async () => {
        for (let i = 0; i < 10; i += 1) {
          await sample();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();
      const results = await Promise.all(calls);
      await sampler;
      await sample();
      expect(
        results.every((r) => ['single', 'no_match', 'retrieval_busy'].includes(r.outcome)),
      ).toBe(true);
      expect(results.some((r) => r.outcome === 'retrieval_busy')).toBe(true);
      expect(Math.max(...counts.map((c) => c.total))).toBeLessThanOrEqual(POOL_MAX);
      expect(counts.every((c) => c.idleInTx === 0)).toBe(true);
      expect(reader.stats()).toMatchObject({ inFlight: 0, poolMax: POOL_MAX });
      expect(reader.stats().total).toBeLessThanOrEqual(POOL_MAX);
    });
  },
);
