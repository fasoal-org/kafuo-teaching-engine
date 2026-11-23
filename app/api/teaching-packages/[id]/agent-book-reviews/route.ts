/**
 * POST /api/teaching-packages/[id]/agent-book-reviews — ask for one agent book
 * review of this package version (Kafuo Agent API D2a). Service key only (the
 * Backend's evaluation). Body:
 * `{ tenantContext: { tenantId }, requestId, evaluationId?, runId?, subjectCode?,
 *    pages: [{ pdfPage, bookPage?, text, image?: { mediaType, data } }],
 *    blocks: [{ id, pdfPage, kind, text, rows?, caption?, bbox? }],
 *    units: [{ contentUnitId, order, blockIds }], constants?, d1Findings?: [{ code, sceneId }] }`.
 * Answers `202 { review_id, status, replayed }` at once; the review runs in this
 * process's agent-review sweep and ends with `teaching_package.agent_review_completed`.
 * A replay with the same `requestId` answers the same review and never pays twice.
 * The page images are held in memory for the run only, never stored.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { parseAgentReviewRequest } from '@/lib/server/teaching-package/agent-book-review-request';
import {
  holdAgentReviewImages,
  insertQueuedAgentReview,
  newAgentReviewId,
  releaseAgentReviewImages,
} from '@/lib/server/teaching-package/agent-book-review-store';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { getTeachingPackageVersion } from '@/lib/server/teaching-package/resolve';
import {
  parseTenantContext,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const runtime = 'nodejs';

/**
 * The body cap: every inline page image together (`MAX_IMAGES_BASE64`, 24M base64
 * characters) plus the page text, blocks and JSON overhead.
 */
const MAX_AGENT_REVIEW_BODY_BYTES = 32 * 1024 * 1024;

function tooLarge(): TeachingPackageError {
  return new TeachingPackageError(
    'AGENT_REVIEW_BODY_TOO_LARGE',
    `the request body is over ${MAX_AGENT_REVIEW_BODY_BYTES} bytes`,
  );
}

/**
 * Read a JSON object body, refusing more than `maxBytes` (413) whether or not the
 * client sent a `Content-Length`: the stream is counted and cancelled at the cap.
 * Null when the body is absent, not JSON or not an object (400).
 */
async function readCappedJsonObject(
  req: Request,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id } = await params;
    const body = await readCappedJsonObject(req, MAX_AGENT_REVIEW_BODY_BYTES);
    if (!body) {
      throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    const tenantId = parseTenantContext(body);
    const version = await getTeachingPackageVersion(id, { tenantId });
    const request = parseAgentReviewRequest(body);
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const now = Date.now();
    const subjectCode =
      typeof body.subjectCode === 'string' && body.subjectCode.trim() !== ''
        ? body.subjectCode
        : await readStageSubjectCode(pool as never, version.currentStageId);

    const reviewId = newAgentReviewId();
    if (request.images.length > 0 && !holdAgentReviewImages(reviewId, request.images, now)) {
      throw new TeachingPackageError(
        'AGENT_REVIEW_BUSY',
        'too many page images are waiting for review in this process; try again shortly',
      );
    }
    let inserted: Awaited<ReturnType<typeof insertQueuedAgentReview>>;
    try {
      inserted = await insertQueuedAgentReview(pool as never, {
        id: reviewId,
        aggregate: { tenantId, learningItem: version.learningItem },
        versionId: version.id,
        stageId: version.currentStageId,
        subjectCode,
        requestId: request.requestId,
        evaluationId: request.evaluationId,
        runId: request.runId,
        evidence: request.evidence,
        hasImages: request.images.length > 0,
        now,
      });
    } catch (error) {
      // Nothing was stored: free the held images (and their memory) at once.
      releaseAgentReviewImages(reviewId);
      throw error;
    }
    const { review, replayed } = inserted;
    if (replayed) {
      releaseAgentReviewImages(reviewId);
      // A replay of a review that has not run yet re-arms its images (a restart lost them).
      if (review.status === 'queued' && request.images.length > 0) {
        holdAgentReviewImages(review.id, request.images, now);
      }
    }
    // Start it now (cap 1): the images are in this process's memory.
    void import('@/lib/server/teaching-package/agent-book-review')
      .then(({ sweepAgentBookReviews }) => sweepAgentBookReviews({ pool: pool as never }))
      .catch((error) => {
        console.error('agent review sweep failed', JSON.stringify(describeErrorSafely(error)));
      });
    return NextResponse.json(
      { review_id: review.id, status: review.status, replayed },
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to queue the agent book review' } },
      { status: 500 },
    );
  }
}

async function readStageSubjectCode(
  queryable: { query: (text: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  stageId: string,
): Promise<string | null> {
  const result = await queryable.query(
    `SELECT data->>'subjectCode' AS subject_code FROM document_stages WHERE id = $1`,
    [stageId],
  );
  const row = result.rows[0] as { subject_code?: string | null } | undefined;
  return row?.subject_code ?? null;
}
