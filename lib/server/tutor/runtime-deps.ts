/**
 * Process-wide dependencies of the tutor runtime (pool, Kafuo client, clock,
 * executor seams) with a test override, so routes stay thin and suites can
 * plug PGlite + a fake Kafuo without mocking every module.
 *
 * `Symbol.for` memo like the other runtime registries: the override survives
 * `vi.resetModules()` and is visible across bundles.
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import type { AppDocument } from '@/lib/document-store/persistence-types';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { TeachingCallOptions } from '@/lib/server/teaching-model/execute';
import type { DirectGroundingDeps } from '@/lib/server/tutor/grounding/kafuo-grounding-reader';
import { getKafuoGroundingReader } from '@/lib/server/tutor/grounding/pg-grounding-reader';
import { createQueryEmbedder } from '@/lib/server/tutor/grounding/query-embedding';
import {
  getKafuoIntegrationClient,
  type KafuoIntegrationClient,
} from '@/lib/server/tutor/kafuo-integration-client';

export interface TutorRuntimeDeps {
  pool: ConnectableQueryable;
  kafuo: KafuoIntegrationClient;
  /** Epoch ms clock. */
  now: () => number;
  workerId?: string;
  idFactory?: () => string;
  executor?: Pick<
    TeachingCallOptions,
    'rateCard' | 'proxyRatioReader' | 'completionRetryDelaysMs' | 'timeoutMs' | 'idFactory'
  >;
  inProgressWindowS?: number;
  heartbeatMs?: number;
  completionTxRetryDelaysMs?: readonly number[];
  /**
   * Help: the pinned Stage document reader (the Scene lives there). Defaults
   * to the owner-scoped teaching-package document store; tests plug PGlite.
   */
  loadStageDocument?: (stageId: string) => Promise<AppDocument | null>;
  /**
   * Free Chat `direct` / `shadow` grounding (discovery-first P6/P7): the Kafuo
   * grounding reader + query embedder seam. Wired (P6) when
   * `KAFUO_GROUNDING_DATABASE_URL` is set; while unset,
   * `TUTOR_GROUNDING_SOURCE=direct` falls back to `kafuo_http` and `shadow`
   * records "not available".
   */
  grounding?: DirectGroundingDeps;
}

const OVERRIDE_KEY = Symbol.for('openmaic.tutor.runtime-deps-override');

function overrides(): { deps?: TutorRuntimeDeps } {
  const registry = globalThis as Record<symbol, { deps?: TutorRuntimeDeps } | undefined>;
  return (registry[OVERRIDE_KEY] ??= {});
}

/** Test seam: replace the runtime deps for this process (undefined clears). */
export function setTutorRuntimeDepsForTests(deps: TutorRuntimeDeps | undefined): void {
  overrides().deps = deps;
}

const GROUNDING_OVERRIDE_KEY = Symbol.for('openmaic.tutor.direct-grounding-override');
const EMBEDDER_KEY = Symbol.for('openmaic.tutor.query-embedder');

/**
 * Test seam beside `setTutorRuntimeDepsForTests`: replace the process's direct
 * grounding deps (`null` = none, `undefined` clears the override).
 */
export function setDirectGroundingDepsForTests(deps: DirectGroundingDeps | null | undefined): void {
  const registry = globalThis as Record<symbol, { deps: DirectGroundingDeps | null } | undefined>;
  registry[GROUNDING_OVERRIDE_KEY] = deps === undefined ? undefined : { deps };
}

/** The pg reader + query embedder, when `KAFUO_GROUNDING_DATABASE_URL` is set (lazy pool). */
export function resolveDirectGroundingDeps(): DirectGroundingDeps | undefined {
  const registry = globalThis as Record<symbol, unknown>;
  const override = registry[GROUNDING_OVERRIDE_KEY] as
    | { deps: DirectGroundingDeps | null }
    | undefined;
  if (override) return override.deps ?? undefined;
  const reader = getKafuoGroundingReader();
  if (!reader) return undefined;
  const embedder = (registry[EMBEDDER_KEY] ??=
    createQueryEmbedder()) as DirectGroundingDeps['embedder'];
  return { reader, embedder };
}

export async function resolveTutorRuntimeDeps(): Promise<TutorRuntimeDeps> {
  const override = overrides().deps;
  if (override) return override;
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const grounding = resolveDirectGroundingDeps();
  return {
    pool: pool as unknown as ConnectableQueryable,
    kafuo: getKafuoIntegrationClient(),
    now: Date.now,
    ...(grounding ? { grounding } : {}),
  };
}
