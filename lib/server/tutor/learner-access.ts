/**
 * Learner grant re-validation (Kafuo launch plan Wave 2, ET-16 (c); G2).
 *
 * A learner grant cookie lives `TEACHING_PACKAGE_EDITOR_SESSION_SECONDS` (8 h by
 * default). Help turns already re-check access on every reserve, but the Stage
 * document, the signed media and the Help history were served for the grant's
 * whole life — after Premium ended, the account was suspended or the lesson was
 * put on hold. Every such read under a LEARNER grant now asks Kafuo
 * (`POST /learner-access/check`, contracts §2.4) whether the grant's student may
 * still open the grant's learning item; edit, preview and write grants are never
 * checked.
 *
 * - **Cache.** One answer per (tenant, studentRef, learning item), for
 *   `LEARNER_ACCESS_CACHE_SECONDS` (default 60, capped at 300, `0` disables). Only
 *   Kafuo's answers are cached (allowed or refused); an unreachable Kafuo or a
 *   `temporarily_unavailable` answer is never cached. In memory, per instance,
 *   bounded. The version → learning item mapping is immutable and cached apart.
 * - **Fail closed.** Kafuo unreachable, a 5xx, a contract 4xx or a misconfigured
 *   entitlement mode → `unavailable` (the caller answers a retryable 503). An
 *   unknown `studentRef` (404) is a refusal.
 * - **A learner grant without the student block cannot be checked** and is served
 *   as before (logged once per version and instance). Kafuo sends the handoff
 *   without the block whenever the learner context does not resolve — today that
 *   is EVERY SECTION Stage (the context resolver walks the lesson hierarchy only),
 *   so refusing it would take every SECTION Stage down. Closing this needs Kafuo to
 *   send at least the `studentRef` for SECTION handoffs (lead decision, G2).
 * - **Not configured.** Without `KAFUO_INTEGRATION_BASE_URL` / the shared secret
 *   the check is skipped OUTSIDE production only (local development keeps today's
 *   behaviour, logged once). In production an unconfigured integration fails
 *   closed (`INTEGRATION_NOT_CONFIGURED`, 503).
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import { readVersion } from '@/lib/persistence/teaching-package';
import type { VerifiedEditorGrant } from '@/lib/server/teaching-package/editor-grant';
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import { describeErrorSafely } from '@/lib/server/teaching-package/safe-error';
import {
  getKafuoIntegrationClient,
  isKafuoIntegrationConfigured,
  isKafuoUnreachableError,
  KafuoIntegrationError,
  type LearnerAccessCheckRequest,
  type LearnerAccessCheckResult,
} from '@/lib/server/tutor/kafuo-integration-client';

const log = createLogger('TutorLearnerAccess');

export const DEFAULT_LEARNER_ACCESS_CACHE_SECONDS = 60;
/** The task bound (G2): a revoked grant is noticed within five minutes at most. */
export const MAX_LEARNER_ACCESS_CACHE_SECONDS = 300;
const MAX_CACHE_ENTRIES = 5_000;
/** Retry hint on a fail-closed answer (seconds). */
export const LEARNER_ACCESS_RETRY_AFTER_S = 5;

/** Why a learner grant could not be checked: it carries no student block (logged). */
export const LEARNER_CONTEXT_MISSING = 'learner_context_missing';
/** The refusal reason when Kafuo does not know the grant's `studentRef`. */
export const STUDENT_REF_UNKNOWN = 'student_ref_unknown';

export function learnerAccessCacheSeconds(): number {
  const raw = process.env.LEARNER_ACCESS_CACHE_SECONDS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_LEARNER_ACCESS_CACHE_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_LEARNER_ACCESS_CACHE_SECONDS;
  return Math.min(Math.floor(value), MAX_LEARNER_ACCESS_CACHE_SECONDS);
}

/** Who and what a learner read is checked for (also signed into media links). */
export interface LearnerAccessScope {
  tenantId: string;
  studentRef: string;
  learningItemId: string;
  learningItemType: string | null;
}

export type LearnerAccessOutcome =
  /** `scope` is null when no check applied (not a learner grant, or local dev). */
  | { kind: 'allowed'; scope: LearnerAccessScope | null }
  | { kind: 'denied'; reason: string }
  | { kind: 'unavailable'; reason: 'not_configured' | 'unreachable' | 'temporarily_unavailable' };

export interface LearnerAccessDeps {
  /** Reads the grant's version (→ learning item). Not needed by `checkLearnerAccessScope`. */
  pool?: Queryable;
  client?: {
    checkLearnerAccess(request: LearnerAccessCheckRequest): Promise<LearnerAccessCheckResult>;
  };
  /** Epoch ms. */
  now?: () => number;
  /** Defaults to `isKafuoIntegrationConfigured()`. */
  configured?: boolean;
  /** Defaults to `NODE_ENV === 'production'`. */
  production?: boolean;
}

// ---------------------------------------------------------------------------
// Caches (process memory, bounded)

interface CachedAnswer {
  allowed: boolean;
  reason: string | null;
  expiresAt: number;
}

interface CacheState {
  answers: Map<string, CachedAnswer>;
  items: Map<string, { id: string; type: string | null }>;
  warnedUnconfigured: boolean;
  /** Versions whose context-less learner grants were already logged. */
  warnedNoContext: Map<string, true>;
}

const CACHE_KEY = Symbol.for('openmaic.tutor.learner-access-cache');

function cache(): CacheState {
  const registry = globalThis as Record<symbol, CacheState | undefined>;
  return (registry[CACHE_KEY] ??= {
    answers: new Map(),
    items: new Map(),
    warnedUnconfigured: false,
    warnedNoContext: new Map(),
  });
}

/** Test seam: forget every cached answer and learning item. */
export function resetLearnerAccessCacheForTests(): void {
  const state = cache();
  state.answers.clear();
  state.items.clear();
  state.warnedUnconfigured = false;
  state.warnedNoContext.clear();
}

function boundedSet<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function scopeKey(scope: LearnerAccessScope): string {
  return JSON.stringify([
    scope.tenantId,
    scope.studentRef,
    scope.learningItemType ?? '',
    scope.learningItemId,
  ]);
}

function isProduction(deps: LearnerAccessDeps): boolean {
  return deps.production ?? process.env.NODE_ENV === 'production';
}

function isConfigured(deps: LearnerAccessDeps): boolean {
  return deps.configured ?? isKafuoIntegrationConfigured();
}

// ---------------------------------------------------------------------------
// The check

/**
 * Kafuo's answer for one scope, through the cache. Used directly by the media
 * route (the scope arrives signed in the link) and by `evaluateLearnerGrantAccess`.
 */
export async function checkLearnerAccessScope(
  scope: LearnerAccessScope,
  deps: LearnerAccessDeps = {},
): Promise<LearnerAccessOutcome> {
  if (!isConfigured(deps)) {
    if (isProduction(deps)) return { kind: 'unavailable', reason: 'not_configured' };
    const state = cache();
    if (!state.warnedUnconfigured) {
      state.warnedUnconfigured = true;
      log.warn(
        JSON.stringify({
          event: 'tutor.learner_access_unchecked',
          detail:
            'KAFUO_INTEGRATION_BASE_URL is unset; learner reads are not re-validated (development only)',
        }),
      );
    }
    return { kind: 'allowed', scope };
  }
  const now = (deps.now ?? Date.now)();
  const key = scopeKey(scope);
  const { answers } = cache();
  const cached = answers.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.allowed
      ? { kind: 'allowed', scope }
      : { kind: 'denied', reason: cached.reason ?? 'academic_unavailable' };
  }
  if (cached) answers.delete(key);

  let result: LearnerAccessCheckResult;
  try {
    result = await (deps.client ?? getKafuoIntegrationClient()).checkLearnerAccess({
      tenantId: scope.tenantId,
      studentRef: scope.studentRef,
      learningItemId: scope.learningItemId,
      learningItemType: scope.learningItemType,
    });
  } catch (error) {
    if (
      !isKafuoUnreachableError(error) &&
      error instanceof KafuoIntegrationError &&
      error.status === 404 &&
      error.code === STUDENT_REF_UNKNOWN
    ) {
      result = { allowed: false, reason: STUDENT_REF_UNKNOWN };
    } else {
      log.warn(
        JSON.stringify({
          event: 'tutor.learner_access_unavailable',
          error: describeErrorSafely(error).name,
          status: error instanceof KafuoIntegrationError ? error.status : null,
        }),
      );
      return { kind: 'unavailable', reason: 'unreachable' };
    }
  }
  if (!result.allowed && result.reason === 'temporarily_unavailable') {
    return { kind: 'unavailable', reason: 'temporarily_unavailable' };
  }
  const ttlMs = learnerAccessCacheSeconds() * 1000;
  if (ttlMs > 0) {
    boundedSet(answers, key, {
      allowed: result.allowed,
      reason: result.allowed ? null : result.reason,
      expiresAt: now + ttlMs,
    });
  }
  if (result.allowed) return { kind: 'allowed', scope };
  log.info(
    JSON.stringify({
      event: 'tutor.learner_access_refused',
      tenantId: scope.tenantId,
      learningItemId: scope.learningItemId,
      reason: result.reason,
    }),
  );
  return { kind: 'denied', reason: result.reason };
}

async function learningItemOf(
  pool: Queryable,
  tenantId: string,
  versionId: string,
): Promise<{ id: string; type: string | null } | null> {
  const key = JSON.stringify([tenantId, versionId]);
  const { items } = cache();
  const known = items.get(key);
  if (known) return known;
  const version = await readVersion(pool, versionId, { tenantId });
  if (!version) return null;
  const item = { id: version.learningItem.id, type: version.learningItem.type ?? null };
  boundedSet(items, key, item);
  return item;
}

/**
 * The re-validation of one read under `grant`.
 *
 * Not a learner grant → allowed, no scope (edit / preview / write are never
 * checked). A learner grant → its version's learning item, then Kafuo's answer for
 * (tenant, studentRef, item). `scope` on an allowed outcome is what a media link
 * signs, so the media route can repeat the check without a cookie.
 */
export async function evaluateLearnerGrantAccess(
  grant: Pick<VerifiedEditorGrant, 'tenantId' | 'versionId' | 'purpose' | 'student'>,
  deps: LearnerAccessDeps,
): Promise<LearnerAccessOutcome> {
  if (grant.purpose !== 'learner') return { kind: 'allowed', scope: null };
  const enforced = isConfigured(deps) || isProduction(deps);
  if (!grant.student) {
    // No studentRef to check with (every SECTION Stage today): served as before.
    const { warnedNoContext } = cache();
    const versionKey = JSON.stringify([grant.tenantId, grant.versionId]);
    if (enforced && !warnedNoContext.has(versionKey)) {
      boundedSet(warnedNoContext, versionKey, true);
      log.warn(
        JSON.stringify({
          event: 'tutor.learner_access_unchecked',
          reason: LEARNER_CONTEXT_MISSING,
          tenantId: grant.tenantId,
          versionId: grant.versionId,
        }),
      );
    }
    return { kind: 'allowed', scope: null };
  }
  if (!enforced) {
    // Local development without the integration: no check (logged once); a best
    // effort scope still signs media links the same way production does.
    const item = deps.pool
      ? await learningItemOf(deps.pool, grant.tenantId, grant.versionId).catch(() => null)
      : null;
    if (!item) return { kind: 'allowed', scope: null };
    return checkLearnerAccessScope(
      {
        tenantId: grant.tenantId,
        studentRef: grant.student.studentRef,
        learningItemId: item.id,
        learningItemType: item.type,
      },
      deps,
    );
  }
  if (!isConfigured(deps)) return { kind: 'unavailable', reason: 'not_configured' };
  if (!deps.pool) throw new Error('evaluateLearnerGrantAccess needs a pool for a learner grant');
  let item: { id: string; type: string | null } | null;
  try {
    item = await learningItemOf(deps.pool, grant.tenantId, grant.versionId);
  } catch (error) {
    log.warn(
      JSON.stringify({
        event: 'tutor.learner_access_unavailable',
        error: describeErrorSafely(error).name,
        stage: 'version_read',
      }),
    );
    return { kind: 'unavailable', reason: 'unreachable' };
  }
  if (!item) return { kind: 'denied', reason: 'learning_item_unresolved' };
  return checkLearnerAccessScope(
    {
      tenantId: grant.tenantId,
      studentRef: grant.student.studentRef,
      learningItemId: item.id,
      learningItemType: item.type,
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Refusal → error envelopes

/**
 * Delivery reads (Stage document, signed media): `ACCOUNT_INACTIVE` (403) for an
 * inactive account, `LEARNER_ACCESS_REVOKED` (403, `details.reason`) for any
 * other refusal, `LEARNER_ACCESS_UNAVAILABLE` / `INTEGRATION_NOT_CONFIGURED`
 * (503, retryable) when the check could not be made. `null` when allowed.
 */
export function learnerDeliveryError(outcome: LearnerAccessOutcome): TeachingPackageError | null {
  if (outcome.kind === 'allowed') return null;
  if (outcome.kind === 'unavailable') {
    return outcome.reason === 'not_configured'
      ? new TeachingPackageError(
          'INTEGRATION_NOT_CONFIGURED',
          'the learner access check is not configured (KAFUO_INTEGRATION_BASE_URL)',
          { retryAfterS: LEARNER_ACCESS_RETRY_AFTER_S },
        )
      : new TeachingPackageError(
          'LEARNER_ACCESS_UNAVAILABLE',
          'the learner access check could not be completed; try again shortly',
          { retryAfterS: LEARNER_ACCESS_RETRY_AFTER_S },
        );
  }
  if (outcome.reason === 'account_inactive') {
    return new TeachingPackageError('ACCOUNT_INACTIVE', 'the student account is not active', {
      reason: outcome.reason,
    });
  }
  return new TeachingPackageError(
    'LEARNER_ACCESS_REVOKED',
    'the student can no longer open this lesson',
    { reason: outcome.reason },
  );
}

/**
 * Help reads (the Help history): the Help turn's own refusal mapping
 * (`turn-runner.refusalCode`), so the app shows the same denial sheet it shows
 * for a refused turn — `ALLOWANCE_EXHAUSTED` (429) with `details.reason`,
 * `ACCOUNT_INACTIVE` (403), `METER_UNAVAILABLE` (503, retryable).
 */
export function learnerHelpError(outcome: LearnerAccessOutcome): TeachingPackageError | null {
  if (outcome.kind === 'allowed') return null;
  if (outcome.kind === 'unavailable') {
    return new TeachingPackageError(
      'METER_UNAVAILABLE',
      'the entitlement service could not confirm access; try again shortly',
      { retryAfterS: LEARNER_ACCESS_RETRY_AFTER_S },
    );
  }
  if (outcome.reason === 'account_inactive') {
    return new TeachingPackageError('ACCOUNT_INACTIVE', 'the student account is not active', {
      reason: outcome.reason,
    });
  }
  return new TeachingPackageError(
    'ALLOWANCE_EXHAUSTED',
    'the student can no longer open this lesson',
    {
      reason: outcome.reason,
      window: null,
      resetAt: null,
    },
  );
}
