/**
 * The S6 stage export (s6-s7-readiness §1.4 G0) on a real Postgres (PGlite) with the
 * Teaching Engine's own schema and a read-only session: the exact rows of a version's
 * stage, attempt and ledger, the two HTTP reads, the manifest, and the refusals.
 * Fixture rows only; no real lesson is read.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureGenerationUsageSchema } from '@/lib/persistence/generation-usage';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  ensureTeachingModelAttemptsSchema,
  insertStartedAttempt,
} from '@/lib/persistence/teaching-model-attempts';
import { ensureTeachingPackageSchema } from '@/lib/persistence/teaching-package';
import {
  collectS6StageExport,
  writeS6StageExport,
} from '@/lib/server/teaching-package/s6-stage-export';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) {
    return this.db.query<Row>(text, params);
  }
}

const NOW = 1_800_000_000;

async function seed(pool: PGlitePool): Promise<void> {
  await pool.query(
    `INSERT INTO document_stages (id, name, created_at, updated_at, data)
     VALUES ('stage-1', 'Lesson', 1, 1, '{"id":"stage-1"}'::jsonb)`,
  );
  await pool.query(`INSERT INTO stage_meta (stage_id, owner_id) VALUES ('stage-1', 'owner')
                    ON CONFLICT (stage_id) DO NOTHING`);
  await pool.query(
    `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES
       ('stage-1', 'scene_b', 2, '{"title":"Second"}'::jsonb),
       ('stage-1', 'scene_a', 1, '{"title":"First"}'::jsonb)`,
  );
  await pool.query(
    `INSERT INTO document_outlines (stage_id, data) VALUES ('stage-1', '[{"id":"outline-1"}]'::jsonb)`,
  );
  await pool.query(
    `INSERT INTO teaching_package_versions
       (id, tenant_id, learning_item_type, learning_item_id, version, status, current_stage_id,
        current_attempt_id, teaching_model_key, teaching_model_version, created_at, updated_at)
     VALUES ('tpv-1', 'tenant-1', 'lesson', '227', 1, 'draft', 'stage-1', NULL, 'g5', 'g5.v11', 1, 1)`,
  );
  await pool.query(
    `INSERT INTO teaching_package_generation_attempts
       (id, tenant_id, learning_item_type, learning_item_id, version_id, kind, status,
        requested_by_actor_ref, teaching_model_key, teaching_model_version, input_snapshot, created_at)
     VALUES ('tpa-orig', 'tenant-1', 'lesson', '227', 'tpv-1', 'initial', 'succeeded', 'actor',
             'g5', 'g5.v11', '{"policyVersion":"r1-2026-09"}'::jsonb, 1)`,
  );
  await pool.query(
    `UPDATE teaching_package_versions SET current_attempt_id = 'tpa-orig' WHERE id = 'tpv-1'`,
  );
  for (const [id, sceneId] of [
    ['tma-1', null],
    ['tma-2', 'scene_a'],
  ] as const) {
    await insertStartedAttempt(pool, {
      id,
      tenantId: 'tenant-1',
      capability: 'package_generation',
      subjectCode: 'CHEMISTRY',
      policyVersion: 'r1-2026-09',
      stage: sceneId ? 'scene-content:slide' : 'scene-outlines-stream',
      providerId: 'openai',
      modelId: 'gpt-6-luna',
      modelString: 'openai:gpt-6-luna',
      thinkingLabel: 'low',
      role: 'primary',
      attemptIndex: 1,
      origin: 'openmaic_runtime',
      association: {
        kind: 'generation',
        generationAttemptId: 'tpa-orig',
        ...(sceneId ? { sceneId } : {}),
      },
      workerId: 'w',
      startedAt: NOW + (sceneId ? 2 : 1),
    });
  }
  // Another tenant's row on the same attempt id is never exported.
  await insertStartedAttempt(pool, {
    id: 'tma-other',
    tenantId: 'tenant-2',
    capability: 'package_generation',
    subjectCode: 'MATH',
    policyVersion: 'r1-2026-09',
    stage: 'scene-actions',
    providerId: 'openai',
    modelId: 'gpt-6-luna',
    modelString: 'openai:gpt-6-luna',
    thinkingLabel: 'low',
    role: 'primary',
    attemptIndex: 1,
    origin: 'openmaic_runtime',
    association: { kind: 'generation', generationAttemptId: 'tpa-orig' },
    workerId: 'w',
    startedAt: NOW,
  });
}

describe('S6 stage export (read-only)', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let out: string;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
    await ensureTeachingModelAttemptsSchema(pool as never);
    await ensureGenerationUsageSchema(pool as never);
    await seed(pool);
    out = await fs.mkdtemp(path.join(os.tmpdir(), 's6-export-'));
  });

  afterEach(async () => {
    await db.close();
    await fs.rm(out, { recursive: true, force: true });
  });

  it('refuses a connection that is not read-only, before any read', async () => {
    const spy = vi.spyOn(pool, 'query');
    await expect(
      collectS6StageExport({
        queryable: pool,
        tenantId: 'tenant-1',
        versionId: 'tpv-1',
        teUrl: null,
        serviceKey: null,
      }),
    ).rejects.toThrow(/not read-only/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('exports the stage, attempt and tenant-scoped ledger rows, and the HTTP reads, under item/attempt', async () => {
    await pool.query('SET default_transaction_read_only = on');
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      expect(auth).toBe('Bearer svc-key');
      return url.includes('/agent-read/scenes')
        ? new Response(JSON.stringify({ scenes: [{ id: 'scene_a' }] }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 'TEACHING_PACKAGE_NOT_APPROVED' } }), {
            status: 409,
          });
    });
    const exported = await collectS6StageExport({
      queryable: pool,
      tenantId: 'tenant-1',
      versionId: 'tpv-1',
      teUrl: 'https://te.example.test/',
      serviceKey: 'svc-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-11-27T00:00:00Z'),
    });
    expect(exported).toMatchObject({
      learningItemId: '227',
      attemptId: 'tpa-orig',
      stageId: 'stage-1',
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://te.example.test/api/teaching-packages/tpv-1/agent-read/scenes?tenantId=tenant-1',
      'https://te.example.test/api/teaching-packages/tpv-1/outline?tenantId=tenant-1&learningItemType=lesson&learningItemId=227',
    ]);
    const scenes = exported.files['scenes.json'] as Array<{ id: string }>;
    expect(scenes.map((scene) => scene.id)).toEqual(['scene_a', 'scene_b']);
    const ledger = exported.files['ledger.json'] as Array<Record<string, unknown>>;
    expect(ledger.map((row) => [row.id, row.scene_id])).toEqual([
      ['tma-1', null],
      ['tma-2', 'scene_a'],
    ]);
    expect(ledger[0]).not.toHaveProperty('student_ref');
    expect(ledger[0]).not.toHaveProperty('turn_id');
    expect(exported.manifest).toMatchObject({
      readOnly: true,
      sceneCount: 2,
      ledgerRowCount: 2,
      http: { 'agent-read-scenes.json': 200, 'outline-http.json': 409 },
    });

    const { dir, files } = await writeS6StageExport(out, exported);
    expect(dir).toBe(path.join(out, '227', 'tpa-orig'));
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.files.map((file: { name: string }) => file.name)).toContain('attempt.json');
    for (const file of files) {
      const bytes = await fs.readFile(path.join(dir, file.name));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    expect(JSON.stringify(manifest)).not.toContain('svc-key');
    // Never overwritten: the same attempt again needs a label.
    await expect(writeS6StageExport(out, exported)).rejects.toThrow(/already exists/);
    const labelled = await writeS6StageExport(out, exported, { label: 'after-a1' });
    expect(labelled.dir).toBe(path.join(out, '227', 'tpa-orig__after-a1'));
  });

  it('skips the HTTP reads when asked and records it; another tenant sees nothing', async () => {
    await pool.query('SET default_transaction_read_only = on');
    const exported = await collectS6StageExport({
      queryable: pool,
      tenantId: 'tenant-1',
      versionId: 'tpv-1',
      teUrl: null,
      serviceKey: null,
    });
    expect(exported.manifest.http).toEqual({
      'agent-read-scenes.json': 'skipped',
      'outline-http.json': 'skipped',
    });
    await expect(
      collectS6StageExport({
        queryable: pool,
        tenantId: 'tenant-2',
        versionId: 'tpv-1',
        teUrl: null,
        serviceKey: null,
      }),
    ).rejects.toThrow(/not found/);
  });
});
