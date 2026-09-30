/**
 * Read-only database access for the SATTS operator scripts. A plain `pg` pool
 * (never the app's persistence provider, whose bootstrap runs DDL) and every
 * query inside `BEGIN READ ONLY`, so the scripts cannot write even by mistake.
 */
import { Pool } from 'pg';

import type { MaintenanceDocument } from '@/lib/server/speech/maintenance';

export async function withReadOnly<T>(fn: (query: <R>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await fn(async <R,>(sql: string, params: unknown[] = []) =>
      (await client.query(sql, params)).rows as R[],
    );
    await client.query('ROLLBACK');
    return result;
  } finally {
    client.release();
    await pool.end();
  }
}

export interface StageRow {
  id: string;
  data: MaintenanceDocument['stage'];
  attempt_subject: string | null;
}

/** Stages (not deleted) with their Stage JSON and the current attempt's subject column. */
export const STAGES_SQL = `
  SELECT s.id, s.data, a.subject_code AS attempt_subject
    FROM document_stages s
    LEFT JOIN stage_meta m ON m.stage_id = s.id
    LEFT JOIN teaching_package_versions v ON v.current_stage_id = s.id
    LEFT JOIN teaching_package_generation_attempts a ON a.id = v.current_attempt_id
   WHERE m.deleted_at IS NULL`;

export const SCENES_SQL = `SELECT id, data FROM document_scenes WHERE stage_id = $1 ORDER BY scene_order, id`;
