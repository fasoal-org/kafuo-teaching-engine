/**
 * Stage-scoped Editor grant (plan §12.2): Kafuo authorizes → TE mints a
 * handoff token (server-to-server) → the browser redeems it → the browser
 * holds a signed, HttpOnly capability for exactly one `stageId` (`read` for
 * preview, `write` for edit) plus an isolated runtime learner identity
 * (`tp:<nonce>`).
 *
 * Signing mirrors the repo's HMAC + digest/timing-safe idioms
 * (`middleware.ts`, `lib/persistence/server-auth.ts`); no new secret is
 * introduced (TEACHING_PACKAGE_GRANT_SECRET optionally overrides the service
 * key for rotation independence). The service owner principal is never written
 * to any cookie or response — the grant is the browser's only credential.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TEACHING_PACKAGE_GRANT_COOKIE = 'teaching_package_grant';
export const TEACHING_PACKAGE_LEARNER_COOKIE = 'teaching_package_learner_key';

export type EditorGrantCapability = 'read' | 'write';

export interface EditorHandoffPayload {
  v: 1;
  kind: 'handoff';
  versionId: string;
  stageId: string;
  capability: EditorGrantCapability;
  nonce: string;
  exp: number;
}

export interface EditorGrantPayload {
  v: 1;
  kind: 'grant';
  versionId: string;
  stageId: string;
  capability: EditorGrantCapability;
  learnerKey: string;
  exp: number;
}

export interface VerifiedEditorGrant {
  versionId: string;
  stageId: string;
  capability: EditorGrantCapability;
  learnerKey: string;
  exp: number;
}

const HANDOFF_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_SECONDS = 28800; // 8h
const MAX_GRANT_ENTRIES = 5;

function grantSecret(): string {
  const override = process.env.TEACHING_PACKAGE_GRANT_SECRET?.trim();
  return override || process.env.TEACHING_ENGINE_SERVICE_KEY?.trim() || '';
}

export function editorSessionSeconds(): number {
  const raw = Number(process.env.TEACHING_PACKAGE_EDITOR_SESSION_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SESSION_SECONDS;
}

function sign(payloadJson: string): string {
  return createHmac('sha256', grantSecret()).update(payloadJson).digest('hex');
}

function encodeSigned<T extends object>(payload: T): string {
  const payloadJson = JSON.stringify(payload);
  return `${Buffer.from(payloadJson, 'utf8').toString('base64url')}.${sign(payloadJson)}`;
}

function decodeSigned<T>(token: string): T | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadJson = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  const signature = token.slice(dot + 1);
  const expected = sign(payloadJson);
  const left = createHash('sha256').update(signature).digest();
  const right = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(left, right)) return null;
  try {
    return JSON.parse(payloadJson) as T;
  } catch {
    return null;
  }
}

/** Mint a single-purpose handoff token (exp ≤ 5 minutes). */
export function mintEditorHandoffToken(input: {
  versionId: string;
  stageId: string;
  capability: EditorGrantCapability;
  now?: number;
}): { token: string; expiresAt: number } {
  const now = input.now ?? Date.now();
  const expiresAt = now + HANDOFF_TTL_MS;
  const payload: EditorHandoffPayload = {
    v: 1,
    kind: 'handoff',
    versionId: input.versionId,
    stageId: input.stageId,
    capability: input.capability,
    nonce: randomBytes(12).toString('base64url'),
    exp: expiresAt,
  };
  return { token: encodeSigned(payload), expiresAt };
}

export function verifyEditorHandoffToken(token: string): EditorHandoffPayload | null {
  const payload = decodeSigned<EditorHandoffPayload>(token);
  if (!payload || payload.v !== 1 || payload.kind !== 'handoff') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

function grantFromPayload(payload: EditorGrantPayload): VerifiedEditorGrant | null {
  if (payload.v !== 1 || payload.kind !== 'grant') return null;
  if (payload.capability !== 'read' && payload.capability !== 'write') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (typeof payload.stageId !== 'string' || typeof payload.learnerKey !== 'string') return null;
  return {
    versionId: payload.versionId,
    stageId: payload.stageId,
    capability: payload.capability,
    learnerKey: payload.learnerKey,
    exp: payload.exp,
  };
}

/** Build a fresh grant payload for one stage (redeem-time). */
export function buildEditorGrantPayload(input: {
  versionId: string;
  stageId: string;
  capability: EditorGrantCapability;
  now?: number;
}): { payload: EditorGrantPayload; token: string } {
  const now = input.now ?? Date.now();
  const payload: EditorGrantPayload = {
    v: 1,
    kind: 'grant',
    versionId: input.versionId,
    stageId: input.stageId,
    capability: input.capability,
    learnerKey: `tp:${randomBytes(12).toString('base64url')}`,
    exp: now + editorSessionSeconds() * 1000,
  };
  return { payload, token: encodeSigned(payload) };
}

/**
 * The Set-Cookie pair a redeem writes: the HttpOnly grant cookie (whose value
 * is the serialized JSON array of grant tokens — the credential) and the
 * readable companion learner key (a partition name, not a credential).
 */
export function editorGrantCookieHeaders(grantCookieValue: string, learnerKey: string): string[] {
  const maxAge = editorSessionSeconds();
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return [
    `${TEACHING_PACKAGE_GRANT_COOKIE}=${encodeURIComponent(grantCookieValue)}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
    `${TEACHING_PACKAGE_LEARNER_COOKIE}=${encodeURIComponent(learnerKey)}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  ];
}

/** The Set-Cookie pair that releases a grant session. */
export function editorGrantReleaseCookieHeaders(): string[] {
  const expired = '=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0';
  const expiredLearner = '=; Path=/; SameSite=Lax; Max-Age=0';
  return [
    `${TEACHING_PACKAGE_GRANT_COOKIE}${expired}`,
    `${TEACHING_PACKAGE_LEARNER_COOKIE}${expiredLearner}`,
  ];
}

function parseCookieHeader(headers: Headers, name: string): string | undefined {
  const raw = headers.get('cookie');
  if (!raw) return undefined;
  for (const item of raw.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Every currently-valid grant entry the browser holds (newest last). */
export function readEditorGrants(headers: Headers): VerifiedEditorGrant[] {
  const raw = parseCookieHeader(headers, TEACHING_PACKAGE_GRANT_COOKIE);
  if (!raw) return [];
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const grants: VerifiedEditorGrant[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const payload = decodeSigned<EditorGrantPayload>(entry);
    const grant = payload ? grantFromPayload(payload) : null;
    if (grant) grants.push(grant);
  }
  return grants;
}

/** The valid grant entry for one Stage, if any. Never throws. */
export function readEditorGrant(headers: Headers, stageId: string): VerifiedEditorGrant | null {
  return readEditorGrants(headers).find((grant) => grant.stageId === stageId) ?? null;
}

/**
 * Serialize the cookie's entries with a new grant: replaces the entry for the
 * same Stage and evicts the oldest beyond the cap (§12.2).
 */
export function serializeGrantCookie(
  existingTokenEntries: string[],
  newToken: string,
  newStageId: string,
): string {
  // Keep only entries that are still valid and not for the replaced Stage.
  const kept = existingTokenEntries.filter((token) => {
    const payload = decodeSigned<EditorGrantPayload>(token);
    const grant = payload ? grantFromPayload(payload) : null;
    return grant !== null && grant.stageId !== newStageId;
  });
  while (kept.length >= MAX_GRANT_ENTRIES) kept.shift();
  kept.push(newToken);
  return JSON.stringify(kept);
}

/**
 * Serialize a new grant cookie value from the current request cookie and the
 * fresh grant token (redeem-time helper).
 */
export function grantCookieValueForRedeem(
  requestHeaders: Headers,
  newToken: string,
  newStageId: string,
): string {
  const raw = parseCookieHeader(requestHeaders, TEACHING_PACKAGE_GRANT_COOKIE);
  let entries: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed.filter((e): e is string => typeof e === 'string');
    } catch {
      entries = [];
    }
  }
  return serializeGrantCookie(entries, newToken, newStageId);
}

/** The minimal runtime-store surface Stage derivation needs. */
export interface RuntimeScopeStore {
  getSession(sessionId: string): Promise<
    | {
        stageId: string;
        learnerKey: string;
      }
    | undefined
  >;
}

export interface DerivedRuntimeScope {
  stageId: string;
  learnerKey: string;
  /** False for an unknown session: the handler should answer its own 404. */
  known: boolean;
}

/**
 * Derive the (stageId, learnerKey) scope a runtime request acts on, mirroring
 * the storage handler's path grammar — from the body (`POST /runtime/sessions`),
 * the path (stage-scoped routes), or the stored session. Admin and merge
 * routes derive nothing (they are not Stage-scoped) and answer null.
 */
export async function deriveRuntimeScope(
  method: string,
  path: string,
  body: unknown,
  runtimeStore: RuntimeScopeStore,
): Promise<DerivedRuntimeScope | null> {
  let parts: string[];
  try {
    // Segments arrive percent-encoded (learner keys contain `:`); decode them
    // exactly like the storage handler and parseDocumentAction do.
    parts = new URL(path, 'http://runtime.invalid').pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (parts[0] !== 'runtime') return null;
  const rest = parts.slice(1);

  // POST /runtime/sessions — scope from the JSON body.
  if (method === 'POST' && rest.length === 1 && rest[0] === 'sessions') {
    const init = body as { stageId?: unknown; learnerKey?: unknown } | null;
    if (
      init &&
      typeof init.stageId === 'string' &&
      init.stageId !== '' &&
      typeof init.learnerKey === 'string' &&
      init.learnerKey !== ''
    ) {
      return { stageId: init.stageId, learnerKey: init.learnerKey, known: true };
    }
    return null;
  }

  // Session-scoped routes: /runtime/sessions/<id>[/status|/records[/...]].
  if (rest[0] === 'sessions' && rest.length >= 2) {
    const session = await runtimeStore.getSession(rest[1]!).catch(() => undefined);
    if (!session) return null;
    return { stageId: session.stageId, learnerKey: session.learnerKey, known: false };
  }

  // Stage-scoped routes:
  // GET /runtime/stages/<stageId>/learners/<lk>/sessions,
  // DELETE /runtime/stages/<stageId>/learners/<lk>.
  if (rest[0] === 'stages' && rest[2] === 'learners') {
    if (rest.length === 5 && rest[4] === 'sessions') {
      return { stageId: rest[1]!, learnerKey: rest[3]!, known: true };
    }
    if (method === 'DELETE' && rest.length === 4) {
      return { stageId: rest[1]!, learnerKey: rest[3]!, known: true };
    }
  }

  // Admin/merge/everything else: not Stage-scoped.
  return null;
}

/** The Stage a document action targets, or null for list/unknown actions. */
export function deriveDocumentStageId(action: { kind: string; stageId?: string }): string | null {
  if (
    (action.kind === 'read' ||
      action.kind === 'create' ||
      action.kind === 'write' ||
      action.kind === 'delete') &&
    typeof action.stageId === 'string'
  ) {
    return action.stageId;
  }
  return null;
}
