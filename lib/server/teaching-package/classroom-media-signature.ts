/**
 * Signed classroom-media links for the `ACCESS_CODE`-gated deployment.
 *
 * The mobile player loads Stage images and narration audio with no credential
 * (`NetworkImage`, `just_audio`, `video_player` take a bare URL). So when the
 * gate is on, a learner's Stage document is delivered with every
 * `/api/classroom-media/<id>/(media|audio)/<file>` reference signed:
 * `?exp=<epoch s>&sig=<hmac>`. The media route then serves a read only with a
 * valid, unexpired signature for exactly that file, or with the browser's
 * access cookie (admins, whose pages use plain URLs).
 *
 * Signing happens at delivery, so it covers whatever the document references,
 * including a successor Stage's media still stored under its source Stage id
 * (`stage-clone.ts`). The signature binds the Stage id, the decoded file path
 * and the expiry, and expires with the learner grant that read the document.
 *
 * The key is derived from the grant secret with a domain-separation label, so
 * a media signature can never be presented as any grant token or vice versa.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { verifyAccessToken } from '@/lib/server/access-token';
import { grantSecret } from '@/lib/server/teaching-package/signed-token';

const KEY_LABEL = 'openmaic:classroom-media-url:v1';

/**
 * `/api/classroom-media/<id>/(media|audio)/<file>[?]`, relative or inside an
 * absolute URL, an HTML attribute or CSS `url(…)`. A following `?` is consumed
 * so an existing query string is kept after the signature.
 */
const MEDIA_REFERENCE =
  /\/api\/classroom-media\/([A-Za-z0-9_-]+)\/((?:media|audio)\/[^\s"'<>()?#\\&]+)(\?)?/g;

function mediaKey(): Buffer | null {
  const secret = grantSecret();
  if (!secret) return null;
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

/** The signed message: Stage id, the DECODED path the route resolves, expiry. */
function signature(key: Buffer, classroomId: string, segments: readonly string[], exp: number) {
  return createHmac('sha256', key)
    .update(`${classroomId}\n${segments.join('/')}\n${exp}`)
    .digest('base64url');
}

/** Decode `media/a%20b.png` the way the route receives it, or null when malformed. */
function decodeSegments(encodedPath: string): string[] | null {
  try {
    return encodedPath.split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** Sign every classroom-media reference in one string. */
function signString(value: string, key: Buffer, exp: number): string {
  if (!value.includes('/api/classroom-media/')) return value;
  return value.replace(
    MEDIA_REFERENCE,
    (match, classroomId: string, encodedPath: string, query: string | undefined) => {
      const segments = decodeSegments(encodedPath);
      if (!segments) return match;
      const params = `exp=${exp}&sig=${signature(key, classroomId, segments, exp)}`;
      // `…/a.png?v=2` becomes `…/a.png?exp=…&sig=…&v=2`.
      return `/api/classroom-media/${classroomId}/${encodedPath}?${params}${query ? '&' : ''}`;
    },
  );
}

/**
 * Deep copy of a delivered document with every classroom-media reference
 * signed until `expSeconds`. Unchanged (same value) when no signing key is
 * configured, so a deployment without the Teaching Package API is untouched.
 */
export function signLearnerMediaUrls<T>(payload: T, expSeconds: number): T {
  const key = mediaKey();
  if (!key) return payload;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return signString(value, key, expSeconds);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const copy: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) copy[name] = walk(child);
      return copy;
    }
    return value;
  };
  return walk(payload) as T;
}

/** Whether `sig` is a valid, unexpired signature for this exact file. */
export function verifyClassroomMediaSignature(
  classroomId: string,
  segments: readonly string[],
  exp: string | null,
  sig: string | null,
  nowMs: number = Date.now(),
): boolean {
  const key = mediaKey();
  if (!key || !exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  const expSeconds = Number(exp);
  if (expSeconds * 1000 < nowMs) return false;
  const expected = signature(key, classroomId, segments, expSeconds);
  const left = createHash('sha256').update(sig).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * The gate for one media read while `ACCESS_CODE` is set: the browser's valid
 * access cookie (admins), or a valid signature from learner delivery.
 */
export function canReadGatedClassroomMedia(input: {
  accessCode: string;
  accessCookie: string | undefined;
  classroomId: string;
  segments: readonly string[];
  searchParams: URLSearchParams;
  nowMs?: number;
}): boolean {
  if (input.accessCookie && verifyAccessToken(input.accessCookie, input.accessCode)) return true;
  return verifyClassroomMediaSignature(
    input.classroomId,
    input.segments,
    input.searchParams.get('exp'),
    input.searchParams.get('sig'),
    input.nowMs,
  );
}
