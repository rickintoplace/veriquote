/**
 * Mutation operators for the matcher benchmark.
 *
 * Every operator carries its own ground truth, so the benchmark needs no
 * human labelling and no LLM. Operators fall into three families:
 *
 *   faithful    The quote still reports the source honestly, but the string
 *               differs (extraction noise, typography, elision). The matcher
 *               MUST still find it -- a miss here is a false accusation.
 *   manipulated The quote is near-verbatim but its meaning was altered
 *               (number swapped, negated, spliced). The matcher is NOT
 *               expected to catch these; they exist to quantify the blind
 *               spot that the entailment judge has to cover.
 *   absent      The quote does not occur in the source at all. The matcher
 *               MUST report `not_found` -- a hit here is a missed fabrication.
 *
 * Operators are additionally tagged `natural` or `adversarial`. Natural
 * operators reproduce failures that answering models actually produce;
 * adversarial ones are deliberate attacks on the matcher. Headline numbers are
 * reported over natural operators, with adversarial ones shown separately, so
 * a worst case cannot be passed off as a typical one -- or hidden.
 *
 * Each operator returns `null` when it does not apply to a given passage
 * (e.g. no digits to swap); those cases are skipped, never counted.
 */

import { pick } from '../lib/rng.mjs';

/** @typedef {'faithful'|'manipulated'|'absent'} Family */

const CONTENT_WORD = /\b[a-z]{5,}\b/gi;

// ---------------------------------------------------------------- faithful

const identity = (q) => q;

const whitespace = (q) =>
  q.replace(/ /g, (_, i) => (i % 7 === 0 ? '\n' : ' ')).replace(/(\S) (\S)/g, '$1  $2');

const typography = (q) =>
  q
    .replace(/"([^"]*)"/g, '“$1”')
    .replace(/'/g, '’')
    .replace(/ - /g, ' — ')
    .replace(/-/g, '‐')
    .replace(/ /g, (m, i) => (i % 11 === 0 ? ' ' : m));

const caseFold = (q) => q.toLowerCase();

/** Character-level noise of the kind PDF/HTML extraction produces. */
function ocrNoise(q, rng) {
  const subs = { m: 'rn', l: '1', O: '0', o: '0', S: '5', i: 'l', e: 'c' };
  const chars = q.split('');
  const budget = Math.max(1, Math.floor(q.length / 60));
  let applied = 0;
  for (let attempt = 0; attempt < budget * 20 && applied < budget; attempt++) {
    const i = Math.floor(rng() * chars.length);
    if (subs[chars[i]]) {
      chars[i] = subs[chars[i]];
      applied++;
    }
  }
  return applied ? chars.join('') : null;
}

/** Standard scholarly elision: drop the middle, mark it with an ellipsis. */
function elision(q) {
  if (q.length < 120) return null;
  const a = Math.floor(q.length * 0.35);
  const b = Math.floor(q.length * 0.65);
  return `${q.slice(0, a).trimEnd()} … ${q.slice(b).trimStart()}`;
}

/** Soft hyphens and line breaks left over from a justified PDF column. */
const hyphenation = (q) => q.replace(/(\w{3})(\w{3,})/g, (m, a, b, i) => (i % 5 === 0 ? `${a}-\n${b}` : m));

// ------------------------------------------------------------- manipulated

/** Swap a digit run for a different one: 19% -> 79%. */
function numberSwap(q, rng) {
  const nums = [...q.matchAll(/\b\d+(?:[.,]\d+)?\b/g)];
  if (!nums.length) return null;
  const m = pick(rng, nums);
  const digits = m[0].replace(/\D/g, '');
  const bumped = m[0].replace(/\d/, (d) => String((Number(d) + 3 + Number(digits[0] || 0)) % 10));
  const changed = bumped === m[0] ? m[0].replace(/\d/, (d) => String((Number(d) + 5) % 10)) : bumped;
  if (changed === m[0]) return null;
  return q.slice(0, m.index) + changed + q.slice(m.index + m[0].length);
}

/** Insert or remove a negation: "reduced" -> "did not reduce". */
function negation(q) {
  if (/\bnot\b/.test(q)) return q.replace(/\bnot\b/, '');
  const aux = q.match(/\b(is|are|was|were|has|have|can|may|will|does|do)\b/);
  if (aux) return q.slice(0, aux.index + aux[0].length) + ' not' + q.slice(aux.index + aux[0].length);
  const verb = q.match(/\b(\w+)(ed|es)\b/);
  if (verb) return q.slice(0, verb.index) + 'did not ' + verb[1] + q.slice(verb.index + verb[0].length);
  return null;
}

/** Strengthen hedged evidence: "may" -> "does", "some" -> "all". */
function quantifierUpgrade(q) {
  const ups = [
    [/\bmay\b/, 'does'],
    [/\bmight\b/, 'will'],
    [/\bcan\b/, 'always does'],
    [/\bsome\b/, 'all'],
    [/\bmany\b/, 'all'],
    [/\boften\b/, 'always'],
    [/\bassociated with\b/, 'caused by'],
    [/\bsuggests?\b/, 'proves'],
    [/\bmost\b/, 'every'],
  ];
  for (const [re, to] of ups) if (re.test(q)) return q.replace(re, to);
  return null;
}

/** Replace a content word with one taken from a different document. */
function entitySwap(q, rng, ctx) {
  const words = [...q.matchAll(CONTENT_WORD)];
  if (!words.length || !ctx.foreignWords?.length) return null;
  const w = pick(rng, words);
  const replacement = pick(rng, ctx.foreignWords);
  if (replacement.toLowerCase() === w[0].toLowerCase()) return null;
  return q.slice(0, w.index) + replacement + q.slice(w.index + w[0].length);
}

/**
 * Quote mining: join the opening of this passage to the closing of a distant
 * passage from the same document. Every character is verbatim; the sentence
 * they form is not in the source.
 */
function splice(q, rng, ctx) {
  const other = pick(rng, ctx.siblings || []);
  if (!other || other === q) return null;
  const head = q.slice(0, Math.floor(q.length * 0.5)).trimEnd();
  const tail = other.slice(Math.floor(other.length * 0.5)).trimStart();
  if (head.length < 30 || tail.length < 30) return null;
  return `${head} ${tail}`;
}

// ------------------------------------------------------------------ absent

/**
 * Real quote, wrong document. The single most common attribution failure in
 * multi-source answers: the text is genuine, the citation index is not.
 */
function wrongSource(q, rng, ctx) {
  return ctx.foreignPassage || null;
}

/** Recombine the source's own vocabulary into prose that never appears in it. */
function scramble(q, rng) {
  const words = q.split(/\s+/);
  if (words.length < 8) return null;
  const out = words.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join(' ');
}

/** @type {{name: string, family: Family, fn: Function, note: string, realism: 'natural'|'adversarial'}[]} */
export const OPERATORS = [
  { name: 'identity', family: 'faithful', fn: identity, note: 'untouched passage', realism: 'natural' },
  { name: 'whitespace', family: 'faithful', fn: whitespace, note: 'line breaks, double spaces', realism: 'natural' },
  { name: 'typography', family: 'faithful', fn: typography, note: 'smart quotes, dashes, NBSP', realism: 'natural' },
  { name: 'case', family: 'faithful', fn: caseFold, note: 'lowercased', realism: 'natural' },
  { name: 'ocr_noise', family: 'faithful', fn: ocrNoise, note: 'extraction typos (~1 per 60 chars)', realism: 'natural' },
  { name: 'elision', family: 'faithful', fn: elision, note: 'middle replaced by an ellipsis', realism: 'natural' },
  { name: 'hyphenation', family: 'faithful', fn: hyphenation, note: 'PDF column hyphen + newline', realism: 'natural' },

  { name: 'number_swap', family: 'manipulated', fn: numberSwap, note: 'a figure was changed', realism: 'natural' },
  { name: 'negation', family: 'manipulated', fn: negation, note: 'negation inserted or removed', realism: 'natural' },
  { name: 'quantifier_upgrade', family: 'manipulated', fn: quantifierUpgrade, note: 'hedge strengthened', realism: 'natural' },
  { name: 'entity_swap', family: 'manipulated', fn: entitySwap, note: 'content word replaced', realism: 'natural' },
  { name: 'splice', family: 'manipulated', fn: splice, note: 'two distant fragments joined', realism: 'natural' },

  { name: 'wrong_source', family: 'absent', fn: wrongSource, note: 'real quote, wrong document', realism: 'natural' },
  { name: 'scramble', family: 'absent', fn: scramble, note: "source's vocabulary, invented prose", realism: 'adversarial' },
];
