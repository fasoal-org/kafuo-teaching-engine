/**
 * Q-14 (Quran/hadith plan): the package editor's write path refuses an edit
 * that changes a pinned verse or hadith.
 *
 * Generation pins the sha256 + source block id of every protected quote of its
 * source on the document's outline record (`outline.sacredQuotes`). A document
 * or Scene write (`PUT /documents/<s>`, `PUT /documents/<s>/scenes/<x>`) on such
 * a Stage is checked before the store runs: every ﴿…﴾ span and attributed
 * hadith it carries must hash to a pin, no verse may be cut or spoken, and a
 * whole-document write may not drop or rewrite the pins themselves. A Stage
 * without pins (any non-package or pre-rule document) is never checked.
 */
import {
  findPinnedSacredTextEdits,
  pinnedQuotesIn,
  readSacredQuotePins,
  SACRED_TEXT_PINNED,
  samePins,
  shownQuotesIn,
  shownSceneTexts,
  type SacredQuote,
  type SacredQuotePin,
  type SacredSceneLike,
  type SacredTextFinding,
} from '@/lib/server/teaching-package/sacred-text';

export interface SacredEditRefusal {
  status: 422;
  code: string;
  message: string;
  scenes: Array<{ id: string; code: string }>;
}

interface OutlineReader {
  query(sql: string, values: unknown[]): Promise<{ rows: Array<{ data: unknown }> }>;
}

/** The PUT target of a write the guard covers, or `null`. */
function writeTarget(
  method: string,
  path: string,
): { stageId: string; kind: 'document' | 'scene' } | null {
  if (method !== 'PUT') return null;
  let parts: string[];
  try {
    parts = new URL(path, 'http://documents.invalid').pathname
      .split('/')
      .filter((part) => part !== '')
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (parts[0] !== 'documents' || !parts[1]) return null;
  if (parts.length === 2) return { stageId: parts[1], kind: 'document' };
  if (parts.length === 4 && parts[2] === 'scenes') return { stageId: parts[1], kind: 'scene' };
  return null;
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** The stored pins of a Stage, or `null` when it has none. */
export async function readStagePins(queryable: OutlineReader, stageId: string) {
  const result = await queryable.query('SELECT data FROM document_outlines WHERE stage_id = $1', [
    stageId,
  ]);
  const outline = decode(result.rows[0]?.data) as { sacredQuotes?: unknown } | null;
  return readSacredQuotePins(outline?.sacredQuotes);
}

/**
 * M-1: the pinned quote texts the Stage's STORED Scenes show (every Scene, so
 * a write under a new Scene id is checked too). The edit is then checked
 * against these texts, not only against the spans it still brackets.
 */
async function storedPinnedQuotes(
  queryable: OutlineReader,
  stageId: string,
  pins: readonly SacredQuotePin[],
): Promise<SacredQuote[]> {
  if (pins.length === 0) return [];
  const result = await queryable.query(
    'SELECT data FROM document_scenes WHERE stage_id = $1 ORDER BY scene_order, id',
    [stageId],
  );
  const stored = result.rows
    .map((row) => decode(row.data))
    .filter((scene): scene is SacredSceneLike => !!scene && typeof scene === 'object');
  const texts = shownSceneTexts(stored);
  // Pinned quotes first (they carry the pin's reference), then every span the
  // stored Scenes already show: a cut or wrapped verse that a regeneration
  // wrote without a new pin must survive an unchanged save.
  const pinned = pinnedQuotesIn(texts, pins);
  const seen = new Set(pinned.map((quote) => quote.sha256));
  return [...pinned, ...shownQuotesIn(texts).filter((quote) => !seen.has(quote.sha256))];
}

function refusal(findings: SacredTextFinding[]): SacredEditRefusal {
  return {
    status: 422,
    code: SACRED_TEXT_PINNED,
    message:
      findings[0]?.message ??
      'this edit changes a Quran verse or hadith the package pins to the book text',
    scenes: findings.map((finding) => ({ id: finding.sceneId, code: finding.code })),
  };
}

/**
 * The refusal for this request, or `null` to let it through. Reads a clone of
 * the body, so the store still receives the original stream. An unreadable
 * body is left to the store's own validation.
 */
export async function sacredTextEditRefusal(
  request: Request,
  path: string,
  queryable: OutlineReader,
): Promise<SacredEditRefusal | null> {
  const target = writeTarget(request.method, path);
  if (!target) return null;
  const pins = await readStagePins(queryable, target.stageId);
  if (!pins) return null;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const recovered = await storedPinnedQuotes(queryable, target.stageId, pins);
  if (target.kind === 'scene') {
    const findings = findPinnedSacredTextEdits([body as SacredSceneLike], pins, recovered);
    return findings.length > 0 ? refusal(findings) : null;
  }
  const document = body as { scenes?: unknown; outline?: { sacredQuotes?: unknown } | null };
  // S-1: the store REPLACES the outline record on a whole-document save (and
  // deletes it when `outline` is absent or null), so a save of a pinned Stage
  // must carry the outline with the same pins; anything else drops them.
  const sent =
    document.outline && typeof document.outline === 'object'
      ? readSacredQuotePins(document.outline.sacredQuotes)
      : null;
  if (!sent || !samePins(sent, pins)) {
    return refusal([
      {
        code: SACRED_TEXT_PINNED,
        sceneId: '',
        message: 'this write drops or rewrites the Quran / hadith pins of the package',
      },
    ]);
  }
  const scenes = Array.isArray(document.scenes) ? (document.scenes as SacredSceneLike[]) : [];
  const findings = findPinnedSacredTextEdits(scenes, pins, recovered);
  return findings.length > 0 ? refusal(findings) : null;
}
