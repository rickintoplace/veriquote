import { describe, expect, it } from 'vitest';
import { normalizeForMatch } from '../src/match/normalize.js';
import {
  bestFuzzyWindow,
  diceSimilarity,
  matchQuoteAgainstSource,
  matchQuoteAgainstText,
  trigramCounts,
} from '../src/match/fuzzy.js';

describe('normalizeForMatch', () => {
  it('unifies typography, case and whitespace', () => {
    const { text } = normalizeForMatch('  “Smart” — QUOTES  and\tspaces  ');
    expect(text).toBe('"smart" - quotes and spaces');
  });

  it('maps normalized offsets back to the original string', () => {
    const original = 'A  “B”  C';
    const { text, map } = normalizeForMatch(original);
    expect(text).toBe('a "b" c');
    const bIndex = text.indexOf('b');
    expect(original[map[bIndex]]).toBe('B');
    const cIndex = text.indexOf('c');
    expect(original[map[cIndex]]).toBe('C');
  });

  it('drops soft hyphens and zero-width characters', () => {
    expect(normalizeForMatch('cita­tion​').text).toBe('citation');
  });
});

describe('trigram Dice', () => {
  it('is 1 for identical strings and 0 for disjoint strings', () => {
    const a = trigramCounts('hello world');
    expect(diceSimilarity(a, trigramCounts('hello world'))).toBe(1);
    expect(diceSimilarity(a, trigramCounts('xyzxyzxyz'))).toBe(0);
  });
});

const SOURCE =
  'Background: Falls are common in older adults. In this randomized controlled trial, ' +
  'vitamin D supplementation reduced the rate of falls by 19% compared with placebo ' +
  '(95% CI 5-31%). No significant effect on fracture incidence was observed. ' +
  'Adverse events were rare and mild in both groups across the 24-month follow-up period.';

describe('matchQuoteAgainstText', () => {
  it('finds exact raw substrings with offsets', () => {
    const q = 'reduced the rate of falls by 19%';
    const r = matchQuoteAgainstText(q, SOURCE);
    expect(r.method).toBe('exact');
    expect(r.score).toBe(1);
    expect(SOURCE.slice(r.start!, r.end!)).toBe(q);
  });

  it('finds matches that differ only in typography/case', () => {
    const q = 'Reduced the rate of falls by 19% compared with placebo (95% CI 5–31%)';
    const r = matchQuoteAgainstText(q, SOURCE);
    expect(r.method).toBe('normalized');
    expect(r.score).toBe(1);
    expect(SOURCE.slice(r.start!, r.end!).toLowerCase()).toContain('reduced the rate of falls');
  });

  it('scores near-verbatim quotes high but below 1 (fuzzy)', () => {
    const q =
      'vitamin D supplements reduced the rates of falling by 19% compared to placebo (95% CI 5-31%)';
    const r = matchQuoteAgainstText(q, SOURCE);
    expect(r.method).toBe('fuzzy');
    expect(r.score).toBeGreaterThan(0.7);
    expect(r.score).toBeLessThan(1);
    expect(SOURCE.slice(r.start!, r.end!)).toContain('falls');
  });

  it('rejects fabricated quotes', () => {
    const r = matchQuoteAgainstText(
      'omega-3 fatty acids cured all fractures instantly in every participant studied',
      SOURCE,
    );
    expect(r.method).toBe('not_found');
    expect(r.score).toBeLessThan(0.4);
  });

  it('penalizes very short quotes', () => {
    const r = matchQuoteAgainstText('falls are commn', SOURCE);
    expect(r.score).toBeLessThan(0.5);
  });
});

describe('bestFuzzyWindow', () => {
  it('is deterministic', () => {
    const q = normalizeForMatch('reduced the rate of falls by nineteen percent').text;
    const t = normalizeForMatch(SOURCE).text;
    const a = bestFuzzyWindow(q, t, [0.85, 1, 1.15]);
    const b = bestFuzzyWindow(q, t, [0.85, 1, 1.15]);
    expect(a).toEqual(b);
    expect(a.offset).toBeGreaterThanOrEqual(0);
  });
});

describe('matchQuoteAgainstSource', () => {
  it('falls back to extraTexts and reports the field', () => {
    const r = matchQuoteAgainstSource(
      'a completely different abstract sentence about bone mineral density outcomes',
      {
        text: SOURCE,
        extraTexts: [
          'Abstract: a completely different abstract sentence about bone mineral density outcomes.',
        ],
      },
    );
    expect(r.method).toBe('exact');
    expect(r.field).toBe('extraTexts[0]');
  });

  it('skips too-short source fields', () => {
    const r = matchQuoteAgainstSource('some quote text that is reasonably long here', {
      text: 'tiny',
    });
    expect(r.method).toBe('not_found');
  });
});
