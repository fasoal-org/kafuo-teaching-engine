/**
 * `GET /api/tutor/conversations?status=active&cursor&limit=20` — list the
 * student's conversations; `POST /api/tutor/conversations` — create one
 * (`{ subjectCode, clientRequestId }` → `201 { conversation }`, or `200` on
 * an idempotent replay). Kafuo R1 contracts §5; plan §6.4, P6.
 *
 * Student grant only (`withStudentGrant`); 404 when the Teaching Package API
 * is off. `403 SUBJECT_NOT_ALLOWED` when the code is not in the grant,
 * `422 SUBJECT_ROUTE_UNAVAILABLE` when the policy cannot resolve it.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { readJsonObject } from '@/lib/server/teaching-package/route-helpers';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import {
  createConversation,
  listConversations,
  toWireConversation,
} from '@/lib/server/tutor/conversation-service';
import { withStudentGrant } from '@/lib/server/tutor/guards';
import { resolveTutorRuntimeDeps } from '@/lib/server/tutor/runtime-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest) {
  return withStudentGrant(req, async (request, { grant }) => {
    const deps = await resolveTutorRuntimeDeps();
    const params = request.nextUrl.searchParams;
    const rawLimit = Number(params.get('limit'));
    const page = await listConversations(deps, grant, {
      status: params.get('status'),
      cursor: params.get('cursor'),
      limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : null,
    });
    return NextResponse.json(page, { headers: NO_STORE });
  });
}

export async function POST(req: NextRequest) {
  return withStudentGrant(req, async (request, { grant }) => {
    const body = await readJsonObject(request);
    if (!body) throw new TeachingPackageError('INVALID_REQUEST', 'request body must be a JSON object');
    const deps = await resolveTutorRuntimeDeps();
    const { conversation, created } = await createConversation(deps, {
      grant,
      subjectCode: body.subjectCode,
      clientRequestId: body.clientRequestId,
    });
    return NextResponse.json(
      { conversation: toWireConversation(conversation) },
      { status: created ? 201 : 200, headers: NO_STORE },
    );
  });
}
