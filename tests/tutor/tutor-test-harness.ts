/**
 * Shared fixtures for the tutor runtime suites: a PGlite pool with the Kafuo
 * R1 schemas, an event-recording wrapper (ledger writes, transaction
 * boundaries), a fake Kafuo client, and student-grant minting.
 *
 * `vi.mock` calls must live in each test file (they are hoisted per file);
 * this module only holds plain helpers.
 */
import { PGlite } from '@electric-sql/pglite';
import { vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { ensureLegacyHelpTurnsSchema } from '@/lib/persistence/legacy-help-turns';
import { ensureMeterFinalizeOutboxSchema } from '@/lib/persistence/meter-finalize-outbox';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureTeachingPackageSchema } from '@/lib/persistence/teaching-package';
import { ensureTeachingModelAttemptsSchema } from '@/lib/persistence/teaching-model-attempts';
import { ensureTutorRuntimeSchema } from '@/lib/persistence/tutor-runtime';
import type {
  GroundingSearchRequest,
  GroundingSearchResponse,
  KafuoIntegrationClient,
  MeterFinalizeRequest,
  MeterFinalizeResult,
  MeterReserveDecision,
  MeterReserveRequest,
} from '@/lib/server/tutor/kafuo-integration-client';
import { parseSseFrames } from '@/lib/server/tutor/sse';
import { mintStudentHandoff, redeemStudentHandoff } from '@/lib/server/tutor/student-grant';

export const STUDENT_REF = 'abcdefghijklmnopqrstuvwx';
export const OTHER_STUDENT_REF = 'zyxwvutsrqponmlkjihgfedc';
export const T0_MS = 1_800_000_000_000;

/** PGlite behind the `ConnectableQueryable` shape, recording ledger writes and tx boundaries. */
export class RecordingPool {
  failInsert = false;
  failCommit = false;
  constructor(
    readonly db: PGlite,
    readonly events: string[] = [],
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) {
    if (/^\s*INSERT INTO teaching_model_attempts/i.test(text)) {
      this.events.push('ledger:insert');
      if (this.failInsert) throw new Error('ledger down (insert)');
    }
    if (/^\s*UPDATE teaching_model_attempts SET\s+accounting_status = 'complete'/i.test(text)) {
      this.events.push('ledger:update');
    }
    if (/^\s*INSERT INTO meter_finalize_outbox/i.test(text)) this.events.push('outbox:insert');
    return this.db.query<Row>(text, params);
  }

  async connect() {
    return {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        params?: unknown[],
      ) => {
        const statement = text.trim().toUpperCase();
        if (statement === 'BEGIN') this.events.push('tx:begin');
        if (statement === 'COMMIT') {
          if (this.failCommit) throw new Error('commit failed');
          this.events.push('tx:commit');
        }
        if (statement === 'ROLLBACK') this.events.push('tx:rollback');
        return this.query<Row>(text, params);
      },
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

export async function createTutorPool(
  events: string[] = [],
  options: {
    /** Help suites: the real document + stage-meta + teaching-package schemas (versions, attempts, units). */
    packageSchema?: boolean;
  } = {},
): Promise<RecordingPool> {
  const db = new PGlite();
  await db.waitReady;
  const pool = new RecordingPool(db, events);
  if (options.packageSchema) {
    await ensureDocumentSchema(pool);
    await ensureStageMetaSchema(pool);
    await ensureTeachingPackageSchema(pool);
  } else {
    // The FK target of tutor_help_sessions; the package schema itself is not needed here.
    await pool.query('CREATE TABLE IF NOT EXISTS teaching_package_versions (id TEXT PRIMARY KEY)');
  }
  await ensureTeachingModelAttemptsSchema(pool);
  await ensureTutorRuntimeSchema(pool);
  await ensureMeterFinalizeOutboxSchema(pool);
  await ensureLegacyHelpTurnsSchema(pool);
  return pool;
}

export function asConnectable(pool: RecordingPool): ConnectableQueryable {
  return pool as unknown as ConnectableQueryable;
}

// ---------------------------------------------------------------------------
// Fake Kafuo integration client
// ---------------------------------------------------------------------------

export interface FakeKafuo {
  client: KafuoIntegrationClient;
  reserve: ReturnType<
    typeof vi.fn<(request: MeterReserveRequest) => Promise<MeterReserveDecision>>
  >;
  finalize: ReturnType<
    typeof vi.fn<(request: MeterFinalizeRequest) => Promise<MeterFinalizeResult>>
  >;
  groundingSearch: ReturnType<
    typeof vi.fn<(request: GroundingSearchRequest) => Promise<GroundingSearchResponse>>
  >;
  events: string[];
}

export function fakeKafuo(events: string[] = []): FakeKafuo {
  let nextReservation = 0;
  const reserve = vi.fn(async (_request: MeterReserveRequest): Promise<MeterReserveDecision> => {
    events.push('kafuo:reserve');
    nextReservation += 1;
    return {
      allowed: true,
      reservationId: `res-${nextReservation}`,
      replay: false,
      status: {
        limit: 30,
        used: nextReservation,
        remaining: 30 - nextReservation,
        resetAt: '2026-10-01T00:00:00+03:00',
      },
    };
  });
  const finalize = vi.fn(async (_request: MeterFinalizeRequest): Promise<MeterFinalizeResult> => {
    events.push('kafuo:finalize');
    return { status: 'delivered' };
  });
  const groundingSearch = vi.fn(
    async (_request: GroundingSearchRequest): Promise<GroundingSearchResponse> => {
      events.push('kafuo:grounding');
      return { units: [], lessonMatch: null, truncated: false };
    },
  );
  return {
    client: { reserve, finalize, groundingSearch } as unknown as KafuoIntegrationClient,
    reserve,
    finalize,
    groundingSearch,
    events,
  };
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export const ACADEMIC = {
  curriculumId: '27',
  curriculumName: 'المنهج الوطني',
  curriculumVersionLabel: '2026',
  gradeLabel: 'الصف التاسع',
};

export const SUBJECTS = [
  {
    code: 'MATH',
    offeringId: '10',
    nameAr: 'الرياضيات',
    nameEn: 'Mathematics',
    academicLanguage: 'ar',
  },
  {
    code: 'CHEMISTRY',
    offeringId: '11',
    nameAr: 'الكيمياء',
    nameEn: 'Chemistry',
    academicLanguage: 'ar',
  },
];

/** A student grant bearer header (`Bearer tsg.…`) for the given student and subjects. */
export function studentBearer(
  options: {
    studentRef?: string;
    subjects?: typeof SUBJECTS;
    freeChat?: boolean;
    tenantId?: string;
  } = {},
): string {
  const { token } = mintStudentHandoff({
    tenantId: options.tenantId ?? '1',
    studentRef: options.studentRef ?? STUDENT_REF,
    academic: ACADEMIC,
    allowedSubjects: options.subjects ?? SUBJECTS,
    localeHint: 'ar',
    entitlements: { freeChat: options.freeChat ?? true, help: true },
  });
  return `Bearer ${redeemStudentHandoff(token).grant}`;
}

// ---------------------------------------------------------------------------
// SSE + LLM stream helpers
// ---------------------------------------------------------------------------

export async function readSse(
  response: Response,
): Promise<Array<{ event: string; data: unknown }>> {
  return parseSseFrames(await new Response(response.body).text());
}

export const USAGE = {
  inputTokens: 1200,
  outputTokens: 40,
  inputTokenDetails: { cacheReadTokens: 0 },
};

type Part = { type: string; text?: string; error?: unknown; finishReason?: string };

/** A fake `streamLLM` result: the executor consumes `fullStream` and awaits `totalUsage`. */
export function streamOf(parts: Part[], usage: unknown = USAGE) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    totalUsage: Promise.resolve(usage),
  };
}

export function textStream(text: string) {
  return streamOf([
    { type: 'text-delta', text },
    { type: 'finish', finishReason: 'stop' },
  ]);
}

export function ok(text: string) {
  return { text, finishReason: 'stop', usage: USAGE, totalUsage: USAGE };
}
