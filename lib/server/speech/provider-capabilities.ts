/**
 * Provider capability table (plan §12.5). The segmenter and the orchestrator
 * read their limits here, never from provider constants. A row is filled only
 * from that provider's official documentation plus measured reliability; an
 * unknown provider has no row and never runs the governed profile.
 */
export interface ProviderCapability {
  supportsInstructions: boolean;
  /** Documented hard limit, enforced client-side (M3). */
  maxInputChars: number;
  /** Documented token cap (P2), counting instructions (M1). */
  maxInputTokens?: number;
  tokenizer?: 'o200k_base';
  /** Reliability budget per segment (Wave 0, M4). */
  maxReliableSegmentChars: number;
  /** Estimated-token budget per segment (Wave 0 §3). */
  maxReliableSegmentTokens?: number;
  /** κ multiplier on the token estimate (Wave 0: 1.05). */
  tokenKappa: number;
  usageSource: 'sse-done' | 'none';
  requestTimeoutMs: number;
  localeParam: 'none' | 'language';
  formats: readonly string[];
  pinnedModelRequired: boolean;
}

/** Provider id → model predicate → capability. */
const CAPABILITIES: ReadonlyArray<{
  providerId: string;
  model: RegExp;
  capability: ProviderCapability;
}> = [
  {
    providerId: 'openai-tts',
    model: /^gpt-4o-mini-tts/,
    capability: {
      supportsInstructions: true,
      maxInputChars: 4096, // P1
      maxInputTokens: 2000, // P2, M1
      tokenizer: 'o200k_base', // M2
      maxReliableSegmentChars: 600, // M4, Wave 0 §3
      maxReliableSegmentTokens: 500, // Wave 0 §3
      tokenKappa: 1.05, // Wave 0 §3
      usageSource: 'sse-done', // M5
      requestTimeoutMs: 90_000, // M8
      localeParam: 'none',
      formats: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'], // P8
      pinnedModelRequired: true, // §12.2
    },
  },
  {
    // D-4 revised 2026-09-29: Cartesia Sonic, voice "Reem". Versioned model ids
    // only (`sonic-3.6`, never `sonic-latest`), so the fingerprint stays honest.
    providerId: 'cartesia-tts',
    model: /^sonic-\d/,
    capability: {
      supportsInstructions: false, // accent comes from the voice; only speed/emotion exist
      // Transcript limit is not documented; this client-side cap is conservative.
      maxInputChars: 1000,
      maxReliableSegmentChars: 600, // Wave 0 budget kept until a Cartesia measurement says otherwise
      tokenKappa: 1,
      usageSource: 'none', // billed per character; no usage payload
      requestTimeoutMs: 60_000,
      localeParam: 'language',
      formats: ['mp3', 'wav'],
      pinnedModelRequired: false, // no dated snapshots; the version is in the model id
    },
  },
];

export function providerCapability(providerId: string, modelId: string): ProviderCapability | null {
  return (
    CAPABILITIES.find((row) => row.providerId === providerId && row.model.test(modelId))?.capability ??
    null
  );
}

/** Hard-cap margin (plan §13.2): `κ·(tok(seg)+tok(instr)) ≤ maxInputTokens − 150` must always hold. */
export const TOKEN_CAP_MARGIN = 150;
