/**
 * The `direct` Free Chat grounding flow over the reader seam
 * (discovery-first plan §5.3–§5.6, P7; D-10, D-17, D-18):
 *
 *   probe (D-10)        none / reuse turn → `probeItems`; a `single` match to an
 *                       item other than the current one upgrades to retrieve
 *   revalidate (D-17)   reuse turn → one `validateUnits`; any unit invalid → retrieve
 *   retrieve            `resolveItems` → single | ambiguous (≤ 3, searched only
 *                       above `TUTOR_GROUNDING_AMBIGUOUS_SEARCH_MIN_SCORE`) →
 *                       `itemEmbeddingProfile` → embed once per turn with the
 *                       selected run's provider/model/dims → `searchUnits` bound
 *                       to the run ids (≤ 5 distinct units)
 *                       weak, or ambiguous with a weak spread → clarification
 *                       no_match / index_not_ready → insufficient, no embedding,
 *                       no vector search
 *                       run_superseded → one re-profile (re-embed only if the
 *                       group changed) → a second failure is retrieval_unavailable
 *
 * A scope refusal from ANY call (`student_ref_unknown`,
 * `offering_not_permitted`) is authoritative: the turn refuses with
 * SUBJECT_NO_LONGER_AVAILABLE (D-18), before any reservation.
 *
 * Nothing here logs text, vectors or rows (RET-07); the resolution audit
 * carries ids, outcomes, scores, matched term types and build/run ids only.
 */
import { TeachingPackageError } from '@/lib/server/teaching-package/errors';
import type { InsufficientReason } from '@/lib/server/tutor/prompt-assembly';

import { clarificationTitle, MAX_CLARIFICATION_CANDIDATES } from './clarification';
import { ambiguousSearchMinScore, evidenceFloor } from './grounding-config';
import type {
  DirectGroundingDeps,
  GroundingReaderScope,
  ItemCandidate,
  ItemEmbeddingProfile,
  ItemProfileEntry,
  ReaderCallMeta,
  ResolveItemsResult,
  SearchUnitRow,
  UnitRef,
} from './kafuo-grounding-reader';

export const MAX_SEARCH_TARGETS = 3;
export const SEARCH_UNIT_LIMIT = 5;

// ---------------------------------------------------------------------------
// Timings (RET-06): resolve = probe + resolve_items; search = profile +
// search_units + validate_units; embed = the query embedding.
// ---------------------------------------------------------------------------

export interface RetrievalTimings {
  poolWaitMs: number;
  resolveMs: number;
  embedMs: number;
  searchMs: number;
  totalRetrievalMs: number;
}

export class RetrievalClock {
  private poolWaitMs = 0;
  private resolveMs = 0;
  private embedMs = 0;
  private searchMs = 0;
  private calls = 0;
  private readonly startedAt = performance.now();

  async time<T>(stage: 'resolve' | 'embed' | 'search', run: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    this.calls += 1;
    try {
      return await run();
    } finally {
      const elapsed = performance.now() - t0;
      if (stage === 'resolve') this.resolveMs += elapsed;
      else if (stage === 'embed') this.embedMs += elapsed;
      else this.searchMs += elapsed;
    }
  }

  addPoolWait(meta: ReaderCallMeta | { outcome: string }): void {
    const wait = (meta as ReaderCallMeta).poolWaitMs;
    if (typeof wait === 'number' && Number.isFinite(wait)) this.poolWaitMs += wait;
  }

  /** `null` when no reader or embedding call ran this turn. */
  snapshot(): RetrievalTimings | null {
    if (this.calls === 0) return null;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return {
      poolWaitMs: round(this.poolWaitMs),
      resolveMs: round(this.resolveMs),
      embedMs: round(this.embedMs),
      searchMs: round(this.searchMs),
      totalRetrievalMs: round(performance.now() - this.startedAt),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ScopeRefusalOutcome = 'student_ref_unknown' | 'offering_not_permitted';

/** D-18: the student lost access mid-conversation → the existing 403 envelope. */
export function accessLost(outcome: ScopeRefusalOutcome): TeachingPackageError {
  return new TeachingPackageError(
    'SUBJECT_NO_LONGER_AVAILABLE',
    `the subject is no longer available to this student (${outcome})`,
  );
}

function refusalOf(result: { outcome: string }): ScopeRefusalOutcome | null {
  return result.outcome === 'student_ref_unknown' || result.outcome === 'offering_not_permitted'
    ? result.outcome
    : null;
}

/** A throwing reader is `retrieval_unavailable` (the seam contract returns, never throws). */
async function safeCall<T extends { outcome: string }>(
  run: () => Promise<T>,
): Promise<T | { outcome: 'retrieval_unavailable' }> {
  try {
    return await run();
  } catch {
    return { outcome: 'retrieval_unavailable' };
  }
}

function candidateAudit(candidate: ItemCandidate) {
  return {
    itemId: candidate.learningItemId,
    itemType: candidate.itemType,
    score: candidate.score,
    matchedTermTypes: candidate.matchedTermTypes,
    routable: candidate.routable,
    ...(candidate.buildId !== undefined ? { buildId: candidate.buildId } : {}),
    ...(candidate.readiness !== undefined ? { readiness: candidate.readiness } : {}),
    ...(candidate.matchSource !== undefined ? { matchSource: candidate.matchSource } : {}),
  };
}

/** Ids, outcome, scores and term types only — never titles or text. */
export function describeResolution(result: ResolveItemsResult | { outcome: string }) {
  const record = result as Partial<{
    outcome: string;
    reasonCode: string | null;
    indexCoverage: string;
    candidates: ItemCandidate[];
  }>;
  return {
    outcome: record.outcome,
    ...(record.reasonCode !== undefined ? { reasonCode: record.reasonCode } : {}),
    ...(record.indexCoverage !== undefined ? { indexCoverage: record.indexCoverage } : {}),
    ...(record.candidates ? { candidates: record.candidates.map(candidateAudit) } : {}),
  };
}

// ---------------------------------------------------------------------------
// D-10 probe
// ---------------------------------------------------------------------------

export interface ProbeOutcome {
  /** The `single` resolution to retrieve with, when the probe upgrades the turn. */
  upgrade: ResolveItemsResult | null;
  audit: Record<string, unknown>;
}

/**
 * One indexed statement on an eligible none/reuse turn. Any failure leaves
 * the original decision standing; a scope refusal still refuses the turn.
 */
export async function runDiscoveryProbe(
  direct: DirectGroundingDeps,
  scope: GroundingReaderScope,
  text: string,
  currentItemIds: ReadonlySet<string>,
  clock: RetrievalClock,
): Promise<ProbeOutcome> {
  const result = await clock.time('resolve', () =>
    safeCall(() => direct.reader.probeItems(scope, { text })),
  );
  clock.addPoolWait(result);
  const refusal = refusalOf(result);
  if (refusal) throw accessLost(refusal);
  if (result.outcome === 'single') {
    const top = (result as Extract<ResolveItemsResult, { outcome: 'single' }>).candidates[0];
    if (top && top.routable && !currentItemIds.has(top.learningItemId)) {
      return {
        upgrade: result as ResolveItemsResult,
        audit: { outcome: 'single', itemId: top.learningItemId, upgraded: true },
      };
    }
    return {
      upgrade: null,
      audit: { outcome: 'single', itemId: top?.learningItemId ?? null, upgraded: false },
    };
  }
  return { upgrade: null, audit: { outcome: result.outcome, upgraded: false } };
}

// ---------------------------------------------------------------------------
// D-17 reuse revalidation
// ---------------------------------------------------------------------------

export type RevalidationOutcome = 'valid' | 'invalid' | 'retrieval_busy' | 'retrieval_unavailable';

export async function revalidateUnits(
  direct: DirectGroundingDeps,
  scope: GroundingReaderScope,
  unitRefs: UnitRef[],
  clock: RetrievalClock,
): Promise<{ outcome: RevalidationOutcome; validCount: number }> {
  const result = await clock.time('search', () =>
    safeCall(() => direct.reader.validateUnits(scope, { unitRefs })),
  );
  clock.addPoolWait(result);
  const refusal = refusalOf(result);
  if (refusal) throw accessLost(refusal);
  if (result.outcome === 'retrieval_busy' || result.outcome === 'retrieval_unavailable') {
    return { outcome: result.outcome, validCount: 0 };
  }
  const valid = new Set((result as { validUnitIds: string[] }).validUnitIds);
  const validCount = unitRefs.filter((ref) => valid.has(ref.contentUnitId)).length;
  return { outcome: validCount === unitRefs.length ? 'valid' : 'invalid', validCount };
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface DirectRetrievalRequest {
  /** The question resolved and embedded (the original question on a clarification choice). */
  text: string;
  /** A `single` resolution already obtained by the probe (no second resolve call). */
  resolved?: ResolveItemsResult;
  /** The student's choice after a clarification (resolution skipped). */
  selected?: ItemCandidate;
}

export interface RetrievedItem {
  itemId: string;
  itemType: ItemCandidate['itemType'];
  title: string | null;
}

export type DirectRetrievalResult =
  | {
      kind: 'retrieved';
      units: SearchUnitRow[];
      /** Items of the kept units, in first-appearance order. */
      items: RetrievedItem[];
      resolution: Record<string, unknown>;
      embedding: { model: string; tokens: number | null };
    }
  | {
      kind: 'clarify';
      candidates: Array<{ itemId: string; itemType: ItemCandidate['itemType']; title: string }>;
      resolution: Record<string, unknown>;
    }
  | {
      kind: 'insufficient';
      reason: InsufficientReason;
      resolution: Record<string, unknown>;
      embedding?: { model: string; tokens: number | null };
    };

interface ProfileSelection {
  group: { provider: string; model: string; dims: number };
  targets: Array<{ candidate: ItemCandidate; profile: ItemEmbeddingProfile }>;
  dropped: Array<{ itemId: string; reason: string }>;
}

function groupKey(profile: { provider: string; model: string; dims: number }): string {
  return `${profile.provider}\u0000${profile.model}\u0000${profile.dims}`;
}

/** Candidates the student can be shown (non-empty titles), ≤ 3. */
function clarifiable(candidates: readonly ItemCandidate[]) {
  const out: Array<{ itemId: string; itemType: ItemCandidate['itemType']; title: string }> = [];
  for (const candidate of candidates) {
    const title = clarificationTitle(candidate.title);
    if (!title) continue;
    out.push({ itemId: candidate.learningItemId, itemType: candidate.itemType, title });
    if (out.length >= MAX_CLARIFICATION_CANDIDATES) break;
  }
  return out;
}

/** "Weak spread" (no number before D-7): search only when every candidate clears the floor. */
function shouldSearchAmbiguous(candidates: readonly ItemCandidate[]): boolean {
  const floor = ambiguousSearchMinScore();
  if (floor === null) return false;
  return candidates.every((candidate) => candidate.score >= floor);
}

export async function retrieveDirect(
  direct: DirectGroundingDeps,
  scope: GroundingReaderScope,
  request: DirectRetrievalRequest,
  clock: RetrievalClock,
): Promise<DirectRetrievalResult> {
  let resolved: ResolveItemsResult | { outcome: 'retrieval_unavailable' };
  if (request.selected) {
    resolved = {
      outcome: 'single',
      reasonCode: 'clarification_choice',
      candidates: [request.selected],
    };
  } else if (request.resolved) {
    resolved = request.resolved;
  } else {
    resolved = await clock.time('resolve', () =>
      safeCall(() =>
        direct.reader.resolveItems(scope, {
          text: request.text,
          maxCandidates: MAX_SEARCH_TARGETS,
        }),
      ),
    );
    clock.addPoolWait(resolved);
  }
  const resolution: Record<string, unknown> = {
    ...describeResolution(resolved),
    ...(request.selected ? { selection: 'clarification_choice' } : {}),
    ...(request.resolved ? { via: 'probe' } : {}),
  };
  const insufficient = (reason: InsufficientReason): DirectRetrievalResult => ({
    kind: 'insufficient',
    reason,
    resolution,
  });
  const clarifyOr = (candidates: readonly ItemCandidate[]): DirectRetrievalResult => {
    const shown = clarifiable(candidates);
    return shown.length > 0
      ? { kind: 'clarify', candidates: shown, resolution }
      : insufficient('no_match');
  };

  const refusal = refusalOf(resolved);
  if (refusal) throw accessLost(refusal);
  switch (resolved.outcome) {
    case 'retrieval_busy':
      return insufficient('retrieval_busy');
    case 'retrieval_unavailable':
      return insufficient('retrieval_unavailable');
    case 'no_match':
      return insufficient('no_match');
    case 'index_not_ready':
      return insufficient('index_not_ready');
    case 'weak':
      return clarifyOr(resolved.candidates);
    case 'ambiguous': {
      const candidates = resolved.candidates
        .filter((candidate) => candidate.routable)
        .slice(0, MAX_SEARCH_TARGETS);
      if (candidates.length === 0) return insufficient('no_match');
      if (!shouldSearchAmbiguous(candidates)) return clarifyOr(candidates);
      return searchItems(direct, scope, request.text, candidates, resolution, clock);
    }
    case 'single': {
      const top = resolved.candidates[0];
      if (!top) return insufficient('no_match');
      return searchItems(direct, scope, request.text, [top], resolution, clock);
    }
    default:
      return insufficient('retrieval_unavailable');
  }
}

async function profileTargets(
  direct: DirectGroundingDeps,
  scope: GroundingReaderScope,
  candidates: readonly ItemCandidate[],
  clock: RetrievalClock,
): Promise<ProfileSelection | { reason: InsufficientReason; profiles: Record<string, string> }> {
  const result = await clock.time('search', () =>
    safeCall(() =>
      direct.reader.itemEmbeddingProfile(scope, {
        itemIds: candidates.map((candidate) => candidate.learningItemId),
      }),
    ),
  );
  clock.addPoolWait(result);
  const refusal = refusalOf(result);
  if (refusal) throw accessLost(refusal);
  if (result.outcome === 'retrieval_busy' || result.outcome === 'retrieval_unavailable') {
    return { reason: result.outcome, profiles: {} };
  }
  const entries = new Map<string, ItemProfileEntry>();
  for (const entry of (result as { items: ItemProfileEntry[] }).items) {
    entries.set(entry.learningItemId, entry);
  }
  const profiles: Record<string, string> = {};
  for (const candidate of candidates) {
    profiles[candidate.learningItemId] =
      entries.get(candidate.learningItemId)?.outcome ?? 'missing';
  }
  // The group of the top-ranked candidate with a usable run (RET-01).
  const anchor = candidates
    .map((candidate) => entries.get(candidate.learningItemId))
    .find(
      (entry): entry is Extract<ItemProfileEntry, { outcome: 'ok' }> => entry?.outcome === 'ok',
    );
  if (!anchor) {
    const top = entries.get(candidates[0]!.learningItemId);
    return {
      reason:
        top?.outcome === 'embedding_profile_mismatch'
          ? 'embedding_profile_mismatch'
          : 'retrieval_unavailable',
      profiles,
    };
  }
  const key = groupKey(anchor);
  const selection: ProfileSelection = {
    group: { provider: anchor.provider, model: anchor.model, dims: anchor.dims },
    targets: [],
    dropped: [],
  };
  for (const candidate of candidates) {
    const entry = entries.get(candidate.learningItemId);
    if (entry?.outcome === 'ok' && groupKey(entry) === key) {
      selection.targets.push({ candidate, profile: entry });
    } else {
      selection.dropped.push({
        itemId: candidate.learningItemId,
        reason: entry?.outcome === 'ok' ? 'dropped_incompatible' : (entry?.outcome ?? 'missing'),
      });
    }
  }
  return selection;
}

async function searchItems(
  direct: DirectGroundingDeps,
  scope: GroundingReaderScope,
  text: string,
  candidates: readonly ItemCandidate[],
  resolution: Record<string, unknown>,
  clock: RetrievalClock,
): Promise<DirectRetrievalResult> {
  const insufficient = (
    reason: InsufficientReason,
    embedding?: { model: string; tokens: number | null },
  ): DirectRetrievalResult => ({
    kind: 'insufficient',
    reason,
    resolution,
    ...(embedding ? { embedding } : {}),
  });

  let selection = await profileTargets(direct, scope, candidates, clock);
  if ('reason' in selection) {
    resolution.profiles = selection.profiles;
    return insufficient(selection.reason);
  }

  let vector: number[] | null = null;
  let embedding: { model: string; tokens: number | null } | undefined;
  let embeddedGroup: string | null = null;
  let reprofiled = false;

  for (;;) {
    const current: ProfileSelection = selection;
    resolution.searchedItemIds = current.targets.map((target) => target.candidate.learningItemId);
    resolution.dropped = current.dropped;
    resolution.group = current.group;
    resolution.runIds = current.targets.map((target) => target.profile.embeddingRunId);
    resolution.buildIds = current.targets.map((target) => target.profile.buildId);
    resolution.reprofiled = reprofiled;

    if (vector === null || embeddedGroup !== groupKey(current.group)) {
      const embedded = await clock.time('embed', () =>
        direct.embedder
          .embed({ ...current.group, text })
          .catch(() => ({ outcome: 'embedding_unavailable' as const })),
      );
      if (embedded.outcome === 'embedding_provider_unsupported') {
        return insufficient('embedding_provider_unsupported');
      }
      if (embedded.outcome !== 'ok') return insufficient('retrieval_unavailable', embedding);
      embedding = { model: current.group.model, tokens: embedded.tokens };
      if (embedded.vector.length !== current.group.dims) {
        return insufficient('embedding_profile_mismatch', embedding);
      }
      vector = embedded.vector;
      embeddedGroup = groupKey(current.group);
    }

    const query = vector;
    const searched = await clock.time('search', () =>
      safeCall(() =>
        direct.reader.searchUnits(scope, {
          targets: current.targets.map((target) => ({
            learningItemId: target.candidate.learningItemId,
            embeddingRunId: target.profile.embeddingRunId,
          })),
          query,
          provider: current.group.provider,
          model: current.group.model,
          limit: SEARCH_UNIT_LIMIT,
        }),
      ),
    );
    clock.addPoolWait(searched);
    resolution.searchOutcome = searched.outcome;
    const refusal = refusalOf(searched);
    if (refusal) throw accessLost(refusal);
    switch (searched.outcome) {
      case 'retrieval_busy':
        return insufficient('retrieval_busy', embedding);
      case 'retrieval_unavailable':
        return insufficient('retrieval_unavailable', embedding);
      case 'embedding_profile_mismatch':
        return insufficient('embedding_profile_mismatch', embedding);
      case 'run_superseded': {
        // One re-profile; a second supersession (or a failed re-profile) gives up.
        if (reprofiled) return insufficient('retrieval_unavailable', embedding);
        reprofiled = true;
        const next = await profileTargets(direct, scope, candidates, clock);
        if ('reason' in next) {
          resolution.reprofiled = true;
          return insufficient('retrieval_unavailable', embedding);
        }
        selection = next;
        continue;
      }
      case 'ok': {
        const kafuoDropped = (searched as { dropped?: unknown[] }).dropped;
        if (kafuoDropped && kafuoDropped.length > 0) resolution.kafuoDropped = kafuoDropped;
        const floor = evidenceFloor();
        const titles = new Map(
          candidates.map((candidate) => [candidate.learningItemId, candidate] as const),
        );
        const units = (searched as { units: SearchUnitRow[] }).units
          .filter((unit) => unit.similarity >= floor)
          .slice(0, SEARCH_UNIT_LIMIT);
        resolution.unitCount = units.length;
        if (units.length === 0) return insufficient('below_evidence_floor', embedding);
        const items: RetrievedItem[] = [];
        for (const unit of units) {
          if (items.some((item) => item.itemId === unit.learningItemId)) continue;
          const candidate = titles.get(unit.learningItemId);
          items.push({
            itemId: unit.learningItemId,
            itemType: unit.itemType,
            title: clarificationTitle(candidate?.title) ?? null,
          });
        }
        return { kind: 'retrieved', units, items, resolution, embedding: embedding! };
      }
      default:
        return insufficient('retrieval_unavailable', embedding);
    }
  }
}
