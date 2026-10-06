/**
 * `screenVisual` — the one compliance screen used identically for generated,
 * source and author-supplied visuals.
 *
 * | layer | can REJECT | can APPROVE |
 * | 0. verdict cache `(profileId, sha256)`            | yes | yes |
 * | 1. manifest signals (non-educational/decorative)  | excludes | no |
 * | 2. text signals naming the MOE mark itself        | yes | no  |
 * | 3./4. repetition, geometry                        | escalate only | no |
 * | 5. vision — the MOE-specific question             | yes | YES — the only automated way |
 *
 * FAIL CLOSED: the deterministic layers can condemn or escalate but can never
 * establish compliance, so a visual with no cached verdict that cannot be
 * vision-screened is `unresolved` — treated exactly like `rejected` for
 * learner visibility. A missing / failing vision service never relaxes the
 * restriction and never stops generation: the caller withholds and replaces.
 */
import { createHash } from 'node:crypto';
import { resolveMoeBrandProfile } from './brand-profile';
import type {
  ComplianceVerdict,
  MoeBrandProfile,
  ScreenVisualOptions,
  VerdictStore,
  VisionScreeningClient,
  VisualMetadata,
} from './types';

/** Below this the vision answer is `unresolved`, never `approved`. */
export const VISION_APPROVAL_CONFIDENCE = 0.8;

export interface ScreenVisualDeps {
  store: VerdictStore;
  /** Absent → nothing can be approved automatically (fail closed). */
  vision?: VisionScreeningClient;
  now?: () => number;
  log?: (message: string) => void;
}

export function visualChecksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const normalizeText = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/[ً-ْـ]/g, '') // Arabic diacritics + tatweel
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Words that say "this is a mark", which turn a name match into a condemnation. */
const MARK_WORDS = ['logo', 'emblem', 'seal', 'crest', 'watermark', 'شعار', 'ختم', 'علامة مائية'];

/**
 * Layer 2. Rejects only when the descriptive text names the MOE MARK ITSELF
 * (an MOE name together with a mark word, or a known watermark phrase). A bare
 * mention of the ministry, or a generic "logo", is not a rejection.
 */
export function moeTextSignal(
  metadata: VisualMetadata | undefined,
  profile: MoeBrandProfile,
): string | undefined {
  const text = normalizeText(
    [metadata?.caption, metadata?.figureLabel, metadata?.description].filter(Boolean).join(' '),
  );
  if (!text) return undefined;
  for (const phrase of profile.watermarkPhrases) {
    if (text.includes(normalizeText(phrase))) return `text names an MOE watermark: "${phrase}"`;
  }
  const names = profile.names.filter((name) => name.length > 3).map(normalizeText);
  const namesMoe = names.some((name) => text.includes(name));
  const namesMark = MARK_WORDS.some((word) => text.includes(normalizeText(word)));
  return namesMoe && namesMark ? 'text names an MOE logo / mark' : undefined;
}

/** Layer 1. Pedagogical-value exclusion carried from the source manifest. */
function manifestExclusion(metadata: VisualMetadata | undefined): string | undefined {
  const role = metadata?.manifestRole?.toLowerCase();
  const decision = metadata?.manifestDecision?.toLowerCase();
  if (role === 'non_educational' || role === 'decorative') return `manifest role: ${role}`;
  if (decision === 'exclude' || decision === 'excluded') return `manifest decision: ${decision}`;
  return undefined;
}

export async function screenVisual(
  bytes: Buffer,
  options: ScreenVisualOptions,
  deps: ScreenVisualDeps,
): Promise<ComplianceVerdict> {
  const profile = options.profile ?? resolveMoeBrandProfile();
  const checksum = visualChecksum(bytes);
  const now = deps.now ?? Date.now;
  const make = (
    verdict: ComplianceVerdict['verdict'],
    method: ComplianceVerdict['method'],
    reasons: string[],
    extra: Partial<ComplianceVerdict> = {},
  ): ComplianceVerdict => ({
    verdict,
    method,
    reasons,
    checksum,
    profileId: profile.id,
    screenedAt: now(),
    ...extra,
  });

  // Layer 0 — cache. `unresolved` is never served from cache: a later run with
  // a working vision service must be able to resolve it.
  const cached = await deps.store.get(profile.id, checksum).catch(() => undefined);
  if (cached && cached.verdict !== 'unresolved') return { ...cached, method: 'cache' };

  const settle = async (verdict: ComplianceVerdict) => {
    await deps.store.put(verdict).catch((error: unknown) => {
      deps.log?.(`verdict store write failed for ${checksum}: ${String(error)}`);
    });
    return verdict;
  };

  // Layer 1 — manifest exclusion (can exclude, never approve).
  const excluded = manifestExclusion(options.metadata);
  if (excluded) return settle(make('rejected', 'manifest', [excluded]));

  // Layer 2 — text signals (can reject, never approve).
  const textSignal = moeTextSignal(options.metadata, profile);
  if (textSignal) return settle(make('rejected', 'text-signal', [textSignal]));

  // Layers 3/4 only escalate; every visual reaches layer 5 anyway, because
  // nothing short of it can approve.
  if (!deps.vision) {
    return settle(make('unresolved', 'none', ['no vision screening service is configured']));
  }

  try {
    const answer = await deps.vision.screen({
      bytes,
      mimeType: options.mimeType ?? 'image/png',
      profile,
      checkRenderedText: options.textPolicy === 'text-free',
    });
    const extra = { model: deps.vision.model, confidence: answer.confidence };
    const evidence = answer.evidence ? [answer.evidence] : [];
    if (answer.moeMark === 'present' && answer.confidence >= VISION_APPROVAL_CONFIDENCE) {
      return settle(make('rejected', 'vision', ['MOE mark detected', ...evidence], extra));
    }
    if (options.textPolicy === 'text-free' && answer.containsRenderedText === true) {
      return settle(
        make('rejected', 'vision', ['rendered text in a text-free visual', ...evidence], extra),
      );
    }
    if (
      answer.moeMark === 'absent' &&
      answer.confidence >= VISION_APPROVAL_CONFIDENCE &&
      (options.textPolicy !== 'text-free' || answer.containsRenderedText === false)
    ) {
      return settle(make('approved', 'vision', [], extra));
    }
    return settle(
      make('unresolved', 'vision', ['vision answer was not confident enough', ...evidence], extra),
    );
  } catch (error) {
    deps.log?.(`vision screening failed for ${checksum}: ${String(error)}`);
    return settle(make('unresolved', 'vision', ['vision screening service failed']));
  }
}

/** Learner visibility: only `approved` is visible. */
export function isLearnerVisible(verdict: ComplianceVerdict | undefined): boolean {
  return verdict?.verdict === 'approved';
}
