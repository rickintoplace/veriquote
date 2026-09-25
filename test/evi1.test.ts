import { describe, expect, it } from 'vitest';
import {
  extractClaims,
  parseAnswer,
  parseEvi1Appendix,
  serializeEvi1Appendix,
  stripClaimMarkers,
  stripEvi1Appendix,
  stripForDisplay,
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

  it('returns null without an appendix', () => {
    expect(parseEvi1Appendix('no appendix here')).toBeNull();
    expect(parseEvi1Appendix('Text.\nEVI1')).toBeNull();
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

describe('tolerant appendix parsing', () => {
  const BODY = 'Ice floats.[1]{c1}';
  const EV = 'c1|1|"ice is less dense"';
  const cases: [string, string][] = [
    ['bold start line', `${BODY}\n\n**EVI1**\n${EV}\nEND_EVI1`],
    ['colon after EVI1', `${BODY}\n\nEVI1:\n${EV}\nEND_EVI1`],
    ['evidence on the EVI1 line', `${BODY}\n\nEVI1 ${EV}\nEND_EVI1`],
    ['code fence around it', `${BODY}\n\n\`\`\`\nEVI1\n${EV}\nEND_EVI1\n\`\`\``],
    ['fence with EVI1 as language', `${BODY}\n\n\`\`\`EVI1\n${EV}\nEND_EVI1\n\`\`\``],
    ['missing END_EVI1', `${BODY}\n\nEVI1\n${EV}`],
    ['END_EVI11 from the gateway', `${BODY}\n\nEVI1\n${EV}\nEND_EVI11`],
    ['missing EVI1 line', `${BODY}\n\n${EV}\nEND_EVI1`],
    ['bare evidence lines at the end', `${BODY}\n\n${EV}`],
    ['spaces around the pipes', `${BODY}\n\nEVI1\nc1 | 1 | "ice is less dense"\nEND_EVI1`],
    ['CRLF line endings', `${BODY}\r\n\r\nEVI1\r\n${EV}\r\nEND_EVI1\r\n`],
  ];

  it.each(cases)('%s', (_, text) => {
    const parsed = parseEvi1Appendix(text);
    expect(parsed!.items).toEqual([{ claimId: 'c1', sourceIndex: 1, quote: 'ice is less dense' }]);
    expect(parsed!.warnings).toEqual([]);
    expect(stripEvi1Appendix(text).trim()).toBe(BODY);
    expect(parseAnswer(text).warnings).toEqual([]);
  });

  it('keeps a fence that closes an earlier code block', () => {
    const text = `Run:\n\`\`\`\nls\n\`\`\`\n\nEVI1\n${EV}\nEND_EVI1`;
    expect(stripEvi1Appendix(text)).toBe('Run:\n```\nls\n```');
  });

  it('does not treat sentences or headings about the EVI1 gene as the appendix', () => {
    const text = '## EVI1\nEVI1 is an oncogene.[1]{c1}\nEVI1: overexpressed in AML.';
    expect(parseEvi1Appendix(text)).toBeNull();
    expect(stripEvi1Appendix(text)).toBe(text);
    const withAppendix = `${text}\n\nEVI1\nc1|1|"EVI1 is an oncogene"\nEND_EVI1`;
    expect(stripEvi1Appendix(withAppendix)).toBe(text);
    expect(parseEvi1Appendix(withAppendix)!.items[0].quote).toBe('EVI1 is an oncogene');
  });

  it('stops at the first END_EVI1 line and keeps text after it', () => {
    const text = `${BODY}\n\nEVI1\n${EV}\nEND_EVI1\nc2|2|"after"\nTrailing note.`;
    expect(parseEvi1Appendix(text)!.items).toHaveLength(1);
  });
});

describe('stripForDisplay', () => {
  const FULL = `Ice floats.[1]{c1} Water expands.[2]{c2}\n\nEVI1\nc1|1|"less dense"\nc2|2|"expands"\nEND_EVI1`;

  it('matches the final display text for a complete answer', () => {
    expect(stripForDisplay(FULL)).toBe('Ice floats.[1] Water expands.[2]');
    expect(stripForDisplay(FULL)).toBe(parseAnswer(FULL).cleanText);
  });

  const APPENDIX = 'c1|1|"less dense"\nc2|2|"expands"';
  const variants = [
    FULL,
    FULL.replace('EVI1\n', '**EVI1**\n'),
    FULL.replace('EVI1\n', 'EVI1: '),
    FULL.replace('EVI1\n', '```\nEVI1\n') + '\n```',
    FULL.replace('EVI1\n', ''),
    FULL.replace('\nEND_EVI1', ''),
    `Ice floats.[1]{c1} Water expands.[2]{c2}\n\n${APPENDIX}`,
  ];

  it.each(variants.map((v, i) => [i, v]))('never shows protocol residue while streaming (variant %i)', (_, text) => {
    for (let i = 1; i <= text.length; i++) {
      const shown = stripForDisplay(text.slice(0, i));
      expect(shown, `prefix ${i}`).not.toMatch(/\{|EVI|END|^\s*c\d|\||```/m);
      expect('Ice floats.[1] Water expands.[2]'.startsWith(shown), `prefix ${i}: ${shown}`).toBe(true);
    }
    expect(stripForDisplay(text)).toBe('Ice floats.[1] Water expands.[2]');
  });

  it('hides a streamed appendix without an EVI1 line', () => {
    expect(stripForDisplay('Ice floats.[1]{c1}\n\nc1|')).toBe('Ice floats.[1]');
    expect(stripForDisplay('Ice floats.[1]{c1}\n\nc1|1|"less de')).toBe('Ice floats.[1]');
  });

  it('hides a half-streamed decorated or fenced start line', () => {
    expect(stripForDisplay('Ice floats.[1]{c1}\n\n**EVI')).toBe('Ice floats.[1]');
    expect(stripForDisplay('Ice floats.[1]{c1}\n\n```\nEVI1\nc1|1|"le')).toBe('Ice floats.[1]');
  });

  it('shows nothing of an evidence-first block while it streams', () => {
    const text = 'EVI1\nc1|1|"ice is less dense"\nEND_EVI1\n\nIce floats.[1]{c1}';
    for (let i = 1; i <= text.length; i++) {
      const shown = stripForDisplay(text.slice(0, i));
      expect('Ice floats.[1]'.startsWith(shown), `prefix ${i}: ${shown}`).toBe(true);
    }
  });

  it('keeps a code block that ends the answer', () => {
    expect(stripForDisplay('Run:[1]{c1}\n```\nls\n```')).toBe('Run:[1]\n```\nls\n```');
  });

  it('leaves text without protocol alone', () => {
    expect(stripForDisplay('Plain answer with [1] and {braces}.')).toBe('Plain answer with [1] and {braces}.');
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

  it('takes the sources of a claim without [n] from the appendix', () => {
    const parsed = parseAnswer('Beta cells sense glucose.{c1} Ice floats.[1]{c2}\n\nEVI1\nc1|2|"q1"\nc1|3|"q2"\nc2|1|"q3"\nEND_EVI1');
    expect(parsed.claims[0]).toEqual({ id: 'c1', text: 'Beta cells sense glucose.', sourceIndexes: [2, 3] });
    expect(parsed.warnings).toEqual(['Claim c1: no citation group directly before marker; sources taken from the EVI1 appendix.']);
  });

  it('keeps warning about a claim without [n] and without evidence', () => {
    const parsed = parseAnswer('Beta cells sense glucose.{c1}\n\nEVI1\nc2|1|"q"\nEND_EVI1');
    expect(parsed.claims[0].sourceIndexes).toEqual([]);
    expect(parsed.warnings).toContain('Claim c1: no citation group directly before marker.');
  });

  it('keeps several quotes for one pair and drops repeated ones', () => {
    const parsed = parseAnswer('A.[1]{c1}\n\nEVI1\nc1|1|"q1"\nc1|1|"q2"\nc1|1|"q1"\nEND_EVI1');
    expect(parsed.evidence.map((e) => e.quote)).toEqual(['q1', 'q2']);
    expect(parsed.warnings).toEqual(['EVI1: repeated quote for c1|1; keeping first occurrence.']);
  });

  it('parses an evidence block that comes before the answer', () => {
    const text = 'EVI1\nc1|1|"ice is less dense"\nc2|2|"water expands"\nEND_EVI1\n\nIce floats.[1]{c1} Water expands.[2]{c2}';
    const parsed = parseAnswer(text);
    expect(parsed.cleanText).toBe('Ice floats.[1] Water expands.[2]');
    expect(parsed.evidence).toHaveLength(2);
    expect(parsed.warnings).toEqual([]);
  });

  it('ends an evidence-first block without END_EVI1 at the answer', () => {
    const text = 'EVI1\nc1|1|"ice is less dense"\n\nIce floats.[1]{c1}';
    const parsed = parseAnswer(text);
    expect(parsed.cleanText).toBe('Ice floats.[1]');
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.warnings).toEqual([]);
  });
});

describe('stripClaimMarkers', () => {
  it('removes only claim markers', () => {
    expect(stripClaimMarkers('Keep [1] drop {c1} and {c23}.')).toBe('Keep [1] drop  and .');
  });
});
