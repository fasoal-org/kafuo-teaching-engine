/**
 * The MOE-specific vision question, asked of a vision-capable model.
 *
 * Model selection: `VISUAL_COMPLIANCE_MODEL`, else the deployment's
 * `DEFAULT_MODEL` WHEN it is vision-capable. No model → `undefined`, and
 * `screenVisual` then fails closed (`unresolved`).
 */
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { resolveModel } from '@/lib/server/resolve-model';
import type { MoeBrandProfile, VisionScreeningClient } from './types';

const log = createLogger('VisualCompliance');

function buildQuestion(profile: MoeBrandProfile, checkRenderedText: boolean): string {
  return [
    'You are a compliance screener for educational lesson visuals. Inspect the attached image and answer ONE specific question.',
    '',
    'QUESTION: Does this image contain a Ministry of Education (MOE) logo, MOE branding, or an MOE watermark?',
    `The MOE marks to recognise are any logo, crest, seal, wordmark, stamp or watermark belonging to: ${profile.names.join(' | ')}.`,
    profile.watermarkPhrases.length
      ? `Known MOE watermark phrases: ${profile.watermarkPhrases.join(' | ')}.`
      : '',
    profile.referenceImages?.length
      ? 'Reference images of the MOE logo are attached AFTER the image under review.'
      : '',
    '',
    'IMPORTANT: only an MOE mark counts. A logo, brand, seal or watermark that is clearly NOT MOE (a company logo in a case study, a publisher imprint, a brand in a photograph) is "absent". If a mark is present but you cannot tell whether it is MOE, answer "uncertain".',
    checkRenderedText
      ? 'ALSO report whether the image contains ANY rendered text (letters, words, numbers used as labels, captions or titles) in any language.'
      : '',
    '',
    'Reply with ONLY this JSON object:',
    `{"moeMark":"present"|"absent"|"uncertain","containsRenderedText":true|false,"confidence":0.0-1.0,"evidence":"one short sentence"}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function parseVisionAnswer(
  text: string,
): Awaited<ReturnType<VisionScreeningClient['screen']>> {
  const match = /\{[\s\S]*\}/.exec(text);
  const parsed = match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
  const moeMark =
    parsed.moeMark === 'present' || parsed.moeMark === 'absent' ? parsed.moeMark : 'uncertain';
  const confidence =
    typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0;
  return {
    moeMark,
    confidence,
    ...(typeof parsed.containsRenderedText === 'boolean'
      ? { containsRenderedText: parsed.containsRenderedText }
      : {}),
    ...(typeof parsed.evidence === 'string' ? { evidence: parsed.evidence.slice(0, 300) } : {}),
  };
}

let cached: Promise<VisionScreeningClient | undefined> | undefined;

/** The configured vision client, or `undefined` when none can be resolved. */
export function getVisionScreeningClient(): Promise<VisionScreeningClient | undefined> {
  cached ??= (async () => {
    const modelString = process.env.VISUAL_COMPLIANCE_MODEL || process.env.DEFAULT_MODEL;
    if (!modelString) return undefined;
    try {
      const { model, modelInfo } = await resolveModel({ modelString });
      if (!process.env.VISUAL_COMPLIANCE_MODEL && !modelInfo?.capabilities?.vision) {
        log.warn(
          `DEFAULT_MODEL "${modelString}" is not vision-capable and VISUAL_COMPLIANCE_MODEL is unset — visuals will be withheld (unresolved)`,
        );
        return undefined;
      }
      const client: VisionScreeningClient = {
        model: modelString,
        async screen({ bytes, mimeType, profile, checkRenderedText }) {
          const content: Array<
            { type: 'text'; text: string } | { type: 'image'; image: string; mimeType?: string }
          > = [
            { type: 'text', text: buildQuestion(profile, checkRenderedText) },
            { type: 'image', image: bytes.toString('base64'), mimeType },
          ];
          for (const reference of profile.referenceImages ?? []) {
            const data = /^data:([^;]+);base64,(.+)$/.exec(reference);
            content.push(
              data
                ? { type: 'image', image: data[2]!, mimeType: data[1] }
                : { type: 'image', image: reference },
            );
          }
          const result = await callLLM(
            { model, messages: [{ role: 'user', content }], maxRetries: 0 },
            'visual-compliance',
          );
          return parseVisionAnswer(result.text);
        },
      };
      return client;
    } catch (error) {
      log.warn('Vision screening model could not be resolved — visuals will be withheld:', error);
      return undefined;
    }
  })();
  return cached;
}

/** Test seam: drop the memoised client. */
export function resetVisionScreeningClient(): void {
  cached = undefined;
}
