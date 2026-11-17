/**
 * g5.v11 (owner, 17 Nov 2026): the teacher guide's answer DRAWINGS — a `reference` item's
 * `modelAnswer: { kind: 'figure', image }` («مثّل بيانيًا», «ارسم …»).
 *
 * Each drawing is fetched once per run from the transient presigned `image.url` of the
 * request the run was started (or resumed) with — the same secure download as
 * `contentResource` / `normalizedContentResource` (`fetchBytesSecurely`: pinned DNS,
 * revalidated redirects, a content-type allowlist and a bounded body) — then verified: the
 * declared size, the declared SHA-256 and the PNG signature. FAIL-SOFT: a drawing that
 * cannot be fetched or does not verify is left out and logged by item only (never its
 * URL); the item then behaves as if no figure was sent, and the lesson never fails for it.
 *
 * A kept drawing becomes a TE-minted source image (`src-guide-<n>`, the item's position in the
 * guide) with NO content unit: it is never offered to the outline planner, never linked to
 * a slide by its unit, and reaches only the worked-solution outline the guide answers
 * select it on (`injectGuideAnswers`). Its bytes live in memory until the Stage stores
 * them like the book's images (`materializeSourceImages`).
 */
import { createHash } from 'node:crypto';

import { createLogger } from '@/lib/logger';
import { fetchBytesSecurely, type SecureBytesOptions } from '@/lib/server/agent-runtime/fetch-url';
import { guideFigureImageId } from '@/lib/server/teaching-package/guide-answers';
import type { NormalizedSourceImage } from '@/lib/server/teaching-package/source-images';
import type { KafuoTeacherGuide } from '@/lib/types/teaching-package';

const log = createLogger('GuideAnswerFigures');

/** The source role of a stored answer drawing (prompts and the manifest read it). */
export const GUIDE_FIGURE_SOURCE_ROLE = 'answer_figure';

/** At most this many drawings are fetched per run (a lesson has a handful). */
const DEFAULT_MAX_FIGURES = 30;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface GuideFigureAcquisitionPolicy {
  /** Only items of these content units are fetched (the lesson's check and exercise units). */
  unitIds?: ReadonlySet<string>;
  maxFigures: number;
  bodyTimeoutMs: number;
  maxAttempts: number;
  /** Test seam: the delay before a retry. */
  retryDelayMs: number;
  /** Test seam for the download transport. */
  secureFetch?: SecureBytesOptions['fetchImpl'];
  /** Test seam for the pinned dispatcher. */
  dispatcher?: SecureBytesOptions['dispatcher'];
}

class FigureRejected extends Error {}

function isRetryable(error: unknown): boolean {
  if (error instanceof FigureRejected) return false;
  const record = error as { name?: string; message?: string };
  if (record?.name !== 'FetchUrlError') return true;
  const message = record.message ?? '';
  return !message.includes('blocked') && !message.includes('Unsupported content type');
}

async function download(
  url: string,
  sizeBytes: number,
  policy: Partial<GuideFigureAcquisitionPolicy>,
): Promise<Buffer> {
  const downloaded = await fetchBytesSecurely(url, {
    // Object stores may label a PNG generically; the signature is checked below.
    allowedContentTypes: new Set(['image/png', 'application/octet-stream']),
    maxBytes: sizeBytes,
    bodyTimeoutMs: policy.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS,
    ...(policy.secureFetch ? { fetchImpl: policy.secureFetch } : {}),
    ...(policy.dispatcher ? { dispatcher: policy.dispatcher } : {}),
  });
  if (downloaded.truncated) throw new FigureRejected('larger than its declared size');
  return downloaded.bytes;
}

/**
 * The verified drawings of `guide`, in guide order, each a source image `src-guide-<n>`.
 * Never throws: whatever fails is left out (and logged without its URL).
 */
export async function acquireGuideAnswerFigures(
  guide: KafuoTeacherGuide,
  policy: Partial<GuideFigureAcquisitionPolicy> = {},
): Promise<NormalizedSourceImage[]> {
  const maxFigures = policy.maxFigures ?? DEFAULT_MAX_FIGURES;
  const maxAttempts = Math.max(1, policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const figures: NormalizedSourceImage[] = [];
  let tried = 0;
  for (const [at, item] of guide.items.entries()) {
    const modelAnswer = item.modelAnswer;
    if (item.status !== 'reference' || modelAnswer?.kind !== 'figure') continue;
    if (policy.unitIds && !policy.unitIds.has(item.contentUnitId)) continue;
    const name = `${item.contentUnitId}/${item.label}`;
    const { url, sizeBytes, checksumSha256 } = modelAnswer.image;
    if (!url) {
      log.warn(`Teacher-guide drawing ${name} has no retrieval URL; left out`);
      continue;
    }
    if (tried >= maxFigures) {
      log.warn(`Teacher-guide drawing ${name} is over the ${maxFigures}-drawing limit; left out`);
      continue;
    }
    tried += 1;
    let reason = 'could not be downloaded';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const data = await download(url, sizeBytes, policy);
        if (data.length !== sizeBytes) throw new FigureRejected('size does not match');
        const sha256 = createHash('sha256').update(data).digest('hex');
        if (sha256 !== checksumSha256) throw new FigureRejected('checksum does not match');
        if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
          throw new FigureRejected('is not a PNG');
        }
        const width = data.readUInt32BE(16);
        const height = data.readUInt32BE(20);
        figures.push({
          id: guideFigureImageId(at),
          data,
          mimeType: 'image/png',
          sha256,
          pageNumber: null,
          ...(width > 0 ? { width } : {}),
          ...(height > 0 ? { height } : {}),
          sourceRole: GUIDE_FIGURE_SOURCE_ROLE,
        });
        reason = '';
        break;
      } catch (error) {
        // Only the item and the class of failure are logged: a fetch error can carry the URL.
        reason = error instanceof FigureRejected ? error.message : 'could not be downloaded';
        if (!isRetryable(error) || attempt >= maxAttempts) break;
        const delay = policy.retryDelayMs ?? 1000 * 2 ** (attempt - 1);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    if (reason) log.warn(`Teacher-guide drawing ${name} ${reason}; left out`);
  }
  return figures;
}
