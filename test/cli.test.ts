import { describe, expect, it } from 'vitest';
import { main, type CliIo } from '../src/cli/main.js';
import type { EntailmentJudge } from '../src/types.js';

const PAGE =
  '<html><body><main><p>The ozone layer was discovered in 1913 by French physicists Charles Fabry and Henri Buisson.</p>' +
  '<p>It absorbs 97 to 99 percent of the medium-frequency ultraviolet light from the Sun.</p></main></body></html>';

const GOOD = [
  'It absorbs most medium-frequency UV light.[1]{c1}',
  'EVI1',
  'c1|1|"It absorbs 97 to 99 percent of the medium-frequency ultraviolet light"',
  'END_EVI1',
].join('\n');

const FABRICATED = [
  'The treaty banned CFCs at once.[1]{c1}',
  'EVI1',
  'c1|1|"all chlorofluorocarbon production ended overnight in every signatory country"',
  'END_EVI1',
].join('\n');

function run(argv: string[], files: Record<string, string> = {}, extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fetched: string[] = [];
  const io: CliIo = {
    argv,
    env: {},
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    readStdin: async () => files['<stdin>'] ?? '',
    fetch: (async (url: string) => {
      fetched.push(url);
      return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
    }) as typeof globalThis.fetch,
    version: '9.9.9',
    color: false,
    ...extra,
  };
  return main(io).then((code) => ({ code, out: out.join(''), err: err.join(''), fetched }));
}

describe('veriquote CLI', () => {
  it('passes a grounded answer and fetches the source itself', async () => {
    const r = await run(['check', 'a.md', '-s', 'https://example.org/ozone'], { 'a.md': GOOD });
    expect(r.code).toBe(0);
    expect(r.fetched).toEqual(['https://example.org/ozone']);
    expect(r.out).toContain('PASS');
    expect(r.out).toContain('judge: off');
  });

  it('exits 2 with a correction prompt in --json mode for a fabricated quote', async () => {
    const r = await run(['check', '-', '--source', 'https://example.org/ozone', '--json'], { '<stdin>': FABRICATED });
    expect(r.code).toBe(2);
    const json = JSON.parse(r.out);
    expect(json.verdict).toBe('revise');
    expect(json.problems[0].type).toBe('quote_not_in_source');
    expect(json.instructionsForModel).toContain('Claim c1');
    expect(json.sources[0]).toMatchObject({ index: 1, url: 'https://example.org/ozone' });
  });

  it('reads local files as sources, HTML by extension', async () => {
    const r = await run(['check', 'a.md', '-s', 'page.html'], { 'a.md': GOOD, 'page.html': PAGE });
    expect(r.code).toBe(0);
    expect(r.fetched).toEqual([]);
  });

  it('accepts a JSON job with inline sources', async () => {
    const job = JSON.stringify({ answer: GOOD, sources: [{ text: 'It absorbs 97 to 99 percent of the medium-frequency ultraviolet light.' }] });
    const r = await run(['check', '--job', 'job.json'], { 'job.json': job });
    expect(r.code).toBe(0);
  });

  it('uses the judge and reports its verdict', async () => {
    const judge: EntailmentJudge = {
      judge: async (items) => items.map(() => ({ class: 'overstated', confidence: 0.4, reasons: ['Claim is broader than the quote.'] })),
    };
    const r = await run(['check', 'a.md', '-s', 'https://example.org/ozone'], { 'a.md': GOOD }, { judge });
    expect(r.code).toBe(2);
    expect(r.out).toContain('overstated 0.40');
    expect(r.out).toContain('Claim is broader than the quote.');
  });

  it('refuses to run a key without a model rather than silently skipping the judge', async () => {
    const r = await run(['check', 'a.md', '-s', 'https://example.org/ozone'], { 'a.md': GOOD }, {
      env: { VERIQUOTE_JUDGE_API_KEY: 'sk-test' },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('VERIQUOTE_JUDGE_MODEL');
  });

  it('exits 1 on usage errors and on unreadable sources', async () => {
    expect((await run(['check', 'a.md'], { 'a.md': GOOD })).code).toBe(1);
    expect((await run(['check', 'a.md', '--bogus'], { 'a.md': GOOD })).code).toBe(1);
    const missing = await run(['check', 'a.md', '-s', 'nope.txt'], { 'a.md': GOOD });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('nope.txt');
  });

  it('prints the citation instructions and the version', async () => {
    expect((await run(['prompt'])).out).toContain('EVI1');
    expect((await run(['--version'])).out).toBe('9.9.9\n');
  });
});
