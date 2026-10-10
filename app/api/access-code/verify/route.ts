import { cookies } from 'next/headers';
import { timingSafeEqual } from 'crypto';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createAccessToken } from '@/lib/server/access-token';
import { ACCESS_TOKEN_MAX_AGE_SECONDS } from '@/lib/server/startup-config';

export async function POST(request: Request) {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return apiSuccess({ valid: true });
  }

  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');
  }

  // Constant-time comparison
  if (!body.code) {
    return apiError('INVALID_REQUEST', 401, 'Invalid access code');
  }
  const encoder = new TextEncoder();
  const a = encoder.encode(body.code);
  const b = encoder.encode(accessCode);
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    return apiError('INVALID_REQUEST', 401, 'Invalid access code');
  }

  const token = createAccessToken(accessCode);
  const cookieStore = await cookies();
  cookieStore.set('openmaic_access', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // Same 12 h the server enforces on the signed issued-at (verifyAccessToken).
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === 'production',
  });

  return apiSuccess({ valid: true });
}
