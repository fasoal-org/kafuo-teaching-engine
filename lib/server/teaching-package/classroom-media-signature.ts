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
 *
 * **Learner access scope (ET-16 c, G2).** A link delivered under a learner grant
 * that carries the Kafuo student block also carries `as=<scope>`: the grant's
 * tenant, opaque `studentRef` and learning item (base64url JSON). The scope is
 * inside the signed message, under its own key label (`…:v2`), so it can neither
 * be altered nor stripped (a stripped link fails the v1 check: different key,
 * different message). The media route re-validates the scope with Kafuo (cached
 * ≤ 5 min, `tutor/learner-access.ts`) before it serves, so a revoked learner stops
 * receiving media without waiting for the grant to expire. Links without `as`
 * (v1) are still accepted until their own expiry: grants minted before the scope
 * existed, and learner grants without the student block in local development.
 * The `studentRef` is an opaque Kafuo HMAC handle (contracts §1), never a student
 * id; it now appears in media URLs.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { verifyAccessToken } from '@/lib/server/access-token';
import { grantSecret } from '@/lib/server/teaching-package/signed-token';

const KEY_LABEL = 'openmaic:classroom-media-url:v1';
/** Links that carry a learner access scope (`as=`). */
const SCOPED_KEY_LABEL = 'openmaic:classroom-media-url:v2';

/** The learner access scope a v2 link carries (the shape `tutor/learner-access.ts` checks). */
export interface MediaAccessScope {
  tenantId: string;
  studentRef: string;
  learningItemId: string;
  learningItemType: string | null;
}

const MAX_SCOPE_PARAM_CHARS = 1024;

function encodeScope(scope: MediaAccessScope): string {
  return Buffer.from(
    JSON.stringify([scope.tenantId, scope.studentRef, scope.learningItemType, scope.learningItemId]),
    'utf8',
  ).toString('base64url');
}

/** The scope a v2 link carries, or null for a malformed one. */
export function decodeMediaAccessScope(param: string): MediaAccessScope | null {
  if (param.length === 0 || param.length > MAX_SCOPE_PARAM_CHARS || !/^[A-Za-z0-9_-]+$/.test(param)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(param, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [tenantId, studentRef, learningItemType, learningItemId] = parsed;
    if (
      typeof tenantId !== 'string' ||
      tenantId === '' ||
      typeof studentRef !== 'string' ||
      studentRef === '' ||
      typeof learningItemId !== 'string' ||
      learningItemId === '' ||
      (learningItemType !== null && typeof learningItemType !== 'string')
    ) {
      return null;
    }
    return { tenantId, studentRef, learningItemId, learningItemType };
  } catch {
    return null;
  }
}

/**
 * `/api/classroom-media/<id>/(media|audio)/<file>[?]`, relative or inside an
 * absolute URL, an HTML attribute or CSS `url(…)`. A following `?` is consumed
 * so an existing query string is kept after the signature.
 */
const MEDIA_REFERENCE =
  /\/api\/classroom-media\/([A-Za-z0-9_-]+)\/((?:media|audio)\/[^\s"'<>()?#\\&]+)(\?)?/g;

function mediaKey(label: string = KEY_LABEL): Buffer | null {
  const secret = grantSecret();
  if (!secret) return null;
  return createHmac('sha256', secret).update(label).digest();
}

/**
 * The signed message: Stage id, the DECODED path the route resolves, expiry,
 * and (v2 only) the encoded learner access scope.
 */
function signature(
  key: Buffer,
  classroomId: string,
  segments: readonly string[],
  exp: number,
  scopeParam?: string,
) {
  const message = `${classroomId}\n${segments.join('/')}\n${exp}`;
  return createHmac('sha256', key)
    .update(scopeParam === undefined ? message : `${message}\n${scopeParam}`)
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
function signString(value: string, key: Buffer, exp: number, scopeParam?: string): string {
  if (!value.includes('/api/classroom-media/')) return value;
  return value.replace(
    MEDIA_REFERENCE,
    (match, classroomId: string, encodedPath: string, query: string | undefined) => {
      const segments = decodeSegments(encodedPath);
      if (!segments) return match;
      const sig = signature(key, classroomId, segments, exp, scopeParam);
      const params =
        scopeParam === undefined
          ? `exp=${exp}&sig=${sig}`
          : `exp=${exp}&as=${scopeParam}&sig=${sig}`;
      // `…/a.png?v=2` becomes `…/a.png?exp=…&sig=…&v=2`.
      return `/api/classroom-media/${classroomId}/${encodedPath}?${params}${query ? '&' : ''}`;
    },
  );
}

/**
 * Deep copy of a delivered document with every classroom-media reference
 * signed until `expSeconds`. Unchanged (same value) when no signing key is
 * configured, so a deployment without the Teaching Package API is untouched.
 * With `scope` (a learner grant with the student block, ET-16 c) every link is a
 * v2 link carrying that scope.
 */
export function signLearnerMediaUrls<T>(
  payload: T,
  expSeconds: number,
  scope?: MediaAccessScope | null,
): T {
  const key = mediaKey(scope ? SCOPED_KEY_LABEL : KEY_LABEL);
  if (!key) return payload;
  const scopeParam = scope ? encodeScope(scope) : undefined;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return signString(value, key, expSeconds, scopeParam);
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

/**
 * Whether `sig` is a valid, unexpired signature for this exact file. With
 * `scopeParam` (the link's `as=`) the v2 key and message are checked.
 */
export function verifyClassroomMediaSignature(
  classroomId: string,
  segments: readonly string[],
  exp: string | null,
  sig: string | null,
  nowMs: number = Date.now(),
  scopeParam?: string | null,
): boolean {
  const scoped = scopeParam !== undefined && scopeParam !== null;
  const key = mediaKey(scoped ? SCOPED_KEY_LABEL : KEY_LABEL);
  if (!key || !exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  if (scoped && decodeMediaAccessScope(scopeParam) === null) return false;
  const expSeconds = Number(exp);
  if (expSeconds * 1000 < nowMs) return false;
  const expected = signature(key, classroomId, segments, expSeconds, scoped ? scopeParam : undefined);
  const left = createHash('sha256').update(sig).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export type GatedClassroomMediaAccess =
  | { allowed: false }
  /** `scope` is the learner access scope a v2 link carries (to re-validate), else null. */
  | { allowed: true; scope: MediaAccessScope | null };

/**
 * The gate for one media read while `ACCESS_CODE` is set: the browser's valid
 * access cookie (admins: never re-validated), or a valid signature from learner
 * delivery (a v2 link returns its learner access scope for the caller to check).
 */
export function readGatedClassroomMediaAccess(input: {
  accessCode: string;
  accessCookie: string | undefined;
  classroomId: string;
  segments: readonly string[];
  searchParams: URLSearchParams;
  nowMs?: number;
}): GatedClassroomMediaAccess {
  if (input.accessCookie && verifyAccessToken(input.accessCookie, input.accessCode)) {
    return { allowed: true, scope: null };
  }
  const scopeParam = input.searchParams.get('as');
  const valid = verifyClassroomMediaSignature(
    input.classroomId,
    input.segments,
    input.searchParams.get('exp'),
    input.searchParams.get('sig'),
    input.nowMs,
    scopeParam,
  );
  if (!valid) return { allowed: false };
  return { allowed: true, scope: scopeParam === null ? null : decodeMediaAccessScope(scopeParam) };
}

/** {@link readGatedClassroomMediaAccess} as a boolean (the signature/cookie gate only). */
export function canReadGatedClassroomMedia(input: {
  accessCode: string;
  accessCookie: string | undefined;
  classroomId: string;
  segments: readonly string[];
  searchParams: URLSearchParams;
  nowMs?: number;
}): boolean {
  return readGatedClassroomMediaAccess(input).allowed;
}
