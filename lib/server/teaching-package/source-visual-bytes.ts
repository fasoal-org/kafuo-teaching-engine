/**
 * Read a materialized textbook visual back from its stage media directory as a
 * data URL, so a planner that works after the package was built (slide
 * insertion) can SEE the image it writes a teaching note for (slide image plan
 * D-4).
 *
 * Fail-soft by design: any doubt — a path that is not a stage media path, an
 * unknown type, a file that is missing, too large, or whose bytes do not match
 * the manifest checksum — returns `undefined`, and the caller plans without
 * that image attached. Only paths this TE minted
 * (`/api/classroom-media/<stage>/media/<file>`) are read, and only inside
 * that stage's media directory.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CLASSROOMS_DIR, isValidClassroomId } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('SourceVisualBytes');

/** The largest image a planner call attaches. */
export const MAX_PLANNER_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const SERVING_PATH = /^\/api\/classroom-media\/([^/]+)\/media\/([^/]+)$/;

export async function readSourceVisualDataUrl(
  servingPath: string,
  expected: { sha256?: string } = {},
  classroomsDir: string = CLASSROOMS_DIR,
): Promise<string | undefined> {
  const match = SERVING_PATH.exec(servingPath);
  if (!match) return undefined;
  const [, stageId, fileName] = match as unknown as [string, string, string];
  if (!isValidClassroomId(stageId) || fileName.includes('..') || fileName.includes('\0')) {
    return undefined;
  }
  const mimeType = IMAGE_TYPES[path.extname(fileName).toLowerCase()];
  if (!mimeType) return undefined;
  const mediaDir = path.resolve(classroomsDir, stageId, 'media');
  const target = path.resolve(mediaDir, fileName);
  if (!target.startsWith(mediaDir + path.sep)) return undefined;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_PLANNER_IMAGE_BYTES) return undefined;
    const data = await fs.readFile(target);
    if (expected.sha256 && createHash('sha256').update(data).digest('hex') !== expected.sha256) {
      log.warn(`source visual ${fileName} does not match its manifest checksum; not attached`);
      return undefined;
    }
    return `data:${mimeType};base64,${data.toString('base64')}`;
  } catch {
    return undefined;
  }
}
