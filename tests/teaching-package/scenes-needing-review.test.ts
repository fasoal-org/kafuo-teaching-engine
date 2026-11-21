/**
 * "N slides need review" follows the live Stage (21 Nov 2026): the stored
 * end-of-generation count is reported only when the Stage cannot be read, so
 * Kafuo's card and the Submit/Approve gate name the same slides.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { AppScene } from '@/lib/types/stage';
import type { GenerationAttempt } from '@/lib/types/teaching-package';
import { makeSlideScene } from '../agent-runtime/_stage-fixtures';

const mocks = vi.hoisted(() => ({
  loadDocument: vi.fn(),
  readApprovedVersion: vi.fn(),
  readActiveVersion: vi.fn(),
  readLatestWebhookSequence: vi.fn(),
  readAttemptById: vi.fn(),
  clientQuery: vi.fn(),
}));

vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => ({ loadDocument: mocks.loadDocument }),
}));

vi.mock('@/lib/persistence/teaching-package', () => ({
  readApprovedVersion: mocks.readApprovedVersion,
  readActiveVersion: mocks.readActiveVersion,
  readLatestWebhookSequence: mocks.readLatestWebhookSequence,
  readAttemptById: mocks.readAttemptById,
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool: {
      connect: async () => ({ query: mocks.clientQuery, release: () => {} }),
      query: mocks.clientQuery,
    },
  }),
}));

import { withLiveScenesNeedingReview } from '@/lib/server/teaching-package/scenes-needing-review';
import { GET as aggregateRoute } from '@/app/api/teaching-packages/aggregate/route';

const SERVICE_KEY = 'scenes-needing-review-service-key';

function attempt(partial: Partial<GenerationAttempt> = {}): GenerationAttempt {
  return {
    id: 'tpa-snr-1',
    tenantId: 'tenant-snr',
    learningItem: { type: 'lesson', id: '189' },
    versionId: 'tpv-snr-1',
    kind: 'initial',
    status: 'succeeded',
    requestId: 'kafuo-req-1',
    requestDigest: null,
    teachingSkillsContract: null,
    skillPolicyDigest: null,
    generationRuns: 1,
    requestedByActorRef: 'kafuo:admin-1',
    teachingModel: { key: 'g5', version: 'g5.v10' },
    inputSnapshot: {
      learningItem: { type: 'lesson', id: '189' },
      teachingModel: { key: 'g5', version: 'g5.v10' },
      learningObjectives: [],
      contentUnitRefs: [],
      sourceRefs: [],
      generationContext: {},
      generationOptions: {},
      requirementDigest: '0'.repeat(64),
      requirementPreview: 'preview',
      pdfContentSummary: null,
      requestedAt: 1,
      // What the runner wrote at the end of generation.
      scenesNeedingReview: 1,
    } as GenerationAttempt['inputSnapshot'],
    producedStageId: 'stage-snr-1',
    stageId: 'stage-snr-1',
    displacedAt: null,
    stageReleasedAt: null,
    progress: null,
    error: null,
    errorCode: null,
    errorRetryable: null,
    ...partial,
  } as GenerationAttempt;
}

function flagged(id: string, order: number, code: string): AppScene {
  return {
    ...makeSlideScene(id, 'stage-snr-1', order),
    generationIssues: [{ code, message: 'kept with a problem' }],
  };
}

/** Three slides still flagged on the live Stage (one regenerated slide, two later marks). */
function liveStageWithThreeFlagged(): { scenes: AppScene[] } {
  return {
    scenes: [
      makeSlideScene('s1', 'stage-snr-1', 1),
      flagged('s2', 2, 'ACTION_REFERENCE_INVALID'),
      flagged('s3', 3, 'NARRATION_MISSING'),
      makeSlideScene('s4', 'stage-snr-1', 4),
      flagged('s5', 5, 'NARRATION_AUDIO_FAILED'),
    ],
  };
}

function countOf(reported: GenerationAttempt): unknown {
  return (reported.inputSnapshot as { scenesNeedingReview?: unknown }).scenesNeedingReview;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('withLiveScenesNeedingReview', () => {
  it('reports the live Stage count (3) over the stored snapshot (1)', async () => {
    mocks.loadDocument.mockResolvedValue(liveStageWithThreeFlagged());
    const reported = await withLiveScenesNeedingReview(attempt());
    expect(countOf(reported)).toBe(3);
    expect(mocks.loadDocument).toHaveBeenCalledWith('stage-snr-1');
  });

  it('reports 0 once every flagged slide on the live Stage is clean', async () => {
    mocks.loadDocument.mockResolvedValue({
      scenes: [makeSlideScene('s1', 'stage-snr-1', 1), makeSlideScene('s2', 'stage-snr-1', 2)],
    });
    expect(countOf(await withLiveScenesNeedingReview(attempt()))).toBe(0);
  });

  it('falls back to the stored count when the Stage cannot be read (no document)', async () => {
    mocks.loadDocument.mockResolvedValue(null);
    const original = attempt();
    const reported = await withLiveScenesNeedingReview(original);
    expect(countOf(reported)).toBe(1);
    expect(reported).toBe(original);
  });

  it('falls back to the stored count when the Stage read throws', async () => {
    mocks.loadDocument.mockRejectedValue(new Error('connection refused'));
    expect(countOf(await withLiveScenesNeedingReview(attempt()))).toBe(1);
  });

  it.each([
    ['a running attempt', { status: 'running' as const }],
    ['a failed attempt', { status: 'failed' as const }],
    ['a released Stage', { stageId: null }],
    ['a displaced Stage', { displacedAt: 5 }],
  ])('leaves %s untouched and never reads a Stage', async (_label, partial) => {
    const original = attempt(partial);
    expect(await withLiveScenesNeedingReview(original)).toBe(original);
    expect(mocks.loadDocument).not.toHaveBeenCalled();
  });
});

describe('GET /api/teaching-packages/aggregate', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgres://scenes-needing-review-test');
    vi.stubEnv('TEACHING_ENGINE_SERVICE_KEY', SERVICE_KEY);
    mocks.clientQuery.mockImplementation(async (sql: string) =>
      sql.includes('FROM teaching_package_generation_attempts')
        ? { rows: [{ id: 'tpa-snr-1' }] }
        : { rows: [] },
    );
    mocks.readApprovedVersion.mockResolvedValue(null);
    mocks.readActiveVersion.mockResolvedValue(null);
    mocks.readLatestWebhookSequence.mockResolvedValue(7);
    mocks.readAttemptById.mockResolvedValue(attempt());
  });

  function read(): Promise<Response> {
    return aggregateRoute(
      new NextRequest(
        'http://localhost/api/teaching-packages/aggregate?tenantId=tenant-snr&learningItemType=lesson&learningItemId=189',
        { headers: { authorization: `Bearer ${SERVICE_KEY}` } },
      ),
    );
  }

  it('reports the live count Kafuo reconciliation reads (inputSnapshot.scenesNeedingReview)', async () => {
    mocks.loadDocument.mockResolvedValue(liveStageWithThreeFlagged());
    const response = await read();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.latestAttempt.id).toBe('tpa-snr-1');
    expect(body.latestAttempt.inputSnapshot.scenesNeedingReview).toBe(3);
    expect(body.latestAggregateSequence).toBe(7);
    // A count only: no Stage or Scene document reaches the response.
    expect(JSON.stringify(body)).not.toContain('kept with a problem');
    // The Stage is read after the advisory-locked transaction committed.
    const sql = mocks.clientQuery.mock.calls.map((call) => String(call[0]));
    expect(sql.at(-1)).toBe('COMMIT');
    expect(mocks.clientQuery.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      mocks.loadDocument.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps the stored count when the Stage cannot be read', async () => {
    mocks.loadDocument.mockResolvedValue(null);
    const body = await (await read()).json();
    expect(body.latestAttempt.inputSnapshot.scenesNeedingReview).toBe(1);
  });
});
