import { describe, expect, it } from 'vitest';
import { gateReport } from '../src/gate.js';
import { verifyAnswer } from '../src/report.js';
import type { EntailmentJudge, EntailmentResult } from '../src/types.js';

const SOURCE = {
  text:
    'The ozone layer was discovered in 1913 by French physicists Charles Fabry and Henri Buisson. ' +
    'It absorbs 97 to 99 percent of the medium-frequency ultraviolet light from the Sun.',
};

const judgeReturning = (byId: Record<string, EntailmentResult>): EntailmentJudge => ({
  judge: async (items) => items.map((it) => byId[it.id] ?? { class: 'entailed', confidence: 1, reasons: [] }),
});

async function gate(answer: string, judge?: EntailmentJudge) {
  const report = await verifyAnswer({ answer, sources: [SOURCE], judge });
  return gateReport(report, answer);
}

describe('gateReport', () => {
  it('passes a verbatim, supported citation', async () => {
    const answer = [
      'It absorbs most medium-frequency UV light.[1]{c1}',
      'EVI1',
      'c1|1|"It absorbs 97 to 99 percent of the medium-frequency ultraviolet light"',
      'END_EVI1',
    ].join('\n');
    const result = await gate(answer, judgeReturning({}));
    expect(result.verdict).toBe('pass');
    expect(result.instructionsForModel).toBeNull();
  });

  it('fails a quote that is not in the source, whatever the judge says', async () => {
    const answer = [
      'The treaty banned CFCs at once.[1]{c1}',
      'EVI1',
      'c1|1|"all chlorofluorocarbon production ended overnight in every signatory country"',
      'END_EVI1',
    ].join('\n');
    const result = await gate(answer, judgeReturning({}));
    expect(result.verdict).toBe('revise');
    expect(result.problems[0].type).toBe('quote_not_in_source');
    expect(result.instructionsForModel).toContain('Claim c1');
  });

  it('fails a verbatim quote the judge finds contradicted', async () => {
    const answer = [
      'It was discovered in 1913 by G. M. B. Dobson.[1]{c1}',
      'EVI1',
      'c1|1|"The ozone layer was discovered in 1913 by French physicists Charles Fabry and Henri Buisson."',
      'END_EVI1',
    ].join('\n');
    const result = await gate(answer, judgeReturning({ 'c1|1': { class: 'contradicted', confidence: 0, reasons: [] } }));
    expect(result.problems.map((p) => p.type)).toEqual(['contradicted_by_source']);
  });

  it('reports a judge error as unverified, neither pass nor a failed citation', async () => {
    const answer = [
      'It absorbs most medium-frequency UV light.[1]{c1}',
      'EVI1',
      'c1|1|"It absorbs 97 to 99 percent of the medium-frequency ultraviolet light"',
      'END_EVI1',
    ].join('\n');
    const result = await gate(answer, judgeReturning({ 'c1|1': { class: 'error', confidence: null, reasons: ['judge_timeout'] } }));
    expect(result.verdict).toBe('unverified');
    expect(result.problems).toEqual([]);
    expect(result.unjudged).toEqual([{ claimId: 'c1', sourceIndex: 1, reason: 'judge_timeout' }]);
    expect(result.instructionsForModel).toBeNull();
  });

  it('flags uncited factual sentences but not initials, questions or headings', async () => {
    const answer = [
      '## Background',
      'It was described by G. M. B. Dobson, who built the first spectrophotometer.[1]{c1}',
      'Is the hole still growing over the Antarctic every single year?',
      'Ozone depletion has since been fully reversed in every region of the atmosphere.',
      'EVI1',
      'c1|1|"The ozone layer was discovered in 1913 by French physicists"',
      'END_EVI1',
    ].join('\n');
    const result = await gate(answer);
    expect(result.uncited).toEqual([
      'Ozone depletion has since been fully reversed in every region of the atmosphere.',
    ]);
  });
});
