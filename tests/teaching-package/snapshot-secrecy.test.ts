import { describe, expect, it } from 'vitest';

import type { GenerationInputSnapshot } from '@/lib/types/teaching-package';

function baseSnapshot(overrides: Record<string, unknown> = {}): GenerationInputSnapshot {
  return {
    learningItem: { type: 'lesson', id: 'li-sec' },
    teachingModel: { key: 'g5', version: 'g5.v1' },
    learningObjectives: [],
    contentUnitRefs: [],
    sourceRefs: [],
    generationContext: {},
    generationOptions: {},
    requirementDigest: '0'.repeat(64),
    requirementPreview: 'p',
    pdfContentSummary: null,
    requestedAt: 1,
    ...overrides,
  } as GenerationInputSnapshot;
}

describe('snapshot secrecy (narrow credential-path rules, plan §4.4.7)', () => {
  async function insert(snapshot: GenerationInputSnapshot): Promise<unknown> {
    // assertSnapshotPersistable is module-private; insertAttempt is its caller.
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    await db.waitReady;
    const { ensureDocumentSchema } = await import('@openmaic/storage/document/pg');
    const { ensureStageMetaSchema } = await import('@/lib/persistence/stage-meta');
    const tp = await import('@/lib/persistence/teaching-package');
    await ensureDocumentSchema(db as never);
    await ensureStageMetaSchema(db as never);
    await tp.ensureTeachingPackageSchema(db as never);
    try {
      await tp.insertAttempt(db as never, {
        id: 'tpa-sec',
        aggregate: { tenantId: 'tenant-sec', learningItem: { type: 'lesson', id: 'li-sec' } },
        kind: 'initial',
        status: 'queued',
        requestedByActorRef: 'a',
        teachingModel: { key: 'g5', version: 'g5.v1' },
        inputSnapshot: snapshot,
        now: 1,
      });
      return null;
    } catch (error) {
      return error;
    } finally {
      await db.close();
    }
  }

  it('rejects contentResource.url', async () => {
    const error = await insert(
      baseSnapshot({
        contentResource: { id: 'cs-1', mimeType: 'application/pdf', url: 'https://r2/x.pdf?sig=1' },
      }) as never,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/contentResource\.url/);
  });

  it('rejects normalizedContentResource.url and permits only stable facts', async () => {
    const error = await insert(
      baseSnapshot({
        normalizedContentResource: { id: 'ncr-1', url: 'https://r2/x.zip?sig=1' },
      }) as never,
    );
    expect((error as Error).message).toMatch(/normalizedContentResource\.url|credential-bearing/);
    expect(
      await insert(
        baseSnapshot({
          normalizedContentResource: {
            id: 'ncr-1',
            mimeType: 'application/zip',
            schemaVersion: 'kafuo.normalized-content.v1',
            contentSourceId: 'cs-1',
            contentRevisionId: 'rev-1',
            parseRunId: 'run-1',
            structureProfile: { id: 'p-1', versionId: 'pv-1' },
            fileSizeBytes: 10,
            checksumSha256: 'a'.repeat(64),
          },
        }),
      ),
    ).toBeNull();
  });

  it('rejects signedUrl/presignedUrl/retrievalUrl/downloadUrl keys anywhere', async () => {
    for (const key of ['signedUrl', 'presignedUrl', 'retrievalUrl', 'downloadUrl']) {
      const error = await insert(
        baseSnapshot({
          generationContext: { [key]: 'https://docs.example.test/x' },
        }) as never,
      );
      expect((error as Error).message).toMatch(new RegExp(key));
    }
  });

  it('rejects a URL value carrying credential-bearing query parameters', async () => {
    for (const url of [
      'https://r2.example.test/lesson.pdf?X-Amz-Signature=abc',
      'https://r2.example.test/lesson.pdf?token=secret',
      'https://cdn.example.test/x?sig=1',
    ]) {
      const error = await insert(baseSnapshot({ generationContext: { assetLink: url } }) as never);
      expect((error as Error).message).toMatch(/credential-bearing/);
    }
  });

  it('accepts a safe unrelated metadata url and the secret-free resource facts', async () => {
    const error = await insert(
      baseSnapshot({
        generationContext: { documentationUrl: 'https://docs.example.test/guide' },
        contentResource: {
          id: 'cs-1',
          mimeType: 'application/pdf',
          measuredBytes: 128,
          measuredSha256: 'b'.repeat(64),
        },
        tenantId: 'tenant-sec',
        teachingFlow: [{ stage: 'lesson_introduction', instructions: 'i' }],
      }),
    );
    expect(error).toBeNull();
  });
});
