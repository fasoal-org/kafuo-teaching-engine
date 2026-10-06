/**
 * Kafuo R1 student handoff + student grant (contracts §3.1, §5; plan §4.3,
 * §9.3, P5).
 *
 * Flow: Kafuo (service key) mints a short-lived HANDOFF for one student →
 * Mobile redeems it at `GET /api/tutor/handoff/redeem` → Mobile holds a
 * STUDENT GRANT (`Authorization: Bearer tsg.<payload>.<hmac>`, TTL 60 min) that
 * is the only credential on `app/api/tutor/**` Free Chat routes.
 *
 * Kinds are distinct and never interchangeable (§5): a student grant is
 * `kind: 'student-grant'`; the learner (Help) cookie grant is `kind: 'grant'`
 * with `purpose: 'learner'`. Both are signed with the same secret through
 * `signed-token.ts`, and each verifier checks its own `kind` after the
 * signature, so presenting one as the other is `GRANT_INVALID` (401).
 *
 * The grant carries the intersection of Kafuo's `allowedSubjects` with the
 * code-owned policy table (§3.1): a subject Kafuo allows but OpenMAIC cannot
 * route is dropped at redeem, and the redeem response reports what remains
 * (an empty list is a valid "unavailable" state for the client).
 */
import { randomBytes } from 'node:crypto';

import { handoffTtlMs } from '@/lib/server/teaching-package/editor-grant';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { decodeSigned, encodeSigned } from '@/lib/server/teaching-package/signed-token';
import { isSubjectCode } from '@/lib/server/teaching-model/subject-policy';
import {
  STUDENT_REF_PATTERN,
  type StudentAcademic,
  type StudentEntitlements,
  type StudentSubject,
} from '@/lib/server/tutor/student-context';

export const STUDENT_GRANT_PREFIX = 'tsg.';
const DEFAULT_STUDENT_GRANT_TTL_SECONDS = 3600;

export type StudentHandoffPurpose = 'free_chat';

export interface StudentHandoffPayload {
  v: 1;
  kind: 'student-handoff';
  tenantId: string;
  studentRef: string;
  academic: StudentAcademic;
  allowedSubjects: StudentSubject[];
  localeHint?: string;
  entitlements: StudentEntitlements;
  nonce: string;
  /** Epoch ms. */
  exp: number;
}

export interface StudentGrantPayload {
  v: 1;
  kind: 'student-grant';
  tenantId: string;
  studentRef: string;
  academic: StudentAcademic;
  /** Kafuo's list ∩ the policy table, fixed at redeem. */
  allowedSubjects: StudentSubject[];
  localeHint?: string;
  entitlements: StudentEntitlements;
  /** Epoch ms. */
  exp: number;
}

/** `TUTOR_STUDENT_GRANT_TTL_SECONDS`, default 3600 (contracts §5: 60 min). */
export function studentGrantTtlSeconds(): number {
  const raw = Number(process.env.TUTOR_STUDENT_GRANT_TTL_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_STUDENT_GRANT_TTL_SECONDS;
}

export interface MintStudentHandoffInput {
  tenantId: string;
  studentRef: string;
  academic: StudentAcademic;
  allowedSubjects: StudentSubject[];
  localeHint?: string;
  entitlements: StudentEntitlements;
  now?: number;
}

/** Mint a single-use-intended handoff for one student (TTL 5 min, `handoffTtlMs`). */
export function mintStudentHandoff(input: MintStudentHandoffInput): {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
} {
  const now = input.now ?? Date.now();
  const expiresAt = now + handoffTtlMs();
  const payload: StudentHandoffPayload = {
    v: 1,
    kind: 'student-handoff',
    tenantId: input.tenantId,
    studentRef: input.studentRef,
    academic: input.academic,
    allowedSubjects: input.allowedSubjects,
    ...(input.localeHint ? { localeHint: input.localeHint } : {}),
    entitlements: input.entitlements,
    nonce: randomBytes(12).toString('base64url'),
    exp: expiresAt,
  };
  return { token: encodeSigned(payload), expiresAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isAcademic(value: unknown): value is StudentAcademic {
  return (
    isRecord(value) &&
    isNullableString(value.curriculumName) &&
    isNullableString(value.curriculumVersionLabel) &&
    isNullableString(value.gradeLabel) &&
    (value.curriculumId === undefined || typeof value.curriculumId === 'string')
  );
}

function isSubjectList(value: unknown): value is StudentSubject[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.code === 'string' &&
        typeof entry.offeringId === 'string' &&
        isNullableString(entry.nameAr) &&
        isNullableString(entry.nameEn) &&
        typeof entry.academicLanguage === 'string',
    )
  );
}

function isEntitlements(value: unknown): value is StudentEntitlements {
  return isRecord(value) && typeof value.freeChat === 'boolean' && typeof value.help === 'boolean';
}

/** Structural checks shared by both payload kinds (signature already verified). */
function hasStudentShape(payload: Record<string, unknown>): boolean {
  return (
    payload.v === 1 &&
    typeof payload.tenantId === 'string' &&
    payload.tenantId !== '' &&
    typeof payload.studentRef === 'string' &&
    STUDENT_REF_PATTERN.test(payload.studentRef) &&
    isAcademic(payload.academic) &&
    isSubjectList(payload.allowedSubjects) &&
    (payload.localeHint === undefined || typeof payload.localeHint === 'string') &&
    isEntitlements(payload.entitlements) &&
    typeof payload.exp === 'number'
  );
}

function invalid(message: string): TeachingPackageError {
  return new TeachingPackageError('GRANT_INVALID', message);
}

/**
 * Verify a handoff token. Throws `GRANT_INVALID` for anything not a
 * well-formed, intact `student-handoff` (including a student GRANT or an
 * editor handoff presented here) and `GRANT_EXPIRED` once `exp` has passed.
 */
export function verifyStudentHandoff(
  token: string,
  now: number = Date.now(),
): StudentHandoffPayload {
  const payload = decodeSigned<Record<string, unknown>>(token);
  if (!payload || payload.kind !== 'student-handoff' || !hasStudentShape(payload)) {
    throw invalid('the student handoff token is invalid');
  }
  if (typeof payload.nonce !== 'string') throw invalid('the student handoff token is invalid');
  if ((payload.exp as number) < now) {
    throw new TeachingPackageError('GRANT_EXPIRED', 'the student handoff token has expired');
  }
  return payload as unknown as StudentHandoffPayload;
}

/** Kafuo's list ∩ the policy table, order preserved, duplicates by code dropped. */
export function intersectWithPolicy(subjects: readonly StudentSubject[]): StudentSubject[] {
  const seen = new Set<string>();
  const kept: StudentSubject[] = [];
  for (const subject of subjects) {
    if (!isSubjectCode(subject.code) || seen.has(subject.code)) continue;
    seen.add(subject.code);
    kept.push(subject);
  }
  return kept;
}

export interface RedeemedStudentGrant {
  /** The bearer credential: `tsg.<base64url payload>.<hex hmac>`. */
  grant: string;
  payload: StudentGrantPayload;
  /** Epoch ms. */
  expiresAt: number;
  subjects: StudentSubject[];
  academic: StudentAcademic;
}

/**
 * Redeem a handoff into a student grant (contracts §5 row 1). The grant's
 * subject list is the policy intersection; everything else is carried from
 * the handoff verbatim. Throws exactly what `verifyStudentHandoff` throws.
 */
export function redeemStudentHandoff(
  token: string,
  now: number = Date.now(),
): RedeemedStudentGrant {
  const handoff = verifyStudentHandoff(token, now);
  const subjects = intersectWithPolicy(handoff.allowedSubjects);
  const expiresAt = now + studentGrantTtlSeconds() * 1000;
  const payload: StudentGrantPayload = {
    v: 1,
    kind: 'student-grant',
    tenantId: handoff.tenantId,
    studentRef: handoff.studentRef,
    academic: handoff.academic,
    allowedSubjects: subjects,
    ...(handoff.localeHint ? { localeHint: handoff.localeHint } : {}),
    entitlements: handoff.entitlements,
    exp: expiresAt,
  };
  return {
    grant: `${STUDENT_GRANT_PREFIX}${encodeSigned(payload)}`,
    payload,
    expiresAt,
    subjects,
    academic: handoff.academic,
  };
}

/**
 * Verify the `Authorization` header of a Free Chat request. Accepts exactly
 * `Bearer tsg.<payload>.<hmac>` whose payload is an intact `student-grant`;
 * a learner grant (`kind: 'grant'`), an editor handoff, a student handoff or
 * the service key presented here are all `GRANT_INVALID`.
 */
export function verifyStudentGrant(
  authorizationHeader: string | null | undefined,
  now: number = Date.now(),
): StudentGrantPayload {
  const header = authorizationHeader ?? '';
  if (!header.startsWith('Bearer ')) throw invalid('a student grant bearer token is required');
  const token = header.slice(7).trim();
  if (!token.startsWith(STUDENT_GRANT_PREFIX)) throw invalid('the student grant is invalid');
  const payload = decodeSigned<Record<string, unknown>>(token.slice(STUDENT_GRANT_PREFIX.length));
  if (!payload || payload.kind !== 'student-grant' || !hasStudentShape(payload)) {
    throw invalid('the student grant is invalid');
  }
  if ((payload.exp as number) < now) {
    throw new TeachingPackageError('GRANT_EXPIRED', 'the student grant has expired');
  }
  return payload as unknown as StudentGrantPayload;
}
