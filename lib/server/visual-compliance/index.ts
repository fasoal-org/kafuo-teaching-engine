/**
 * Visual compliance — public surface and the default dependency wiring.
 */
import { createLogger } from '@/lib/logger';
import { screenVisual, type ScreenVisualDeps } from './screen-visual';
import { MemoryVerdictStore, PgVerdictStore } from './verdict-store';
import { getVisionScreeningClient } from './vision-client';
import type { ComplianceVerdict, ScreenVisualOptions, VerdictStore } from './types';

export * from './types';
export * from './brand-profile';
export * from './screen-visual';
export * from './verdict-store';
export {
  getVisionScreeningClient,
  parseVisionAnswer,
  resetVisionScreeningClient,
} from './vision-client';

const log = createLogger('VisualCompliance');
let defaultStore: Promise<VerdictStore> | undefined;

/** The shared verdict store: Postgres when configured, else process-local. */
export function getVerdictStore(): Promise<VerdictStore> {
  defaultStore ??= (async () => {
    if (!process.env.DATABASE_URL) return new MemoryVerdictStore();
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL);
    return new PgVerdictStore(pool as never);
  })();
  return defaultStore;
}

/** Test seam: inject or reset the shared store. */
export function setVerdictStore(store: VerdictStore | undefined): void {
  defaultStore = store ? Promise.resolve(store) : undefined;
}

/** `screenVisual` with the deployment's store and vision client. */
export async function screenVisualWithDefaults(
  bytes: Buffer,
  options: ScreenVisualOptions,
  overrides: Partial<ScreenVisualDeps> = {},
): Promise<ComplianceVerdict> {
  const store = overrides.store ?? (await getVerdictStore());
  const vision = 'vision' in overrides ? overrides.vision : await getVisionScreeningClient();
  const verdict = await screenVisual(bytes, options, {
    store,
    vision,
    log: (message) => log.warn(message),
    ...overrides,
  });
  if (verdict.verdict !== 'approved') {
    log.warn(
      `Visual ${verdict.checksum.slice(0, 12)} (${options.origin}) withheld — ${verdict.verdict}: ${verdict.reasons.join('; ')}`,
    );
  }
  return verdict;
}
