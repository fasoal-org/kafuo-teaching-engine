import { promises as fs, createReadStream, type ReadStream } from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { CLASSROOMS_DIR, isValidClassroomId } from '@/lib/server/classroom-storage';
import { parseRangeHeader } from '@/lib/server/http-range';
import { createLogger } from '@/lib/logger';
import { readGatedClassroomMediaAccess } from '@/lib/server/teaching-package/classroom-media-signature';
import { readEditorGrants } from '@/lib/server/teaching-package/editor-grant';
import { holdsLessonEditorGrant } from '@/lib/server/teaching-package/editor-grant-tenant-access';
import { checkLearnerAccessScope, learnerDeliveryError } from '@/lib/server/tutor/learner-access';
import { getVerdictStore } from '@/lib/server/visual-compliance';
import { checksumOfFile, isHeldChecksum } from '@/lib/server/visual-compliance/delivery-hold';

const log = createLogger('ClassroomMedia');

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
};

const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=86400, immutable' } as const;
/** Behind ACCESS_CODE: the device may cache, a shared cache may not. */
const GATED_CACHE_HEADERS = { 'Cache-Control': 'private, max-age=86400, immutable' } as const;

/** Bridge a fs ReadStream into a web ReadableStream, propagating errors and cancel. */
function toWebStream(stream: ReadStream): ReadableStream {
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: Buffer | string) => controller.enqueue(chunk));
      stream.on('end', () => controller.close());
      stream.on('error', (err) => controller.error(err));
    },
    cancel() {
      stream.destroy();
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ classroomId: string; path: string[] }> },
) {
  const { classroomId, path: pathSegments } = await params;

  // Validate classroomId
  if (!isValidClassroomId(classroomId)) {
    return NextResponse.json({ error: 'Invalid classroom ID' }, { status: 400 });
  }

  // Validate path segments — no traversal
  const joined = pathSegments.join('/');
  if (joined.includes('..') || pathSegments.some((s) => s.includes('\0'))) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  // Only allow media/ and audio/ subdirectories
  const subDir = pathSegments[0];
  if (subDir !== 'media' && subDir !== 'audio') {
    return NextResponse.json({ error: 'Invalid path' }, { status: 404 });
  }

  // ACCESS_CODE gate: a read needs the browser's access cookie (admins) or a
  // link signed at learner delivery (the mobile player, which sends no
  // credential). Without ACCESS_CODE the read stays open, as before.
  const accessCode = process.env.ACCESS_CODE;
  if (accessCode) {
    let access = readGatedClassroomMediaAccess({
      accessCode,
      accessCookie: req.cookies.get('openmaic_access')?.value,
      classroomId,
      segments: pathSegments,
      searchParams: req.nextUrl.searchParams,
    });
    // D-O1-1 / D-O1-6 (Roles Module phase 1): a teacher's edit/preview grant
    // for this Stage, or for another Stage of the same lesson, in its own
    // tenant reads the media as the admin's access cookie does (a successor
    // Stage keeps its predecessor's media links). It only ever adds access: a
    // learner grant is not accepted here and still needs its signed link, so
    // the scope check below keeps running.
    if (!access.allowed && (await holdsLessonEditorGrant(req.headers, classroomId))) {
      access = { allowed: true, scope: null };
    }
    if (!access.allowed) {
      return NextResponse.json(
        { error: 'Media link expired or invalid' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    // ET-16 (c), G2: a link signed for a learner carries the learner's access
    // scope; Kafuo re-validates it (cached ≤ 5 min) before any byte is served, so a
    // revoked learner stops receiving media before the grant expires. Fails closed.
    if (access.scope) {
      const refusal = learnerDeliveryError(await checkLearnerAccessScope(access.scope));
      if (refusal) {
        const retryAfter = (refusal.details as { retryAfterS?: unknown } | undefined)?.retryAfterS;
        return NextResponse.json(
          {
            error: {
              code: refusal.code,
              message: refusal.message,
              ...(refusal.details === undefined ? {} : { details: refusal.details }),
            },
          },
          {
            status: refusal.status,
            headers: {
              'Cache-Control': 'no-store',
              ...(typeof retryAfter === 'number' ? { 'Retry-After': String(retryAfter) } : {}),
            },
          },
        );
      }
    }
  }

  const filePath = path.join(CLASSROOMS_DIR, classroomId, ...pathSegments);
  const resolvedBase = path.resolve(CLASSROOMS_DIR, classroomId);

  try {
    // Resolve symlinks and verify the real path stays within the classroom dir
    const realPath = await fs.realpath(filePath);
    if (!realPath.startsWith(resolvedBase + path.sep) && realPath !== resolvedBase) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const ext = path.extname(realPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // RSS 7.5.8 — hold. An image whose bytes carry a `rejected` compliance
    // verdict is not served to learners: 404 unless the request holds a `write`
    // grant for this Stage (an editor remediating it), and then never with the
    // public, immutable cache header.
    let cacheHeaders: Record<string, string> = accessCode ? GATED_CACHE_HEADERS : CACHE_HEADERS;
    if (subDir === 'media' && contentType.startsWith('image/')) {
      const checksum = await checksumOfFile(realPath);
      if (checksum && (await isHeldChecksum(await getVerdictStore(), checksum))) {
        const canEdit = readEditorGrants(req.headers).some(
          (grant) => grant.stageId === classroomId && grant.capability === 'write',
        );
        if (!canEdit) return NextResponse.json({ error: 'Not found' }, { status: 404 });
        cacheHeaders = { 'Cache-Control': 'private, no-store' };
      }
    }

    // Range requests enable progressive playback and seeking for hosted media
    // (e.g. <video> streams the moov atom first, then fetches on seek).
    const range = parseRangeHeader(req.headers.get('range'), stat.size);

    if (range.kind === 'unsatisfiable') {
      // Never cache a range error: an immutable/public 416 would poison the
      // media URL in shared and browser caches, breaking later valid requests.
      return new NextResponse(null, {
        status: 416,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Range': `bytes */${stat.size}`,
        },
      });
    }

    if (range.kind === 'range') {
      const stream = createReadStream(realPath, { start: range.start, end: range.end });
      return new NextResponse(toWebStream(stream), {
        status: 206,
        headers: {
          ...cacheHeaders,
          'Content-Type': contentType,
          'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    // Stream the file to avoid loading large videos into memory
    return new NextResponse(toWebStream(createReadStream(realPath)), {
      status: 200,
      headers: {
        ...cacheHeaders,
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        'Accept-Ranges': 'bytes',
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    log.error(
      `Classroom media serving failed [classroomId=${classroomId}, path=${joined}]:`,
      error,
    );
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
