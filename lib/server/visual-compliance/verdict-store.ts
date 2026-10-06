/**
 * Verdict store — `visual_compliance_verdicts`, one additive table created by
 * the same self-bootstrapping DDL pattern as the Teaching Package tables. No
 * existing table, Stage document or scene is altered; it stores verdicts about
 * bytes, keyed by `(profile_id, checksum)`, so re-runs, clones and re-used
 * assets cost nothing and inherit a hold automatically.
 */
import type { ComplianceVerdict, VerdictStore } from './types';

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const VISUAL_COMPLIANCE_TABLE = `
CREATE TABLE IF NOT EXISTS visual_compliance_verdicts (
  profile_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('approved','rejected','unresolved')),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  method TEXT NOT NULL,
  model TEXT,
  confidence DOUBLE PRECISION,
  screened_at DOUBLE PRECISION NOT NULL,
  confirmed_by TEXT,
  PRIMARY KEY (profile_id, checksum)
)`;

export async function ensureVisualComplianceSchema(queryable: Queryable): Promise<void> {
  await queryable.query(VISUAL_COMPLIANCE_TABLE);
}

function fromRow(row: Record<string, unknown>): ComplianceVerdict {
  return {
    profileId: String(row.profile_id),
    checksum: String(row.checksum),
    verdict: row.verdict as ComplianceVerdict['verdict'],
    reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
    method: row.method as ComplianceVerdict['method'],
    ...(row.model ? { model: String(row.model) } : {}),
    ...(row.confidence !== null && row.confidence !== undefined
      ? { confidence: Number(row.confidence) }
      : {}),
    screenedAt: Number(row.screened_at),
    ...(row.confirmed_by ? { confirmedBy: String(row.confirmed_by) } : {}),
  };
}

export class PgVerdictStore implements VerdictStore {
  private ready: Promise<void> | undefined;
  constructor(private readonly queryable: Queryable) {}

  private ensure(): Promise<void> {
    this.ready ??= ensureVisualComplianceSchema(this.queryable);
    return this.ready;
  }

  async get(profileId: string, checksum: string): Promise<ComplianceVerdict | undefined> {
    await this.ensure();
    const { rows } = await this.queryable.query(
      'SELECT * FROM visual_compliance_verdicts WHERE profile_id = $1 AND checksum = $2',
      [profileId, checksum],
    );
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  /**
   * Upsert. An operator-confirmed verdict outranks automated ones: an automated
   * write never overwrites a row that carries `confirmed_by`.
   */
  async put(verdict: ComplianceVerdict): Promise<void> {
    await this.ensure();
    await this.queryable.query(
      `INSERT INTO visual_compliance_verdicts
         (profile_id, checksum, verdict, reasons, method, model, confidence, screened_at, confirmed_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)
       ON CONFLICT (profile_id, checksum) DO UPDATE SET
         verdict = EXCLUDED.verdict, reasons = EXCLUDED.reasons, method = EXCLUDED.method,
         model = EXCLUDED.model, confidence = EXCLUDED.confidence,
         screened_at = EXCLUDED.screened_at, confirmed_by = EXCLUDED.confirmed_by
       WHERE visual_compliance_verdicts.confirmed_by IS NULL OR EXCLUDED.confirmed_by IS NOT NULL`,
      [
        verdict.profileId,
        verdict.checksum,
        verdict.verdict,
        JSON.stringify(verdict.reasons),
        verdict.method,
        verdict.model ?? null,
        verdict.confidence ?? null,
        verdict.screenedAt,
        verdict.confirmedBy ?? null,
      ],
    );
  }
}

/** Process-local store: tests, and deployments without a database. */
export class MemoryVerdictStore implements VerdictStore {
  private readonly verdicts = new Map<string, ComplianceVerdict>();
  async get(profileId: string, checksum: string) {
    return this.verdicts.get(`${profileId}:${checksum}`);
  }
  async put(verdict: ComplianceVerdict) {
    const key = `${verdict.profileId}:${verdict.checksum}`;
    const existing = this.verdicts.get(key);
    if (existing?.confirmedBy && !verdict.confirmedBy) return;
    this.verdicts.set(key, verdict);
  }
}
