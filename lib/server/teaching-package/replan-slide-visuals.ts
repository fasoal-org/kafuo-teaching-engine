/**
 * Re-plan the VISUAL of one existing slide outline (slide image plan, D-1/D-3/D-4).
 *
 * The planner — not a deterministic swap — chooses the textbook image(s) a
 * slide shows and writes one teaching note per image (`imagePlans`), or a
 * native-diagram note (`visualPlan.diagram`) when no linked image exists. It is
 * re-asked for ONE slide, with that slide's linked images attached so it sees
 * what it describes, when:
 *
 * - the outline answer selected no linked image, or delivered an image without
 *   its note (D-1);
 * - the slide's chosen image was outside the outline call's vision budget, so
 *   its note could only have come from the caption (D-4);
 * - an administrator changed the slide's images (D-3).
 *
 * Only the visual fields and the learner-visible key points change; the slide's
 * id, order, position, classification and cited units are kept. One corrective
 * re-ask, then the caller's admin-correction pause applies.
 */

import {
  parseJsonResponse,
  type AICallFn,
  type ImagePlan,
  type PdfImage,
  type SceneOutline,
  type VisualPlan,
} from '@openmaic/generation';

/** Linked images attached to one re-plan call, by vision priority. */
export const MAX_REPLAN_IMAGES = 6;

export interface ReplanSlideVisualsInput {
  outline: SceneOutline;
  /** The source images linked to the slide's Content Units, by vision priority. */
  linkedImages: readonly PdfImage[];
  /** The image bytes / URL the model sees, per image id. */
  imageSrc: (image: PdfImage) => string;
  /** The approved text of the slide's cited units (may be empty). */
  sourceText: string;
  languageDirective: string;
  /** Why the slide is re-planned (the findings it must fix). */
  reasons: readonly string[];
  /**
   * Images the answer must show — exactly these — when the selection itself is
   * settled (an administrator's choice, D-3) and only the notes are missing.
   */
  requiredImageIds?: readonly string[];
  /** The remaining visual findings of a candidate (empty = accepted). */
  check: (candidate: SceneOutline) => string[];
  aiCall: AICallFn;
}

export type ReplanSlideVisualsResult =
  | { ok: true; outline: SceneOutline; calls: number }
  | { ok: false; messages: string[]; calls: number };

interface RawVisualPlan {
  suggestedImageIds?: unknown;
  imagePlans?: unknown;
  visualPlan?: unknown;
  keyPoints?: unknown;
}

function systemPrompt(): string {
  return [
    'You re-plan the VISUAL of ONE existing lesson slide. Its title, purpose and position are fixed; only its visual and the wording of its key points may change.',
    'Return ONLY a JSON object, no prose, with these fields:',
    '- "suggestedImageIds": the ids of the attached textbook images this slide shows (only ids listed below; may be empty only when none is listed);',
    '- "imagePlans": exactly one entry per id in suggestedImageIds, same order: { "imageId", "shows": what this image actually shows, "teachingPoint": what the learner must notice in it and why it is on this slide };',
    '- "visualPlan": { "mode": "image" } when an image is chosen; otherwise { "mode": "native", "diagram": { "shows", "teachingPoint" } } describing a simple diagram built only from the source text;',
    '- "keyPoints": 3 to 6 short learner-visible points — the same teaching content, made consistent with the chosen image(s).',
    'Rules: when any listed image teaches this slide, choose it. Write "shows" only from what you can see in the attached image or read in its caption and figure label — never invent content. Add no fact the slide or its source does not contain. Write "shows", "teachingPoint" and "keyPoints" in the lesson language.',
  ].join('\n');
}

function userPrompt(input: ReplanSlideVisualsInput, images: readonly PdfImage[]): string {
  const lines = [
    ...(input.languageDirective
      ? [`Language and register policy: ${input.languageDirective}`]
      : []),
    `Slide title: ${input.outline.title}`,
    `Slide purpose (planner note): ${input.outline.description}`,
    'Current key points:',
    ...(input.outline.keyPoints ?? []).map((point, index) => `${index + 1}. ${point}`),
    '',
    images.length > 0
      ? 'Textbook images linked to this slide (attached, in this order):'
      : 'Textbook images linked to this slide: none — plan a native diagram.',
    ...images.map((image) => {
      const source = [
        image.figureLabel ? `figure ${image.figureLabel}` : '',
        image.caption ? `caption "${image.caption}"` : '',
        image.pageNumber ? `page ${image.pageNumber}` : '',
      ].filter(Boolean);
      return `- ${image.id}${source.length ? ` (${source.join(', ')})` : ''}`;
    }),
    ...(input.sourceText ? ['', 'Source text of this slide:', input.sourceText] : []),
    ...(input.requiredImageIds?.length
      ? [
          '',
          `These images were chosen for this slide by a reviewer: keep exactly ${input.requiredImageIds.join(', ')} in suggestedImageIds, and write the note of each one.`,
        ]
      : []),
    '',
    'Fix these findings:',
    ...input.reasons.map((reason) => `- ${reason}`),
  ];
  return lines.join('\n');
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

/** The model's answer merged onto the slide; only the visual fields and key points move. */
function mergeAnswer(
  outline: SceneOutline,
  raw: RawVisualPlan | null,
  eligible: ReadonlySet<string>,
  required: readonly string[] | undefined,
): { outline: SceneOutline } | { messages: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { messages: ['the answer is not a JSON object'] };
  }
  const messages: string[] = [];
  const ids = strings(raw.suggestedImageIds);
  const foreign = ids.filter((id) => !eligible.has(id));
  if (foreign.length > 0) {
    messages.push(
      `"suggestedImageIds" may only name the listed images; not listed: ${foreign.join(', ')}`,
    );
  }
  if (
    required?.length &&
    (ids.length !== required.length || required.some((id) => !ids.includes(id)))
  ) {
    messages.push(`"suggestedImageIds" must be exactly ${required.join(', ')}`);
  }
  const imagePlans: ImagePlan[] = (Array.isArray(raw.imagePlans) ? raw.imagePlans : [])
    .filter((plan): plan is Record<string, unknown> => !!plan && typeof plan === 'object')
    .map((plan) => ({
      imageId: typeof plan.imageId === 'string' ? plan.imageId : '',
      shows: typeof plan.shows === 'string' ? plan.shows.trim() : '',
      teachingPoint: typeof plan.teachingPoint === 'string' ? plan.teachingPoint.trim() : '',
    }));
  const plan = raw.visualPlan as Partial<VisualPlan> | undefined;
  const mode = ids.length > 0 ? 'image' : 'native';
  if (plan?.mode !== mode) messages.push(`"visualPlan.mode" must be "${mode}" for this answer`);
  const keyPoints = strings(raw.keyPoints);
  if (keyPoints.length < 3 || keyPoints.length > 6) {
    messages.push('"keyPoints" must hold 3 to 6 non-empty strings');
  }
  if (messages.length > 0) return { messages };

  const {
    suggestedImageIds: _ids,
    imagePlans: _plans,
    visualPlan: _visual,
    mediaGenerations,
    ...rest
  } = outline;
  const otherMedia = (mediaGenerations ?? []).filter((request) => request.type !== 'image');
  const diagram = plan?.diagram;
  return {
    outline: {
      ...rest,
      keyPoints,
      visualPlan:
        mode === 'image'
          ? { mode }
          : {
              mode,
              ...(diagram && typeof diagram === 'object'
                ? {
                    diagram: {
                      shows: typeof diagram.shows === 'string' ? diagram.shows.trim() : '',
                      teachingPoint:
                        typeof diagram.teachingPoint === 'string'
                          ? diagram.teachingPoint.trim()
                          : '',
                    },
                  }
                : {}),
            },
      ...(ids.length > 0 ? { suggestedImageIds: ids, imagePlans } : {}),
      ...(otherMedia.length > 0 ? { mediaGenerations: otherMedia } : {}),
    },
  };
}

export async function replanSlideVisuals(
  input: ReplanSlideVisualsInput,
): Promise<ReplanSlideVisualsResult> {
  const images = input.linkedImages.slice(0, MAX_REPLAN_IMAGES);
  const eligible = new Set(images.map((image) => image.id));
  const visionImages = images.map((image) => ({
    id: image.id,
    src: input.imageSrc(image),
    ...(image.width ? { width: image.width } : {}),
    ...(image.height ? { height: image.height } : {}),
  }));
  let calls = 0;
  let messages: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? userPrompt(input, images)
        : [
            userPrompt(input, images),
            '',
            'Your previous answer was rejected for these reasons; return a corrected JSON object:',
            ...messages.map((message) => `- ${message}`),
          ].join('\n');
    calls += 1;
    let answer: string;
    try {
      answer = await input.aiCall(
        systemPrompt(),
        prompt,
        visionImages.length > 0 ? visionImages : undefined,
      );
    } catch (error) {
      return {
        ok: false,
        messages: [
          `the slide visual could not be re-planned (${error instanceof Error ? error.message : String(error)})`,
        ],
        calls,
      };
    }
    const merged = mergeAnswer(
      input.outline,
      parseJsonResponse<RawVisualPlan>(answer),
      eligible,
      input.requiredImageIds,
    );
    if ('messages' in merged) {
      messages = merged.messages;
      continue;
    }
    const remaining = input.check(merged.outline);
    if (remaining.length === 0) return { ok: true, outline: merged.outline, calls };
    messages = remaining;
  }
  return { ok: false, messages, calls };
}
