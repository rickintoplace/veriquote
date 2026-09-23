import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from '../src/source/html.js';
import { fetchSource, sourceFromBody } from '../src/source/fetch.js';

const PAGE = `<!doctype html><html><head><title>Ozone &amp; UV</title><style>p{color:red}</style></head>
<body><nav>Menu Home About</nav><main><h1>Ozone layer</h1>
<p>The ozone layer absorbs 97&nbsp;to&nbsp;99&#37; of <b>medium-frequency</b> UV&#8212;mostly.</p>
<script>var p = "not content";</script><!-- hidden --></main><footer>Imprint</footer></body></html>`;

const fakeFetch = (body: BodyInit, headers: Record<string, string>, status = 200) =>
  (async () => new Response(body, { status, headers })) as typeof globalThis.fetch;

describe('htmlToText', () => {
  it('keeps text, drops scripts, styles and comments, decodes entities', () => {
    const text = htmlToText(PAGE);
    expect(text).toContain('The ozone layer absorbs 97 to 99% of medium-frequency UV—mostly.');
    expect(text).not.toContain('not content');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('hidden');
  });

  it('leaves unknown entities alone', () => {
    expect(decodeEntities('a &madeup; b &#x41;')).toBe('a &madeup; b A');
  });
});

describe('sourceFromBody', () => {
  it('matches against <main> first and keeps the full page as a fallback', () => {
    const source = sourceFromBody(PAGE, 'text/html; charset=utf-8', 'https://example.org/ozone');
    expect(source.title).toBe('Ozone & UV');
    expect(source.text).not.toContain('Menu Home');
    expect(source.extraTexts?.[0]).toContain('Menu Home');
  });

  it('passes plain text through unchanged', () => {
    expect(sourceFromBody('plain <b>text</b>', 'text/plain').text).toBe('plain <b>text</b>');
  });
});

describe('fetchSource', () => {
  it('decodes the declared charset', async () => {
    const latin1 = new Blob([Uint8Array.from([0x47, 0x72, 0xfc, 0xdf, 0x65])]); // "Grüße" in ISO-8859-1
    const source = await fetchSource('https://example.org', {
      fetch: fakeFetch(latin1, { 'content-type': 'text/plain; charset=iso-8859-1' }),
    });
    expect(source.text).toBe('Grüße');
  });

  it('rejects PDFs with a pointer to what to do instead', async () => {
    await expect(
      fetchSource('https://example.org/a.pdf', { fetch: fakeFetch('%PDF', { 'content-type': 'application/pdf' }) }),
    ).rejects.toThrow(/pdftotext/);
  });

  it('reports HTTP errors with the URL', async () => {
    await expect(
      fetchSource('https://example.org/missing', { fetch: fakeFetch('', { 'content-type': 'text/html' }, 404) }),
    ).rejects.toThrow('could not fetch https://example.org/missing: HTTP 404');
  });
});

describe('reference markers', () => {
  it('drops Wikipedia-style [n] footnote markers, which quoting models leave out', () => {
    const html = '<p>It was ratified by 198 parties,<sup id="cite_ref-6" class="reference"><a href="#cite_note-6">[6]</a></sup> the first.</p>';
    expect(htmlToText(html)).toBe('It was ratified by 198 parties, the first.');
  });
});
