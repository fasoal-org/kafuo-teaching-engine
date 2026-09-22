/**
 * Execution-time prompt hardening for generated images (defence in depth
 * ONLY). This step approves nothing — every generated visual is still screened
 * by `screenVisual` before it can become learner-visible.
 */
import type { ImageTextPolicy } from './types';

const MOE_POLICY =
  'Do not depict or imitate any Ministry of Education logo, branding or watermark. Do not invent logos, seals, crests, stamps or watermarks of any kind.';
const TEXT_FREE_POLICY =
  'The image must contain NO text at all: no letters, words, numbers, labels, captions or titles in any language.';

export const MOE_NEGATIVE_PROMPT =
  'ministry of education logo, government logo, official seal, crest, emblem, watermark, stamp, brand logo';
const TEXT_NEGATIVE_PROMPT = 'text, letters, words, captions, labels, numbers, typography';

/** Resolve the embedded-text policy from AUTHORITATIVE lesson metadata only. */
export function resolveImageTextPolicy(textDirection: string | undefined): ImageTextPolicy {
  if (textDirection === 'rtl') return 'text-free';
  return textDirection === 'ltr' ? 'authoritative-language' : 'unrestricted';
}

/**
 * Return a copy of image options with the policy suffix appended and a
 * `negativePrompt` set for adapters that forward one. `reinforce` strengthens
 * the wording for a regeneration after a rejected attempt.
 */
export function applyImagePromptPolicy<T extends { prompt: string; negativePrompt?: string }>(
  options: T,
  textPolicy: ImageTextPolicy = 'unrestricted',
  reinforce = false,
): T {
  const parts = [MOE_POLICY, ...(textPolicy === 'text-free' ? [TEXT_FREE_POLICY] : [])];
  const suffix = reinforce
    ? `STRICT REQUIREMENTS (a previous attempt was rejected): ${parts.join(' ')} Produce a clean, plain educational illustration.`
    : parts.join(' ');
  if (options.prompt.includes(MOE_POLICY)) return options;
  const negative = [
    options.negativePrompt,
    MOE_NEGATIVE_PROMPT,
    ...(textPolicy === 'text-free' ? [TEXT_NEGATIVE_PROMPT] : []),
  ]
    .filter(Boolean)
    .join(', ');
  return { ...options, prompt: `${options.prompt.trim()}\n\n${suffix}`, negativePrompt: negative };
}
