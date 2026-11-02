// Lesson 306 (F-1): the outline answer diagnostics stay on the attempt row and
// never travel in an attempt record (aggregate read, generate replay).
import { describe, expect, it } from 'vitest';

import type { GenerationInputSnapshot } from '@/lib/types/teaching-package';

const snapshot = {
  learningItem: { type: 'lesson', id: 'li-diag' },
  teachingModel: { key: 'g5', version: 'g5.v8' },
  learningObjectives: [],
  contentUnitRefs: [],
  sourceRefs: [],
  generationContext: {},
  generationOptions: {},
  requirementDigest: '0'.repeat(64),
  requirementPreview: 'p',
  pdfContentSummary: null,
  requestedAt: 1,
} as unknown as GenerationInputSnapshot;

describe('attempt record snapshot (outlineAnswerDiagnostics)', () => {
  it('keeps the diagnostics on the row and strips them from the record', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    await db.waitReady;
    const { ensureDocumentSchema } = await import('@openmaic/storage/document/pg');
    const { ensureStageMetaSchema } = await import('@/lib/persistence/stage-meta');
    const tp = await import('@/lib/persistence/teaching-package');
    try {
      await ensureDocumentSchema(db as never);
      await ensureStageMetaSchema(db as never);
      await tp.ensureTeachingPackageSchema(db as never);
      await tp.insertAttempt(db as never, {
        id: 'tpa-diag',
        aggregate: { tenantId: 'tenant-diag', learningItem: { type: 'lesson', id: 'li-diag' } },
        kind: 'initial',
        status: 'queued',
        requestedByActorRef: 'a',
        teachingModel: { key: 'g5', version: 'g5.v8' },
        inputSnapshot: snapshot,
        now: 1,
      });
      const diagnostics = [
        {
          parse: null,
          malformed: ['entry #1 is a nested answer object'],
          rawLength: 3,
          rawHead: 'raw',
          rawTail: '',
          generationRun: 1,
          at: 2,
        },
      ];
      await db.query(
        `UPDATE teaching_package_generation_attempts
            SET input_snapshot = input_snapshot || $2::jsonb WHERE id = $1`,
        ['tpa-diag', JSON.stringify({ outlineAnswerDiagnostics: diagnostics })],
      );

      const record = await tp.readAttemptById(db as never, 'tpa-diag');
      expect(record?.inputSnapshot).toEqual(snapshot);
      expect('outlineAnswerDiagnostics' in (record?.inputSnapshot ?? {})).toBe(false);

      const row = await db.query<{ input_snapshot: Record<string, unknown> }>(
        `SELECT input_snapshot FROM teaching_package_generation_attempts WHERE id = $1`,
        ['tpa-diag'],
      );
      expect(row.rows[0]?.input_snapshot.outlineAnswerDiagnostics).toEqual(diagnostics);
    } finally {
      await db.close();
    }
  });
});
