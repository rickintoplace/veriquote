/**
 * Deterministic fuzzy quote matching.
 *
 * Strategy, in order of preference:
 *   1. exact raw substring,
 *   2. exact substring after normalization (quotes, dashes, case, whitespace),
 *   3. best sliding window by character-trigram Dice similarity, with a
 *      coarse scan followed by a fine refinement around the best offset.
 *
 * Everything here is pure and deterministic: same inputs, same result.
 */

import type { QuoteMatch, SourceDocument } from '../types.js';
import { normalizeForMatch } from './normalize.js';

export interface MatchOptions {
  /** Source fields shorter than this are skipped (too little signal). Default 40. */
  minSourceLength?: number;
  /**
   * Quotes shorter than this get a proportional score penalty, because short
   * strings produce spuriously high trigram similarity. Default 90.
   */
  shortQuoteLength?: number;
  /** Fuzzy score below this yields method `"not_found"`. Default 0.4. */
  fuzzyThreshold?: number;
  /** Window sizes to try, as multiples of the quote length. Default [0.85, 1, 1.15]. */
  windowScales?: number[];
}

const DEFAULTS: Required<MatchOptions> = {
  minSourceLength: 40,
  shortQuoteLength: 90,
  fuzzyThreshold: 0.4,
  windowScales: [0.85, 1, 1.15],
};

/** Multiset of character trigrams of `s` as gram -> count. */
export function trigramCounts(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i + 3 <= s.length; i++) {
    const g = s.slice(i, i + 3);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice similarity between two trigram multisets. */
export function diceSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let aTotal = 0;
  let bTotal = 0;
  for (const v of a.values()) aTotal += v;
  for (const v of b.values()) bTotal += v;
  if (!aTotal || !bTotal) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [g, v] of small) {
    const w = large.get(g);
    if (w) inter += Math.min(v, w);
  }
  return (2 * inter) / (aTotal + bTotal);
}

interface WindowHit {
  score: number;
  /** Start offset in the scanned text; -1 when nothing scored above 0. */
  offset: number;
  windowLength: number;
}

/**
 * Rolling-window Dice scan: slides a window of `windowLength` over `text` in
 * steps of `step`, keeping trigram counts and the multiset intersection with
 * the quote incrementally updated — O(text length) per window size instead of
 * O(text length x window length).
 */
function scanWindows(
  quoteGrams: Map<string, number>,
  quoteTotal: number,
  text: string,
  windowLength: number,
  step: number,
  from: number,
  to: number,
): WindowHit {
  const best: WindowHit = { score: 0, offset: -1, windowLength };
  if (quoteTotal === 0) return best;

  const gramsInWindow = windowLength - 2;
  if (gramsInWindow <= 0 || windowLength > text.length) {
    const d = diceSimilarity(quoteGrams, trigramCounts(text));
    if (d > best.score) {
      best.score = d;
      best.offset = 0;
      best.windowLength = text.length;
    }
    return best;
  }

  const start = Math.max(0, from);
  const end = Math.min(to, text.length - windowLength);
  if (start > end) return best;

  // Initialize counts/intersection for the window at `start`.
  const counts = new Map<string, number>();
  let inter = 0;
  const add = (g: string) => {
    const c = (counts.get(g) ?? 0) + 1;
    counts.set(g, c);
    if (c <= (quoteGrams.get(g) ?? 0)) inter++;
  };
  const remove = (g: string) => {
    const c = (counts.get(g) ?? 1) - 1;
    if (c === 0) counts.delete(g);
    else counts.set(g, c);
    if (c < (quoteGrams.get(g) ?? 0)) inter--;
  };

  for (let i = start; i < start + gramsInWindow; i++) add(text.slice(i, i + 3));

  const denom = quoteTotal + gramsInWindow;
  for (let pos = start; ; pos += step) {
    const d = (2 * inter) / denom;
    if (d > best.score) {
      best.score = d;
      best.offset = pos;
    }
    if (best.score >= 0.995 || pos + step > end) break;
    // Slide by `step`: retire grams starting in [pos, pos+step),
    // admit grams starting in [pos+gramsInWindow, pos+gramsInWindow+step).
    for (let i = pos; i < pos + step; i++) remove(text.slice(i, i + 3));
    for (let i = pos + gramsInWindow; i < pos + gramsInWindow + step; i++) {
      add(text.slice(i, i + 3));
    }
  }
  return best;
}

/** Best fuzzy window of `text` for `quote` (both already normalized). */
export function bestFuzzyWindow(quote: string, text: string, scales: number[]): WindowHit {
  const qLen = quote.length;
  if (!qLen || !text.length) return { score: 0, offset: -1, windowLength: 0 };
  const quoteGrams = trigramCounts(quote);
  let quoteTotal = 0;
  for (const v of quoteGrams.values()) quoteTotal += v;

  const coarseStep = Math.max(10, Math.min(80, Math.round(qLen / 8)));
  let best: WindowHit = { score: 0, offset: -1, windowLength: 0 };
  for (const scale of scales) {
    const w = Math.max(40, Math.round(qLen * scale));
    const hit = scanWindows(quoteGrams, quoteTotal, text, w, coarseStep, 0, text.length);
    if (hit.score > best.score) best = hit;
  }
  if (best.offset >= 0 && coarseStep > 1) {
    // Fine pass: re-scan around the coarse optimum with step 1.
    const refined = scanWindows(
      quoteGrams,
      quoteTotal,
      text,
      best.windowLength,
      1,
      best.offset - coarseStep,
      best.offset + coarseStep,
    );
    if (refined.score > best.score) best = refined;
  }
  return best;
}

/** Match `quote` against a single text field. Offsets refer to `text` as given. */
export function matchQuoteAgainstText(
  quote: string,
  text: string,
  options?: MatchOptions,
): QuoteMatch {
  const opts = { ...DEFAULTS, ...options };
  const quoteRaw = quote.trim();
  const empty: QuoteMatch = { method: 'not_found', score: 0, field: 'text' };
  if (!quoteRaw || !text) return empty;

  const rawIndex = text.indexOf(quoteRaw);
  if (rawIndex !== -1) {
    return {
      method: 'exact',
      score: 1,
      start: rawIndex,
      end: rawIndex + quoteRaw.length,
      field: 'text',
    };
  }

  const q = normalizeForMatch(quoteRaw);
  const t = normalizeForMatch(text);
  if (!q.text || !t.text) return empty;

  const normIndex = t.text.indexOf(q.text);
  if (normIndex !== -1) {
    return {
      method: 'normalized',
      score: 1,
      start: t.map[normIndex],
      end: mapEndOffset(t.map, normIndex + q.text.length - 1, text),
      field: 'text',
    };
  }

  const hit = bestFuzzyWindow(q.text, t.text, opts.windowScales);
  const lengthPenalty = Math.min(1, q.text.length / opts.shortQuoteLength);
  const score = Math.max(0, Math.min(0.99, hit.score * lengthPenalty));
  if (hit.offset < 0 || score < opts.fuzzyThreshold) {
    return { ...empty, score };
  }
  const lastNormIndex = Math.min(hit.offset + hit.windowLength - 1, t.map.length - 1);
  return {
    method: 'fuzzy',
    score,
    start: t.map[hit.offset],
    end: mapEndOffset(t.map, lastNormIndex, text),
    field: 'text',
  };
}

/** Exclusive end offset in the original text for the normalized char at `lastIndex`. */
function mapEndOffset(map: Int32Array, lastIndex: number, original: string): number {
  const srcIndex = map[Math.max(0, Math.min(lastIndex, map.length - 1))];
  // Advance past the full code point at srcIndex.
  const cp = original.codePointAt(srcIndex);
  return srcIndex + (cp !== undefined && cp > 0xffff ? 2 : 1);
}

/**
 * Match `quote` against all text fields of a source document and return the
 * best result. Stops early on the first perfect hit.
 */
export function matchQuoteAgainstSource(
  quote: string,
  source: SourceDocument,
  options?: MatchOptions,
): QuoteMatch {
  const opts = { ...DEFAULTS, ...options };
  const fields: Array<{ name: string; text: string }> = [
    { name: 'text', text: source.text ?? '' },
  ];
  (source.extraTexts ?? []).forEach((t, i) => fields.push({ name: `extraTexts[${i}]`, text: t }));

  let best: QuoteMatch = { method: 'not_found', score: 0, field: 'text' };
  for (const field of fields) {
    if (field.text.trim().length < opts.minSourceLength) continue;
    const r = matchQuoteAgainstText(quote, field.text, opts);
    if (r.score > best.score) best = { ...r, field: field.name };
    if (best.score === 1) break;
  }
  return best;
}
