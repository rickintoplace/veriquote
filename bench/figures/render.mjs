#!/usr/bin/env node
/**
 * Render the README figures from bench/results/*.json as static SVG, one light
 * and one dark variant each. No dependencies; re-run after any benchmark:
 *
 *   node bench/figures/render.mjs
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '..', 'results');
const load = (f) => JSON.parse(readFileSync(join(RESULTS, f), 'utf8'));

const THEMES = {
  light: {
    surface: '#ffffff', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781',
    grid: '#e1e0d9', axis: '#c3c2b7', wash: 'rgba(11,11,11,0.05)',
    s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', track: 0.16,
    fPass: '#008300', fJudge: '#eda100', fFail: '#e34948', cComplete: '#0e7c61', cVerbatim: '#5cc29e',
  },
  dark: {
    surface: '#0d1117', ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781',
    grid: '#2c2c2a', axis: '#383835', wash: 'rgba(255,255,255,0.06)',
    s1: '#3987e5', s2: '#d95926', s3: '#199e70', track: 0.28,
    fPass: '#00863a', fJudge: '#b88c00', fFail: '#e0607e', cComplete: '#3dab85', cVerbatim: '#107a5c',
  },
};

const FONT = 'system-ui, -apple-system, &quot;Segoe UI&quot;, Helvetica, Arial, sans-serif';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;

function text(x, y, s, { size = 12, fill, weight = 400, anchor = 'start', mono = false } = {}) {
  const num = mono ? ' font-variant-numeric="tabular-nums"' : '';
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${num}>${esc(s)}</text>`;
}

function svg(width, height, t, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}" font-family="${FONT}">
<title>${esc(title)}</title>
<rect width="${width}" height="${height}" rx="8" fill="${t.surface}"/>
${body.join('\n')}
</svg>
`;
}

/** Greedy word wrap for SVG text, which does not wrap on its own. */
function wrap(s, width) {
  const lines = [''];
  for (const word of s.split(' ')) {
    const cur = lines[lines.length - 1];
    if (cur && cur.length + word.length + 1 > width) lines.push(word);
    else lines[lines.length - 1] = cur ? `${cur} ${word}` : word;
  }
  return lines;
}

/** Wilson 95% interval for k successes out of n. */
function wilson(k, n) {
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function xAxis(t, { x0, x1, y0, y1, domain, ticks, fmt }) {
  const sx = (v) => x0 + ((v - domain[0]) / (domain[1] - domain[0])) * (x1 - x0);
  const out = [];
  for (const v of ticks) {
    const x = sx(v);
    out.push(`<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="${t.grid}" stroke-width="1"/>`);
    out.push(text(x, y1 + 16, fmt(v), { size: 11, fill: t.muted, anchor: 'middle', mono: true }));
  }
  return { sx, marks: out };
}

const OP_LABELS = {
  identity: 'untouched passage',
  whitespace: 'line breaks, double spaces',
  typography: 'smart quotes, dashes, NBSP',
  case: 'lowercased',
  ocr_noise: 'OCR-style typos',
  elision: 'middle elided with …',
  hyphenation: 'PDF hyphenation',
  number_swap: 'a figure changed',
  negation: 'negation flipped',
  quantifier_upgrade: 'hedge strengthened',
  entity_swap: 'a content word swapped',
  splice: 'two fragments spliced',
  wrong_source: 'real quote, wrong document',
  paraphrase: 'honest paraphrase',
  scramble: 'source words, invented prose (adversarial)',
};

// --------------------------------------------------------------- figure 1

function matcherFigure(t) {
  const m = load('matcher.json');
  const FAMILIES = [
    { key: 'faithful', name: 'Faithful, reformatted', note: 'must pass', color: t.fPass },
    { key: 'manipulated', name: 'Meaning changed', note: 'the judge’s job', color: t.fJudge },
    { key: 'absent', name: 'Not in the source', note: 'must fail', color: t.fFail },
  ];
  const W = 760;
  const labelRight = 262;
  const x0 = 282;
  const x1 = 736;
  const rowH = 21;
  const headH = 28;
  let y = 104;
  const rows = [];
  for (const f of FAMILIES) {
    rows.push({ head: f, y });
    y += headH;
    for (const op of m.operators.filter((o) => o.family === f.key)) {
      rows.push({ op, f, y });
      y += rowH;
    }
    y += 6;
  }
  const plotTop = 96;
  const plotBottom = y - 4;
  const H = plotBottom + 58;
  const { sx, marks } = xAxis(t, {
    x0, x1, y0: plotTop, y1: plotBottom, domain: [0, 1],
    ticks: [0, 0.2, 0.4, 0.6, 0.8, 1], fmt: (v) => v.toFixed(1),
  });
  const sep = m.separation;
  const body = [
    text(24, 32, 'How the matcher scores faithful, altered and missing quotes', { size: 16, weight: 600, fill: t.ink }),
    text(24, 52, `Matcher score per mutation, ${m.itemCount.toLocaleString('en')} quotes from 5 pinned Wikipedia articles. Line: min–max · dot: median.`, { size: 12, fill: t.ink2 }),
  ];
  // legend
  let lx = 24;
  for (const f of FAMILIES) {
    body.push(`<circle cx="${lx + 5}" cy="74" r="5" fill="${f.color}"/>`);
    const label = `${f.name}: ${f.note}`;
    body.push(text(lx + 16, 78, label, { size: 12, fill: t.ink2 }));
    lx += 16 + label.length * 6.6 + 22;
  }
  // gap band + threshold
  body.push(`<rect x="${sx(sep.highestAbsentScore)}" y="${plotTop}" width="${sx(sep.lowestFaithfulScore) - sx(sep.highestAbsentScore)}" height="${plotBottom - plotTop}" fill="${t.wash}"/>`);
  body.push(...marks);
  body.push(`<line x1="${sx(m.threshold)}" y1="${plotTop}" x2="${sx(m.threshold)}" y2="${plotBottom}" stroke="${t.ink2}" stroke-width="1.5"/>`);
  body.push(text(sx(m.threshold) - 6, plotTop + 12, `default threshold ${m.threshold}`, { size: 11, fill: t.ink2, anchor: 'end' }));
  body.push(text((sx(sep.highestAbsentScore) + sx(sep.lowestFaithfulScore)) / 2, plotTop + 12, `gap ${sep.gap.toFixed(2)}`, { size: 11, fill: t.muted, anchor: 'middle' }));

  for (const r of rows) {
    if (r.head) {
      body.push(text(24, r.y + 18, r.head.name, { size: 12, weight: 600, fill: t.ink }));
      continue;
    }
    const cy = r.y + rowH / 2;
    body.push(text(labelRight, cy + 4, OP_LABELS[r.op.operator] ?? r.op.operator, { size: 12, fill: t.ink2, anchor: 'end' }));
    const a = sx(r.op.minScore);
    const b = Math.max(sx(r.op.maxScore), a + 1);
    body.push(`<line x1="${a}" y1="${cy}" x2="${b}" y2="${cy}" stroke="${r.f.color}" stroke-width="2" stroke-linecap="round"/>`);
    body.push(`<circle cx="${sx(r.op.medianScore)}" cy="${cy}" r="4.5" fill="${r.f.color}" stroke="${t.surface}" stroke-width="2"/>`);
  }
  body.push(text(x1, H - 18, 'Scores in [0, 1]; ≥ 0.4 counts as found. Source: bench/results/matcher.json', { size: 11, fill: t.muted, anchor: 'end' }));
  return svg(W, H, t, body, 'Matcher score ranges per mutation family');
}

// --------------------------------------------------------------- figure 2

function tangoFigure(t) {
  const m = load('matcher.json');
  const g = load('judge-glm-5.3-flash.json');
  const absent = m.families.find((f) => f.family === 'absent' && f.realism === 'natural');
  const manipulated = m.families.find((f) => f.family === 'manipulated' && f.realism === 'natural');
  const none = g.confusion.none;
  const noneN = none.full + none.partial + none.none;
  const flagged = none.partial + none.none;

  const COLS = [
    { name: 'Matcher', sub: 'deterministic', color: t.s1 },
    { name: 'Judge', sub: g.model, color: t.s2 },
    { name: 'Together', sub: 'fails if either fails', color: t.ink },
  ];
  const ROWS = [
    {
      name: 'Quote is not in the source',
      sub: 'invented, paraphrased, or from another document',
      cells: [
        { v: 1 - absent.acceptedRate, cap: `${absent.n - Math.round(absent.acceptedRate * absent.n)} of ${absent.n} rejected` },
        { v: null, cap: 'never sees the source' },
        { v: 1 - absent.acceptedRate, cap: 'caught by the matcher' },
      ],
    },
    {
      name: 'Quote is real, claim is not',
      sub: 'the source does not support what is claimed',
      cells: [
        { v: 1 - manipulated.acceptedRate, cap: `${Math.round(manipulated.acceptedRate * manipulated.n)} of ${manipulated.n} accepted` },
        { v: flagged / noneN, cap: `${flagged} of ${noneN} flagged` },
        { v: flagged / noneN, cap: 'caught by the judge' },
      ],
    },
  ];
  const W = 760;
  const colX = [280, 440, 600];
  const colW = 136;
  const rowY = [132, 222];
  const H = 364;
  const body = [
    text(24, 32, 'Which check catches which kind of bad citation', { size: 16, weight: 600, fill: t.ink }),
    text(24, 52, 'Share of bad citations each check catches, by kind of failure.', { size: 12, fill: t.ink2 }),
  ];
  COLS.forEach((c, i) => {
    body.push(`<rect x="${colX[i]}" y="80" width="10" height="10" rx="2" fill="${c.color}"/>`);
    body.push(text(colX[i] + 16, 89, c.name, { size: 13, weight: 600, fill: t.ink }));
    body.push(text(colX[i], 106, c.sub, { size: 11, fill: t.muted }));
  });
  ROWS.forEach((r, ri) => {
    const y = rowY[ri];
    body.push(`<line x1="24" y1="${y - 12}" x2="${W - 24}" y2="${y - 12}" stroke="${t.grid}" stroke-width="1"/>`);
    body.push(text(24, y + 16, r.name, { size: 13, weight: 600, fill: t.ink }));
    wrap(r.sub, 34).forEach((line, li) => body.push(text(24, y + 34 + li * 14, line, { size: 11, fill: t.ink2 })));
    r.cells.forEach((cell, ci) => {
      const x = colX[ci];
      const c = COLS[ci].color;
      body.push(text(x, y + 22, cell.v === null ? '—' : pct(cell.v, 0), { size: 22, weight: 600, fill: cell.v ? t.ink : t.muted }));
      body.push(`<rect x="${x}" y="${y + 34}" width="${colW}" height="8" rx="4" fill="${c}" fill-opacity="${t.track}"/>`);
      if (cell.v) body.push(`<rect x="${x}" y="${y + 34}" width="${Math.max(8, colW * cell.v)}" height="8" rx="4" fill="${c}"/>`);
      body.push(text(x, y + 60, cell.cap, { size: 11, fill: t.ink2 }));
    });
  });
  body.push(text(24, H - 36, `Matcher: synthetic quotes from bench/results/matcher.json (n = ${absent.n} and ${manipulated.n}). Judge: ALCE citations that human annotators`, { size: 11, fill: t.muted }));
  body.push(text(24, H - 20, `marked “does not support” (n = ${noneN}), counted as caught unless judged fully supported. Different test sets; see bench/.`, { size: 11, fill: t.muted }));
  return svg(W, H, t, body, 'Which check catches which failure');
}

// --------------------------------------------------------------- figure 3

function judgeFigure(t) {
  const files = readdirSync(RESULTS).filter((f) => /^judge-.+\.json$/.test(f));
  const rows = files.map((f) => {
    const d = load(f);
    const none = d.confusion.none;
    const noneN = none.full + none.partial + none.none;
    const n = d.binary.tp + d.binary.fp + d.binary.fn + d.binary.tn;
    return {
      model: d.model.replace(/^openai-/, '').replace(/-0731$/, '') + (d.thinking === false ? ', no reasoning' : ''),
      // "caught" = not called fully supported, so higher is better in both panels
      caught: 1 - none.full / noneN,
      caughtCi: wilson(none.partial + none.none, noneN),
      agree: d.binary.accuracy,
      agreeCi: wilson(d.binary.tp + d.binary.tn, n),
      noneN,
      n,
      requested: d.itemsRequested,
    };
  }).sort((a, b) => b.caught - a.caught);

  const W = 760;
  const labelRight = 236;
  const p1 = [256, 470];
  const p2 = [530, 736];
  const top = 108;
  const rowH = 30;
  const bottom = top + rows.length * rowH;
  const H = bottom + 76;
  const a1 = xAxis(t, { x0: p1[0], x1: p1[1], y0: top - 6, y1: bottom, domain: [0.6, 1], ticks: [0.6, 0.7, 0.8, 0.9, 1], fmt: (v) => `${Math.round(v * 100)}%` });
  const a2 = xAxis(t, { x0: p2[0], x1: p2[1], y0: top - 6, y1: bottom, domain: [0.65, 0.9], ticks: [0.65, 0.7, 0.75, 0.8, 0.85, 0.9], fmt: (v) => `${Math.round(v * 100)}%` });
  const body = [
    text(24, 32, 'Judge models compared with human annotators', { size: 16, weight: 600, fill: t.ink }),
    text(24, 52, `ALCE human labels, the same ${rows[0].requested} claim–source pairs for every model, temperature 0. Dot: measured · line: 95% interval.`, { size: 12, fill: t.ink2 }),
    text(p1[0], 84, 'Unsupported citations caught ↑', { size: 13, weight: 600, fill: t.ink }),
    text(p1[0], 99, 'not called fully supported by the judge', { size: 11, fill: t.muted }),
    text(p2[0], 84, 'Agreement with annotators ↑', { size: 13, weight: 600, fill: t.ink }),
    text(p2[0], 99, '“fully supports”: yes or no', { size: 11, fill: t.muted }),
    ...a1.marks,
    ...a2.marks,
  ];
  const trueNli = 0.776;
  body.push(`<line x1="${a2.sx(trueNli)}" y1="${top - 6}" x2="${a2.sx(trueNli)}" y2="${bottom}" stroke="${t.ink2}" stroke-width="1.5"/>`);
  body.push(text(a2.sx(trueNli), bottom + 32, 'specialised NLI model 77.6%', { size: 11, fill: t.ink2, anchor: 'middle' }));

  rows.forEach((r, i) => {
    const cy = top + i * rowH + rowH / 2;
    body.push(text(labelRight, cy + 4, r.model, { size: 12, fill: t.ink, anchor: 'end' }));
    for (const [ax, v, ci, color] of [[a1, r.caught, r.caughtCi, t.s2], [a2, r.agree, r.agreeCi, t.s2]]) {
      body.push(`<line x1="${ax.sx(ci[0])}" y1="${cy}" x2="${ax.sx(ci[1])}" y2="${cy}" stroke="${color}" stroke-opacity="0.45" stroke-width="2" stroke-linecap="round"/>`);
      body.push(`<circle cx="${ax.sx(v)}" cy="${cy}" r="4.5" fill="${color}" stroke="${t.surface}" stroke-width="2"/>`);
      body.push(text(ax.sx(ci[1]) + 7, cy + 4, pct(v), { size: 11, fill: t.ink2, mono: true }));
    }
  });
  body.push(text(24, H - 18, `Caught: share of the pairs annotators marked “does not support” (${Math.min(...rows.map((r) => r.noneN))}–${Math.max(...rows.map((r) => r.noneN))} per model). Specialised NLI model: TRUE (Honovich et al., 2022), as reported by Gao et al. (2023).`, { size: 11, fill: t.muted }));
  return svg(W, H, t, body, 'Judge models compared against human annotators');
}

// --------------------------------------------------------------- figure 4

function protocolFigure(t) {
  const p = load('protocol.json');
  const rows = p.summary.map((s) => ({
    model: s.model.replace(/^openai-|^meta-/, '').replace(/-0731$/, ''),
    complete: s.completeRate,
    verbatim: s.verbatimRate,
    n: s.n,
  })).sort((a, b) => b.complete + b.verbatim - (a.complete + a.verbatim));
  const SERIES = [
    { key: 'complete', name: 'Complete: every cited claim carries a quote', color: t.cComplete },
    { key: 'verbatim', name: 'Verbatim: the quote is really in the source', color: t.cVerbatim },
  ];
  const W = 760;
  const labelRight = 206;
  const x0 = 222;
  const x1 = 700;
  const top = 104;
  const barH = 12;
  const groupH = 2 * barH + 2 + 18;
  const bottom = top + rows.length * groupH;
  const H = bottom + 62;
  const { sx, marks } = xAxis(t, { x0, x1, y0: top - 6, y1: bottom, domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v) => `${v * 100}%` });
  const body = [
    text(24, 32, 'How well answering models follow the citation instructions', { size: 16, weight: 600, fill: t.ink }),
    text(24, 52, `Answering models given the citation protocol: 18 tasks, ${p.repeats} runs each. Parsed and matched mechanically, no labels.`, { size: 12, fill: t.ink2 }),
    ...marks,
  ];
  let lx = 24;
  for (const s of SERIES) {
    body.push(`<rect x="${lx}" y="69" width="10" height="10" rx="2" fill="${s.color}"/>`);
    body.push(text(lx + 16, 78, s.name, { size: 12, fill: t.ink2 }));
    lx += 16 + s.name.length * 6.5 + 26;
  }
  rows.forEach((r, i) => {
    const gy = top + i * groupH;
    body.push(text(labelRight, gy + barH + 5, r.model, { size: 12, fill: t.ink, anchor: 'end' }));
    SERIES.forEach((s, si) => {
      const y = gy + si * (barH + 2);
      const v = r[s.key];
      const w = Math.max(4, sx(v) - x0);
      // square at the baseline, 4px rounded data end
      body.push(`<path d="M${x0},${y} h${w - 4} a4,4 0 0 1 4,4 v${barH - 8} a4,4 0 0 1 -4,4 h${-(w - 4)} z" fill="${s.color}"/>`);
      body.push(text(x0 + w + 6, y + barH - 2, pct(v), { size: 11, fill: t.ink2, mono: true }));
    });
  });
  body.push(`<line x1="${x0}" y1="${top - 6}" x2="${x0}" y2="${bottom}" stroke="${t.axis}" stroke-width="1"/>`);
  body.push(text(24, H - 18, 'Source: bench/results/protocol.json', { size: 11, fill: t.muted }));
  return svg(W, H, t, body, 'Citation protocol compliance per answering model');
}

// ------------------------------------------------------------------ write

// ------------------------------------------------------- demo data block

/** The same numbers, compact, for the charts in demo/index.html. */
function demoData() {
  const m = load('matcher.json');
  const fam = (family, realism) => {
    const ops = m.operators.filter((o) => o.family === family && o.realism === realism);
    const f = m.families.find((x) => x.family === family && x.realism === realism);
    return {
      n: f.n, median: f.medianScore, accepted: f.acceptedRate,
      min: Math.min(...ops.map((o) => o.minScore)), max: Math.max(...ops.map((o) => o.maxScore)),
    };
  };
  const glm = load('judge-glm-5.3-flash.json');
  const none = glm.confusion.none;
  const judges = readdirSync(RESULTS).filter((f) => /^judge-.+\.json$/.test(f)).map((f) => {
    const d = load(f);
    const nn = d.confusion.none;
    const noneN = nn.full + nn.partial + nn.none;
    const n = d.binary.tp + d.binary.fp + d.binary.fn + d.binary.tn;
    return {
      model: d.model.replace(/^openai-/, '').replace(/-0731$/, ''),
      reasoning: d.thinking !== false,
      falseGreen: nn.full / noneN, falseGreenCi: wilson(nn.full, noneN), unsupported: noneN,
      agreement: d.binary.accuracy, agreementCi: wilson(d.binary.tp + d.binary.tn, n),
    };
  });
  const p = load('protocol.json');
  return {
    source: 'bench/results/*.json',
    matcher: {
      items: m.itemCount, threshold: m.threshold, gap: m.separation, sweep: m.thresholdSweep,
      operators: m.operators.map((o) => ({
        label: (OP_LABELS[o.operator] ?? o.operator).replace(/ \(adversarial\)$/, ''), family: o.family, realism: o.realism,
        n: o.n, min: o.minScore, median: o.medianScore, max: o.maxScore,
      })),
      faithful: fam('faithful', 'natural'), manipulated: fam('manipulated', 'natural'),
      absent: fam('absent', 'natural'), adversarial: fam('absent', 'adversarial'),
    },
    tango: {
      judgeModel: glm.model,
      absent: { n: fam('absent', 'natural').n, matcherCaught: 1 - fam('absent', 'natural').accepted },
      unsupported: {
        manipulatedN: fam('manipulated', 'natural').n, matcherCaught: 1 - fam('manipulated', 'natural').accepted,
        judgeN: none.full + none.partial + none.none, judgeCaught: (none.partial + none.none) / (none.full + none.partial + none.none),
      },
    },
    judges, trueNli: 0.776,
    protocol: {
      tasks: 18, runs: p.repeats,
      models: p.summary.map((r) => ({
        model: r.model.replace(/^openai-|^meta-/, '').replace(/-0731$/, ''),
        complete: r.completeRate, verbatim: r.verbatimRate, answers: r.n,
      })),
    },
  };
}

/** Write the data block between the markers in demo/index.html, if present. */
function updateDemo() {
  const file = join(HERE, '..', '..', 'demo', 'index.html');
  const html = readFileSync(file, 'utf8');
  const start = '/* BENCH-DATA:BEGIN */';
  const end = '/* BENCH-DATA:END */';
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a === -1 || b === -1) return;
  const round = (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
  const block = `${start}\nconst BENCH = ${JSON.stringify(demoData(), round)};\n`;
  writeFileSync(file, html.slice(0, a) + block + html.slice(b));
  console.log(`updated ${file}`);
}

const FIGURES = { tango: tangoFigure, matcher: matcherFigure, judges: judgeFigure, protocol: protocolFigure };
for (const [name, render] of Object.entries(FIGURES)) {
  for (const [mode, theme] of Object.entries(THEMES)) {
    const file = join(HERE, `${name}-${mode}.svg`);
    writeFileSync(file, render(theme));
    console.log(`wrote ${file}`);
  }
}
updateDemo();
