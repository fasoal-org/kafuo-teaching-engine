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

export async function resolveTutorRuntimeDeps(): Promise<TutorRuntimeDeps> {
  const override = overrides().deps;
  if (override) return override;
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return {
    pool: pool as unknown as ConnectableQueryable,
    kafuo: getKafuoIntegrationClient(),
    now: Date.now,
  };
}
