/**
 * Teaching Skills governance marker + snapshot lineage (Module 2 W6 — teaching-
 * skills plan §P Step 7, §B.12/§B.13/§F/§M).
 *
 * The durable legacy-vs-Module-2 discriminator: two additive nullable columns
 * on `teaching_package_generation_attempts`, persisted from the request marker
 * (NULL ⇒ legacy, never inferred), policy lineage riding the existing
 * `input_snapshot` JSONB beside `teachingFlow`, and the companion governance
 * read beside `readFlowForVersion` over the same predecessor walk — so all
 * three legacy tiers resolve and a cloned successor inherits governance exactly
 * as it inherits flow (AC-TS-034, VAL-TS-006/022).
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDocumentSchema, splitSqlStatements } from '@openmaic/storage/document/pg';

import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
} from '@/lib/persistence/teaching-package';
import {
  TEACHING_SKILLS_CONTRACT_V1,
  buildKafuoStartRequest,
  parseKafuoGenerationRequest,
} from '@/lib/server/teaching-package/kafuo-request';
import { computeSkillPolicyDigest } from '@/lib/server/teaching-package/skill-policy';
import { readTeachingSkillsGovernanceForVersion } from '@/lib/server/teaching-package/exact-flow';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { GenerationInputSnapshot, TeachingFlowEntry } from '@/lib/types/teaching-package';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) {
    return this.db.query<T>(text, params);
  }

  async end() {
    await this.db.close();
  }
}

async function seedStageRow(pool: PGlitePool, stageId: string): Promise<void> {
  await pool.query(
    `INSERT INTO document_stages (id, name, created_at, updated_at, data)
     VALUES ($1, 'seed stage', 1, 1, '{}'::jsonb)`,
    [stageId],
  );
}

function snapshot(teachingFlow?: TeachingFlowEntry[]): GenerationInputSnapshot {
  return {
    learningItem: { type: 'lesson', id: 'li-governance' },
    teachingModel: { key: 'g5', version: 'g5.v1' },
    learningObjectives: [],
    contentUnitRefs: [],
    sourceRefs: [],
    generationContext: {},
    generationOptions: {},
    requirementDigest: '0'.repeat(64),
    requirementPreview: 'preview',
    pdfContentSummary: null,
    requestedAt: 1,
    ...(teachingFlow ? { teachingFlow } : {}),
  };
}

const governedPolicy = {
  required: [],
  preferred: [{ skillId: 'feynman-learning', version: 'v1' }],
  allowed: [
    { skillId: 'feynman-learning', version: 'v1' },
    { skillId: 'learning-to-learn', version: 'v1' },
  ],
  combinationRestrictions: [],
};

const governedFlow: TeachingFlowEntry[] = [
  { stage: 'lesson_introduction', instructions: 'i', skillPolicy: governedPolicy },
  { stage: 'outcome_teaching_cards', instructions: 'c', skillPolicy: governedPolicy },
];

/** The pre-W6 attempts table exactly as an already-populated database holds it. */
const PRE_W6_ATTEMPTS_TABLE = `
CREATE TABLE IF NOT EXISTS teaching_package_generation_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) > 0),
  learning_item_type TEXT NOT NULL CHECK (learning_item_type IN ('lesson','section')),
  learning_item_id TEXT NOT NULL,
  version_id TEXT REFERENCES teaching_package_versions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('initial','regeneration')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  request_id TEXT,
  request_digest TEXT,
  generation_runs INTEGER NOT NULL DEFAULT 0,
  requested_by_actor_ref TEXT NOT NULL,
  teaching_model_key TEXT NOT NULL,
  teaching_model_version TEXT NOT NULL,
  input_snapshot JSONB NOT NULL,
  produced_stage_id TEXT,
  stage_id TEXT REFERENCES document_stages(id) ON DELETE SET NULL,
  displaced_at DOUBLE PRECISION,
  stage_released_at DOUBLE PRECISION,
  progress JSONB,
  error TEXT,
  error_code TEXT,
  error_retryable BOOLEAN,
  created_at DOUBLE PRECISION NOT NULL,
  started_at DOUBLE PRECISION,
  completed_at DOUBLE PRECISION
);
`;

describe('teaching skills governance — persistence', () => {
  let pool: PGlitePool;
  const qp = () => pool as never;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await ensureTeachingPackageSchema(qp());
  });

  afterEach(async () => {
    await pool.end();
  });

  it('evolves a populated pre-W6 database: additive nullable columns, no backfill, idempotent', async () => {
    const db = new PGlite();
    await db.waitReady;
    const oldPool = new PGlitePool(db);
    const oldQp = () => oldPool as never;
    await ensureDocumentSchema(oldQp());
    await ensureStageMetaSchema(oldQp());
    await ensureTeachingPackageSchema(oldQp());
    // Then REPLACE the attempts table with its pre-W6 shape (the FK to
    // teaching_package_versions stays satisfied) and seed a legacy row.
    // source_contexts holds an FK to attempts; drop both, ensure recreates them.
    await oldPool.query(`DROP TABLE teaching_package_source_contexts`);
    await oldPool.query(`DROP TABLE teaching_package_generation_attempts`);
    for (const statement of splitSqlStatements(PRE_W6_ATTEMPTS_TABLE)) {
      await oldPool.query(statement);
    }
    await seedStageRow(oldPool, 'stage-pre-w6');
    await oldPool.query(
      `INSERT INTO teaching_package_generation_attempts
         (id, tenant_id, learning_item_type, learning_item_id, kind, status,
          requested_by_actor_ref, teaching_model_key, teaching_model_version,
          input_snapshot, created_at)
       VALUES ('tpa-pre-w6', '__legacy__', 'lesson', 'li-old', 'initial', 'failed',
               'actor', 'g5', 'g5.v1', '{}'::jsonb, 1)`,
    );

    await expect(ensureTeachingPackageSchema(oldQp())).resolves.toBeUndefined();
    await expect(ensureTeachingPackageSchema(oldQp())).resolves.toBeUndefined();

    const columns = await oldPool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'teaching_package_generation_attempts'
          AND column_name IN ('teaching_skills_contract', 'skill_policy_digest')`,
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      'skill_policy_digest',
      'teaching_skills_contract',
    ]);
    expect(columns.rows.every((row) => row.is_nullable === 'YES')).toBe(true);

    // No backfill: the pre-existing attempt stays legacy — NULL IS the marker
    // (AC-TS-034; inferring one would fabricate governance history).
    const legacy = await oldPool.query<{
      teaching_skills_contract: string | null;
      skill_policy_digest: string | null;
    }>(
      `SELECT teaching_skills_contract, skill_policy_digest
         FROM teaching_package_generation_attempts WHERE id = 'tpa-pre-w6'`,
    );
    expect(legacy.rows[0]).toEqual({
      teaching_skills_contract: null,
      skill_policy_digest: null,
    });
    await oldPool.end();
  });

  it('persists the marker and policy digest from the request, null for legacy', async () => {
    await seedStageRow(pool, 'stage-governed');
    const governed = await insertAttempt(qp(), {
      id: 'tpa-governed',
      aggregate: { tenantId: 't-1', learningItem: { type: 'lesson', id: 'li-governance' } },
      kind: 'initial',
      status: 'queued',
      requestedByActorRef: 'a',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: snapshot(governedFlow),
      teachingSkillsContract: TEACHING_SKILLS_CONTRACT_V1,
      skillPolicyDigest: computeSkillPolicyDigest(governedFlow),
      now: 1,
    });
    expect(governed.teachingSkillsContract).toBe('kafuo.teaching-skills.v1');
    expect(governed.skillPolicyDigest).toMatch(/^[0-9a-f]{64}$/);

    const legacy = await insertAttempt(qp(), {
      id: 'tpa-legacy',
      aggregate: { tenantId: 't-1', learningItem: { type: 'lesson', id: 'li-legacy' } },
      kind: 'initial',
      status: 'queued',
      requestedByActorRef: 'a',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      inputSnapshot: snapshot(),
      now: 2,
    });
    expect(legacy.teachingSkillsContract).toBeNull();
    expect(legacy.skillPolicyDigest).toBeNull();
  });

  it('keeps a governed snapshot secret-free (assertSnapshotPersistable passes on insert)', async () => {
    // The insert above already proves the governed snapshot — contract marker,
    // policy digest, and policies inside teachingFlow (identifiers and versions
    // only) — clears the secrecy rules. This pins the snapshot SHAPE: no URL,
    // no credential-shaped key anywhere in the persisted payload.
    const governedSnapshot = snapshot(governedFlow);
    governedSnapshot.teachingSkillsContract = TEACHING_SKILLS_CONTRACT_V1;
    governedSnapshot.skillPolicyDigest = computeSkillPolicyDigest(governedFlow);
    const serialized = JSON.stringify(governedSnapshot);
    // No retrieval URL of any shape, and no URL-valued field, anywhere in the
    // persisted payload (the real gate checks generationContext key names and
    // credential-bearing URL values; this pin is the whole-payload view).
    expect(serialized).not.toMatch(/:\/\/|"[^"]*[Uu]rl"\s*:/);
  });
});

describe('readTeachingSkillsGovernanceForVersion — the three legacy tiers', () => {
  let pool: PGlitePool;
  const qp = () => pool as never;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureDocumentSchema(qp());
    await ensureStageMetaSchema(qp());
    await ensureTeachingPackageSchema(qp());
  });

  afterEach(async () => {
    await pool.end();
  });

  async function seedVersionWithAttempt(options: {
    versionId: string;
    attemptId: string | null;
    contract?: string | null;
    policyDigest?: string | null;
    flow?: TeachingFlowEntry[] | null;
    predecessor?: string | null;
  }): Promise<void> {
    await seedStageRow(pool, `stage-${options.versionId}`);
    await insertVersion(qp(), {
      id: options.versionId,
      aggregate: { tenantId: 't-1', learningItem: { type: 'lesson', id: 'li-tier' } },
      version: 1,
      status: 'approved',
      currentStageId: `stage-${options.versionId}`,
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 1,
    });
    if (options.predecessor) {
      await pool.query(
        `UPDATE teaching_package_versions SET predecessor_version_id = $1 WHERE id = $2`,
        [options.predecessor, options.versionId],
      );
    }
    if (options.attemptId) {
      await insertAttempt(qp(), {
        id: options.attemptId,
        aggregate: { tenantId: 't-1', learningItem: { type: 'lesson', id: 'li-tier' } },
        kind: 'initial',
        status: 'succeeded',
        requestedByActorRef: 'a',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        inputSnapshot: snapshot(options.flow ?? undefined),
        ...(options.contract ? { teachingSkillsContract: options.contract } : {}),
        ...(options.policyDigest ? { skillPolicyDigest: options.policyDigest } : {}),
        now: 1,
      });
      await pool.query(
        `UPDATE teaching_package_versions SET current_attempt_id = $1 WHERE id = $2`,
        [options.attemptId, options.versionId],
      );
    }
  }

  it('tier A — no reachable attempt anywhere: null (pre-Kafuo; both gates skip)', async () => {
    await seedVersionWithAttempt({ versionId: 'tpv-tier-a', attemptId: null });
    expect(await readTeachingSkillsGovernanceForVersion(qp(), 'tpv-tier-a')).toBeNull();
  });

  it('tier B — attempt with flow but no marker: contract null, a DIFFERENT state from tier A', async () => {
    await seedVersionWithAttempt({
      versionId: 'tpv-tier-b',
      attemptId: 'tpa-tier-b',
      contract: null,
      flow: [{ stage: 'lesson_introduction', instructions: 'i' }],
    });
    expect(await readTeachingSkillsGovernanceForVersion(qp(), 'tpv-tier-b')).toEqual({
      contract: null,
      policyDigest: null,
    });
  });

  it('tier C — flow and marker: the governed state', async () => {
    await seedVersionWithAttempt({
      versionId: 'tpv-tier-c',
      attemptId: 'tpa-tier-c',
      contract: TEACHING_SKILLS_CONTRACT_V1,
      policyDigest: 'a'.repeat(64),
      flow: governedFlow,
    });
    expect(await readTeachingSkillsGovernanceForVersion(qp(), 'tpv-tier-c')).toEqual({
      contract: 'kafuo.teaching-skills.v1',
      policyDigest: 'a'.repeat(64),
    });
  });

  it('a cloned successor inherits governance through the predecessor walk, like flow', async () => {
    await seedVersionWithAttempt({
      versionId: 'tpv-c-predecessor',
      attemptId: 'tpa-c-predecessor',
      contract: TEACHING_SKILLS_CONTRACT_V1,
      policyDigest: 'b'.repeat(64),
      flow: governedFlow,
    });
    // The successor is clone-only: currentAttemptId NULL, predecessor set.
    await seedStageRow(pool, 'stage-tpv-c-successor');
    await insertVersion(qp(), {
      id: 'tpv-c-successor',
      aggregate: { tenantId: 't-1', learningItem: { type: 'lesson', id: 'li-tier' } },
      version: 2,
      status: 'draft',
      currentStageId: 'stage-tpv-c-successor',
      teachingModel: { key: 'g5', version: 'g5.v1' },
      now: 2,
      predecessorVersionId: 'tpv-c-predecessor',
    });
    expect(await readTeachingSkillsGovernanceForVersion(qp(), 'tpv-c-successor')).toEqual({
      contract: 'kafuo.teaching-skills.v1',
      policyDigest: 'b'.repeat(64),
    });
  });
});

describe('governance marker — parsed once at the single detection point', () => {
  const governedBody = () => ({
    requestId: 'req-1',
    tenantContext: { tenantId: 'tenant-1' },
    actorRef: '42',
    learningItem: {
      type: 'lesson',
      id: '901',
      title: 'Photosynthesis',
      unit: { id: '12', title: 'Unit 3' },
      curriculum: { id: '5', name: 'Science 5' },
      curriculumVersion: { id: '8', versionLabel: '2026-A' },
      language: 'ar',
    },
    learningObjectives: [
      { objectiveRef: '7001', snapshot: { statement: 'Explain photosynthesis.' } },
    ],
    teachingModel: {
      key: 'g5',
      version: 'g5.v1',
      flow: governedFlow.map((entry) => ({
        stage: entry.stage,
        instructions: entry.instructions,
        skillPolicy: entry.skillPolicy,
      })),
    },
    contentResource: {
      id: 'cs-1',
      mimeType: 'application/pdf',
      url: 'https://r2.example.test/lesson.pdf?X-Amz-Signature=abc',
    },
    generation: {},
    teachingSkills: TEACHING_SKILLS_CONTRACT_V1,
  });

  it('carries the marker onto the parsed request and the start/execution contexts', () => {
    const { request, aggregate } = parseKafuoGenerationRequest(governedBody());
    expect(request.teachingSkillsContract).toBe('kafuo.teaching-skills.v1');
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(start.teachingSkillsContract).toBe('kafuo.teaching-skills.v1');
    expect(start.skillPolicyDigest).toBe(computeSkillPolicyDigest(request.teachingModel.flow));
    expect(kafuo.teachingSkillsContract).toBe('kafuo.teaching-skills.v1');
  });

  it('a genuinely pre-Module-2 request stays legacy: no marker, no policy, no digest', () => {
    const raw = governedBody() as Record<string, unknown>;
    delete raw.teachingSkills;
    const teachingModel = raw.teachingModel as Record<string, unknown>;
    teachingModel.flow = (teachingModel.flow as Array<Record<string, unknown>>).map((entry) => {
      const legacy = { stage: entry.stage, instructions: entry.instructions };
      return legacy;
    });
    const { request, aggregate } = parseKafuoGenerationRequest(raw);
    expect(request.teachingSkillsContract).toBeUndefined();
    expect(request.teachingModel.flow.every((entry) => entry.skillPolicy === undefined)).toBe(true);
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(start.teachingSkillsContract).toBeNull();
    expect(start.skillPolicyDigest).toBeNull();
    expect(kafuo.teachingSkillsContract).toBeNull();
  });

  it('a marker-less request that still carries policy is LEGACY, never inferred governed (§M)', () => {
    // The transitional Kafuo shape: policy is projected from the frozen stages
    // whenever they declare it, while the governance flag stays off — so the
    // wire legitimately carries policy without the marker. The marker, not
    // policy presence, declares governance: mode stays legacy; the policy
    // digest is still computed as lineage evidence, and the contract column
    // stays NULL so the attempt resolves as tier B, never tier C.
    const raw = governedBody() as Record<string, unknown>;
    delete raw.teachingSkills;
    const { request, aggregate } = parseKafuoGenerationRequest(raw);
    expect(request.teachingSkillsContract).toBeUndefined();
    const { start, kafuo } = buildKafuoStartRequest(request, aggregate);
    expect(start.teachingSkillsContract).toBeNull();
    expect(start.skillPolicyDigest).toBe(computeSkillPolicyDigest(request.teachingModel.flow));
    expect(kafuo.teachingSkillsContract).toBeNull();
  });

  it('refuses an unknown or malformed contract string instead of ignoring it', () => {
    for (const bad of ['kafuo.teaching-skills.v2', '', 7]) {
      const raw = governedBody() as Record<string, unknown>;
      raw.teachingSkills = bad;
      expect(() => parseKafuoGenerationRequest(raw)).toThrowError(
        expect.objectContaining({ code: 'INVALID_REQUEST' }),
      );
    }
  });
});

describe('computeSkillPolicyDigest — lineage evidence, not the mode', () => {
  it('is null for a policy-free flow', () => {
    expect(computeSkillPolicyDigest([{ stage: 's', instructions: 'i' }])).toBeNull();
  });

  it('is deterministic and policy-sensitive', () => {
    const first = computeSkillPolicyDigest(governedFlow);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(computeSkillPolicyDigest(governedFlow)).toBe(first);
    const changed: TeachingFlowEntry[] = [
      {
        stage: 'lesson_introduction',
        instructions: 'i',
        skillPolicy: {
          ...governedPolicy,
          preferred: [{ skillId: 'learning-to-learn', version: 'v1' }],
        },
      },
      { stage: 'outcome_teaching_cards', instructions: 'c', skillPolicy: governedPolicy },
    ];
    expect(computeSkillPolicyDigest(changed)).not.toBe(first);
  });
});

describe('error vocabulary completeness (W5/W6 codes)', () => {
  it('SKILL_POLICY_REQUIRED, SKILL_POLICY_INVALID, SKILL_NOT_FOUND, SKILL_VERSION_UNRESOLVED carry their §J statuses', () => {
    const expected: Array<[string, number]> = [
      ['SKILL_POLICY_REQUIRED', 400],
      ['SKILL_POLICY_INVALID', 422],
      ['SKILL_NOT_FOUND', 422],
      ['SKILL_VERSION_UNRESOLVED', 422],
      ['SKILL_LINEAGE_UNRESOLVABLE', 409],
    ];
    for (const [code, status] of expected) {
      const error = new TeachingPackageError(code as never, 'vocabulary probe');
      expect(error.status, code).toBe(status);
    }
  });
});
