/**
 * Learner delivery boundary (RSS 7.5.8) — withhold a CONFIRMED MOE-prohibited
 * visual without touching the stored document.
 *
 * - Document reads under a `read` grant: a compliance OVERLAY blanks the `src`
 *   of any image element whose bytes hold a `rejected` verdict, just before
 *   the response is sent. Editors (`write` grant) see the original element.
 * - The media route answers 404 for such a file unless the request carries a
 *   `write` grant for that Stage.
 *
 * This overlay is the ONLY permitted read-time transformation of the
 * authoritative document: it can only withhold a confirmed-prohibited visual
 * and never touches semantic, assistance, language or direction fields.
 * `unresolved` verdicts on existing packages are NOT withheld here — they are
 * queued for operator review (RSS-FR-125); new packages never ship them.
 *
 * Verdicts are keyed by checksum, so successor clones and re-used assets
 * inherit a hold automatically. Nothing is deleted or rewritten.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CLASSROOMS_DIR, isValidClassroomId } from '@/lib/server/classroom-storage';
import { resolveMoeBrandProfile } from './brand-profile';
import { visualChecksum } from './screen-visual';
import type { VerdictStore } from './types';

const MEDIA_PATH = /\/api\/classroom-media\/([^/?#]+)\/(media\/[^?#]+)/;

/** checksum cache keyed by `realPath:mtimeMs:size` — a file is hashed once. */
const fileChecksums = new Map<string, string>();

export async function checksumOfFile(realPath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(realPath);
    const key = `${realPath}:${stat.mtimeMs}:${stat.size}`;
    const known = fileChecksums.get(key);
    if (known) return known;
    const checksum = visualChecksum(await fs.readFile(realPath));
    fileChecksums.set(key, checksum);
    return checksum;
  } catch {
    return undefined;
  }
}

/** The checksum of the bytes behind an image `src`, when they are local to us. */
export async function checksumOfSource(src: string): Promise<string | undefined> {
  const data = /^data:[^;,]+;base64,([\s\S]+)$/.exec(src);
  if (data) return visualChecksum(Buffer.from(data[1]!, 'base64'));
  const media = MEDIA_PATH.exec(src);
  if (!media || !isValidClassroomId(media[1]!)) return undefined;
  const relative = decodeURIComponent(media[2]!);
  if (relative.includes('..') || relative.includes('\0')) return undefined;
  return checksumOfFile(path.join(CLASSROOMS_DIR, media[1]!, relative));
}

/** True when these bytes hold a `rejected` verdict under the active profile. */
export async function isHeldChecksum(store: VerdictStore, checksum: string): Promise<boolean> {
  const verdict = await store.get(resolveMoeBrandProfile().id, checksum).catch(() => undefined);
  return verdict?.verdict === 'rejected';
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every image element of a document / scene / scene-list payload. */
function* imageElements(payload: unknown): Generator<Json> {
  if (Array.isArray(payload)) {
    for (const item of payload) yield* imageElements(item);
    return;
  }
  if (!isRecord(payload)) return;
  if (payload.type === 'image' && typeof payload.src === 'string') {
    yield payload;
    return;
  }
  for (const key of ['scenes', 'content', 'canvas', 'elements', 'scene']) {
    if (key in payload) yield* imageElements(payload[key]);
  }
}

/**
 * Blank the `src` of every held image in a COPY of `payload`. Returns the
 * payload untouched (same reference) when nothing is held.
 */
export async function applyComplianceOverlay<T>(payload: T, store: VerdictStore): Promise<T> {
  const copy = structuredClone(payload);
  let held = 0;
  for (const element of imageElements(copy)) {
    const checksum = await checksumOfSource(element.src as string);
    if (checksum && (await isHeldChecksum(store, checksum))) {
      element.src = '';
      held += 1;
    }
  }
  return held > 0 ? copy : payload;
}
