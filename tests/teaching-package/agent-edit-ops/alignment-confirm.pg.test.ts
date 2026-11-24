/**
 * Wave F2.5 (A8) and F2.6 over PGlite, through the real `agent-ops/alignment-confirm`
 * route and `agent-read/scenes`: the agent confirms a slide only when its own op made it
 * stale (R-H1: compared without narration audio; R-H2: aligned before; insertion
 * neighbours never), and the read's `alignment.confirmable_by_agent` is the same proof.
 * Plus R-H4: an existing database with the old agent-ops CHECK is widened in place.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppScene } from '@/lib/types/stage';
import {
  AGENT,
  body,
  PGlitePool,
  setupHarness,
  STAGE,
  textSlide,
  VERSION,
  TENANT,
  type Harness,
} from './_pg';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

async function editText(harness: Harness, sceneId: string, text: string) {
  const response = await harness.post('text-element', {
    expectedRevision: await harness.revision(),
    sceneId,
    elementId: `${sceneId}-text`,
    text,
  });
  expect(response.status).toBe(200);
}

async function confirm(harness: Harness, sceneId: string, extra: Record<string, unknown> = {}) {
  return harness.post('alignment-confirm', {
    expectedRevision: await harness.revision(),
    sceneId,
    reason: 'the agent rewrote this slide’s text; the teaching skill still fits',
    ...extra,
  });
}

async function readAlignment(harness: Harness, sceneId: string) {
  const read = await harness.read();
  return read.scenes.find((scene) => scene.scene_id === sceneId)!.alignment as Record<
    string,
    unknown
  >;
}

async function insertRegeneration(
  harness: Harness,
  input: { sceneId: string; actorRef: string; previous: AppScene; result: AppScene; at: number },
) {
  await harness.pool.query(
    `INSERT INTO teaching_package_scene_regenerations
       (id, tenant_id, version_id, stage_id, scene_id, scene_order, idempotency_key,
        request_digest, instruction, reason, actor_ref, status, attempt_token, lease_expires_at,
        base_scene_rev, previous_scene, result_scene, result_scene_rev, requested_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, 1, $1, 'd', 'narration only', 'r', $6, 'succeeded', 't', 0,
             1, $7::jsonb, $8::jsonb, 2, $9, $9)`,
    [
      `rg-${input.at}`,
      TENANT,
      VERSION,
      STAGE,
      input.sceneId,
      input.actorRef,
      JSON.stringify(input.previous),
      JSON.stringify(input.result),
      input.at,
    ],
  );
}

describe('agent-ops alignment-confirm (A8)', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.pool.end();
    vi.unstubAllEnvs();
  });

  it('confirms a slide the agent’s own edit made stale, under its revision, with the reason', async () => {
    harness = await setupHarness({ scenes: [textSlide('s1', 1)], governed: true });
    expect(await readAlignment(harness, 's1')).toMatchObject({
      state: 'current',
      confirmable_by_agent: false,
    });
    await editText(harness, 's1', 'نص جديد');
    expect(await readAlignment(harness, 's1')).toEqual({
      state: 'stale',
      reason: 'material-change',
      confirmable_by_agent: true,
    });
    const dry = await confirm(harness, 's1', { dryRun: true });
    expect(await body(dry)).toMatchObject({ dryRun: true, status: 'would_confirm', proof: 'edit' });

    const response = await confirm(harness, 's1', { idempotencyKey: 'agt_3_confirm_0001' });
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ status: 'done', sceneId: 's1', proof: 'edit' });
    const scene = await harness.scene('s1');
    expect(scene.alignmentBaseline).toMatchObject({
      origin: 'reviewer-confirmation',
      actorRef: AGENT,
    });
    expect(await readAlignment(harness, 's1')).toMatchObject({ state: 'confirmed' });
    const row = (
      await harness.pool.query(
        `SELECT result FROM teaching_package_agent_ops WHERE op = 'alignment-confirm'`,
      )
    ).rows[0] as { result: Record<string, unknown> };
    expect(row.result.reason).toContain('the agent rewrote');
    // A retry by the key answers done before the revision check its write moved.
    const retry = await harness.post('alignment-confirm', {
      expectedRevision: 0,
      sceneId: 's1',
      reason: 'the agent rewrote this slide’s text; the teaching skill still fits',
      idempotencyKey: 'agt_3_confirm_0001',
    });
    expect(await body(retry)).toMatchObject({ status: 'done', replayed: true });
  });

  it('two agent edits in a row stay confirmable; narration audio written after still matches (R-H1)', async () => {
    harness = await setupHarness({ scenes: [textSlide('s1', 1)], governed: true });
    await editText(harness, 's1', 'نص أول');
    await editText(harness, 's1', 'نص ثان');
    // Someone voices the slide afterwards: only audio ids change.
    const voiced = await harness.scene('s1');
    await harness.teacherPut({
      ...voiced,
      actions: (voiced.actions ?? []).map((action) => ({ ...action, audioId: 'aud-later' })),
    } as AppScene);
    expect((await readAlignment(harness, 's1')).confirmable_by_agent).toBe(true);
    expect((await confirm(harness, 's1')).status).toBe(200);
  });

  it('refuses a slide the teacher changed, one edited after the agent, and one stale before', async () => {
    harness = await setupHarness({
      scenes: [textSlide('s1', 1), textSlide('s2', 2), textSlide('s3', 3)],
      governed: true,
      staleSceneIds: ['s3'],
    });
    // s1: only the teacher changed it.
    const s1 = await harness.scene('s1');
    await harness.teacherPut({ ...s1, title: 'teacher title' } as AppScene);
    // s2: the agent, then the teacher.
    await editText(harness, 's2', 'نص الوكيل');
    const s2 = await harness.scene('s2');
    await harness.teacherPut({ ...s2, title: 'teacher after agent' } as AppScene);
    // s3: stale before the agent touched it.
    await editText(harness, 's3', 'نص الوكيل');

    const reasons: Record<string, unknown> = {};
    for (const sceneId of ['s1', 's2', 's3']) {
      const response = await confirm(harness, sceneId);
      expect(response.status).toBe(422);
      const refusal = await body(response);
      expect(refusal.error.code).toBe('STALE_NOT_BY_AGENT');
      reasons[sceneId] = refusal.error.details.reason;
      expect((await readAlignment(harness, sceneId)).confirmable_by_agent).toBe(false);
    }
    expect(reasons).toEqual({ s1: 'no-agent-op', s2: 'edited-since', s3: 'stale-before' });
    expect(
      await harness.count(
        `SELECT count(*) AS n FROM teaching_package_agent_ops WHERE op = 'alignment-confirm'`,
      ),
    ).toBe(0);
  });

  it('an agent regeneration row is a proof (narration-only included); a teacher’s is not', async () => {
    harness = await setupHarness({
      scenes: [textSlide('s1', 1), textSlide('s2', 2)],
      governed: true,
    });
    for (const [sceneId, actorRef] of [
      ['s1', AGENT],
      ['s2', 'editor:teacher-1'],
    ] as const) {
      const previous = await harness.scene(sceneId);
      const result = {
        ...previous,
        actions: (previous.actions ?? []).map((action) => ({ ...action, text: 'طيب نص مختلف' })),
      } as AppScene;
      await harness.teacherPut(result);
      await insertRegeneration(harness, { sceneId, actorRef, previous, result, at: Date.now() });
    }
    expect((await confirm(harness, 's1')).status).toBe(200);
    const refused = await confirm(harness, 's2');
    expect((await body(refused)).error.details.reason).toBe('last-write-not-agent');
  });

  it('a slide an insertion moved after the agent’s op is not confirmable (R-H2)', async () => {
    harness = await setupHarness({ scenes: [textSlide('s1', 1)], governed: true });
    await editText(harness, 's1', 'نص الوكيل');
    const at = Date.now() + 10_000;
    await harness.pool.query(
      `INSERT INTO teaching_package_scene_insertions
         (id, tenant_id, version_id, stage_id, new_scene_id, new_outline_id, unit_ids,
          teaching_stage, idempotency_key, request_digest, reason, actor_ref, status,
          attempt_token, lease_expires_at, scene_rev_transitions, requested_at, completed_at)
       VALUES ('in-1', $1, $2, $3, 's-new', 'o-new', '[]'::jsonb, '{}'::jsonb, 'k', 'd', 'r',
               $4, 'succeeded', 't', 0, $5::jsonb, $6, $6)`,
      [TENANT, VERSION, STAGE, AGENT, JSON.stringify({ s1: { before: 2, after: 3 } }), at],
    );
    expect((await readAlignment(harness, 's1')).confirmable_by_agent).toBe(false);
    expect((await body(await confirm(harness, 's1'))).error.details.reason).toBe(
      'last-write-not-agent',
    );
  });

  it('a stale revision is 409 and an aligned slide is answered without a write', async () => {
    harness = await setupHarness({ scenes: [textSlide('s1', 1)], governed: true });
    const stale = await harness.post('alignment-confirm', {
      expectedRevision: (await harness.revision()) + 1,
      sceneId: 's1',
      reason: 'r',
    });
    expect(stale.status).toBe(409);
    const aligned = await confirm(harness, 's1');
    expect(await body(aligned)).toMatchObject({ status: 'done', alreadyAligned: true });
    expect(await harness.count('SELECT count(*) AS n FROM teaching_package_agent_ops')).toBe(0);
  });
});

describe('R-H4: the agent-ops table of an existing database', () => {
  it('widens the old op CHECK and adds the proof columns, idempotently', async () => {
    const db = new PGlite();
    await db.waitReady;
    const pool = new PGlitePool(db);
    try {
      // The E3 shape, as production created it (CREATE TABLE IF NOT EXISTS keeps it).
      await pool.query(`CREATE TABLE teaching_package_agent_ops (
        tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
        version_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('delete','narration-audio','link-dry-run')),
        scene_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','done')),
        result JSONB,
        lease_until DOUBLE PRECISION,
        created_at DOUBLE PRECISION NOT NULL,
        updated_at DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (version_id, op, idempotency_key)
      )`);
      await pool.query(
        `INSERT INTO teaching_package_agent_ops VALUES
           ('t', 'v', 'k0', 'delete', 's', 'd', 'done', NULL, NULL, 1, 1)`,
      );
      const { ensureTeachingPackageSchema } = await import('@/lib/persistence/teaching-package');
      const { ensureDocumentSchema, ensureStageMetaSchema } = await import('../helpers');
      await ensureDocumentSchema(pool as never);
      await ensureStageMetaSchema(pool as never);
      await ensureTeachingPackageSchema(pool as never);
      await ensureTeachingPackageSchema(pool as never);
      const { recordEditInTransaction, listAgentEditRows } =
        await import('@/lib/server/teaching-package/agent-op-records');
      await recordEditInTransaction(pool as never, {
        tenantId: 't',
        versionId: 'v',
        idempotencyKey: 'k1',
        sceneId: 's',
        requestDigest: 'd',
        now: 2,
        op: 'text-element',
        actorRef: AGENT,
        resultSceneRev: 3,
        resultFingerprint: 'f'.repeat(64),
        alignedBefore: true,
        result: {},
      });
      expect(await listAgentEditRows(pool as never, 'v')).toEqual([
        {
          op: 'text-element',
          sceneId: 's',
          actorRef: AGENT,
          at: 2,
          resultSceneRev: 3,
          resultFingerprint: 'f'.repeat(64),
          alignedBefore: true,
        },
      ]);
      await expect(
        pool.query(
          `INSERT INTO teaching_package_agent_ops VALUES
             ('t', 'v', 'k2', 'publish', 's', 'd', 'done', NULL, NULL, 1, 1)`,
        ),
      ).rejects.toThrow();
      // The old row survived.
      expect(
        (await pool.query(`SELECT count(*) AS n FROM teaching_package_agent_ops`)).rows,
      ).toEqual([{ n: 2 }]);
    } finally {
      await pool.end();
    }
  });
});
