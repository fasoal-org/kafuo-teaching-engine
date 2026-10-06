/**
 * Visual compliance — shared vocabulary.
 *
 * GOVERNING RULE: only a visual with an `approved` verdict may become
 * learner-visible. Prompt instructions reduce how often a bad visual is
 * produced; they are never the control. The control is screening the actual
 * bytes, and it FAILS CLOSED: `unresolved` is treated exactly like `rejected`
 * for learner visibility.
 *
 * ENFORCEMENT SCOPE (FRD RSS-FR-084/085): Ministry of Education logo, MOE
 * branding, MOE watermark — nothing broader. A generic logo / seal / watermark
 * is only a SIGNAL that escalates a visual to the MOE-specific check; a mark
 * positively identified as not MOE is approved as far as this feature goes.
 */

export type VisualVerdict = 'approved' | 'rejected' | 'unresolved';

/** Where a visual came from — recorded with the verdict, never a verdict input. */
export type VisualOrigin = 'generated' | 'source' | 'author-supplied' | 'existing-package';

/** Whether rendered text inside the image is acceptable for this lesson. */
export type ImageTextPolicy = 'text-free' | 'authoritative-language' | 'unrestricted';

/** How a verdict was reached. `operator` outranks every automated method. */
export type VerdictMethod = 'cache' | 'manifest' | 'text-signal' | 'vision' | 'operator' | 'none';

/** Descriptive text that travels with a visual (never the pixels themselves). */
export interface VisualMetadata {
  caption?: string;
  figureLabel?: string;
  description?: string;
  /** Manifest role/decision carried through normalisation, when available. */
  manifestRole?: string;
  manifestDecision?: string;
  width?: number;
  height?: number;
  /** How many pages / places the same checksum appears on (page furniture). */
  occurrences?: number;
}

/**
 * The MOE marks to recognise. "Ministry of Education" is jurisdiction-specific,
 * so this is configuration, not code: selected per tenant / curriculum.
 */
export interface MoeBrandProfile {
  id: string;
  /** Names and wordmarks, Arabic and English. */
  names: string[];
  /** Known watermark phrases. */
  watermarkPhrases: string[];
  /** Optional reference images of the logo (data URLs / https), for the vision check. */
  referenceImages?: string[];
}

export interface ComplianceVerdict {
  verdict: VisualVerdict;
  reasons: string[];
  method: VerdictMethod;
  /** sha256 of the screened bytes, hex. */
  checksum: string;
  profileId: string;
  model?: string;
  confidence?: number;
  screenedAt: number;
  /** Set when a human confirmed the verdict. */
  confirmedBy?: string;
}

export interface ScreenVisualOptions {
  origin: VisualOrigin;
  metadata?: VisualMetadata;
  profile?: MoeBrandProfile;
  textPolicy?: ImageTextPolicy;
  mimeType?: string;
}

/** The MOE-specific vision question. Absent client → nothing can be approved. */
export interface VisionScreeningClient {
  readonly model: string;
  screen(input: {
    bytes: Buffer;
    mimeType: string;
    profile: MoeBrandProfile;
    checkRenderedText: boolean;
  }): Promise<{
    moeMark: 'present' | 'absent' | 'uncertain';
    containsRenderedText?: boolean;
    confidence: number;
    evidence?: string;
  }>;
}

/** Verdicts about BYTES, keyed by `(profileId, checksum)`. Stores no pedagogy. */
export interface VerdictStore {
  get(profileId: string, checksum: string): Promise<ComplianceVerdict | undefined>;
  put(verdict: ComplianceVerdict): Promise<void>;
}
