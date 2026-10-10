import { NextRequest, NextResponse } from 'next/server';

import { isOpenApiRequest } from '@/lib/config/access-code-allowlist';
import { isAgentRuntimeConfigured, isProWorkbenchEnabled } from '@/lib/config/feature-flags';
import {
  isOpenAccessOptOut,
  readAccessToken,
  resolveAccessGateMode,
} from '@/lib/server/startup-config';

/** Convert string to Uint8Array */
function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/** Convert ArrayBuffer to hex string */
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify an HMAC-signed token using Web Crypto API (Edge-compatible). The
 * format and the 12-hour age rule are `readAccessToken`'s, shared with the
 * Node verifier in `lib/server/access-token.ts`.
 */
async function verifyToken(token: string, accessCode: string): Promise<boolean> {
  const parts = readAccessToken(token, Date.now());
  if (!parts) return false;
  const { message, signature } = parts;

  const keyData = encode(accessCode);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const data = encode(message);
  const expected = bufToHex(await crypto.subtle.sign('HMAC', key, data.buffer as ArrayBuffer));

  // Constant-length comparison (not truly constant-time in JS, but sufficient here)
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Return an actual server-side 404 when either half of the workbench is off.
  // Edge middleware cannot reliably inspect server-only deployment variables,
  // so it enforces the public gate and leaves the complete runtime/database
  // check to Node. A Node-hosted middleware uses the same gate as startup.
  const canInspectServerRuntime = process.env.NEXT_RUNTIME !== 'edge';
  const workbenchEnabled =
    isProWorkbenchEnabled() && (!canInspectServerRuntime || isAgentRuntimeConfigured());
  if (!workbenchEnabled && (pathname === '/workbench' || pathname.startsWith('/workbench/'))) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Read per request (not at module load): `next start` supplies the runtime
  // env, and tests stub it.
  const accessCode = process.env.ACCESS_CODE;
  const gateMode = resolveAccessGateMode({
    accessCode,
    isProduction: process.env.NODE_ENV === 'production',
    allowOpenAccess: isOpenAccessOptOut(process.env.TE_ALLOW_OPEN_ACCESS),
  });
  if (gateMode === 'open') {
    return NextResponse.next();
  }

  // Allow-list: the access-code endpoints, health, and the routes the Backend
  // (server to server) and the mobile app call. Each enforces its own
  // authentication; the access cookie is meaningless to those callers.
  if (isOpenApiRequest(request)) {
    return NextResponse.next();
  }

  // Production without ACCESS_CODE (ET-31): the startup guard refuses to boot,
  // so this only runs if that guard was bypassed. Fail closed: no other /api
  // route is served. Pages still pass; they call /api and get the 503.
  // (`!accessCode` only narrows the type: 'gated' always has a code.)
  if (gateMode === 'closed' || !accessCode) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { success: false, errorCode: 'INTERNAL_ERROR', error: 'Access gate not configured' },
        { status: 503 },
      );
    }
    return NextResponse.next();
  }

  // Check cookie — validate HMAC signature, not just existence
  const cookie = request.cookies.get('openmaic_access');
  if (cookie?.value && (await verifyToken(cookie.value, accessCode))) {
    return NextResponse.next();
  }

  // API requests without valid cookie → 401
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
      { status: 401 },
    );
  }

  // Page requests → let through, frontend shows modal
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
