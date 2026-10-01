import { apiSuccess } from '@/lib/server/api-response';
import { isTeachingPackageApiConfigured } from '@/lib/config/feature-flags';
import {
  getServerWebSearchProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
} from '@/lib/server/provider-config';
import {
  accountingSweeperStatus,
  countStartedRowsPastDeadline,
} from '@/lib/server/teaching-model/accounting-sweeper';
import { getMeterOutboxSweeper } from '@/lib/server/teaching-model/sweep-registry';
import { kafuoGroundingHealth } from '@/lib/server/tutor/grounding/pg-grounding-reader';

const version = process.env.npm_package_version || '0.1.0';

/**
 * Accounting sweeper visibility (Kafuo R1 plan §9.1): a deployment whose
 * sweepers are not running (§9.4) shows up here as a stale `lastLedgerSweepAt`
 * and a growing `startedRowsOlderThanDeadline`; Kafuo's health poll alerts on
 * `lastMeterSweepAt` older than 5 min. Every field is `null` when unknown —
 * health never fails because the ledger cannot be read, and the meter fields
 * stay `null` until the meter outbox sweeper (P5) registers.
 */
async function accountingBlock() {
  const status = accountingSweeperStatus();
  let startedRowsOlderThanDeadline: number | null = null;
  let lastMeterSweepAt: number | null = null;
  let pendingFinalizes: number | null = null;
  let oldestPendingFinalizeAgeS: number | null = null;
  if (isTeachingPackageApiConfigured()) {
    try {
      startedRowsOlderThanDeadline = await countStartedRowsPastDeadline();
    } catch {
      startedRowsOlderThanDeadline = null;
    }
    const meter = getMeterOutboxSweeper();
    if (meter) {
      try {
        const health = await meter.readMeterOutboxHealth();
        lastMeterSweepAt = health.lastMeterSweepAt;
        pendingFinalizes = health.pendingFinalizes;
        oldestPendingFinalizeAgeS = health.oldestPendingFinalizeAgeS;
      } catch {
        /* reported as unknown */
      }
    }
  }
  return {
    lastLedgerSweepAt: status.lastLedgerSweepAt,
    lastMeterSweepAt,
    pendingFinalizes,
    oldestPendingFinalizeAgeS,
    startedRowsOlderThanDeadline,
  };
}

export async function GET() {
  return apiSuccess({
    status: 'ok',
    version,
    capabilities: {
      // A capability is available only when at least one provider is enabled —
      // force-disabled providers (disabled: true) do not count (#665).
      webSearch: Object.values(getServerWebSearchProviders()).some((info) => !info.disabled),
      imageGeneration: Object.values(getServerImageProviders()).some((info) => !info.disabled),
      videoGeneration: Object.values(getServerVideoProviders()).some((info) => !info.disabled),
      tts: Object.values(getServerTTSProviders()).some((info) => !info.disabled),
    },
    accounting: await accountingBlock(),
    // Free Chat direct grounding reader (discovery-first P6): pool counts and
    // the last error code. `null` counts until the lazy pool exists; never the DSN.
    kafuoGrounding: kafuoGroundingHealth(),
  });
}
