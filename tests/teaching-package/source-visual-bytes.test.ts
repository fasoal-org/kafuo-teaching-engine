/**
 * Slide image plan D-4 for insertion: a stage's materialized textbook visual is
 * read back as a data URL only from that stage's media directory, only when its
 * bytes match the manifest checksum — and any doubt means "not attached".
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readSourceVisualDataUrl } from '@/lib/server/teaching-package/source-visual-bytes';

const STAGE = 'stage-abc123';
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const SHA = createHash('sha256').update(BYTES).digest('hex');
let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-visual-bytes-'));
  await fs.mkdir(path.join(dir, STAGE, 'media'), { recursive: true });
  await fs.writeFile(path.join(dir, STAGE, 'media', 'src_1_abcd.png'), BYTES);
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const serving = (file: string) => `/api/classroom-media/${STAGE}/media/${file}`;

describe('readSourceVisualDataUrl', () => {
  it('returns the image as a data URL when the checksum matches', async () => {
    await expect(
      readSourceVisualDataUrl(serving('src_1_abcd.png'), { sha256: SHA }, dir),
    ).resolves.toBe(`data:image/png;base64,${BYTES.toString('base64')}`);
  });

  it('refuses bytes that do not match the manifest checksum', async () => {
    await expect(
      readSourceVisualDataUrl(serving('src_1_abcd.png'), { sha256: 'f'.repeat(64) }, dir),
    ).resolves.toBeUndefined();
  });

  it('reads nothing outside a stage media path or of an unknown type', async () => {
    for (const candidate of [
      '/api/classroom-media/stage-abc123/audio/src_1_abcd.png',
      `/api/classroom-media/${STAGE}/media/..%2F..%2Fsecret.png`,
      `/api/classroom-media/${STAGE}/media/notes.txt`,
      '/etc/passwd',
      'https://example.com/a.png',
    ]) {
      await expect(readSourceVisualDataUrl(candidate, {}, dir)).resolves.toBeUndefined();
    }
  });

  it('is undefined for a missing file', async () => {
    await expect(readSourceVisualDataUrl(serving('gone.png'), {}, dir)).resolves.toBeUndefined();
  });
});
