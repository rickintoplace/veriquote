/**
 * Dependency-free HTML → plain text, good enough to match quotes against.
 * Keeps block structure as line breaks, drops non-content elements, decodes
 * entities. Not a readability extractor: navigation and footers stay in, which
 * costs nothing for matching because a quote only has to be found somewhere.
 */

const DROP_ELEMENTS = /<(script|style|noscript|template|svg|iframe|head|object|canvas)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
/** Reference markers such as Wikipedia's [12]: models quoting the page leave them out. */
const REF_MARKERS = /<sup\b[^>]*class="[^"]*\breference\b[^"]*"[^>]*>[\s\S]*?<\/sup\s*>/gi;
const BLOCK_TAGS =
  /<\/?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|h[1-6]|tr|table|thead|tbody|tfoot|section|article|aside|main|header|footer|nav|blockquote|pre|figure|figcaption|details|summary|form|fieldset|address)\b[^>]*>/gi;
const CELL_TAGS = /<\/?(?:td|th)\b[^>]*>/gi;
const ANY_TAG = /<[^>]+>/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', sbquo: '‚',
  ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  shy: '­', zwj: '‍', zwnj: '‌', thinsp: ' ', ensp: ' ', emsp: ' ',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', minus: '−',
  middot: '·', bull: '•', sect: '§', para: '¶', micro: 'µ', prime: '′', Prime: '″',
  euro: '€', pound: '£', yen: '¥', cent: '¢', frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', mu: 'μ', pi: 'π', sigma: 'σ', Delta: 'Δ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', oacute: 'ó', iacute: 'í', uacute: 'ú',
  ccedil: 'ç', ntilde: 'ñ', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
};

/** Decode numeric and common named HTML entities. Unknown names are left as-is. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Extract the document title, if any. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = m ? decodeEntities(m[1].replace(ANY_TAG, '')).replace(/\s+/g, ' ').trim() : '';
  return title || undefined;
}

/**
 * Inner HTML of the page's `<main>` (or else `<article>`) element, where the
 * content usually lives; `undefined` when there is none.
 */
export function htmlMainContent(html: string): string | undefined {
  for (const tag of ['main', 'article']) {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)</${tag}\\s*>`, 'i').exec(html);
    if (m && m[1].trim()) return m[1];
  }
  return undefined;
}

/** Convert an HTML document or fragment to readable plain text. */
export function htmlToText(html: string): string {
  const text = html
    .replace(COMMENTS, '')
    .replace(REF_MARKERS, '')
    .replace(DROP_ELEMENTS, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(CELL_TAGS, ' ')
    .replace(ANY_TAG, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
