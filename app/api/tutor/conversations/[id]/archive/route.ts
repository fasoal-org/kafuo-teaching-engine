/**
 * `POST /api/tutor/conversations/:id/archive` → `200 { conversation }`
 * (Kafuo R1 contracts §5). Ownership mismatch → `404 CONVERSATION_NOT_FOUND`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { setArchived } from '@/lib/server/tutor/conversation-service';
import { withStudentGrant } from '@/lib/server/tutor/guards';
import { resolveTutorRuntimeDeps } from '@/lib/server/tutor/runtime-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return withStudentGrant(req, async (_request, { grant }) => {
    const { id } = await params;
    const deps = await resolveTutorRuntimeDeps();
    const conversation = await setArchived(deps, grant, id, true);
    return NextResponse.json({ conversation }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
