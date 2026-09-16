/**
 * Attempt admission reports whether it INSERTED the attempt or handed back an
 * existing one — the `created` flag the routes gate the runner on.
 *
 * The race-recovery branch is the one that cannot be driven from the database:
 * it fires only when a competing row with the same `requestId` lands BETWEEN
 * the idempotency pre-check and the insert, inside one transaction holding the
 * aggregate advisory lock. This file injects exactly that interleaving at the
 * persistence seam, which is the only place it is deterministic.
 *
 * Race recovery is a REPLAY, not a creation: another request won the insert, so
 * this call produced no attempt and must not schedule the runner for it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerationAttempt } from '@/lib/types/teaching-package';

const RACED_ID = 'tpa-raced-winner';

const mocks = vi.hoisted(() => ({
  insertAttempt: vi.fn(),
  readAttemptByRequestId: vi.fn(),
  readVersion: vi.fn(),
  reclaimStaleAttempts: vi.fn(),
  readActiveVersion: vi.fn(),
  nextVersionNumber: vi.fn(),
}));

vi.mock('@/lib/persistence/teaching-package', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/teaching-package')>()),
  insertAttempt: mocks.insertAttempt,
  readAttemptByRequestId: mocks.readAttemptByRequestId,
  readVersion: mocks.readVersion,
  reclaimStaleAttempts: mocks.reclaimStaleAttempts,
  readActiveVersion: mocks.readActiveVersion,
  nextVersionNumber: mocks.nextVersionNumber,
}));

import { startGenerationAttempt } from '@/lib/server/teaching-package/generation';

/** A pool whose transaction helper just runs the body — no real database. */
const pool = {
  query: vi.fn().mockResolvedValue({ rows: [] }),
  connect: vi.fn().mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release() {},
  }),
} as never;

function racedAttempt(overrides: Partial<GenerationAttempt> = {}): GenerationAttempt {
  return {
    id: RACED_ID,
    tenantId: 'tenant-race',
    learningItem: { type: 'lesson', id: 'li-race' },
    versionId: null,
    kind: 'initial',
    status: 'queued',
    requestId: 'kafuo-req-raced',
    requestDigest: null,
    generationRuns: 0,
    requestedByActorRef: 'actor-1',
    teachingModel: { key: 'g5', version: 'g5.v1' },
    inputSnapshot: {
      learningItem: { type: 'lesson', id: 'li-race' },
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
    },
    producedStageId: null,
    stageId: null,
    displacedAt: null,
    stageReleasedAt: null,
    progress: null,
    error: null,
    errorCode: null,
    errorRetryable: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** What node-postgres raises when a unique index refuses the insert. */
function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-race',
    learningItem: { type: 'lesson' as const, id: 'li-race' },
    teachingModel: { key: 'g5', version: 'g5.v1' },
    generation: { requirement: 'Teach something' },
    actorRef: 'actor-1',
    requestId: 'kafuo-req-raced',
    ...overrides,
  } as Parameters<typeof startGenerationAttempt>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reclaimStaleAttempts.mockResolvedValue([]);
  mocks.readActiveVersion.mockResolvedValue(null);
  mocks.nextVersionNumber.mockResolvedValue(1);
});

describe('attempt admission reports creation vs replay', () => {
  it('reports a race-recovered attempt as a replay, not a creation', async () => {
    // The pre-check misses (the competitor has not committed yet), the insert
    // loses the unique index, and the recovery read finds the winner.
    mocks.readAttemptByRequestId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(racedAttempt());
    mocks.insertAttempt.mockRejectedValue(uniqueViolation());

    const result = await startGenerationAttempt(pool, request());

    expect(result.created).toBe(false);
    expect(result.attempt.id).toBe(RACED_ID);
    expect(mocks.insertAttempt).toHaveBeenCalledTimes(1);
  });

  it('still enforces the digest on a race-recovered replay', async () => {
    // Recovery is not a bypass: a different semantic payload under the same
    // requestId is a conflict wherever it is discovered.
    mocks.readAttemptByRequestId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(racedAttempt({ requestDigest: 'a'.repeat(64) }));
    mocks.insertAttempt.mockRejectedValue(uniqueViolation());

    await expect(
      startGenerationAttempt(pool, request({ requestDigest: 'b'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('still raises GENERATION_IN_PROGRESS when the collision is not this requestId', async () => {
    // The single-in-flight index refusing a DIFFERENT request is not a replay:
    // it throws, and never returns an attempt the caller might run.
    mocks.readAttemptByRequestId.mockResolvedValue(null);
    mocks.insertAttempt.mockRejectedValue(uniqueViolation());

    await expect(startGenerationAttempt(pool, request())).rejects.toMatchObject({
      code: 'GENERATION_IN_PROGRESS',
    });
  });

  it('reports a freshly inserted attempt as created', async () => {
    mocks.readAttemptByRequestId.mockResolvedValue(null);
    mocks.insertAttempt.mockResolvedValue(racedAttempt({ id: 'tpa-fresh' }));

    const result = await startGenerationAttempt(pool, request());

    expect(result.created).toBe(true);
    expect(result.attempt.id).toBe('tpa-fresh');
  });
});
