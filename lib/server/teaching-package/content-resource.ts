/**
 * Layer A — bounded acquisition of the Kafuo lesson PDF (plan §4.3.2).
 *
 * One acquisition per attempt, reused by every classroom run: secure download
 * (SSRF/DNS/redirect/size/timeout controls from `fetch-url.ts`) → actual-PDF
 * magic validation → measured size/checksum verification → the EXISTING
 * document extractor (`extractDocument`, provider candidates with
 * `textOnly: false`) → `documentArtifactToParsedPdfContent` → source-image
 * normalization. No second parser, no Kafuo-extracted text path.
 *
 * Download/network failures and provider-transient extraction failures are
 * retryable within the acquisition policy; blocked URLs, non-PDF bytes,
 * integrity mismatches, truncation, and empty extractions are terminal for
 * the attempt. Errors never carry the retrieval URL or upstream messages.
 */
import { createHash } from 'node:crypto';

import { extractDocument } from '@/lib/document/extract';
import { documentArtifactToParsedPdfContent } from '@/lib/document/pdf-compat';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import type { KafuoContentResource } from '@/lib/types/teaching-package';
import {
  fetchBytesSecurely,
  resolveServerPdfExtractorCandidates,
  type SecureBytesOptions,
} from '@/lib/server/agent-runtime/fetch-url';
import {
  normalizeSourceImages,
  toVisionPdfImages,
  type NormalizedSource,
} from '@/lib/server/teaching-package/source-images';

/** Structured acquisition failure with safe code/retryable semantics. */
export class ContentResourceAcquisitionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean, safeMessage: string) {
    super(safeMessage);
    this.name = 'ContentResourceAcquisitionError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface AcquisitionPolicy {
  maxBytes: number;
  bodyTimeoutMs: number;
  maxAttempts: number;
  /** Test seam for the download transport. */
  secureFetch?: SecureBytesOptions['fetchImpl'];
  /** Test seam for the pinned dispatcher. */
  dispatcher?: SecureBytesOptions['dispatcher'];
  /** Test seam for the extraction boundary. */
  extract?: (input: Parameters<typeof extractDocument>[0]) => Promise<
    ReturnType<typeof extractDocument>
  >;
}

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;

function acquisitionMaxAttempts(): number {
  const raw = Number(process.env.TEACHING_PACKAGE_ACQUISITION_MAX_ATTEMPTS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_ATTEMPTS;
}

function pdfMaxBytes(): number {
  const raw = Number(process.env.TEACHING_PACKAGE_PDF_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

function pdfBodyTimeoutMs(): number {
  const raw = Number(process.env.TEACHING_PACKAGE_PDF_BODY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BODY_TIMEOUT_MS;
}

function isNetworkish(error: unknown): boolean {
  const record = error as { name?: string; message?: string };
  if (record?.name === 'FetchUrlError') {
    // `blocked`/`unsupported_content_type` classifications are terminal.
    const message = record.message ?? '';
    return !message.includes('blocked') && !message.includes('Unsupported content type');
  }
  return true;
}

/**
 * Bounded acquisition retry (plan §4.3.2): transient download/extraction
 * failures back off and retry; terminal failures (blocked URL, non-PDF bytes,
 * integrity mismatch, truncation, empty content) fail immediately. Mirrors
 * `withGenerationRetry`'s exponential backoff shape with an explicit
 * retryability predicate — acquisition failure classes, not model-call
 * heuristics, decide.
 */
async function withAcquisitionRetry<T>(
  operation: () => Promise<T>,
  maxAttempts: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ContentResourceAcquisitionError && error.retryable;
      if (!retryable || attempt >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** (attempt - 1), 10_000)));
    }
  }
  throw lastError;
}

/**
 * Acquire the authoritative lesson PDF exactly once per attempt and produce
 * the normalized source every classroom run reuses.
 */
export async function acquireContentResource(
  resource: KafuoContentResource,
  policy: Partial<AcquisitionPolicy> = {},
): Promise<NormalizedSource> {
  const maxAttempts = policy.maxAttempts ?? acquisitionMaxAttempts();
  const maxBytes = policy.maxBytes ?? pdfMaxBytes();
  const bodyTimeoutMs = policy.bodyTimeoutMs ?? pdfBodyTimeoutMs();
  const doExtract =
    policy.extract ??
    ((input: Parameters<typeof extractDocument>[0]) => extractDocument(input));

  return withAcquisitionRetry(
    async () => {
      // 1. Secure download over the shared fetch-url controls.
      let downloaded: Awaited<ReturnType<typeof fetchBytesSecurely>>;
      try {
        downloaded = await fetchBytesSecurely(resource.url, {
          allowedContentTypes: new Set(['application/pdf']),
          maxBytes,
          bodyTimeoutMs,
          ...(policy.secureFetch ? { fetchImpl: policy.secureFetch } : {}),
          ...(policy.dispatcher ? { dispatcher: policy.dispatcher } : {}),
        });
      } catch (error) {
        throw new ContentResourceAcquisitionError(
          'CONTENT_RESOURCE_DOWNLOAD_FAILED',
          isNetworkish(error),
          'the lesson PDF could not be downloaded',
        );
      }

      // 2. A truncated download never enters extraction (FRD §10.2.7).
      if (downloaded.truncated) {
        throw new ContentResourceAcquisitionError(
          'CONTENT_RESOURCE_DOWNLOAD_FAILED',
          false,
          'the lesson PDF download was truncated before the byte limit was satisfied',
        );
      }

      // 3. Actual PDF signature — the content type alone proves nothing.
      if (!downloaded.bytes.subarray(0, 5).toString('ascii').startsWith('%PDF-')) {
        throw new ContentResourceAcquisitionError(
          'CONTENT_RESOURCE_NOT_PDF',
          false,
          'the retrieved resource is not a PDF',
        );
      }

      // 4. Measured size/checksum against the supplied integrity metadata.
      const measuredBytes = downloaded.bytes.byteLength;
      const measuredSha256 = createHash('sha256').update(downloaded.bytes).digest('hex');
      if (resource.fileSizeBytes !== undefined && resource.fileSizeBytes !== measuredBytes) {
        throw new ContentResourceAcquisitionError(
          'CONTENT_RESOURCE_INTEGRITY_MISMATCH',
          false,
          'the downloaded PDF size does not match the declared size',
        );
      }
      if (
        resource.checksumSha256 !== undefined &&
        resource.checksumSha256.toLowerCase() !== measuredSha256
      ) {
        throw new ContentResourceAcquisitionError(
          'CONTENT_RESOURCE_INTEGRITY_MISMATCH',
          false,
          'the downloaded PDF checksum does not match the declared checksum',
        );
      }

      // 5. The existing document extraction boundary — providers with
      //    `textOnly: false` so source visuals survive.
      let parsed: ParsedPdfContent;
      try {
        const artifact = await doExtract({
          buffer: downloaded.bytes,
          ...(resource.fileName !== undefined ? { fileName: resource.fileName } : {}),
          fileSize: measuredBytes,
          mimeType: 'application/pdf',
          config: resolveServerPdfExtractorCandidates({ textOnly: false })[0]!.config,
        });
        parsed = documentArtifactToParsedPdfContent(artifact);
      } catch {
        throw new ContentResourceAcquisitionError(
          'PDF_EXTRACTION_FAILED',
          true,
          'the PDF extractor failed to process the lesson resource',
        );
      }

      // 6. Empty parsed content is an explicit asynchronous failure.
      if (!parsed.text || parsed.text.trim() === '') {
        throw new ContentResourceAcquisitionError(
          'PDF_CONTENT_EMPTY',
          false,
          'the PDF produced no extractable text',
        );
      }

      // 7. One normalization boundary for source visuals.
      const { images: normalizedImages, dropped } = normalizeSourceImages(parsed);
      const visionImages = toVisionPdfImages(normalizedImages);
      const visionMapping: Record<string, string> = {};
      for (const image of visionImages) {
        visionMapping[image.id] = image.src;
      }

      return {
        text: parsed.text,
        images: parsed.images,
        normalizedImages,
        visionImages,
        visionMapping,
        measuredBytes,
        measuredSha256,
      } satisfies NormalizedSource;
    },
    maxAttempts,
  );
}

/** Patch the attempt snapshot with the measured resource summary (no URL). */
export function recordPdfContentSummary(
  snapshot: Record<string, unknown>,
  source: NormalizedSource,
): Record<string, unknown> {
  return {
    ...snapshot,
    contentResource: {
      ...((snapshot.contentResource as Record<string, unknown> | undefined) ?? {}),
      measuredBytes: source.measuredBytes,
      measuredSha256: source.measuredSha256,
    },
    pdfContentSummary: {
      present: true,
      textLength: source.text.length,
      imageCount: source.visionImages.length,
    },
    sourceVisualSummary: {
      available: source.normalizedImages.length,
      selected: 0,
      materialized: 0,
    },
  };
}
