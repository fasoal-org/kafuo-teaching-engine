import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { getEncoding } from 'js-tiktoken';
import { describe, expect, it } from 'vitest';

import {
  budgetMessagesOf,
  countExactTokens,
  countTokens,
  effectiveCap,
  FRAMING,
  HARD_CAP,
  resolveProxyRatio,
  seedProxyRatio,
  tighterCapForPolicy,
  UNIT_CHAR_CAP,
  type BudgetMessage,
} from '@/lib/server/tutor/token-budget';
import {
  FRAMING_FIXED,
  FRAMING_PER_MESSAGE,
  SEED_PROXY_RATIO,
} from '@/lib/server/tutor/token-calibration-seed';

/**
 * Budget counters (contracts §8, plan §8.7). The golden section replays the
 * benchmark corpora through the SAME reconstruction the calibration script
 * uses and asserts the counters are conservative against the providers'
 * recorded `prompt_tokens`; it skips when the benchmark files are absent (CI
 * checkouts without the workspace siblings).
 */

const WORKSPACE = path.resolve(process.cwd(), '..');
const CALIBRATION_JSON = path.join(
  WORKSPACE,
  'docs',
  'frds',
  'model_routing',
  'token-calibration.v1.json',
);
const BENCH_DIR = path.join(WORKSPACE, 'benchmarks-scripts', 'results', 'multisubject');

describe('caps and margins', () => {
  it('HARD_CAP 32,000; exact cap 30,080 (6 %); proxy cap 25,600 (20 %); UNIT_CHAR_CAP 10,000', () => {
    expect(HARD_CAP).toBe(32_000);
    expect(UNIT_CHAR_CAP).toBe(10_000);
    expect(effectiveCap('exact')).toBe(30_080);
    expect(effectiveCap('proxy')).toBe(25_600);
  });

  it('tighterCapForPolicy takes the smaller of the pair', () => {
    expect(
      tighterCapForPolicy({
        primary: { counterKind: 'proxy' },
        fallback: { counterKind: 'exact' },
      }),
    ).toBe(25_600);
    expect(
      tighterCapForPolicy({
        primary: { counterKind: 'exact' },
        fallback: { counterKind: 'exact' },
      }),
    ).toBe(30_080);
  });
});

describe('counters', () => {
  const enc = getEncoding('o200k_base');

  it('exact = o200k_base over every message text + 5/message + 3', () => {
    const messages: BudgetMessage[] = [
      { role: 'system', content: 'أنت معلم.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'ما هو التبرير؟' },
          { type: 'image', text: undefined },
        ],
      },
    ];
    const expected =
      enc.encode('أنت معلم.').length +
      enc.encode('ما هو التبرير؟').length +
      FRAMING.perMessage * 2 +
      FRAMING.fixed;
    expect(countExactTokens(messages)).toBe(expected);
    expect(countTokens(messages, 'exact', 'openai:gpt-5-nano')).toBe(expected);
    expect(FRAMING).toEqual({ perMessage: FRAMING_PER_MESSAGE, fixed: FRAMING_FIXED });
  });

  it('proxy = ceil(exact × ratio), seed ratio for the Qwen model, live ratio never below the seed', async () => {
    const messages: BudgetMessage[] = [{ role: 'user', content: 'hello world' }];
    const exact = countExactTokens(messages);
    const seed = seedProxyRatio('qwen:qwen3.7-flash');
    expect(seed).toBe(SEED_PROXY_RATIO['qwen:qwen3.7-flash']);
    expect(countTokens(messages, 'proxy', 'qwen:qwen3.7-flash')).toBe(Math.ceil(exact * seed));
    expect(countTokens(messages, 'proxy', 'qwen:qwen3.7-flash', { proxyRatio: 2 })).toBe(exact * 2);
    expect(await resolveProxyRatio('qwen:qwen3.7-flash')).toBe(seed);
    expect(await resolveProxyRatio('qwen:qwen3.7-flash', async () => null)).toBe(seed);
    expect(await resolveProxyRatio('qwen:qwen3.7-flash', async () => seed - 0.1)).toBe(seed);
    expect(await resolveProxyRatio('qwen:qwen3.7-flash', async () => 1.5)).toBe(1.5);
    // An uncalibrated proxy model gets the conservative default.
    expect(seedProxyRatio('qwen:qwen3.8-flash')).toBeGreaterThan(seed);
  });

  it('budgetMessagesOf lists system + messages, or system + prompt as a user message', () => {
    expect(budgetMessagesOf({ system: 's', messages: [{ role: 'user', content: 'u' }] })).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
    expect(budgetMessagesOf({ prompt: 'p' })).toEqual([{ role: 'user', content: 'p' }]);
  });
});

describe('seed pinned to token-calibration.v1.json', () => {
  it.skipIf(!existsSync(CALIBRATION_JSON))(
    'framing and proxy ratio equal the calibration file',
    () => {
      const doc = JSON.parse(readFileSync(CALIBRATION_JSON, 'utf8')) as {
        framing: { perMessage: number; fixed: number };
        proxyRatio: Record<string, number>;
        exactConservativeShare: Record<string, number>;
      };
      expect(doc.framing).toMatchObject({ perMessage: FRAMING_PER_MESSAGE, fixed: FRAMING_FIXED });
      expect(doc.proxyRatio).toEqual(SEED_PROXY_RATIO);
      for (const [model, share] of Object.entries(doc.exactConservativeShare)) {
        expect(share, model).toBeGreaterThanOrEqual(0.99);
      }
    },
  );
});

describe('golden corpus — counters are conservative against recorded prompt_tokens', () => {
  const available = existsSync(path.join(BENCH_DIR, 'dataset.json'));

  it.skipIf(!available)(
    'exact ≥ reported on ≥ 99 % of OpenAI turns; proxy ≥ reported on ≥ 99 % of Qwen turns',
    async () => {
      const script = (await import('../../scripts/calibrate-token-ratio.mjs')) as {
        CORPORA: Array<{ file: string; model: string; counter: 'exact' | 'proxy' }>;
        reconstructTurns: (
          dir: string,
          file: string,
        ) => Array<{ messages: BudgetMessage[]; reported: number }>;
      };
      for (const corpus of script.CORPORA) {
        const turns = script.reconstructTurns(BENCH_DIR, corpus.file);
        expect(turns.length, corpus.file).toBeGreaterThanOrEqual(20);
        let conservative = 0;
        for (const turn of turns) {
          const count = countTokens(turn.messages, corpus.counter, corpus.model);
          if (count >= turn.reported) conservative += 1;
        }
        const share = conservative / turns.length;
        expect(share, `${corpus.model} (${corpus.counter})`).toBeGreaterThanOrEqual(0.99);
      }
    },
  );
});
