/**
 * Approval gate for governed packages (RSS 7.5.6): at submit / approve, every
 * learner-visible image in the Stage must resolve to bytes we can screen AND
 * hold an `approved` verdict. Freshly generated and source-derived visuals were
 * screened at generation, so they are cache hits here; anything unscreened
 * (typically author-supplied or imported media) is screened now. `rejected` /
 * `unresolved` blocks the transition with an actionable list — this is what
 * makes "no unscreened visual reaches the learner" true for EDITED packages.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CLASSROOMS_DIR, isValidClassroomId } from '@/lib/server/classroom-storage';
import { screenVisualWithDefaults } from './index';
import type { ImageTextPolicy, VisualVerdict } from './types';

export interface StageVisualFinding {
  sceneId: string;
  elementId: string;
  verdict: Exclude<VisualVerdict, 'approved'>;
  reason: string;
}

interface SceneLike {
  id: string;
  type: string;
  content: unknown;
}

const MEDIA_PATH = /\/api\/classroom-media\/([^/?#]+)\/(media\/[^?#]+)/;

/** The bytes behind an image `src`, when this server can read them. */
export async function bytesOfSource(
  src: string,
): Promise<{ bytes: Buffer; mimeType?: string } | undefined> {
  const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(src);
  if (data) return { bytes: Buffer.from(data[2]!, 'base64'), mimeType: data[1] };
  const media = MEDIA_PATH.exec(src);
  if (!media || !isValidClassroomId(media[1]!)) return undefined;
  const relative = decodeURIComponent(media[2]!);
  if (relative.includes('..') || relative.includes('\0')) return undefined;
  try {
    return { bytes: await fs.readFile(path.join(CLASSROOMS_DIR, media[1]!, relative)) };
  } catch {
    return undefined;
  }
}

export async function collectStageVisualFindings(
  scenes: readonly SceneLike[],
  options: {
    textPolicy?: ImageTextPolicy;
    screen?: typeof screenVisualWithDefaults;
  } = {},
): Promise<StageVisualFinding[]> {
  const screen = options.screen ?? screenVisualWithDefaults;
  const findings: StageVisualFinding[] = [];
  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const elements =
      (scene.content as { canvas?: { elements?: Array<Record<string, unknown>> } })?.canvas
        ?.elements ?? [];
    for (const element of elements) {
      if (element.type !== 'image' || typeof element.src !== 'string' || element.src === '') {
        continue;
      }
      const elementId = String(element.id ?? '');
      const source = await bytesOfSource(element.src);
      if (!source) {
        findings.push({
          sceneId: scene.id,
          elementId,
          verdict: 'unresolved',
          reason: 'the image bytes cannot be read for screening (external or unregistered source)',
        });
        continue;
      }
      const verdict = await screen(source.bytes, {
        origin: 'author-supplied',
        textPolicy: options.textPolicy,
        ...(source.mimeType ? { mimeType: source.mimeType } : {}),
      });
      if (verdict.verdict !== 'approved') {
        findings.push({
          sceneId: scene.id,
          elementId,
          verdict: verdict.verdict,
          reason: verdict.reasons.join('; ') || verdict.verdict,
        });
      }
    }
  }
  return findings;
}
