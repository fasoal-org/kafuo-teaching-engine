/**
 * Student context carried inside grants (Kafuo R1 contracts §3.1/§3.2, plan
 * §4.3, §9.3).
 *
 * Kafuo is the authority for who the student is and what they may study;
 * OpenMAIC only ever learns it through a service-key-authenticated mint and
 * then carries it, signed, inside the grant the Mobile client holds. Nothing
 * here is browser- or client-supplied. The parsers are shared by the Free
 * Chat handoff route (`/api/tutor/handoff`) and the learner-mode extension of
 * the editor handoff route, so both refuse exactly the same malformed shapes.
 *
 * `studentRef` is Kafuo-computed and opaque (contracts §1): an HMAC, never a
 * raw student id — the same rule the learner `learnerRef` already follows.
 */
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';

/** Contracts §1: `base64url(HMAC…)[:24]`, so 16..128 url-safe chars. */
export const STUDENT_REF_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Display labels are `string | null`: Kafuo's `master_subjects.name_ar`,
 * `subject_offerings.name_ar` and a lesson's level are nullable columns, and
 * the Backend forwards them as-is rather than inventing text (BR-03: the
 * academic context is trusted precisely because nothing is fabricated). The
 * prompt assembler renders a null label as absent.
 */
export interface StudentAcademic {
  /** Present on Free Chat handoffs (§3.1); the legacy help-turn shape omits it. */
  curriculumId?: string;
  curriculumName: string | null;
  curriculumVersionLabel: string | null;
  gradeLabel: string | null;
}

/** One routed subject the student may open in Free Chat (§3.1). */
export interface StudentSubject {
  code: string;
  offeringId: string;
  nameAr: string | null;
  nameEn: string | null;
  academicLanguage: string;
}

/**
 * The subject of a learner (Help) grant: the version's own subject (§3.2).
 * `code` is `null` when the lesson's master subject has no routing key: the
 * Stage still plays (the handoff is never refused for it), and Help refuses
 * with `SUBJECT_ROUTE_UNAVAILABLE` instead of falling back to a generic model
 * (ROUTE-01).
 */
export interface LearnerSubject {
  code: string | null;
  nameAr: string | null;
  nameEn: string | null;
  academicLanguage: string;
}

export interface StudentEntitlements {
  freeChat: boolean;
  help: boolean;
}

/**
 * The student block embedded in a learner grant (§3.2). Help refuses with
 * `HELP_GROUNDING_UNAVAILABLE` when a grant lacks it — the block is optional
 * on the wire so grants minted before P5 still verify.
 */
export interface LearnerStudentContext {
  studentRef: string;
  academic: StudentAcademic;
  subject: LearnerSubject;
  localeHint?: string;
  entitlements: { help: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TeachingPackageError('INVALID_REQUEST', `${where}.${key} must be a non-empty string`);
  }
  return value;
}

/** A label column that may legitimately be NULL upstream: string or null, never absent-as-garbage. */
function nullableString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new TeachingPackageError('INVALID_REQUEST', `${where}.${key} must be a string or null`);
  }
  return value.trim() === '' ? null : value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new TeachingPackageError('INVALID_REQUEST', `${where}.${key} must be a string`);
  }
  return value;
}

export function parseStudentRef(value: unknown, where = 'studentRef'): string {
  if (typeof value !== 'string' || !STUDENT_REF_PATTERN.test(value)) {
    throw new TeachingPackageError(
      'INVALID_REQUEST',
      `${where} must be an opaque 16..128 character url-safe token`,
    );
  }
  return value;
}

export function parseAcademic(
  value: unknown,
  options: { requireCurriculumId: boolean; where?: string },
): StudentAcademic {
  const where = options.where ?? 'academic';
  if (!isRecord(value)) {
    throw new TeachingPackageError('INVALID_REQUEST', `${where} must be an object`);
  }
  const curriculumId = options.requireCurriculumId
    ? requireString(value, 'curriculumId', where)
    : optionalString(value, 'curriculumId', where);
  return {
    ...(curriculumId === undefined ? {} : { curriculumId }),
    curriculumName: nullableString(value, 'curriculumName', where),
    curriculumVersionLabel: nullableString(value, 'curriculumVersionLabel', where),
    gradeLabel: nullableString(value, 'gradeLabel', where),
  };
}

export function parseStudentSubject(value: unknown, where = 'allowedSubjects[]'): StudentSubject {
  if (!isRecord(value)) {
    throw new TeachingPackageError('INVALID_REQUEST', `${where} must be an object`);
  }
  return {
    code: requireString(value, 'code', where),
    offeringId: requireString(value, 'offeringId', where),
    nameAr: nullableString(value, 'nameAr', where),
    nameEn: nullableString(value, 'nameEn', where),
    academicLanguage: requireString(value, 'academicLanguage', where),
  };
}

export function parseLearnerSubject(value: unknown, where = 'subject'): LearnerSubject {
  if (!isRecord(value)) {
    throw new TeachingPackageError('INVALID_REQUEST', `${where} must be an object`);
  }
  return {
    code: nullableString(value, 'code', where),
    nameAr: nullableString(value, 'nameAr', where),
    nameEn: nullableString(value, 'nameEn', where),
    academicLanguage: requireString(value, 'academicLanguage', where),
  };
}

export function parseLocaleHint(value: unknown, where = 'localeHint'): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 16) {
    throw new TeachingPackageError('INVALID_REQUEST', `${where} must be a short language tag`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, where: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new TeachingPackageError('INVALID_REQUEST', `${where}.${key} must be a boolean`);
  }
  return value;
}

export function parseStudentEntitlements(
  value: unknown,
  where = 'entitlements',
): StudentEntitlements {
  if (!isRecord(value)) {
    throw new TeachingPackageError('INVALID_REQUEST', `${where} must be an object`);
  }
  return {
    freeChat: requireBoolean(value, 'freeChat', where),
    help: requireBoolean(value, 'help', where),
  };
}

export function parseHelpEntitlements(value: unknown, where = 'entitlements'): { help: boolean } {
  if (!isRecord(value)) {
    throw new TeachingPackageError('INVALID_REQUEST', `${where} must be an object`);
  }
  return { help: requireBoolean(value, 'help', where) };
}

/**
 * Structural check for a `student` block read back out of a signed grant.
 * Grants are signed, so this guards against a payload minted by an older
 * build (or hand-assembled in a test) rather than against tampering.
 */
export function isLearnerStudentContext(value: unknown): value is LearnerStudentContext {
  if (!isRecord(value)) return false;
  if (typeof value.studentRef !== 'string' || !STUDENT_REF_PATTERN.test(value.studentRef)) {
    return false;
  }
  const nullableString = (candidate: unknown): boolean =>
    candidate === null || typeof candidate === 'string';
  const academic = value.academic;
  if (
    !isRecord(academic) ||
    !nullableString(academic.curriculumName) ||
    !nullableString(academic.curriculumVersionLabel) ||
    !nullableString(academic.gradeLabel)
  ) {
    return false;
  }
  const subject = value.subject;
  if (
    !isRecord(subject) ||
    !nullableString(subject.code) ||
    !nullableString(subject.nameAr) ||
    !nullableString(subject.nameEn) ||
    typeof subject.academicLanguage !== 'string'
  ) {
    return false;
  }
  if (value.localeHint !== undefined && typeof value.localeHint !== 'string') return false;
  const entitlements = value.entitlements;
  return isRecord(entitlements) && typeof entitlements.help === 'boolean';
}
