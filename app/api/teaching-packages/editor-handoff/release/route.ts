/**
 * POST /api/teaching-packages/editor-handoff/release — clear the Editor grant
 * session: both the HttpOnly grant cookie and the readable companion
 * learner-key cookie (§12.2).
 */
import { NextResponse } from 'next/server';

import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import { editorGrantReleaseCookieHeaders } from '@/lib/server/teaching-package/editor-grant';

export const runtime = 'nodejs';

export async function POST() {
  if (!isTeachingPackageApiConfigured()) return new Response('Not found', { status: 404 });
  const response = NextResponse.json({ released: true });
  for (const cookie of editorGrantReleaseCookieHeaders()) {
    response.headers.append('Set-Cookie', cookie);
  }
  return response;
}
