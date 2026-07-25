import { describe, expect, it } from 'vitest';
import {
  extractClaims,
  parseAnswer,
  parseEvi1Appendix,
  serializeEvi1Appendix,
  stripClaimMarkers,
  stripEvi1Appendix,
} from '../src/protocol/evi1.js';

const ANSWER = [
  'Vitamin D supplementation reduced fall risk in older adults.[1]{c1}',
  'It also improved bone density.[2][3]{c2}',
  '',
  'EVI1',
  'c1|1|"supplementation reduced the rate of falls by 19%"',
  'c2|2|"bone mineral density increased significantly"',
  'c2|3|"BMD improved with \\"high-dose\\" regimens\\nover 12 months"',
  'END_EVI1',
].join('\n');

describe('parseEvi1Appendix', () => {
  it('parses well-formed appendix lines with escapes', () => {
    const parsed = parseEvi1Appendix(ANSWER);
    expect(parsed).not.toBeNull();
    expect(parsed!.items).toHaveLength(3);
    expect(parsed!.items[0]).toEqual({
      claimId: 'c1',
      sourceIndex: 1,
      quote: 'supplementation reduced the rate of falls by 19%',
    });
    expect(parsed!.items[2].quote).toBe('BMD improved with "high-dose" regimens\nover 12 months');
    expect(parsed!.warnings).toHaveLength(0);
  });

  it('returns null without a complete appendix', () => {
    expect(parseEvi1Appendix('no appendix here')).toBeNull();
    expect(parseEvi1Appendix('EVI1\nc1|1|"x"')).toBeNull();
  });

  it('warns on malformed lines but keeps valid ones', () => {
    const parsed = parseEvi1Appendix('EVI1\ngarbage line\nc1|2|"ok quote"\nEND_EVI1');
    expect(parsed!.items).toHaveLength(1);
    expect(parsed!.warnings).toHaveLength(1);
  });

  it('ignores an EVI1 mention inside the answer body', () => {
    const text = 'The EVI1 protocol is neat.\nEVI1\nc1|1|"q"\nEND_EVI1';
    const parsed = parseEvi1Appendix(text);
    expect(parsed!.items).toHaveLength(1);
    expect(stripEvi1Appendix(text)).toBe('The EVI1 protocol is neat.');
  });
});

describe('serializeEvi1Appendix', () => {
  it('round-trips through the parser', () => {
    const items = [
      { claimId: 'c1', sourceIndex: 2, quote: 'a "quoted"\nmulti\\line value' },
    ];
    const parsed = parseEvi1Appendix(serializeEvi1Appendix(items));
    expect(parsed!.items).toEqual(items);
  });
});

describe('extractClaims', () => {
  it('extracts claim text and cited sources', () => {
    const { claims, warnings } = extractClaims(
      'Water expands when freezing.[2][5]{c1} Ice floats.[1]{c2}',
    );
    expect(warnings).toHaveLength(0);
    expect(claims).toEqual([
      { id: 'c1', text: 'Water expands when freezing.', sourceIndexes: [2, 5] },
      { id: 'c2', text: 'Ice floats.', sourceIndexes: [1] },
    ]);
  });

  it('warns when the citation group is not adjacent to the marker', () => {
    const { claims, warnings } = extractClaims('Freezing.[2] {c1}');
    expect(claims[0].sourceIndexes).toEqual([]);
    expect(warnings[0]).toContain('c1');
  });

  it('warns on duplicate claim ids', () => {
    const { claims, warnings } = extractClaims('A.[1]{c1} B.[2]{c1}');
    expect(claims).toHaveLength(1);
    expect(warnings.some((w) => w.includes('duplicate'))).toBe(true);
  });
});

describe('parseAnswer', () => {
  it('produces clean text, claims, evidence and completeness warnings', () => {
    const parsed = parseAnswer(ANSWER);
    expect(parsed.cleanText).not.toContain('{c');
    expect(parsed.cleanText).not.toContain('EVI1');
    expect(parsed.cleanText).toContain('[1]');
    expect(parsed.claims).toHaveLength(2);
    expect(parsed.evidence).toHaveLength(3);
    expect(parsed.warnings).toHaveLength(0);
  });

  it('flags citations without evidence and evidence without citations', () => {
    const parsed = parseAnswer('A claim.[1]{c1}\n\nEVI1\nc9|4|"stray quote"\nEND_EVI1');
    expect(parsed.warnings.some((w) => w.includes('c1|1 has no evidence'))).toBe(true);
    expect(parsed.warnings.some((w) => w.includes('c9|4 has no matching citation'))).toBe(true);
  });

  it('deduplicates evidence items', () => {
    const parsed = parseAnswer('A.[1]{c1}\n\nEVI1\nc1|1|"q1"\nc1|1|"q2"\nEND_EVI1');
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0].quote).toBe('q1');
  });
});

describe('stripClaimMarkers', () => {
  it('removes only claim markers', () => {
    expect(stripClaimMarkers('Keep [1] drop {c1} and {c23}.')).toBe('Keep [1] drop  and .');
  });
});
