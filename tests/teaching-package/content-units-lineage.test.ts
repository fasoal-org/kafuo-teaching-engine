/**
 * Kafuo R1 P4 — Content Unit lineage (plan §8.3, F7; P4 cases a–h).
 *
 * `readContentUnitsForVersion` resolves a Scene's cited units for the version
 * a learner grant PINS, walking exactly as `readRetainedVersionContext`:
 * own `current_attempt_id`, else `predecessor_version_id`, tenant-scoped,
 * cycle-guarded; the resolved attempt must be `kafuo_normalized` with rows.
 *
 * The version chains are built with the persistence primitives directly (the
 * exact rows `createSuccessor` / `replaceStageAfterRegeneration` write:
 * `currentAttemptId: null` + `predecessorVersionId` for a review-edit
 * successor, `currentAttemptId = attempt.id` for a regeneration).
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureTeachingPackageSchema,
  insertAttempt,
  insertVersion,
  readContentUnitsForVersion,
  readRetainedVersionContext,
  upsertContentUnits,
  upsertSourceContext,
  type ContentUnitInput,
} from '@/lib/persistence/teaching-package';
import type { TeachingPackageStatus } from '@/lib/types/teaching-package';
import { ensureDocumentSchema, ensureStageMetaSchema } from '@/tests/teaching-package/helpers';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async end() {
    await this.db.close();
  }
}

const TENANT = 'tenant-lin';
const MODEL = { key: 'g5', version: 'g5.v1' };

const unit = (unitId: string, text = `text of ${unitId}`): ContentUnitInput => ({
  unitId,
  orderIndex: Number(unitId.replace(/\D/g, '')) || 0,
  role: 'CONCEPT',
  normalizedText: text,
});

describe('readContentUnitsForVersion (lineage matrix, plan P4 a–h)', () => {
  let pool: PGlitePool;
  let counter = 0;
  const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;
  const qp = () => pool as never;
  const item = () => ({
    tenantId: TENANT,
    learningItem: { type: 'lesson' as const, id: unique('li') },
  });

  /** A generated attempt: snapshot + source context of `sourceKind` + retained units. */
  async function attempt(
    aggregate: ReturnType<typeof item>,
    options: {
      sourceKind: 'kafuo_normalized' | 'pdf_fallback';
      units?: ContentUnitInput[];
      versionId?: string | null;
      tenantId?: string;
    },
  ) {
    const tenantId = options.tenantId ?? aggregate.tenantId;
    const id = unique('tpa');
    await insertAttempt(qp(), {
      id,
      aggregate: { ...aggregate, tenantId },
      versionId: options.versionId ?? null,
      kind: options.versionId ? 'regeneration' : 'initial',
      status: 'succeeded',
      requestedByActorRef: 'kafuo',
      teachingModel: MODEL,
      inputSnapshot: {
        learningItem: aggregate.learningItem,
        teachingModel: MODEL,
        learningObjectives: [],
        contentUnitRefs: [],
        sourceRefs: [],
        generationContext: {},
        generationOptions: {},
        requirementDigest: '0'.repeat(64),
        requirementPreview: 'p',
        pdfContentSummary: null,
        requestedAt: 1,
        subjectCode: 'MATH',
      },
      now: 1,
    });
    await upsertSourceContext(qp(), {
      tenantId,
      attemptId: id,
      contentResourceId: 'cs-1',
      measuredSha256: 'a'.repeat(64),
      text: 'source',
      sourceKind: options.sourceKind,
    });
    if (options.units)
      await upsertContentUnits(qp(), { tenantId, attemptId: id, units: options.units });
    return id;
  }

  async function version(
    aggregate: ReturnType<typeof item>,
    options: {
      version: number;
      status: TeachingPackageStatus;
      currentAttemptId: string | null;
      predecessorVersionId?: string;
      tenantId?: string;
    },
  ) {
    const id = unique('tpv');
    // `current_stage_id` references a live document row; the Stage content is
    // irrelevant to lineage, so an empty document stands in for it.
    const stageId = unique('stage');
    await pool.query(
      `INSERT INTO document_stages (id, name, created_at, updated_at, data)
       VALUES ($1, 'lineage', 1, 1, '{}'::jsonb)`,
      [stageId],
    );
    await insertVersion(qp(), {
      id,
      aggregate: { ...aggregate, tenantId: options.tenantId ?? aggregate.tenantId },
      version: options.version,
      status: options.status,
      currentStageId: stageId,
      currentAttemptId: options.currentAttemptId,
      ...(options.predecessorVersionId
        ? { predecessorVersionId: options.predecessorVersionId }
        : {}),
      teachingModel: MODEL,
      now: 1,
    });
    return id;
  }

  const resolve = (versionId: string, ids: string[], tenantId = TENANT) =>
    readContentUnitsForVersion(qp(), versionId, ids, { tenantId });

  beforeEach(async () => {
    pool = new PGlitePool(new PGlite());
    await ensureDocumentSchema(pool as never);
    await ensureStageMetaSchema(pool as never);
    await ensureTeachingPackageSchema(pool as never);
  });

  afterEach(async () => {
    await pool.end();
  });

  it('(a) a regenerated version resolves to its OWN attempt, not the predecessor it displaced', async () => {
    const agg = item();
    const first = await attempt(agg, {
      sourceKind: 'kafuo_normalized',
      units: [unit('cu-1', 'old')],
    });
    const v1 = await version(agg, { version: 1, status: 'draft', currentAttemptId: first });
    // Regeneration: `replaceStageAfterRegeneration` relinks current_attempt_id to the new attempt.
    const regenerated = await attempt(agg, {
      sourceKind: 'kafuo_normalized',
      units: [unit('cu-1', 'new'), unit('cu-2')],
      versionId: v1,
    });
    await pool.query(`UPDATE teaching_package_versions SET current_attempt_id = $2 WHERE id = $1`, [
      v1,
      regenerated,
    ]);

    const result = await resolve(v1, ['cu-2', 'cu-1']);
    expect(result).toMatchObject({ lineageStatus: 'own_attempt', resolvedAttemptId: regenerated });
    expect(result.units.map((u) => [u.unitId, u.normalizedText])).toEqual([
      ['cu-1', 'new'],
      ['cu-2', 'text of cu-2'],
    ]);
    // Same attempt the retained-context walk lands on.
    expect((await readRetainedVersionContext(qp(), v1, { tenantId: TENANT }))!.attemptId).toBe(
      regenerated,
    );
  });

  it('(b) a review-edit successor (current_attempt_id NULL) resolves the cloned scenes’ ids through the predecessor attempt', async () => {
    const agg = item();
    const generated = await attempt(agg, {
      sourceKind: 'kafuo_normalized',
      units: [unit('cu-1'), unit('cu-2')],
    });
    const v1 = await version(agg, {
      version: 1,
      status: 'superseded',
      currentAttemptId: generated,
    });
    const v2 = await version(agg, {
      version: 2,
      status: 'draft',
      currentAttemptId: null,
      predecessorVersionId: v1,
    });

    const result = await resolve(v2, ['cu-1', 'cu-2']);
    expect(result).toMatchObject({
      lineageStatus: 'predecessor_attempt',
      resolvedAttemptId: generated,
    });
    expect(result.units.map((u) => u.unitId)).toEqual(['cu-1', 'cu-2']);
  });

  it('(c) two edit-only successors in a row resolve to the nearest generated ancestor', async () => {
    const agg = item();
    const generated = await attempt(agg, { sourceKind: 'kafuo_normalized', units: [unit('cu-7')] });
    const v1 = await version(agg, {
      version: 1,
      status: 'superseded',
      currentAttemptId: generated,
    });
    const v2 = await version(agg, {
      version: 2,
      status: 'superseded',
      currentAttemptId: null,
      predecessorVersionId: v1,
    });
    const v3 = await version(agg, {
      version: 3,
      status: 'approved',
      currentAttemptId: null,
      predecessorVersionId: v2,
    });

    const result = await resolve(v3, ['cu-7']);
    expect(result).toMatchObject({
      lineageStatus: 'predecessor_attempt',
      resolvedAttemptId: generated,
    });
    expect(result.units).toHaveLength(1);
  });

  it('(d) a pinned superseded version resolves through ITS chain while a newer approved version cites different units', async () => {
    const agg = item();
    const oldAttempt = await attempt(agg, {
      sourceKind: 'kafuo_normalized',
      units: [unit('cu-old')],
    });
    const pinned = await version(agg, {
      version: 1,
      status: 'superseded',
      currentAttemptId: oldAttempt,
    });
    const newAttempt = await attempt(agg, {
      sourceKind: 'kafuo_normalized',
      units: [unit('cu-new')],
    });
    const approved = await version(agg, {
      version: 2,
      status: 'approved',
      currentAttemptId: newAttempt,
      predecessorVersionId: pinned,
    });

    const viaPinned = await resolve(pinned, ['cu-old']);
    expect(viaPinned).toMatchObject({
      lineageStatus: 'own_attempt',
      resolvedAttemptId: oldAttempt,
    });
    expect(viaPinned.units.map((u) => u.unitId)).toEqual(['cu-old']);
    // The approved version never "helps" the pinned one: its units are not reachable from it.
    const crossed = await resolve(pinned, ['cu-new']);
    expect(crossed).toMatchObject({
      lineageStatus: 'unavailable',
      resolvedAttemptId: oldAttempt,
      units: [],
    });
    const viaApproved = await resolve(approved, ['cu-new']);
    expect(viaApproved).toMatchObject({
      lineageStatus: 'own_attempt',
      resolvedAttemptId: newAttempt,
    });
  });

  it('(e) a pdf_fallback attempt has no units → unavailable, even when an ancestor has some', async () => {
    const agg = item();
    const normalized = await attempt(agg, {
      sourceKind: 'kafuo_normalized',
      units: [unit('cu-1')],
    });
    const v1 = await version(agg, {
      version: 1,
      status: 'superseded',
      currentAttemptId: normalized,
    });
    const pdf = await attempt(agg, { sourceKind: 'pdf_fallback' });
    const v2 = await version(agg, {
      version: 2,
      status: 'approved',
      currentAttemptId: pdf,
      predecessorVersionId: v1,
    });

    expect(await resolve(v2, ['cu-1'])).toEqual({
      lineageStatus: 'unavailable',
      resolvedAttemptId: null,
      units: [],
    });
    // Likewise a normalized attempt that retained nothing.
    const empty = await attempt(agg, { sourceKind: 'kafuo_normalized' });
    const v3 = await version(agg, {
      version: 3,
      status: 'draft',
      currentAttemptId: empty,
      predecessorVersionId: v2,
    });
    expect(await resolve(v3, ['cu-1'])).toEqual({
      lineageStatus: 'unavailable',
      resolvedAttemptId: null,
      units: [],
    });
  });

  it('(f) a cited id absent from the attempt’s units → partial, with the resolvable units in manifest order', async () => {
    const agg = item();
    const generated = await attempt(agg, {
      sourceKind: 'kafuo_normalized',
      units: [unit('cu-2'), unit('cu-1')],
    });
    const v1 = await version(agg, { version: 1, status: 'approved', currentAttemptId: generated });

    const result = await resolve(v1, ['cu-9', 'cu-2', 'cu-1']);
    expect(result).toMatchObject({ lineageStatus: 'partial', resolvedAttemptId: generated });
    expect(result.units.map((u) => u.unitId)).toEqual(['cu-1', 'cu-2']);
    // None of the cited ids present → unavailable, but the attempt is named.
    expect(await resolve(v1, ['cu-9'])).toMatchObject({
      lineageStatus: 'unavailable',
      resolvedAttemptId: generated,
      units: [],
    });
    // An empty citation list resolves nothing.
    expect(await resolve(v1, [])).toMatchObject({ lineageStatus: 'unavailable', units: [] });
  });

  it('(g) a predecessor cycle terminates as unavailable', async () => {
    const agg = item();
    const v1 = await version(agg, { version: 1, status: 'superseded', currentAttemptId: null });
    const v2 = await version(agg, {
      version: 2,
      status: 'approved',
      currentAttemptId: null,
      predecessorVersionId: v1,
    });
    await pool.query(
      `UPDATE teaching_package_versions SET predecessor_version_id = $2 WHERE id = $1`,
      [v1, v2],
    );

    expect(await resolve(v2, ['cu-1'])).toEqual({
      lineageStatus: 'unavailable',
      resolvedAttemptId: null,
      units: [],
    });
    expect(await readRetainedVersionContext(qp(), v2, { tenantId: TENANT })).toBeNull();
  });

  it('(h) a tenant scope mismatch → unavailable at the version hop AND at the attempt hop', async () => {
    const agg = item();
    const generated = await attempt(agg, { sourceKind: 'kafuo_normalized', units: [unit('cu-1')] });
    const v1 = await version(agg, { version: 1, status: 'approved', currentAttemptId: generated });
    // The version is not visible to another tenant at all.
    expect(await resolve(v1, ['cu-1'], 'tenant-other')).toEqual({
      lineageStatus: 'unavailable',
      resolvedAttemptId: null,
      units: [],
    });
    // A version whose predecessor belongs to another tenant stops at the boundary.
    const foreign = item();
    const foreignAttempt = await attempt(foreign, {
      sourceKind: 'kafuo_normalized',
      units: [unit('cu-1')],
      tenantId: 'tenant-other',
    });
    const foreignVersion = await version(foreign, {
      version: 1,
      status: 'superseded',
      currentAttemptId: foreignAttempt,
      tenantId: 'tenant-other',
    });
    const v2 = await version(agg, {
      version: 2,
      status: 'draft',
      currentAttemptId: null,
      predecessorVersionId: foreignVersion,
    });
    expect(await resolve(v2, ['cu-1'])).toEqual({
      lineageStatus: 'unavailable',
      resolvedAttemptId: null,
      units: [],
    });
    // An unknown version id likewise.
    expect(await resolve('tpv-nope', ['cu-1'])).toEqual({
      lineageStatus: 'unavailable',
      resolvedAttemptId: null,
      units: [],
    });
  });
});
