/**
 * Content-addressed narration audio store (plan §13.6). V1 keeps the local
 * filesystem under `CLASSROOMS_DIR` (D-8: single instance with a persistent,
 * backed-up volume). A regenerated asset always gets a new path, so the
 * `immutable` cache header stays safe; an existing path is never overwritten.
 * Two writers of the same fingerprint write identical bytes via
 * temp-file-plus-rename, which is idempotent.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { fingerprintPrefix } from './fingerprint';

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function narrationAudioFileName(actionId: string, fingerprint: string, format: string): string {
  return `tts-${safeSegment(actionId)}-${fingerprintPrefix(fingerprint)}.${safeSegment(format || 'mp3')}`;
}

export interface NarrationAudioWrite {
  stageId: string;
  actionId: string;
  fingerprint: string;
  format: string;
  bytes: Uint8Array;
  /** Defaults to `CLASSROOMS_DIR`. */
  rootDir?: string;
}

export interface NarrationAudioRef {
  fileName: string;
  /** Path under the stage directory, e.g. `audio/tts-a1-XXXX.mp3`. */
  subPath: string;
  /** `/api/classroom-media/<stage>/audio/<file>`. */
  relativeUrl: string;
  /** False when the same content-addressed file already existed. */
  written: boolean;
}

export async function writeNarrationAudio(input: NarrationAudioWrite): Promise<NarrationAudioRef> {
  const root = input.rootDir ?? CLASSROOMS_DIR;
  const fileName = narrationAudioFileName(input.actionId, input.fingerprint, input.format);
  const dir = path.join(root, safeSegment(input.stageId), 'audio');
  const target = path.join(dir, fileName);
  const ref = {
    fileName,
    subPath: `audio/${fileName}`,
    relativeUrl: `/api/classroom-media/${input.stageId}/audio/${fileName}`,
  };
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(target);
    return { ...ref, written: false };
  } catch {
    // absent: write below
  }
  const temp = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, input.bytes);
  await fs.rename(temp, target);
  return { ...ref, written: true };
}
