/**
 * JSON parsing with fallback strategies for AI-generated responses.
 */

import { jsonrepair } from 'jsonrepair';
import { noopGenerationLogger, type GenerationLogger } from './logger.js';

export interface JsonParsingOptions {
  logger?: GenerationLogger;
}

function repairQuotedPropertyFragments(jsonStr: string): string {
  return jsonStr.replace(
    /([,{]\s*)"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(true|false|null|[+-]?\d+(?:\.\d+)?)"(?=\s*[,}])/g,
    (_match, prefix, key, value) => `${prefix}"${key}": ${value}`,
  );
}

function logJsonParseError(
  stage: string,
  jsonStr: string,
  error: unknown,
  logger: GenerationLogger,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const positionMatch = message.match(/position\s+(\d+)/i);
  const position = positionMatch ? Number(positionMatch[1]) : undefined;

  if (typeof position === 'number' && Number.isFinite(position)) {
    const start = Math.max(0, position - 120);
    const end = Math.min(jsonStr.length, position + 120);
    logger.warn(
      `${stage} parse error at position ${position}: ${message}. Context: ${jsonStr
        .slice(start, end)
        .replace(/\n/g, '\\n')}`,
    );
    return;
  }

  logger.warn(`${stage} parse error: ${message}`);
}

/**
 * Where the parsed JSON was found in the response:
 * - `exact`: the whole (trimmed) response was valid JSON as it stands;
 * - `code-block`: a fenced markdown block;
 * - `balanced-block`: the first bracket-balanced `{…}` / `[…]` block;
 * - `whole-response`: the whole response, after a repair below.
 */
export type JsonParseExtraction = 'exact' | 'code-block' | 'balanced-block' | 'whole-response';

/**
 * Which repair the parsed text needed:
 * - `none`: it parsed as extracted;
 * - `truncation-fix`: the common fixes (quoted property fragments, LaTeX /
 *   invalid escapes, a closed truncated array or object);
 * - `jsonrepair`: the `jsonrepair` library rewrote it;
 * - `control-char`: raw control characters were escaped or removed.
 */
export type JsonParseRepair = 'none' | 'truncation-fix' | 'jsonrepair' | 'control-char';

/** How {@link parseJsonResponseWithInfo} read a response. */
export interface JsonParseInfo {
  extraction: JsonParseExtraction;
  repair: JsonParseRepair;
  /** A `</think>`-style reasoning prefix was cut before parsing. */
  reasoningPrefixStripped: boolean;
  /** True only for `exact`: the model's text was valid JSON with nothing cut or fixed. */
  exact: boolean;
}

export interface JsonParseOutcome<T> {
  value: T | null;
  /** `null` when nothing could be parsed. */
  info: JsonParseInfo | null;
}

export function parseJsonResponse<T>(response: string, options: JsonParsingOptions = {}): T | null {
  return parseJsonResponseWithInfo<T>(response, options).value;
}

/**
 * {@link parseJsonResponse} plus HOW the value was read, so a caller can tell an
 * answer that was valid as written from one a fallback strategy rebuilt. The
 * value, the strategies, their order and every log line are identical.
 */
export function parseJsonResponseWithInfo<T>(
  response: string,
  options: JsonParsingOptions = {},
): JsonParseOutcome<T> {
  const logger = options.logger ?? noopGenerationLogger;
  const exactParsed = tryParseExactJson<T>(response);
  if (exactParsed !== null) {
    return {
      value: exactParsed,
      info: { extraction: 'exact', repair: 'none', reasoningPrefixStripped: false, exact: true },
    };
  }

  const cleanedResponse = stripReasoningPrefix(response);
  if (cleanedResponse !== response.trim()) {
    const parsedCleaned = parseJsonResponseCandidate<T>(cleanedResponse, logger);
    if (parsedCleaned !== null) {
      return {
        value: parsedCleaned.value,
        info: { ...parsedCleaned.method, reasoningPrefixStripped: true, exact: false },
      };
    }
  }

  const parsed = parseJsonResponseCandidate<T>(response, logger);
  if (parsed !== null) {
    return {
      value: parsed.value,
      info: { ...parsed.method, reasoningPrefixStripped: false, exact: false },
    };
  }

  logger.error('Failed to parse JSON from response');
  logger.error('Raw response (first 500 chars):', cleanedResponse.substring(0, 500));
  logger.error(
    'Raw response (last 500 chars):',
    cleanedResponse.substring(Math.max(0, cleanedResponse.length - 500)),
  );

  return { value: null, info: null };
}

function tryParseExactJson<T>(response: string): T | null {
  try {
    return JSON.parse(response.trim()) as T;
  } catch {
    return null;
  }
}

type CandidateMethod = { extraction: JsonParseExtraction; repair: JsonParseRepair };

function stripReasoningPrefix(response: string): string {
  const trimmed = response.trim();
  const matches = [...trimmed.matchAll(/<\/(?:think|thinking|reasoning)>\s*/gi)];
  const lastMatch = matches.at(-1);

  if (!lastMatch || lastMatch.index === undefined) return trimmed;

  return trimmed.slice(lastMatch.index + lastMatch[0].length).trim();
}

function parseJsonResponseCandidate<T>(
  response: string,
  logger: GenerationLogger,
): { value: T; method: CandidateMethod } | null {
  const cleanedResponse = response.trim();

  // Strategy 1: Try to extract JSON from markdown code blocks (may have multiple)
  const codeBlockMatches = cleanedResponse.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  for (const match of codeBlockMatches) {
    const extracted = match[1].trim();
    // Only try if it looks like JSON (starts with { or [)
    if (extracted.startsWith('{') || extracted.startsWith('[')) {
      const result = tryParseJsonWithRepair<T>(extracted, logger);
      if (result !== null) {
        logger.debug('Successfully parsed JSON from code block');
        return { value: result.value, method: { extraction: 'code-block', repair: result.repair } };
      }
    }
  }

  // Strategy 2: Try to find JSON structure directly in response (no code block)
  // Look for array or object start
  const jsonStartArray = cleanedResponse.indexOf('[');
  const jsonStartObject = cleanedResponse.indexOf('{');

  if (jsonStartArray !== -1 || jsonStartObject !== -1) {
    // Prefer the structure that appears first
    const startIndex =
      jsonStartArray === -1
        ? jsonStartObject
        : jsonStartObject === -1
          ? jsonStartArray
          : Math.min(jsonStartArray, jsonStartObject);

    // Find the matching close bracket
    let depth = 0;
    let endIndex = -1;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < cleanedResponse.length; i++) {
      const char = cleanedResponse[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      // escapeNext is always false here: the first branch of the loop resets
      // and skips the iteration whenever it was set.
      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '[' || char === '{') depth++;
        else if (char === ']' || char === '}') {
          depth--;
          if (depth === 0) {
            endIndex = i;
            break;
          }
        }
      }
    }

    if (endIndex !== -1) {
      const jsonStr = cleanedResponse.substring(startIndex, endIndex + 1);
      const result = tryParseJsonWithRepair<T>(jsonStr, logger);
      if (result !== null) {
        logger.debug('Successfully parsed JSON from response body');
        return {
          value: result.value,
          method: { extraction: 'balanced-block', repair: result.repair },
        };
      }
    }
  }

  // Strategy 3: Last resort - try the whole response
  const result = tryParseJsonWithRepair<T>(cleanedResponse.trim(), logger);
  if (result !== null) {
    logger.debug('Successfully parsed raw response as JSON');
    return {
      value: result.value,
      method: { extraction: 'whole-response', repair: result.repair },
    };
  }

  return null;
}

/**
 * Try to parse JSON with various fixes for common AI response issues
 */
export function tryParseJson<T>(jsonStr: string, options: JsonParsingOptions = {}): T | null {
  const result = tryParseJsonWithRepair<T>(jsonStr, options.logger ?? noopGenerationLogger);
  return result === null ? null : result.value;
}

/**
 * A parsed JSON `null` is "nothing parsed", exactly as `tryParseJson`'s callers
 * always read its `null` return — the attempt still ends there.
 */
function withRepair<T>(
  value: unknown,
  repair: JsonParseRepair,
): { value: T; repair: JsonParseRepair } | null {
  return value === null ? null : { value: value as T, repair };
}

function tryParseJsonWithRepair<T>(
  jsonStr: string,
  logger: GenerationLogger,
): { value: T; repair: JsonParseRepair } | null {
  // Attempt 1: Try parsing as-is
  try {
    return withRepair<T>(JSON.parse(jsonStr), 'none');
  } catch (error) {
    logJsonParseError('Attempt 1', jsonStr, error, logger);
    // Continue to fix attempts
  }

  // Attempt 2: Fix common JSON issues from AI responses
  try {
    let fixed = jsonStr;

    // Fix 0: Recover malformed property fragments that were accidentally
    // emitted as standalone strings inside an object, such as:
    // `"height: 76"` -> `"height": 76`
    // `"fixedRatio: false"` -> `"fixedRatio": false`
    // The object-context prefix/suffix guards keep valid JSON strings intact.
    fixed = repairQuotedPropertyFragments(fixed);

    // Fix 1: Handle LaTeX-style escapes that break JSON (e.g., \frac, \left, \right, \times, etc.)
    // These are common in math content and need to be double-escaped
    // Match backslash followed by letters (LaTeX commands) inside strings,
    // but skip valid JSON escape sequences (\b, \f, \n, \r, \t, \u)
    fixed = fixed.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (_match, content) => {
      // Double-escape backslash+letter ONLY for non-JSON-escape letters
      const fixedContent = content.replace(/\\([a-zA-Z])/g, (_m: string, ch: string) => {
        // Preserve valid JSON escape sequences
        if ('bfnrtu'.includes(ch)) return `\\${ch}`;
        return `\\\\${ch}`;
      });
      return `"${fixedContent}"`;
    });

    // Fix 2: Fix other invalid escape sequences (e.g., \S, \L, etc.)
    // Valid JSON escapes: \", \\, \/, \b, \f, \n, \r, \t, \uXXXX
    fixed = fixed.replace(/\\([^"\\\/bfnrtu\n\r])/g, (match, char) => {
      // If it's a letter, it's likely a LaTeX command
      if (/[a-zA-Z]/.test(char)) {
        return '\\\\' + char;
      }
      return match;
    });

    // Fix 3: Try to fix truncated JSON arrays/objects
    const trimmed = fixed.trim();
    if (trimmed.startsWith('[') && !trimmed.endsWith(']')) {
      const lastCompleteObj = fixed.lastIndexOf('}');
      if (lastCompleteObj > 0) {
        fixed = fixed.substring(0, lastCompleteObj + 1) + ']';
        logger.warn('Fixed truncated JSON array');
      }
    } else if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
      // Try to close incomplete object
      const openBraces = (fixed.match(/{/g) || []).length;
      const closeBraces = (fixed.match(/}/g) || []).length;
      if (openBraces > closeBraces) {
        fixed += '}'.repeat(openBraces - closeBraces);
        logger.warn('Fixed truncated JSON object');
      }
    }

    return withRepair<T>(JSON.parse(fixed), 'truncation-fix');
  } catch (error) {
    logJsonParseError('Attempt 2', jsonStr, error, logger);
    // Continue to next attempt
  }

  // Attempt 3: Use jsonrepair to fix malformed JSON (e.g. unescaped quotes in Chinese text)
  try {
    const repaired = jsonrepair(jsonStr);
    return withRepair<T>(JSON.parse(repaired), 'jsonrepair');
  } catch (error) {
    logJsonParseError('Attempt 3', jsonStr, error, logger);
    // Continue to next attempt
  }

  // Attempt 4: More aggressive fixing - remove control characters
  try {
    let fixed = jsonStr;

    // Remove or escape control characters
    fixed = fixed.replace(/[\x00-\x1F\x7F]/g, (char) => {
      switch (char) {
        case '\n':
          return '\\n';
        case '\r':
          return '\\r';
        case '\t':
          return '\\t';
        default:
          return '';
      }
    });

    return withRepair<T>(JSON.parse(fixed), 'control-char');
  } catch (error) {
    logJsonParseError('Attempt 4', jsonStr, error, logger);
    return null;
  }
}
