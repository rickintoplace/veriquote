import { describe, expect, it } from 'vitest';
import { verifyAnswer } from '../src/report.js';
import type { EntailmentInput, EntailmentJudge, EntailmentResult } from '../src/types.js';

const SOURCES = [
  {
    title: 'Trial A',
    text:
      'In this randomized controlled trial of 2,000 participants, vitamin D supplementation ' +
      'reduced the rate of falls by 19% compared with placebo over 24 months of follow-up. ' +
      'The effect was strongest in participants with baseline deficiency.',
  },
  {
    title: 'Trial B',
    text:
      'Bone mineral density increased significantly in the intervention group, while fracture ' +
      'incidence did not differ between groups during the study period of three years overall.',
  },
];

const ANSWER = [
  'Vitamin D reduced fall risk by about a fifth.[1]{c1}',
  'It also increased bone mineral density.[2]{c2}',
  '',
  'EVI1',
  'c1|1|"vitamin D supplementation reduced the rate of falls by 19% compared with placebo"',
  'c2|2|"Bone mineral density increased significantly in the intervention group"',
  'END_EVI1',
].join('\n');

class StubJudge implements EntailmentJudge {
  public received: EntailmentInput[] = [];
  constructor(private readonly results: Record<string, EntailmentResult>) {}
  async judge(items: EntailmentInput[]): Promise<EntailmentResult[]> {
    this.received = items;
    return items.map(
      (it) => this.results[it.id] ?? { class: 'error', confidence: null, reasons: [] },
    );
  }
}

describe('verifyAnswer', () => {
  it('verifies text-match only when no judge is given', async () => {
    const report = await verifyAnswer({ answer: ANSWER, sources: SOURCES });
    expect(report.citations).toHaveLength(2);
    expect(report.citations.every((c) => c.textMatch.method === 'exact')).toBe(true);
    expect(report.summary).toEqual({
      citationCount: 2,
      verbatimRate: 1,
      entailedRate: null,
      meanScore: 1,
      minScore: 1,
    });
    expect(report.cleanText).not.toContain('{c');
    expect(report.warnings).toHaveLength(0);
  });

  it('combines judge confidence with text match conservatively', async () => {
    const judge = new StubJudge({
      'c1|1': { class: 'entailed', confidence: 0.95, reasons: ['direct support'] },
      'c2|2': { class: 'overstated', confidence: 0.4, reasons: ['claim too strong'] },
    });
    const report = await verifyAnswer({ answer: ANSWER, sources: SOURCES, judge });
    expect(judge.received).toHaveLength(2);
    expect(judge.received[0].claim).toBe('Vitamin D reduced fall risk by about a fifth.');
    expect(judge.received[0].context).toContain('randomized controlled trial');
    expect(report.citations[0].score).toBeCloseTo(0.95);
    expect(report.citations[1].score).toBeCloseTo(0.4);
    expect(report.summary.entailedRate).toBe(0.5);
    expect(report.summary.minScore).toBeCloseTo(0.4);
  });

  it('sets score to null on judge errors', async () => {
    const judge = new StubJudge({});
    const report = await verifyAnswer({ answer: ANSWER, sources: SOURCES, judge });
    expect(report.citations.every((c) => c.score === null)).toBe(true);
    expect(report.summary.meanScore).toBeNull();
  });

  it('warns when evidence points at a missing source', async () => {
    const answer = 'A claim.[7]{c1}\n\nEVI1\nc1|7|"some quote text"\nEND_EVI1';
    const report = await verifyAnswer({ answer, sources: SOURCES });
    expect(report.citations).toHaveLength(0);
    expect(report.warnings.some((w) => w.includes('not provided'))).toBe(true);
  });

  it('handles answers without any citations', async () => {
    const report = await verifyAnswer({ answer: 'Just prose, no citations.', sources: SOURCES });
    expect(report.citations).toHaveLength(0);
    expect(report.summary.citationCount).toBe(0);
    expect(report.cleanText).toBe('Just prose, no citations.');
  });
});
