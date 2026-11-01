import { type NextRequest, NextResponse } from 'next/server';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { authenticateServiceRequest } from '@/lib/server/teaching-package/service-auth';
import { teachingPackageErrorResponse } from '@/lib/server/teaching-package/route-helpers';
import { GROUPS, queryConsumptionReport, type ReportFilter } from '@/lib/server/consumption/report';

export const runtime = 'nodejs';
export async function GET(req: NextRequest) {
  try {
    authenticateServiceRequest(req);
    const q = req.nextUrl.searchParams;
    const since = Number(q.get('since'));
    const until = Number(q.get('until'));
    const tenant = q.get('tenant_id');
    const mode = q.get('mode') ?? 'summary';
    const limit = Number(q.get('limit') ?? 50);
    const group = q.get('group_by');
    if (
      !tenant ||
      !/^\d+$/.test(tenant) ||
      !q.has('since') ||
      !q.has('until') ||
      !Number.isFinite(since) ||
      !Number.isFinite(until) ||
      since >= until ||
      until - since > 366 * 86400 ||
      !['summary', 'records', 'groups'].includes(mode) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > (mode === 'groups' ? 366 : 200) ||
      (group !== null && !GROUPS.includes(group as never)) ||
      (q.has('cursor_time') &&
        (!Number.isFinite(Number(q.get('cursor_time'))) || !q.get('cursor_id')))
    ) {
      return NextResponse.json(
        { error: { code: 'INVALID_FILTER', message: 'Invalid report filters' } },
        { status: 422 },
      );
    }
    const f: ReportFilter = {
      tenant_id: tenant,
      since,
      until,
      mode: mode as ReportFilter['mode'],
      limit,
    };
    if (group) f.group_by = group as ReportFilter['group_by'];
    for (const field of [
      'provider',
      'model',
      'feature',
      'category',
      'student_ref',
      'lesson_id',
      'learning_item_id',
      'status',
      'version_id',
      'cursor_id',
    ] as const) {
      const value = q.get(field);
      if (value && value.length <= 200) f[field] = value;
      else if (value)
        return NextResponse.json({ error: { code: 'INVALID_FILTER' } }, { status: 422 });
    }
    if (q.has('cursor_time')) f.cursor_time = Number(q.get('cursor_time'));
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    // Local transaction timeout, released before the HTTP response. No DDL or writes.
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const report = await queryConsumptionReport(client, f);
      await client.query('COMMIT');
      return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const mapped = teachingPackageErrorResponse(error);
    if (mapped) return mapped;
    return NextResponse.json(
      { error: { code: 'REPORT_UNAVAILABLE', message: 'Consumption report unavailable' } },
      { status: 503 },
    );
  }
}
