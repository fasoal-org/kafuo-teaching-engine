/**
 * Source visuals are screened BEFORE they are offered (RSS 7.5.4): only an
 * `approved` visual is handed to the outline model (its text line and its
 * vision bytes), so a non-approved visual can never be selected, never
 * materialised into stage media, and never substituted into a slide.
 *
 * A withheld visual is not lost to the lesson: its caption / figure label stay
 * in the grounding text and the planner is told a figure exists but is
 * unavailable, so it plans a compliant alternative (a generated illustration —
 * itself screened — or native diagram / chart / table elements). Nothing is
 * cropped, inpainted, blurred or overlaid: a visual is never shown "cleaned",
 * only replaced.
 */
import { createLogger } from '@/lib/logger';
import { screenVisualWithDefaults, type ComplianceVerdict } from '@/lib/server/visual-compliance';
import type { NormalizedSourceImage } from './source-images';

const log = createLogger('SourceVisualCompliance');

export interface ScreenedSourceImages {
  approved: NormalizedSourceImage[];
  withheld: Array<{ image: NormalizedSourceImage; verdict: ComplianceVerdict }>;
}

export async function screenSourceImages(
  images: NormalizedSourceImage[],
  screen: typeof screenVisualWithDefaults = screenVisualWithDefaults,
): Promise<ScreenedSourceImages> {
  // The same bytes on several pages are page furniture (crests, watermarks).
  const occurrences = new Map<string, number>();
  for (const image of images)
    occurrences.set(image.sha256, (occurrences.get(image.sha256) ?? 0) + 1);

  const result: ScreenedSourceImages = { approved: [], withheld: [] };
  for (const image of images) {
    const verdict = await screen(image.data, {
      origin: 'source',
      mimeType: image.mimeType,
      metadata: {
        caption: image.caption,
        figureLabel: image.figureLabel,
        description: image.description,
        manifestRole: image.sourceRole,
        width: image.width,
        height: image.height,
        occurrences: occurrences.get(image.sha256),
      },
    });
    if (verdict.verdict === 'approved') result.approved.push(image);
    else result.withheld.push({ image, verdict });
  }
  if (result.withheld.length > 0) {
    log.warn(
      `Withheld ${result.withheld.length}/${images.length} source visual(s): ${result.withheld
        .map(({ image, verdict }) => `${image.id}=${verdict.verdict}`)
        .join(', ')}`,
    );
  }
  return result;
}

/**
 * The planner note for withheld figures — appended to the requirement so the
 * outline plans a compliant alternative instead of referencing the figure.
 */
export function withheldSourceVisualsNote(withheld: ScreenedSourceImages['withheld']): string {
  if (withheld.length === 0) return '';
  const lines = withheld.map(({ image }) => {
    const label = [image.figureLabel, image.caption].filter(Boolean).join(' — ');
    return `- ${label || `a figure on page ${image.pageNumber ?? '?'}`}`;
  });
  return `\n\nThe source contains the following figure(s) that are NOT available to this lesson. Do not reference them as images. Where the idea matters, plan a compliant alternative: a generated illustration, or a diagram / chart / table built from native slide elements.\n${lines.join('\n')}`;
}
