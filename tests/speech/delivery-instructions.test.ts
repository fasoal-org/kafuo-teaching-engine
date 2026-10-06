/** FR-020: the delivery instructions are semantic-free (plan §12.1). */
import { describe, expect, it } from 'vitest';

import {
  DELIVERY_INSTRUCTIONS_AR_SA_V1,
  DELIVERY_PROFILE_ID,
  deliveryDigest,
} from '@/lib/server/speech/delivery-instructions';
import { countTokens } from '@/lib/server/speech/narration-synthesis';

describe('ar-SA-saudi-edu-v1 delivery instructions', () => {
  it('are English, under 600 characters, with no Arabic, digits or LaTeX', () => {
    expect(DELIVERY_PROFILE_ID).toBe('ar-SA-saudi-edu-v1');
    expect(DELIVERY_INSTRUCTIONS_AR_SA_V1.length).toBeLessThan(600);
    expect(DELIVERY_INSTRUCTIONS_AR_SA_V1).not.toMatch(/[؀-ۿ]/);
    expect(DELIVERY_INSTRUCTIONS_AR_SA_V1).not.toMatch(/[0-9٠-٩]/);
    expect(DELIVERY_INSTRUCTIONS_AR_SA_V1).not.toMatch(/\\/);
  });

  it('carry no subject vocabulary or expression meaning', () => {
    for (const word of ['math', 'physic', 'chemi', 'fraction', 'equation', 'formula', 'force', 'water', 'squared', 'element']) {
      expect(DELIVERY_INSTRUCTIONS_AR_SA_V1.toLowerCase()).not.toContain(word);
    }
  });

  it('are 91 o200k tokens, as measured in Wave 0, and have a stable digest', () => {
    expect(countTokens(DELIVERY_INSTRUCTIONS_AR_SA_V1)).toBe(91);
    expect(deliveryDigest(DELIVERY_INSTRUCTIONS_AR_SA_V1)).toMatch(/^[0-9a-f]{64}$/);
    expect(deliveryDigest(null)).toBeNull();
  });
});
