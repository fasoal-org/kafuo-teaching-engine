/**
 * `GET /api/tutor/conversations/:id?beforeSeq&limit=50` — one conversation
 * with a message window (Kafuo R1 contracts §5). Ownership mismatch reads as
 * `404 CONVERSATION_NOT_FOUND`; the pinned subject is NOT re-validated on
 * read (resume still works), only on send.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getConversation } from '@/lib/server/tutor/conversation-service';
import { withStudentGrant } from '@/lib/server/tutor/guards';
import { resolveTutorRuntimeDeps } from '@/lib/server/tutor/runtime-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return withStudentGrant(req, async (request, { grant }) => {
    const { id } = await params;
    const deps = await resolveTutorRuntimeDeps();
    const search = request.nextUrl.searchParams;
    const beforeSeq = Number(search.get('beforeSeq'));
    const limit = Number(search.get('limit'));
    const result = await getConversation(deps, grant, id, {
      beforeSeq: Number.isFinite(beforeSeq) && beforeSeq > 0 ? Math.floor(beforeSeq) : null,
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  });
}
