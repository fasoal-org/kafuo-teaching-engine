/**
 * POST /api/teaching-packages/[id]/agent-ops/[op] — the Kafuo Agent API's
 * teaching-package editor writes (agent API plan §8 E3, `package:write`).
 *
 * Service-to-service only (Kafuo Backend, service key); `[id]` is the package
 * version. `[op]`: `regenerate`, `generate`, `link`, `narration-audio`,
 * `delete`, `skills`, phase 2 F3.3's `add-image`, and wave F2's `quiz-item-edit`, `quiz-item-delete`,
 * `narration-line`, `text-element`, `alignment-confirm`
 * (`lib/server/teaching-package/agent-edit-ops.ts`) — each the editor's own service with the actor
 * `agent:<user id>` (`lib/server/teaching-package/agent-ops.ts`). A never-offered
 * action (submit, approve, publish, …) → 422 `AGENT_ACTION_NOT_ALLOWED`; any
 * other name → 404.
 *
 * Body `{ tenantContext, actorRef, expectedRevision, dryRun?, idempotencyKey?, … }`.
 * `200` = done (or a dry run's verdict), `202 { opId, status: 'running' }` = an
 * AI op whose run row exists and continues after the response.
 */
import { after, type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  assertAgentOpOffered,
  assertAgentOpsActor,
  parseAgentDryRun,
  runAgentOp,
} from '@/lib/server/teaching-package/agent-ops';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { getTeachingPackageVersion } from '@/lib/server/teaching-package/resolve';
import {
  parseTenantContext,
  readJsonObject,
  teachingPackageErrorResponse,
} from '@/lib/server/teaching-package/route-helpers';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; op: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  try {
    authenticateServiceRequest(req);
    const { id, op: name } = await params;
    const op = assertAgentOpOffered(name);
    if (!op) return new Response('Not found', { status: 404 });
    const body = await readJsonObject(req);
    if (!body) {
      throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    const actorRef = assertAgentOpsActor(body.actorRef);
    const tenantId = parseTenantContext(body);
    const dryRun = parseAgentDryRun(body.dryRun);
    const version = await getTeachingPackageVersion(id, { tenantId });
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const answer = await runAgentOp(
      op,
      {
        pool: pool as never,
        version,
        tenantId,
        actorRef,
        dryRun,
        after: (task) => after(task),
      },
      body,
    );
    return NextResponse.json(answer.body, {
      status: answer.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    console.error('TeachingPackages internal error', JSON.stringify(describeErrorSafely(error)));
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'failed to run the agent editor op' } },
      { status: 500 },
    );
  }
}
