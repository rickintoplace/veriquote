/**
 * `veriquote` command line. Kept free of `process` so it can be tested with
 * injected I/O; `bin/veriquote.mjs` wires it to the real process.
 */

import type { EntailmentJudge, SourceDocument, VerificationReport } from '../types.js';
import { verifyAnswer } from '../report.js';
import { gateReport, type GateResult } from '../gate.js';
import { buildCitationInstructions } from '../protocol/prompt.js';
import { ChatCompletionsJudge } from '../judge/chat-judge.js';
import { fetchSource, sourceFromBody } from '../source/fetch.js';

export interface CliIo {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  version: string;
  /** Use ANSI colors in human output. */
  color: boolean;
  /** Test hook: replaces the env-configured judge. */
  judge?: EntailmentJudge;
}

export const EXIT = { pass: 0, error: 1, revise: 2 } as const;

const HELP = `veriquote — check that an LLM answer's quotes exist in its sources and support its claims

Usage
  veriquote prompt                      print the citation instructions for the answering model
  veriquote source <url|file>           print the text a source is checked against (quote from this)
  veriquote check <answer> --source <url|file> [--source …]
  veriquote check --job <file|->        JSON job: {"answer": "...", "sources": [{"text": "..."}]}

  <answer> is a file, or - for stdin. It must contain the EVI1 appendix.
  Sources are numbered in the order given: the first --source is [1].
  URLs are fetched by veriquote itself, not taken from the model.

Options
  -s, --source <url|file>   a cited source (repeatable)
      --job <file|->        read answer and sources from a JSON job
      --json                machine-readable output
      --no-judge            only check that quotes occur in their sources
      --min-score <n>       combined score below which a citation fails (default 0.5)
      --judge-model <id>    overrides VERIQUOTE_JUDGE_MODEL
      --judge-base-url <u>  overrides VERIQUOTE_JUDGE_BASE_URL
  -h, --help / -v, --version

Judge (semantic support check), from the environment:
  VERIQUOTE_JUDGE_API_KEY   any OpenAI-compatible endpoint; without it only quotes are checked
  VERIQUOTE_JUDGE_MODEL     required when a key is set
  VERIQUOTE_JUDGE_BASE_URL  default https://openrouter.ai/api/v1

Exit status: 0 pass · 2 revise · 1 error, or the judge failed (unverified)`;

interface Args {
  command?: string;
  positional: string[];
  sources: string[];
  job?: string;
  json: boolean;
  judge: boolean;
  minScore?: number;
  judgeModel?: string;
  judgeBaseUrl?: string;
  help: boolean;
  version: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const a: Args = { positional: [], sources: [], json: false, judge: true, help: false, version: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-s':
      case '--source':
        a.sources.push(value(i++, arg));
        break;
      case '--job':
        a.job = value(i++, arg);
        break;
      case '--json':
        a.json = true;
        break;
      case '--no-judge':
        a.judge = false;
        break;
      case '--min-score': {
        const n = Number(value(i++, arg));
        if (!(n >= 0 && n <= 1)) throw new UsageError('--min-score must be between 0 and 1');
        a.minScore = n;
        break;
      }
      case '--judge-model':
        a.judgeModel = value(i++, arg);
        break;
      case '--judge-base-url':
        a.judgeBaseUrl = value(i++, arg);
        break;
      case '-h':
      case '--help':
        a.help = true;
        break;
      case '-v':
      case '--version':
        a.version = true;
        break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new UsageError(`unknown option ${arg}`);
        if (a.command === undefined) a.command = arg;
        else a.positional.push(arg);
    }
  }
  return a;
}

export async function main(io: CliIo): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(io.argv);
  } catch (err) {
    io.stderr(`veriquote: ${(err as Error).message}\nRun "veriquote --help" for usage.\n`);
    return EXIT.error;
  }
  if (args.version) {
    io.stdout(`${io.version}\n`);
    return EXIT.pass;
  }
  if (args.help || !args.command) {
    io.stdout(`${HELP}\n`);
    return args.help ? EXIT.pass : EXIT.error;
  }

  try {
    switch (args.command) {
      case 'prompt':
        io.stdout(`${buildCitationInstructions()}\n`);
        return EXIT.pass;
      case 'check':
        return await check(args, io);
      case 'source': {
        if (args.positional.length !== 1) throw new UsageError('source needs exactly one URL or file');
        const src = await loadSource(args.positional[0], io);
        io.stdout(`${src.text}\n`);
        return EXIT.pass;
      }
      default:
        throw new UsageError(`unknown command "${args.command}"`);
    }
  } catch (err) {
    const hint = err instanceof UsageError ? '\nRun "veriquote --help" for usage.' : '';
    io.stderr(`veriquote: ${(err as Error).message}${hint}\n`);
    return EXIT.error;
  }
}

async function check(args: Args, io: CliIo): Promise<number> {
  const read = (path: string) => (path === '-' ? io.readStdin() : io.readFile(path));
  let answer: string;
  let sources: SourceDocument[];

  if (args.job) {
    if (args.positional.length || args.sources.length) {
      throw new UsageError('--job already contains the answer and sources');
    }
    const job = JSON.parse(await read(args.job)) as { answer?: unknown; sources?: unknown };
    answer = String(job.answer ?? '');
    if (!Array.isArray(job.sources)) throw new UsageError('job.sources must be an array');
    sources = job.sources.map((s, i) => {
      if (typeof s?.text !== 'string') throw new UsageError(`job.sources[${i}].text must be a string`);
      return s as SourceDocument;
    });
  } else {
    if (args.positional.length !== 1) throw new UsageError('check needs exactly one answer file (or -)');
    if (!args.sources.length) throw new UsageError('give at least one --source, in citation order');
    answer = await read(args.positional[0]);
    sources = await Promise.all(args.sources.map((s) => loadSource(s, io)));
  }
  if (!answer.trim()) throw new UsageError('the answer is empty');

  const judgeSetup = args.judge ? judgeFromEnv(args, io) : { judge: undefined, model: undefined };
  const report = await verifyAnswer({ answer, sources, judge: judgeSetup.judge });
  const gate = gateReport(report, answer, args.minScore === undefined ? {} : { minScore: args.minScore });

  if (args.json) {
    io.stdout(
      `${JSON.stringify(
        {
          verdict: gate.verdict,
          judge: judgeSetup.model ?? null,
          // The answer as the user should see it: [n] markers kept, {cX} markers and the appendix removed.
          cleanAnswer: report.cleanText,
          summary: report.summary,
          problems: gate.problems,
          uncited: gate.uncited,
          unjudged: gate.unjudged,
          citations: report.citations.map((c) => ({
            claimId: c.claimId,
            sourceIndex: c.sourceIndex,
            match: { method: c.textMatch.method, score: round2(c.textMatch.score) },
            judge: c.entailment
              ? { class: c.entailment.class, support: c.entailment.confidence === null ? null : round2(c.entailment.confidence) }
              : null,
            score: c.score === null ? null : round2(c.score),
          })),
          warnings: report.warnings,
          sources: sources.map((s, i) => ({ index: i + 1, url: s.url, title: s.title, chars: s.text.length })),
          instructionsForModel: gate.instructionsForModel,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout(renderHuman(report, gate, sources, judgeSetup.model, io.color, args.minScore ?? 0.5));
  }
  return gate.verdict === 'pass' ? EXIT.pass : gate.verdict === 'revise' ? EXIT.revise : EXIT.error;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

async function loadSource(ref: string, io: CliIo): Promise<SourceDocument> {
  if (/^https?:\/\//i.test(ref)) {
    return fetchSource(ref, {
      fetch: io.fetch,
      userAgent: `veriquote/${io.version} (+https://github.com/rickintoplace/veriquote)`,
    });
  }
  if (/\.pdf$/i.test(ref)) {
    throw new Error(`${ref}: PDF sources are not supported; extract the text (e.g. pdftotext) and pass the .txt file`);
  }
  const body = await io.readFile(ref);
  const source = sourceFromBody(body, /\.x?html?$/i.test(ref) ? 'text/html' : 'text/plain');
  return { ...source, id: ref, title: source.title ?? ref };
}

function judgeFromEnv(args: Args, io: CliIo): { judge?: EntailmentJudge; model?: string } {
  if (io.judge) return { judge: io.judge, model: args.judgeModel ?? 'custom' };
  const apiKey = io.env.VERIQUOTE_JUDGE_API_KEY || io.env.OPENROUTER_API_KEY;
  if (!apiKey) return {};
  const model = args.judgeModel ?? io.env.VERIQUOTE_JUDGE_MODEL;
  if (!model) {
    throw new UsageError('a judge API key is set but no model: set VERIQUOTE_JUDGE_MODEL, or pass --no-judge');
  }
  const baseUrl =
    args.judgeBaseUrl ?? io.env.VERIQUOTE_JUDGE_BASE_URL ?? io.env.VERIQUOTE_BASE_URL ?? 'https://openrouter.ai/api/v1';
  return {
    model,
    judge: new ChatCompletionsJudge({ apiKey, model, baseUrl, timeoutMs: 120000, fetch: io.fetch }),
  };
}

// ------------------------------------------------------------------ output

const MATCH_LABEL: Record<string, string> = {
  exact: 'verbatim',
  normalized: 'verbatim',
  elided: 'verbatim with omission',
  fuzzy: 'fuzzy',
};

function renderHuman(
  report: VerificationReport,
  gate: GateResult,
  sources: SourceDocument[],
  model: string | undefined,
  color: boolean,
  minScore: number,
): string {
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const green = (s: string) => c('32', s);
  const red = (s: string) => c('31', s);
  const yellow = (s: string) => c('33', s);
  const dim = (s: string) => c('2', s);
  const out: string[] = [];

  out.push(
    dim(`${report.citations.length} citation(s) · ${sources.length} source(s) · judge: ${model ?? 'off (quotes only)'}`),
    '',
  );

  const failed = new Set(gate.problems.map((p) => `${p.claimId}|${p.sourceIndex}`));
  for (const cit of report.citations) {
    const bad = failed.has(`${cit.claimId}|${cit.sourceIndex}`);
    const mark = bad ? red('✗') : cit.score === null ? yellow('?') : green('✓');
    const match =
      cit.textMatch.method === 'not_found'
        ? red(`quote not in source (best ${cit.textMatch.score.toFixed(2)})`)
        : `${MATCH_LABEL[cit.textMatch.method]} ${cit.textMatch.score.toFixed(2)}`;
    const judged = cit.entailment
      ? cit.entailment.class === 'error'
        ? yellow('judge error')
        : `${cit.entailment.class} ${cit.entailment.confidence?.toFixed(2) ?? ''}`.trim()
      : '';
    out.push(`${mark} ${cit.claimId} [${cit.sourceIndex}]  ${[match, judged].filter(Boolean).join(' · ')}`);
    out.push(`    ${truncate(cit.claimText || '(no claim text)', 160)}`);
    const hides = gate.problems.find((p) => p.claimId === cit.claimId && p.sourceIndex === cit.sourceIndex)?.type === 'ellipsis_hides_qualifier';
    if (bad && cit.textMatch.method === 'not_found') out.push(dim('    the quoted text does not occur in the source'));
    else if (hides) {
      const cues = (cit.textMatch.omittedCues ?? []).map((c) => `"${c}"`).join(', ');
      out.push(dim(`    the ellipsis leaves out ${cues}; run with a judge to check the full passage`));
    } else if (bad && cit.entailment?.reasons.length) out.push(dim(`    ${cit.entailment.reasons.map((r) => r.trim().replace(/[.;]+$/, '')).join('; ')}`));
    else if (bad && cit.score !== null && cit.textMatch.method !== 'not_found') {
      out.push(dim(`    combined score ${cit.score.toFixed(2)} is below the minimum ${minScore.toFixed(2)}`));
    }
  }
  for (const s of gate.uncited) out.push(`${yellow('!')} uncited  ${truncate(s, 160)}`);
  for (const w of report.warnings) out.push(dim(`warning: ${w}`));

  out.push('');
  if (gate.verdict === 'pass') {
    out.push(green(report.citations.length ? 'PASS' : 'PASS, but the answer cites nothing'));
  } else if (gate.verdict === 'unverified') {
    out.push(yellow(`UNVERIFIED: the judge failed on ${gate.unjudged.length} citation(s), so their support was not checked. Run the check again.`));
  } else {
    const parts = [
      gate.problems.length && `${gate.problems.length} failed citation(s)`,
      gate.uncited.length && `${gate.uncited.length} uncited sentence(s)`,
    ].filter(Boolean);
    out.push(red(`REVISE: ${parts.join(', ')}`));
    if (gate.unjudged.length) out.push(yellow(`The judge also failed on ${gate.unjudged.length} citation(s).`));
  }
  if (!model) out.push(dim('Only checked that quotes exist in their sources. Set VERIQUOTE_JUDGE_API_KEY to check support.'));
  return `${out.join('\n')}\n`;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}
